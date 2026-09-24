import React, {useCallback, useLayoutEffect} from 'react';
import {act} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import type GenericCollection from '../../../utils/GenericCollection';
import {OnyxProbe, actAndSettle, commitValues, createRecorder, expectOrderedSubsequence, lastCommit, render, settle} from './harness';
import type {Recorder} from './harness';

const KEYS = {
    SESSION: 'session',
    OTHER: 'other',
    DETAILS: 'details',
    REPORT: 'report_',
    POLICY: 'policy_',
};

Onyx.init({
    keys: {
        SESSION: KEYS.SESSION,
        OTHER: KEYS.OTHER,
        DETAILS: KEYS.DETAILS,
        COLLECTION: {REPORT: KEYS.REPORT, POLICY: KEYS.POLICY},
    },
});

beforeEach(async () => {
    await act(async () => {
        await Onyx.clear();
    });
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function ProbeList({onyxKeys, recorders, options}: {onyxKeys: OnyxKey[]; recorders: Recorder[]; options?: {selector?: UseOnyxSelector<OnyxKey, unknown>}}) {
    return (
        <>
            {onyxKeys.map((onyxKey, index) => (
                <OnyxProbe
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    onyxKey={onyxKey}
                    recorder={recorders[index]}
                    options={options}
                />
            ))}
        </>
    );
}

/** Picks one entry of a record key with a selector derived from a prop, the per-row pattern in lists. */
function EntryProbe({entryID, recorder}: {entryID: string; recorder: Recorder}) {
    const selectLogin = useCallback(
        (data: unknown) => {
            const entry = isRecord(data) ? data[entryID] : undefined;
            return isRecord(entry) ? entry.login : undefined;
        },
        [entryID],
    );
    const [login] = useOnyx<OnyxKey, unknown>(KEYS.DETAILS, {selector: selectLogin});
    useLayoutEffect(() => {
        recorder.commits.push({value: login, status: 'loaded', result: [login, {status: 'loaded'}]});
    });
    return null;
}

/** A hook whose inline selector is recreated on every render. */
function InlineSelectorProbe({recorder}: {recorder: Recorder}) {
    // eslint-disable-next-line rulesdir/no-inline-useOnyx-selector -- the inline selector is the behaviour under test
    const result = useOnyx<OnyxKey, unknown>(KEYS.SESSION, {selector: (data) => (isRecord(data) ? {email: data.email} : undefined)});
    useLayoutEffect(() => {
        recorder.commits.push({value: result[0], status: result[1].status, result});
    });
    return null;
}

describe('useOnyx lifecycle contract', () => {
    describe('unmount and remount', () => {
        it('shows the current value on remount after the key changed while unmounted, in one loaded commit', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'before@y.z'}));
            const first = createRecorder();
            const {unmount} = render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={first}
                />,
            );
            await settle();
            unmount();

            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {email: 'after@y.z'}));
            expect(lastCommit(first).value).toEqual({email: 'before@y.z'});

            const second = createRecorder();
            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={second}
                />,
            );
            await settle();

            expect(second.commits).toHaveLength(1);
            expect(lastCommit(second)).toMatchObject({value: {email: 'after@y.z'}, status: 'loaded'});
        });

        it('shows undefined on remount after the key was removed while unmounted', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, 'value'));
            const first = createRecorder();
            const {unmount} = render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={first}
                />,
            );
            await settle();
            unmount();
            await actAndSettle(() => Onyx.set(KEYS.SESSION, null));

            const second = createRecorder();
            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={second}
                />,
            );
            await settle();

            expect(lastCommit(second)).toMatchObject({value: undefined, status: 'loaded'});
            expect(commitValues(second).every((value) => value === undefined)).toBe(true);
        });

        it('shows the current collection on remount after members changed while unmounted', async () => {
            await act(async () => Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'}));
            const first = createRecorder();
            const {unmount} = render(
                <OnyxProbe
                    onyxKey={KEYS.REPORT}
                    recorder={first}
                />,
            );
            await settle();
            unmount();
            await actAndSettle(() => Onyx.mergeCollection(KEYS.REPORT, {[`${KEYS.REPORT}1`]: null, [`${KEYS.REPORT}2`]: {reportID: '2'}} as GenericCollection));

            const second = createRecorder();
            render(
                <OnyxProbe
                    onyxKey={KEYS.REPORT}
                    recorder={second}
                />,
            );
            await settle();

            expect(second.commits).toHaveLength(1);
            expect(lastCommit(second).value).toEqual({[`${KEYS.REPORT}2`]: {reportID: '2'}});
        });

        it('keeps updating the remaining hooks after one of many hooks on the key unmounts', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {count: 0}));
            const recorders = [createRecorder(), createRecorder(), createRecorder()];
            const {rerender} = render(
                <ProbeList
                    onyxKeys={[KEYS.SESSION, KEYS.SESSION, KEYS.SESSION]}
                    recorders={recorders}
                />,
            );
            await settle();

            rerender(
                <ProbeList
                    onyxKeys={[KEYS.SESSION, KEYS.SESSION]}
                    recorders={recorders}
                />,
            );
            const removedCommits = recorders[2].commits.length;
            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {count: 1}));

            expect(lastCommit(recorders[0]).value).toEqual({count: 1});
            expect(lastCommit(recorders[1]).value).toEqual({count: 1});
            expect(recorders[2].commits).toHaveLength(removedCommits);
        });

        it('keeps updating a hook when a hook with its own connection on the same key unmounts', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, 'v0'));
            const shared = createRecorder();
            const isolated = createRecorder();
            const {rerender} = render(
                <>
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={shared}
                    />
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={isolated}
                        options={{reuseConnection: false}}
                    />
                </>,
            );
            await settle();
            rerender(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={shared}
                />,
            );

            await actAndSettle(() => Onyx.set(KEYS.SESSION, 'v1'));

            expect(lastCommit(shared).value).toBe('v1');
            expect(lastCommit(isolated).value).toBe('v0');
        });

        it('mounts and unmounts 50 hooks on a warm key repeatedly, each mount loaded on its first commit', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'x@y.z'}));
            const keys = Array.from({length: 50}, () => KEYS.SESSION);

            for (let round = 0; round < 3; round++) {
                const recorders = keys.map(() => createRecorder());
                const {unmount} = render(
                    <ProbeList
                        onyxKeys={keys}
                        recorders={recorders}
                    />,
                );
                await settle();
                for (const recorder of recorders) {
                    expect(recorder.commits).toHaveLength(1);
                    expect(lastCommit(recorder)).toMatchObject({value: {email: 'x@y.z'}, status: 'loaded'});
                }
                unmount();
                await actAndSettle(() => Onyx.merge(KEYS.SESSION, {round}));
            }

            const final = createRecorder();
            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={final}
                />,
            );
            await settle();
            expect(lastCommit(final).value).toEqual({email: 'x@y.z', round: 2});
        });

        it('mounts and unmounts 50 hooks on member keys repeatedly, each mount loaded on its first commit', async () => {
            const collection: GenericCollection = {};
            for (let index = 0; index < 50; index++) {
                collection[`${KEYS.REPORT}${index}`] = {reportID: String(index)};
            }
            await act(async () => Onyx.mergeCollection(KEYS.REPORT, collection));
            const keys = Object.keys(collection);

            for (let round = 0; round < 3; round++) {
                const recorders = keys.map(() => createRecorder());
                const {unmount} = render(
                    <ProbeList
                        onyxKeys={keys}
                        recorders={recorders}
                    />,
                );
                await settle();
                for (const [index, recorder] of recorders.entries()) {
                    expect(recorder.commits).toHaveLength(1);
                    expect(lastCommit(recorder)).toMatchObject({value: {reportID: String(index)}, status: 'loaded'});
                }
                unmount();
            }
        });

        it('reports no console errors when writes land after unmount', async () => {
            const consoleError = jest.spyOn(console, 'error');
            try {
                await act(async () => Onyx.set(KEYS.SESSION, 'v0'));
                const recorder = createRecorder();
                const {unmount} = render(
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={recorder}
                    />,
                );
                let pending: Promise<void> = Promise.resolve();
                act(() => {
                    pending = Onyx.set(KEYS.SESSION, 'v1');
                });
                unmount();
                await actAndSettle(() => pending);
                await actAndSettle(() => Onyx.merge(KEYS.SESSION, 'v2'));

                expect(consoleError).not.toHaveBeenCalled();
            } finally {
                consoleError.mockRestore();
            }
        });

        it('reports no console errors and no commits when unmounted while still loading', async () => {
            const consoleError = jest.spyOn(console, 'error');
            try {
                const recorder = createRecorder();
                const {unmount} = render(
                    <OnyxProbe
                        onyxKey={KEYS.OTHER}
                        recorder={recorder}
                    />,
                );
                unmount();
                const commitsAtUnmount = recorder.commits.length;
                await settle();
                await actAndSettle(() => Onyx.set(KEYS.OTHER, 'late'));

                expect(recorder.commits).toHaveLength(commitsAtUnmount);
                expect(consoleError).not.toHaveBeenCalled();
            } finally {
                consoleError.mockRestore();
            }
        });
        it('mounts a hook next to an already-connected hook after Onyx.clear and reaches loaded', async () => {
            const first = createRecorder();
            const late = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    key="first"
                    onyxKey={KEYS.SESSION}
                    recorder={first}
                />,
            );
            await settle();
            await actAndSettle(() => Onyx.clear());

            rerender(
                <>
                    <OnyxProbe
                        key="first"
                        onyxKey={KEYS.SESSION}
                        recorder={first}
                    />
                    <OnyxProbe
                        key="late"
                        onyxKey={KEYS.SESSION}
                        recorder={late}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(late)).toMatchObject({value: undefined, status: 'loaded'});
            expect(lastCommit(first)).toMatchObject({value: undefined, status: 'loaded'});
        });

        it('mounts a hook next to an already-connected hook after the key was removed and reaches loaded', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {step: 1}));
            const first = createRecorder();
            const late = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    key="first"
                    onyxKey={KEYS.SESSION}
                    recorder={first}
                />,
            );
            await settle();
            await actAndSettle(() => Onyx.set(KEYS.SESSION, null));

            rerender(
                <>
                    <OnyxProbe
                        key="first"
                        onyxKey={KEYS.SESSION}
                        recorder={first}
                    />
                    <OnyxProbe
                        key="late"
                        onyxKey={KEYS.SESSION}
                        recorder={late}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(late)).toMatchObject({value: undefined, status: 'loaded'});
            expect(late.commits.length).toBeLessThanOrEqual(2);
        });

        it('mounts a member hook next to an already-connected one after setCollection dropped the member and reaches loaded', async () => {
            await act(async () => Onyx.set(`${KEYS.POLICY}1`, {name: 'one'}));
            const first = createRecorder();
            const late = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    key="first"
                    onyxKey={`${KEYS.POLICY}1`}
                    recorder={first}
                />,
            );
            await settle();
            await actAndSettle(() => Onyx.setCollection(KEYS.POLICY, {[`${KEYS.POLICY}2`]: {name: 'two'}} as GenericCollection));

            rerender(
                <>
                    <OnyxProbe
                        key="first"
                        onyxKey={`${KEYS.POLICY}1`}
                        recorder={first}
                    />
                    <OnyxProbe
                        key="late"
                        onyxKey={`${KEYS.POLICY}1`}
                        recorder={late}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(first)).toMatchObject({value: undefined, status: 'loaded'});
            expect(lastCommit(late)).toMatchObject({value: undefined, status: 'loaded'});
        });

        it('keeps an already-loaded hook loaded when a sibling on the same key mounts while a merge is pending', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {step: 1}));
            const loaded = createRecorder();
            const mounting = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    key="loaded"
                    onyxKey={KEYS.SESSION}
                    recorder={loaded}
                />,
            );
            await settle();

            Onyx.merge(KEYS.SESSION, {step: 2});
            rerender(
                <>
                    <OnyxProbe
                        key="mounting"
                        onyxKey={KEYS.SESSION}
                        recorder={mounting}
                    />
                    <OnyxProbe
                        key="loaded"
                        onyxKey={KEYS.SESSION}
                        recorder={loaded}
                    />
                </>,
            );
            await settle();

            expect(loaded.commits.every((frame) => frame.status === 'loaded')).toBe(true);
            expectOrderedSubsequence(commitValues(loaded), [{step: 1}, {step: 2}]);
            expect(lastCommit(loaded).value).toEqual({step: 2});
            expect(lastCommit(mounting)).toMatchObject({value: {step: 2}, status: 'loaded'});
        });
    });

    describe('parent re-render with stable props', () => {
        it('renders once per parent render and returns the identical result tuple', async () => {
            await act(async () => {
                await Onyx.set(KEYS.SESSION, {email: 'x@y.z'});
                await Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'});
            });
            const keys = [KEYS.SESSION, `${KEYS.REPORT}1`, KEYS.REPORT, KEYS.OTHER];
            const recorders = keys.map(() => createRecorder());
            const {rerender} = render(
                <ProbeList
                    onyxKeys={keys}
                    recorders={recorders}
                />,
            );
            await settle();
            const results = recorders.map((recorder) => lastCommit(recorder).result);
            const renderBaselines = recorders.map((recorder) => recorder.renders.length);

            for (let revision = 0; revision < 10; revision++) {
                rerender(
                    <ProbeList
                        onyxKeys={keys}
                        recorders={recorders}
                    />,
                );
            }
            await settle();

            for (const [index, recorder] of recorders.entries()) {
                expect(recorder.renders.length - renderBaselines[index]).toBeLessThanOrEqual(10);
                for (const frame of recorder.renders.slice(renderBaselines[index])) {
                    expect(frame.result).toBe(results[index]);
                }
            }
        });

        it('returns the identical result tuple with a stable selector across parent renders', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'x@y.z', authToken: 'a'}));
            const selector: UseOnyxSelector<OnyxKey, unknown> = (data) => (isRecord(data) ? {email: data.email} : undefined);
            const recorder = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                    options={{selector}}
                />,
            );
            await settle();
            const result = lastCommit(recorder).result;

            for (let revision = 1; revision <= 5; revision++) {
                rerender(
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={recorder}
                        options={{selector}}
                    />,
                );
            }

            expect(recorder.commits).toHaveLength(6);
            expect(recorder.commits.every((frame) => frame.result === result)).toBe(true);
        });

        it('keeps the selected value reference when an inline selector is recreated on every parent render', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'x@y.z', authToken: 'a'}));
            const recorder = createRecorder();
            const {rerender} = render(<InlineSelectorProbe recorder={recorder} />);
            await settle();
            const selected = lastCommit(recorder).value;

            for (let revision = 1; revision <= 5; revision++) {
                rerender(<InlineSelectorProbe recorder={recorder} />);
            }
            await settle();

            expect(recorder.commits).toHaveLength(6);
            expect(recorder.commits.every((frame) => frame.value === selected)).toBe(true);

            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {email: 'new@y.z'}));
            expect(lastCommit(recorder).value).toEqual({email: 'new@y.z'});
        });
    });

    describe('changing inputs while mounted', () => {
        it('applies a prop-dependent selector change on the same commit, with no stale frame', async () => {
            await act(async () => Onyx.set(KEYS.DETAILS, {1: {login: 'one@y.z'}, 2: {login: 'two@y.z'}}));
            const recorder = createRecorder();
            const {rerender} = render(
                <EntryProbe
                    entryID="1"
                    recorder={recorder}
                />,
            );
            await settle();
            expect(commitValues(recorder)).toEqual(['one@y.z']);

            rerender(
                <EntryProbe
                    entryID="2"
                    recorder={recorder}
                />,
            );
            await settle();
            expect(commitValues(recorder)).toEqual(['one@y.z', 'two@y.z']);

            await actAndSettle(() => Onyx.merge(KEYS.DETAILS, {1: {login: 'ignored@y.z'}}));
            expect(lastCommit(recorder).value).toBe('two@y.z');

            await actAndSettle(() => Onyx.merge(KEYS.DETAILS, {2: {login: 'changed@y.z'}}));
            expect(lastCommit(recorder).value).toBe('changed@y.z');
        });

        it('never commits a value of another key after switching between two warm keys', async () => {
            await act(async () => {
                await Onyx.set(`${KEYS.POLICY}1`, {name: 'one'});
                await Onyx.set(`${KEYS.POLICY}2`, {name: 'two'});
            });
            const recorder = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    onyxKey={`${KEYS.POLICY}1`}
                    recorder={recorder}
                />,
            );
            await settle();
            const beforeSwitch = recorder.commits.length;

            rerender(
                <OnyxProbe
                    onyxKey={`${KEYS.POLICY}2`}
                    recorder={recorder}
                />,
            );
            await settle();

            const afterSwitch = recorder.commits.slice(beforeSwitch);
            expect(afterSwitch.every((frame) => frame.value === undefined || (isRecord(frame.value) && frame.value.name === 'two'))).toBe(true);
            expect(lastCommit(recorder)).toMatchObject({value: {name: 'two'}, status: 'loaded'});

            await actAndSettle(() => Onyx.merge(`${KEYS.POLICY}1`, {name: 'uno'}));
            expect(lastCommit(recorder).value).toEqual({name: 'two'});

            await actAndSettle(() => Onyx.merge(`${KEYS.POLICY}2`, {name: 'dos'}));
            expect(lastCommit(recorder).value).toEqual({name: 'dos'});
        });

        it('shows the target key value on the switching render when another hook already reads the target key', async () => {
            await act(async () => {
                await Onyx.set(`${KEYS.POLICY}1`, {name: 'one'});
                await Onyx.set(`${KEYS.POLICY}2`, {name: 'two'});
            });
            const switching = createRecorder();
            const sibling = createRecorder();
            const {rerender} = render(
                <>
                    <OnyxProbe
                        onyxKey={`${KEYS.POLICY}1`}
                        recorder={switching}
                    />
                    <OnyxProbe
                        onyxKey={`${KEYS.POLICY}2`}
                        recorder={sibling}
                    />
                </>,
            );
            await settle();
            const beforeSwitch = switching.commits.length;

            rerender(
                <>
                    <OnyxProbe
                        onyxKey={`${KEYS.POLICY}2`}
                        recorder={switching}
                    />
                    <OnyxProbe
                        onyxKey={`${KEYS.POLICY}2`}
                        recorder={sibling}
                    />
                </>,
            );
            await settle();

            const afterSwitch = switching.commits.slice(beforeSwitch);
            expect(afterSwitch.length).toBeGreaterThanOrEqual(1);
            for (const frame of afterSwitch) {
                expect(frame).toMatchObject({value: {name: 'two'}, status: 'loaded'});
            }
            expect(lastCommit(switching).value).toBe(lastCommit(sibling).value);
        });

        it('lands on the new key value when switching from a warm key to a missing key', async () => {
            await act(async () => Onyx.set(`${KEYS.POLICY}1`, {name: 'one'}));
            const recorder = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    onyxKey={`${KEYS.POLICY}1`}
                    recorder={recorder}
                />,
            );
            await settle();
            const beforeSwitch = recorder.commits.length;

            rerender(
                <OnyxProbe
                    onyxKey={`${KEYS.POLICY}9`}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(recorder.commits.slice(beforeSwitch).every((frame) => frame.value === undefined)).toBe(true);
            expect(lastCommit(recorder)).toMatchObject({value: undefined, status: 'loaded'});

            await actAndSettle(() => Onyx.set(`${KEYS.POLICY}9`, {name: 'nine'}));
            expect(lastCommit(recorder).value).toEqual({name: 'nine'});
        });

        it('keeps the frames of one hook ordered when writes arrive right after a remount', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, 0));
            const recorder = createRecorder();
            const {unmount} = render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );
            await settle();
            unmount();

            const remounted = createRecorder();
            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={remounted}
                />,
            );
            await actAndSettle(() => {
                Onyx.set(KEYS.SESSION, 1);
                Onyx.set(KEYS.SESSION, 2);
            });

            expectOrderedSubsequence(commitValues(remounted), [0, 1, 2]);
            expect(lastCommit(remounted).value).toBe(2);
        });
    });
    describe('current behaviour (suspected bug)', () => {
        it('commits a loaded undefined frame, then loading, then loaded when the key switches to a missing key', async () => {
            await act(async () => Onyx.set(`${KEYS.POLICY}1`, {name: 'one'}));
            const recorder = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    onyxKey={`${KEYS.POLICY}1`}
                    recorder={recorder}
                />,
            );
            await settle();

            rerender(
                <OnyxProbe
                    onyxKey={`${KEYS.POLICY}9`}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(recorder.commits.map((frame) => [frame.value, frame.status])).toEqual([
                [{name: 'one'}, 'loaded'],
                [undefined, 'loaded'],
                [undefined, 'loading'],
                [undefined, 'loaded'],
            ]);
        });

        it('commits the pre-merge value after loading when a hook mounts during a pending merge while another hook is connected', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {step: 1}));
            const connected = createRecorder();
            const mounting = createRecorder();
            const {rerender} = render(
                <OnyxProbe
                    key="connected"
                    onyxKey={KEYS.SESSION}
                    recorder={connected}
                />,
            );
            await settle();

            Onyx.merge(KEYS.SESSION, {step: 2});
            rerender(
                <>
                    <OnyxProbe
                        key="connected"
                        onyxKey={KEYS.SESSION}
                        recorder={connected}
                    />
                    <OnyxProbe
                        key="mounting"
                        onyxKey={KEYS.SESSION}
                        recorder={mounting}
                    />
                </>,
            );
            await settle();

            expect(mounting.commits.map((frame) => [frame.value, frame.status])).toEqual([
                [undefined, 'loading'],
                [{step: 1}, 'loaded'],
                [{step: 2}, 'loaded'],
            ]);
        });
    });
});
