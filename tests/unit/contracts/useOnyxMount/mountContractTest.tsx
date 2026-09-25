import React from 'react';
import {act} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import StorageMock from '../../../../lib/storage';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import type GenericCollection from '../../../utils/GenericCollection';
import {OnyxProbe, commitValues, createRecorder, lastCommit, render, settle} from './harness';
import type {Recorder} from './harness';

const KEYS = {
    SESSION: 'session',
    OTHER: 'other',
    REPORT: 'report_',
    REPORT_DRAFT: 'report_draft_',
    POLICY: 'policy_',
};

Onyx.init({
    keys: {
        SESSION: KEYS.SESSION,
        OTHER: KEYS.OTHER,
        COLLECTION: {REPORT: KEYS.REPORT, REPORT_DRAFT: KEYS.REPORT_DRAFT, POLICY: KEYS.POLICY},
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

function selectField(field: string): UseOnyxSelector<OnyxKey, unknown> {
    return (data) => (isRecord(data) ? data[field] : undefined);
}

function framesOf(recorder: Recorder): unknown[] {
    return recorder.commits.map((frame) => [frame.value, frame.status]);
}

function expectLoadingMountFrames(recorder: Recorder, finalValue: unknown) {
    expect(recorder.commits[0]).toMatchObject({value: undefined, status: 'loading'});
    expect(lastCommit(recorder)).toMatchObject({status: 'loaded'});
    expect(lastCommit(recorder).value).toEqual(finalValue);
    // A loading mount may skip frames but it never commits 'loaded' with a value other than the final one.
    for (const frame of recorder.commits) {
        if (frame.status === 'loaded') {
            expect(frame.value).toEqual(finalValue);
        }
    }
    // Once loaded, the hook never goes back to 'loading' during a mount.
    const firstLoaded = recorder.commits.findIndex((frame) => frame.status === 'loaded');
    expect(recorder.commits.slice(firstLoaded).every((frame) => frame.status === 'loaded')).toBe(true);
    expect(recorder.commits.length).toBeLessThanOrEqual(2);
}

describe('useOnyx mount contract', () => {
    describe('warm key (already in the cache)', () => {
        it('commits the cached value with loaded status on the very first frame and never shows loading', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'a@b.c', accountID: 1}));
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );

            expect(recorder.commits).toHaveLength(1);
            expect(recorder.commits[0]).toMatchObject({value: {email: 'a@b.c', accountID: 1}, status: 'loaded'});

            await settle();

            expect(recorder.commits.length).toBeLessThanOrEqual(1);
            expect(recorder.commits.every((frame) => frame.status === 'loaded')).toBe(true);
        });

        it('returns the value set synchronously before mount even if the write was not awaited', async () => {
            const recorder = createRecorder();

            const pendingSet = Onyx.set(KEYS.SESSION, 'not-awaited');
            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );
            await act(async () => pendingSet);
            await settle();

            expect(recorder.commits[0]).toMatchObject({value: 'not-awaited', status: 'loaded'});
            expect(commitValues(recorder).every((value) => value === 'not-awaited')).toBe(true);
        });

        it.each([
            ['zero', 0],
            ['false', false],
            ['empty string', ''],
            ['empty object', {}],
            ['empty array', []],
            ['NaN', NaN],
        ])('returns the falsy value %s as is, not as undefined', async (_label, storedValue) => {
            await act(async () => Onyx.set(KEYS.SESSION, storedValue));
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(recorder.commits[0].status).toBe('loaded');
            expect(recorder.commits[0].value).toEqual(storedValue);
            expect(lastCommit(recorder).value).toEqual(storedValue);
            expect(recorder.commits.length).toBeLessThanOrEqual(1);
        });

        it('hands every hook on the key the same value reference, which is the reference Onyx.connect delivers', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'shared@b.c'}));
            let connectValue: unknown;
            const connection = Onyx.connectWithoutView({
                key: KEYS.SESSION,
                callback: (value) => {
                    connectValue = value;
                },
            });
            const recorders = Array.from({length: 5}, () => createRecorder());

            render(
                <>
                    {recorders.map((recorder, index) => (
                        <OnyxProbe
                            // eslint-disable-next-line react/no-array-index-key
                            key={index}
                            onyxKey={KEYS.SESSION}
                            recorder={recorder}
                        />
                    ))}
                </>,
            );
            await settle();

            const firstValue = lastCommit(recorders[0]).value;
            expect(firstValue).toEqual({email: 'shared@b.c'});
            for (const recorder of recorders) {
                expect(lastCommit(recorder).value).toBe(firstValue);
            }
            expect(connectValue).toBe(firstValue);
            Onyx.disconnect(connection);
        });
    });

    describe('missing key', () => {
        it('maps a selector result of null to undefined', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: null}));
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                    options={{selector: () => null}}
                />,
            );
            await settle();

            expect(recorder.commits[0]).toMatchObject({value: undefined, status: 'loaded'});
            expect(lastCommit(recorder)).toMatchObject({value: undefined, status: 'loaded'});
        });

        it('keeps falsy selector results', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {count: 0, flag: false}));
            const count = createRecorder();
            const flag = createRecorder();

            render(
                <>
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={count}
                        options={{selector: selectField('count')}}
                    />
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={flag}
                        options={{selector: selectField('flag')}}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(count)).toMatchObject({value: 0, status: 'loaded'});
            expect(lastCommit(flag)).toMatchObject({value: false, status: 'loaded'});
        });

        it('runs the selector with undefined for a missing key and returns its result once loaded', async () => {
            const recorder = createRecorder();
            const seenInputs: unknown[] = [];

            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                    options={{
                        selector: (data) => {
                            seenInputs.push(data);
                            return data === undefined ? 'fallback' : 'present';
                        },
                    }}
                />,
            );
            await settle();

            expect(lastCommit(recorder)).toMatchObject({value: 'fallback', status: 'loaded'});
            expect(seenInputs.every((input) => input === undefined)).toBe(true);
        });
    });

    describe('collection root', () => {
        it('commits the whole cached collection on the first frame', async () => {
            await act(async () =>
                Onyx.mergeCollection(KEYS.REPORT, {
                    [`${KEYS.REPORT}1`]: {reportID: '1'},
                    [`${KEYS.REPORT}2`]: {reportID: '2'},
                } as GenericCollection),
            );
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.REPORT}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(recorder.commits[0]).toMatchObject({status: 'loaded'});
            expect(recorder.commits[0].value).toEqual({[`${KEYS.REPORT}1`]: {reportID: '1'}, [`${KEYS.REPORT}2`]: {reportID: '2'}});
            expect(recorder.commits.length).toBeLessThanOrEqual(1);
        });

        it('never includes members of a collection whose key starts with the same prefix', async () => {
            await act(async () => {
                await Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'});
                await Onyx.set(`${KEYS.REPORT_DRAFT}1`, {draft: true});
            });
            const reports = createRecorder();
            const drafts = createRecorder();

            render(
                <>
                    <OnyxProbe
                        onyxKey={KEYS.REPORT}
                        recorder={reports}
                    />
                    <OnyxProbe
                        onyxKey={KEYS.REPORT_DRAFT}
                        recorder={drafts}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(reports).value).toEqual({[`${KEYS.REPORT}1`]: {reportID: '1'}});
            expect(lastCommit(drafts).value).toEqual({[`${KEYS.REPORT_DRAFT}1`]: {draft: true}});
        });

        it('returns member references identical to the ones a member hook returns', async () => {
            await act(async () => Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'}));
            const root = createRecorder();
            const member = createRecorder();

            render(
                <>
                    <OnyxProbe
                        onyxKey={KEYS.REPORT}
                        recorder={root}
                    />
                    <OnyxProbe
                        onyxKey={`${KEYS.REPORT}1`}
                        recorder={member}
                    />
                </>,
            );
            await settle();

            const rootValue = lastCommit(root).value;
            expect(isRecord(rootValue) && rootValue[`${KEYS.REPORT}1`]).toBe(lastCommit(member).value);
        });

        it('returns a frozen collection object so consumers cannot corrupt the shared snapshot', async () => {
            await act(async () => Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'}));
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.REPORT}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(Object.isFrozen(lastCommit(recorder).value)).toBe(true);
        });

        it('omits members that were set to null', async () => {
            await act(async () => {
                await Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'});
                await Onyx.set(`${KEYS.REPORT}2`, {reportID: '2'});
                await Onyx.set(`${KEYS.REPORT}2`, null);
            });
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.REPORT}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(lastCommit(recorder).value).toEqual({[`${KEYS.REPORT}1`]: {reportID: '1'}});
        });

        it('passes the whole collection to a collection selector', async () => {
            await act(async () =>
                Onyx.mergeCollection(KEYS.REPORT, {
                    [`${KEYS.REPORT}1`]: {reportID: '1'},
                    [`${KEYS.REPORT}2`]: {reportID: '2'},
                } as GenericCollection),
            );
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.REPORT}
                    recorder={recorder}
                    options={{selector: (data) => (isRecord(data) ? Object.keys(data).sort() : [])}}
                />,
            );
            await settle();

            expect(recorder.commits[0]).toMatchObject({status: 'loaded'});
            expect(lastCommit(recorder).value).toEqual([`${KEYS.REPORT}1`, `${KEYS.REPORT}2`]);
        });
    });

    describe('collection member', () => {
        it('commits the cached member on the first frame', async () => {
            await act(async () => Onyx.set(`${KEYS.REPORT}7`, {reportID: '7'}));
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={`${KEYS.REPORT}7`}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(recorder.commits[0]).toMatchObject({value: {reportID: '7'}, status: 'loaded'});
            expect(recorder.commits.length).toBeLessThanOrEqual(1);
        });

        it('does not confuse a member of the longer prefixed collection with a member of the shorter one', async () => {
            await act(async () => {
                await Onyx.set(`${KEYS.REPORT_DRAFT}1`, {draft: true});
                await Onyx.set(`${KEYS.REPORT}draft`, {reportID: 'draft'});
            });
            const draft = createRecorder();
            const report = createRecorder();

            render(
                <>
                    <OnyxProbe
                        onyxKey={`${KEYS.REPORT_DRAFT}1`}
                        recorder={draft}
                    />
                    <OnyxProbe
                        onyxKey={`${KEYS.REPORT}draft`}
                        recorder={report}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(draft).value).toEqual({draft: true});
            expect(lastCommit(report).value).toEqual({reportID: 'draft'});
        });

        it('mounts K hooks on K different members with one commit each', async () => {
            const collection: GenericCollection = {};
            for (let index = 0; index < 30; index++) {
                collection[`${KEYS.REPORT}${index}`] = {reportID: String(index)};
            }
            await act(async () => Onyx.mergeCollection(KEYS.REPORT, collection));
            const recorders = Array.from({length: 30}, () => createRecorder());

            render(
                <>
                    {recorders.map((recorder, index) => (
                        <OnyxProbe
                            // eslint-disable-next-line react/no-array-index-key
                            key={index}
                            onyxKey={`${KEYS.REPORT}${index}`}
                            recorder={recorder}
                        />
                    ))}
                </>,
            );
            await settle();

            for (const [index, recorder] of recorders.entries()) {
                expect(recorder.commits[0]).toMatchObject({value: {reportID: String(index)}, status: 'loaded'});
                expect(recorder.commits.length).toBeLessThanOrEqual(1);
            }
        });
    });

    describe('pending merges', () => {
        it('lands on the result of all queued merges', async () => {
            const recorder = createRecorder();

            Onyx.merge(KEYS.SESSION, {a: 1});
            Onyx.merge(KEYS.SESSION, {b: 2});
            Onyx.merge(KEYS.SESSION, {a: 3});
            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );
            await settle();

            expectLoadingMountFrames(recorder, {a: 3, b: 2});
        });

        it('blanks the output of a selector that has a fallback while the first merge is loading', async () => {
            const recorder = createRecorder();
            const selectWithFallback: UseOnyxSelector<OnyxKey, unknown> = (data) => (isRecord(data) ? data.a : 'fallback');

            Onyx.merge(KEYS.SESSION, {a: 1});
            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                    options={{selector: selectWithFallback}}
                />,
            );
            await settle();

            expectLoadingMountFrames(recorder, 1);
        });
    });

    describe('options', () => {
        it('gives hooks with different selectors on one key independent results', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'a@b.c', accountID: 5}));
            const email = createRecorder();
            const accountID = createRecorder();
            const whole = createRecorder();

            render(
                <>
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={email}
                        options={{selector: selectField('email')}}
                    />
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={accountID}
                        options={{selector: selectField('accountID')}}
                    />
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={whole}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(email).value).toBe('a@b.c');
            expect(lastCommit(accountID).value).toBe(5);
            expect(lastCommit(whole).value).toEqual({email: 'a@b.c', accountID: 5});
        });

        it('shares one result tuple between hooks with the same key and the same selector reference', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'a@b.c', accountID: 5}));
            const selector = (data: unknown) => ({email: isRecord(data) ? data.email : undefined});
            const first = createRecorder();
            const second = createRecorder();

            render(
                <>
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={first}
                        options={{selector}}
                    />
                    <OnyxProbe
                        onyxKey={KEYS.SESSION}
                        recorder={second}
                        options={{selector}}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(first).value).toEqual({email: 'a@b.c'});
            expect(lastCommit(second).value).toEqual({email: 'a@b.c'});
        });
    });

    describe('empty collection root', () => {
        it('reports loaded with an empty object once the store holds any key', async () => {
            await act(async () => Onyx.set(KEYS.OTHER, 'anything'));
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.POLICY}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(recorder.commits[0]).toMatchObject({status: 'loaded'});
            expect(lastCommit(recorder)).toMatchObject({value: {}, status: 'loaded'});
            expect(Object.isFrozen(lastCommit(recorder).value)).toBe(true);
            expect(recorder.commits.length).toBeLessThanOrEqual(1);
        });

        it('reports loaded with an empty frozen object when the store holds no key at all', async () => {
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.POLICY}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(framesOf(recorder)).toEqual([[{}, 'loaded']]);
            expect(Object.isFrozen(lastCommit(recorder).value)).toBe(true);
        });
    });

    describe('current behaviour (#834 change)', () => {
        // On main a missing key committed loading first and then undefined with loaded status.
        it('commits undefined with loaded status on the very first frame for a missing key', async () => {
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );

            expect(framesOf(recorder)).toEqual([[undefined, 'loaded']]);
            await settle();
            expect(framesOf(recorder)).toEqual([[undefined, 'loaded']]);
        });

        // On main a key set to null committed loading first and then undefined with loaded status.
        it('treats a key set to null like a missing key', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, null));
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(framesOf(recorder)).toEqual([[undefined, 'loaded']]);
        });

        // On main a missing member committed loading first and then undefined with loaded status.
        it('commits undefined with loaded status on the first frame for a member that does not exist while siblings do', async () => {
            await act(async () => Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'}));
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={`${KEYS.REPORT}2`}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(framesOf(recorder)).toEqual([[undefined, 'loaded']]);
        });

        // On main a key present only in storage committed loading and then the stored value read from storage.
        it('neither reads storage nor shows loading for a key that is in storage but not in the cache', async () => {
            await StorageMock.setItem(KEYS.SESSION, 'stored');
            jest.mocked(StorageMock.getItem).mockClear();
            jest.mocked(StorageMock.multiGet).mockClear();
            jest.mocked(StorageMock.getAll).mockClear();
            jest.mocked(StorageMock.getAllKeys).mockClear();
            const recorder = createRecorder();

            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(framesOf(recorder)).toEqual([[undefined, 'loaded']]);
            expect(StorageMock.getItem).not.toHaveBeenCalled();
            expect(StorageMock.multiGet).not.toHaveBeenCalled();
            expect(StorageMock.getAll).not.toHaveBeenCalled();
            expect(StorageMock.getAllKeys).not.toHaveBeenCalled();
        });

        // On main the hook committed loading and then only the merged value, never the pre-merge cached one.
        it('commits the pre-merge cached value and then the merged one when it mounts while a merge for the key is queued', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {step: 1}));
            const recorder = createRecorder();

            Onyx.merge(KEYS.SESSION, {step: 2});
            render(
                <OnyxProbe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );

            expect(framesOf(recorder)).toEqual([[{step: 1}, 'loaded']]);
            await settle();
            expect(framesOf(recorder)).toEqual([
                [{step: 1}, 'loaded'],
                [{step: 2}, 'loaded'],
            ]);
            expect(recorder.renders.length).toBeLessThanOrEqual(2);
        });
    });
});
