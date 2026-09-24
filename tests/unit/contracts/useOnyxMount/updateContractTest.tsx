import React, {useEffect, useLayoutEffect} from 'react';
import {act} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import type GenericCollection from '../../../utils/GenericCollection';
import {OnyxProbe, actAndSettle, commitValues, createRecorder, expectOrderedSubsequence, lastCommit, render, settle, useRecordFrames} from './harness';
import type {Recorder} from './harness';

const KEYS = {
    SESSION: 'session',
    OTHER: 'other',
    DERIVED: 'derived',
    DETAILS: 'details',
    POLICY_ALIAS: 'policyAlias',
    POLICY_ALIAS_OWNER: 'policyAliasOwner',
    REPORT: 'report_',
    REPORT_DRAFT: 'report_draft_',
    POLICY: 'policy_',
};

Onyx.init({
    keys: {
        SESSION: KEYS.SESSION,
        OTHER: KEYS.OTHER,
        DERIVED: KEYS.DERIVED,
        DETAILS: KEYS.DETAILS,
        POLICY_ALIAS: KEYS.POLICY_ALIAS,
        POLICY_ALIAS_OWNER: KEYS.POLICY_ALIAS_OWNER,
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

function commitsSince(recorder: Recorder, baseline: number): number {
    return recorder.commits.length - baseline;
}

function renderProbes(onyxKeys: OnyxKey[], options?: {selector?: UseOnyxSelector<OnyxKey, unknown>}): Recorder[] {
    const recorders = onyxKeys.map(() => createRecorder());
    render(
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
        </>,
    );
    return recorders;
}

type PairFrame = {first: unknown; second: unknown};

/** Reads two keys in one component, so each committed frame shows whether the two reads are consistent. */
function PairProbe({firstKey, secondKey, frames, secondSelector}: {firstKey: OnyxKey; secondKey: OnyxKey; frames: PairFrame[]; secondSelector?: UseOnyxSelector<OnyxKey, unknown>}) {
    const [first] = useOnyx<OnyxKey, unknown>(firstKey);
    const [second] = useOnyx<OnyxKey, unknown>(secondKey, {selector: secondSelector});
    useLayoutEffect(() => {
        frames.push({first, second});
    });
    return null;
}

/** Writes a value derived from the key it reads, the "effect that syncs Onyx" pattern. */
function DerivingWriter({recorder}: {recorder: Recorder}) {
    const result = useOnyx<OnyxKey, unknown>(KEYS.SESSION);
    const [session] = result;
    useRecordFrames(recorder, result);
    useEffect(() => {
        if (!isRecord(session)) {
            return;
        }
        Onyx.merge(KEYS.DERIVED, {fromSession: session.counter});
    }, [session]);
    return null;
}

describe('useOnyx update contract', () => {
    describe('updates to the subscribed key', () => {
        it('re-renders every hook on the key with the new value, in one commit at most per hook', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {authToken: 'a', email: 'x@y.z'}));
            const recorders = renderProbes(Array.from({length: 10}, () => KEYS.SESSION));
            await settle();
            const baselines = recorders.map((recorder) => recorder.commits.length);

            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {authToken: 'b'}));

            const sharedValue = lastCommit(recorders[0]).value;
            expect(sharedValue).toEqual({authToken: 'b', email: 'x@y.z'});
            for (const [index, recorder] of recorders.entries()) {
                expect(commitsSince(recorder, baselines[index])).toBeGreaterThanOrEqual(1);
                expect(commitsSince(recorder, baselines[index])).toBeLessThanOrEqual(1);
                expect(lastCommit(recorder).value).toBe(sharedValue);
                expect(lastCommit(recorder).status).toBe('loaded');
            }
        });

        it('re-renders when a nested value changes even though the top-level keys are the same', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {nested: {count: 1}, flag: true}));
            const [recorder] = renderProbes([KEYS.SESSION]);
            await settle();

            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {nested: {count: 2}}));

            expect(lastCommit(recorder).value).toEqual({nested: {count: 2}, flag: true});
        });

        it('re-renders when a top-level primitive changes', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {count: 1, label: 'same'}));
            const [recorder] = renderProbes([KEYS.SESSION]);
            await settle();

            await actAndSettle(() => Onyx.set(KEYS.SESSION, {count: 2, label: 'same'}));

            expect(lastCommit(recorder).value).toEqual({count: 2, label: 'same'});
        });

        it('re-renders for primitive values, including changes between falsy values', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, 0));
            const [recorder] = renderProbes([KEYS.SESSION]);
            await settle();

            await actAndSettle(() => Onyx.set(KEYS.SESSION, false));
            expect(lastCommit(recorder).value).toBe(false);

            await actAndSettle(() => Onyx.set(KEYS.SESSION, ''));
            expect(lastCommit(recorder).value).toBe('');

            await actAndSettle(() => Onyx.set(KEYS.SESSION, 5));
            expect(lastCommit(recorder).value).toBe(5);
        });

        it('does not commit when the same content is written again, and keeps the previous result reference', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'x@y.z', accountID: 1}));
            const [recorder] = renderProbes([KEYS.SESSION]);
            await settle();
            const baseline = recorder.commits.length;
            const previousResult = lastCommit(recorder).result;

            await actAndSettle(() => Onyx.set(KEYS.SESSION, {email: 'x@y.z', accountID: 1}));
            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {accountID: 1}));

            expect(commitsSince(recorder, baseline)).toBe(0);
            expect(lastCommit(recorder).result).toBe(previousResult);
        });

        it('shows a real change that follows a content-equal write', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'x@y.z'}));
            const recorders = renderProbes([KEYS.SESSION, KEYS.SESSION, KEYS.SESSION]);
            await settle();

            await actAndSettle(() => Onyx.set(KEYS.SESSION, {email: 'x@y.z'}));
            await actAndSettle(() => Onyx.set(KEYS.SESSION, {email: 'changed@y.z'}));

            for (const recorder of recorders) {
                expect(lastCommit(recorder).value).toEqual({email: 'changed@y.z'});
            }
        });

        it('shows every value when going back and forth between two objects', async () => {
            const first = {step: 'first'};
            const second = {step: 'second'};
            await act(async () => Onyx.set(KEYS.SESSION, first));
            const recorders = renderProbes([KEYS.SESSION, KEYS.SESSION]);
            await settle();

            for (const next of [second, first, second, first]) {
                await actAndSettle(() => Onyx.set(KEYS.SESSION, next));
                for (const recorder of recorders) {
                    expect(lastCommit(recorder).value).toEqual(next);
                }
            }
        });

        it('lands on undefined with loaded status when the key is removed with set(null), merge(null) or clear', async () => {
            const [recorder] = renderProbes([KEYS.SESSION]);
            await settle();

            await actAndSettle(() => Onyx.set(KEYS.SESSION, 'one'));
            expect(lastCommit(recorder)).toMatchObject({value: 'one', status: 'loaded'});
            await actAndSettle(() => Onyx.set(KEYS.SESSION, null));
            expect(lastCommit(recorder)).toMatchObject({value: undefined, status: 'loaded'});

            await actAndSettle(() => Onyx.set(KEYS.SESSION, 'two'));
            expect(lastCommit(recorder)).toMatchObject({value: 'two', status: 'loaded'});
            await actAndSettle(() => Onyx.merge(KEYS.SESSION, null));
            expect(lastCommit(recorder)).toMatchObject({value: undefined, status: 'loaded'});

            await actAndSettle(() => Onyx.set(KEYS.SESSION, 'three'));
            expect(lastCommit(recorder)).toMatchObject({value: 'three', status: 'loaded'});
            await actAndSettle(() => Onyx.clear());
            expect(lastCommit(recorder)).toMatchObject({value: undefined, status: 'loaded'});

            await actAndSettle(() => Onyx.set(KEYS.SESSION, 'after clear'));
            expect(lastCommit(recorder)).toMatchObject({value: 'after clear', status: 'loaded'});
            expect(recorder.commits.every((frame, index) => index === 0 || frame.status === 'loaded')).toBe(true);
        });

        it('delivers the value of the last write when writes interleave in one tick, without going back in time', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, 'v0'));
            const recorders = renderProbes([KEYS.SESSION, KEYS.SESSION]);
            await settle();
            const baseline = recorders[0].commits.length;

            await actAndSettle(() => {
                Onyx.set(KEYS.SESSION, 'v1');
                Onyx.set(KEYS.SESSION, 'v2');
                Onyx.merge(KEYS.SESSION, 'v3');
            });

            for (const recorder of recorders) {
                expectOrderedSubsequence(commitValues(recorder), ['v0', 'v1', 'v2', 'v3']);
                expect(lastCommit(recorder).value).toBe('v3');
            }
            expect(commitsSince(recorders[0], baseline)).toBeLessThanOrEqual(1);
        });

        it('flushes a burst of merges in one tick to the final merged object with ordered frames', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {}));
            const recorders = renderProbes([KEYS.SESSION, KEYS.SESSION, KEYS.SESSION]);
            await settle();
            const baseline = recorders[0].commits.length;
            const expectedStates: unknown[] = [{}];
            const accumulated: Record<string, boolean> = {};

            await actAndSettle(() => {
                for (let index = 0; index < 20; index++) {
                    accumulated[`user${index}`] = index % 2 === 0;
                    expectedStates.push({...accumulated});
                    Onyx.merge(KEYS.SESSION, {[`user${index}`]: index % 2 === 0});
                }
            });

            for (const recorder of recorders) {
                expectOrderedSubsequence(commitValues(recorder), expectedStates);
                expect(lastCommit(recorder).value).toEqual(accumulated);
            }
            expect(commitsSince(recorders[0], baseline)).toBeGreaterThanOrEqual(1);
            expect(commitsSince(recorders[0], baseline)).toBeLessThanOrEqual(1);
        });

        it('applies a mixed Onyx.update batch to every affected hook', async () => {
            const recorders = renderProbes([KEYS.SESSION, KEYS.OTHER, `${KEYS.REPORT}1`, KEYS.REPORT]);
            await settle();

            await actAndSettle(() =>
                Onyx.update([
                    {onyxMethod: Onyx.METHOD.SET, key: KEYS.SESSION, value: 'set'},
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.OTHER, value: {merged: true}},
                    {onyxMethod: Onyx.METHOD.MERGE_COLLECTION, key: KEYS.REPORT, value: {[`${KEYS.REPORT}1`]: {reportID: '1'}} as GenericCollection},
                ]),
            );

            expect(lastCommit(recorders[0]).value).toBe('set');
            expect(lastCommit(recorders[1]).value).toEqual({merged: true});
            expect(lastCommit(recorders[2]).value).toEqual({reportID: '1'});
            expect(lastCommit(recorders[3]).value).toEqual({[`${KEYS.REPORT}1`]: {reportID: '1'}});
        });
        it('applies an Onyx.update batch on plain keys whose names start like a collection key', async () => {
            const [alias, owner, policies] = renderProbes([KEYS.POLICY_ALIAS, KEYS.POLICY_ALIAS_OWNER, KEYS.POLICY]);
            await settle();
            const policiesBaseline = policies.commits.length;

            await actAndSettle(() =>
                Onyx.update([
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.POLICY_ALIAS, value: {alias: 'a'}},
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.POLICY_ALIAS_OWNER, value: {owner: 'o'}},
                ]),
            );

            expect(lastCommit(alias).value).toEqual({alias: 'a'});
            expect(lastCommit(owner).value).toEqual({owner: 'o'});
            expect(commitsSince(policies, policiesBaseline)).toBeLessThanOrEqual(1);
            expect(lastCommit(policies).value ?? {}).toEqual({});
        });
    });

    describe('updates to other keys', () => {
        it('does not re-render hooks on an unrelated key, member or collection', async () => {
            await act(async () => {
                await Onyx.set(KEYS.SESSION, 'session');
                await Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'});
                await Onyx.set(`${KEYS.POLICY}1`, {name: 'policy'});
            });
            const recorders = renderProbes([KEYS.SESSION, `${KEYS.REPORT}1`, KEYS.REPORT, KEYS.POLICY, `${KEYS.POLICY}1`]);
            await settle();
            const baselines = recorders.map((recorder) => recorder.commits.length);
            const results = recorders.map((recorder) => lastCommit(recorder).result);

            await actAndSettle(() => Onyx.set(KEYS.OTHER, 'unrelated'));
            await actAndSettle(() => Onyx.merge(KEYS.DETAILS, {1: {login: 'a'}}));
            await actAndSettle(() => Onyx.set(`${KEYS.REPORT_DRAFT}1`, {draft: true}));

            for (const [index, recorder] of recorders.entries()) {
                expect(commitsSince(recorder, baselines[index])).toBe(0);
                expect(lastCommit(recorder).result).toBe(results[index]);
            }
        });

        it('re-renders only the hook on the member that changed when K hooks watch K members', async () => {
            const collection: GenericCollection = {};
            for (let index = 0; index < 20; index++) {
                collection[`${KEYS.REPORT}${index}`] = {reportID: String(index), lastMessageText: 'hello'};
            }
            await act(async () => Onyx.mergeCollection(KEYS.REPORT, collection));
            const recorders = renderProbes(Object.keys(collection));
            await settle();
            const baselines = recorders.map((recorder) => recorder.commits.length);

            await actAndSettle(() => Onyx.merge(`${KEYS.REPORT}3`, {lastMessageText: 'changed'}));

            for (const [index, recorder] of recorders.entries()) {
                if (index === 3) {
                    expect(commitsSince(recorder, baselines[index])).toBeGreaterThanOrEqual(1);
                    expect(commitsSince(recorder, baselines[index])).toBeLessThanOrEqual(1);
                    expect(lastCommit(recorder).value).toEqual({reportID: '3', lastMessageText: 'changed'});
                    continue;
                }
                expect(commitsSince(recorder, baselines[index])).toBe(0);
            }
        });

        it('does not re-render a member hook when a mergeCollection touches only its siblings', async () => {
            await act(async () =>
                Onyx.mergeCollection(KEYS.REPORT, {
                    [`${KEYS.REPORT}1`]: {reportID: '1'},
                    [`${KEYS.REPORT}2`]: {reportID: '2'},
                } as GenericCollection),
            );
            const [first, second] = renderProbes([`${KEYS.REPORT}1`, `${KEYS.REPORT}2`]);
            await settle();
            const firstBaseline = first.commits.length;
            const secondBaseline = second.commits.length;

            await actAndSettle(() => Onyx.mergeCollection(KEYS.REPORT, {[`${KEYS.REPORT}2`]: {name: 'two'}} as GenericCollection));

            expect(commitsSince(first, firstBaseline)).toBe(0);
            expect(commitsSince(second, secondBaseline)).toBeLessThanOrEqual(1);
            expect(lastCommit(second).value).toEqual({reportID: '2', name: 'two'});
        });

        it('does not re-render the shorter-prefix collection root when a member of the longer-prefix collection changes, and vice versa', async () => {
            await act(async () => {
                await Onyx.set(`${KEYS.REPORT}1`, {reportID: '1'});
                await Onyx.set(`${KEYS.REPORT_DRAFT}1`, {draft: 1});
            });
            const [reports, drafts] = renderProbes([KEYS.REPORT, KEYS.REPORT_DRAFT]);
            await settle();
            const reportsBaseline = reports.commits.length;
            const draftsBaseline = drafts.commits.length;

            await actAndSettle(() => Onyx.merge(`${KEYS.REPORT_DRAFT}1`, {draft: 2}));

            expect(commitsSince(reports, reportsBaseline)).toBe(0);
            expect(commitsSince(drafts, draftsBaseline)).toBeGreaterThanOrEqual(1);
            expect(lastCommit(drafts).value).toEqual({[`${KEYS.REPORT_DRAFT}1`]: {draft: 2}});

            const draftsAfter = drafts.commits.length;
            await actAndSettle(() => Onyx.merge(`${KEYS.REPORT}1`, {name: 'one'}));

            expect(commitsSince(drafts, draftsAfter)).toBe(0);
            expect(lastCommit(reports).value).toEqual({[`${KEYS.REPORT}1`]: {reportID: '1', name: 'one'}});
            expect(lastCommit(reports).value).not.toHaveProperty(`${KEYS.REPORT_DRAFT}1`);
        });
    });

    describe('collection root', () => {
        it('re-renders every root hook once per member change and keeps untouched member references', async () => {
            await act(async () =>
                Onyx.mergeCollection(KEYS.POLICY, {
                    [`${KEYS.POLICY}1`]: {name: 'one'},
                    [`${KEYS.POLICY}2`]: {name: 'two'},
                } as GenericCollection),
            );
            const recorders = renderProbes([KEYS.POLICY, KEYS.POLICY, KEYS.POLICY]);
            await settle();
            const baselines = recorders.map((recorder) => recorder.commits.length);
            const before = lastCommit(recorders[0]).value;

            await actAndSettle(() => Onyx.merge(`${KEYS.POLICY}1`, {name: 'uno'}));

            const after = lastCommit(recorders[0]).value;
            expect(after).toEqual({[`${KEYS.POLICY}1`]: {name: 'uno'}, [`${KEYS.POLICY}2`]: {name: 'two'}});
            expect(after).not.toBe(before);
            expect(isRecord(after) && isRecord(before) && after[`${KEYS.POLICY}2`] === before[`${KEYS.POLICY}2`]).toBe(true);
            expect(Object.isFrozen(after)).toBe(true);
            for (const [index, recorder] of recorders.entries()) {
                expect(commitsSince(recorder, baselines[index])).toBeGreaterThanOrEqual(1);
                expect(commitsSince(recorder, baselines[index])).toBeLessThanOrEqual(1);
                expect(lastCommit(recorder).value).toBe(after);
            }
        });

        it('adds and removes members', async () => {
            await act(async () => Onyx.set(`${KEYS.POLICY}1`, {name: 'one'}));
            const [recorder] = renderProbes([KEYS.POLICY]);
            await settle();

            await actAndSettle(() => Onyx.set(`${KEYS.POLICY}2`, {name: 'two'}));
            expect(lastCommit(recorder).value).toEqual({[`${KEYS.POLICY}1`]: {name: 'one'}, [`${KEYS.POLICY}2`]: {name: 'two'}});

            await actAndSettle(() => Onyx.set(`${KEYS.POLICY}1`, null));
            expect(lastCommit(recorder).value).toEqual({[`${KEYS.POLICY}2`]: {name: 'two'}});

            await actAndSettle(() => Onyx.merge(`${KEYS.POLICY}2`, null));
            expect(lastCommit(recorder)).toMatchObject({value: {}, status: 'loaded'});
        });

        it('replaces the members with setCollection', async () => {
            await act(async () =>
                Onyx.mergeCollection(KEYS.POLICY, {
                    [`${KEYS.POLICY}1`]: {name: 'one'},
                    [`${KEYS.POLICY}2`]: {name: 'two'},
                } as GenericCollection),
            );
            const [root, removedMember] = renderProbes([KEYS.POLICY, `${KEYS.POLICY}1`]);
            await settle();

            await actAndSettle(() => Onyx.setCollection(KEYS.POLICY, {[`${KEYS.POLICY}3`]: {name: 'three'}} as GenericCollection));

            expect(lastCommit(root).value).toEqual({[`${KEYS.POLICY}3`]: {name: 'three'}});
            expect(lastCommit(removedMember)).toMatchObject({value: undefined, status: 'loaded'});
        });

        it('does not re-render a root hook when a member is written with the same content', async () => {
            await act(async () => Onyx.set(`${KEYS.POLICY}1`, {name: 'one'}));
            const [recorder] = renderProbes([KEYS.POLICY]);
            await settle();
            const baseline = recorder.commits.length;
            const result = lastCommit(recorder).result;

            await actAndSettle(() => Onyx.merge(`${KEYS.POLICY}1`, {name: 'one'}));

            expect(commitsSince(recorder, baseline)).toBe(0);
            expect(lastCommit(recorder).result).toBe(result);
        });
    });

    describe('selectors', () => {
        it('does not re-render when a field outside the selected data changes, for many hooks sharing one selector', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {email: 'x@y.z', authToken: 'a'}));
            const selector = (data: unknown) => ({email: isRecord(data) ? data.email : undefined});
            const recorders = renderProbes(
                Array.from({length: 10}, () => KEYS.SESSION),
                {selector},
            );
            await settle();
            const baselines = recorders.map((recorder) => recorder.commits.length);
            const results = recorders.map((recorder) => lastCommit(recorder).result);

            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {authToken: 'b'}));

            for (const [index, recorder] of recorders.entries()) {
                expect(commitsSince(recorder, baselines[index])).toBe(0);
                expect(lastCommit(recorder).result).toBe(results[index]);
                expect(lastCommit(recorder).value).toEqual({email: 'x@y.z'});
            }

            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {email: 'new@y.z'}));

            for (const [index, recorder] of recorders.entries()) {
                expect(commitsSince(recorder, baselines[index])).toBeGreaterThanOrEqual(1);
                expect(commitsSince(recorder, baselines[index])).toBeLessThanOrEqual(1);
                expect(lastCommit(recorder).value).toEqual({email: 'new@y.z'});
            }
        });

        it('re-renders only the hook whose own selector output changed when K hooks select K entries of one key', async () => {
            const details: Record<string, {login: string}> = {};
            for (let index = 0; index < 10; index++) {
                details[index] = {login: `user${index}@y.z`};
            }
            await act(async () => Onyx.set(KEYS.DETAILS, details));
            const recorders = Array.from({length: 10}, () => createRecorder());
            const selectors = Array.from(
                {length: 10},
                (_, index): UseOnyxSelector<OnyxKey, unknown> =>
                    (data) => {
                        const entry = isRecord(data) ? data[index] : undefined;
                        return isRecord(entry) ? entry.login : undefined;
                    },
            );
            render(
                <>
                    {recorders.map((recorder, index) => (
                        <OnyxProbe
                            // eslint-disable-next-line react/no-array-index-key
                            key={index}
                            onyxKey={KEYS.DETAILS}
                            recorder={recorder}
                            options={{selector: selectors[index]}}
                        />
                    ))}
                </>,
            );
            await settle();
            const baselines = recorders.map((recorder) => recorder.commits.length);

            await actAndSettle(() => Onyx.merge(KEYS.DETAILS, {4: {login: 'changed@y.z'}}));

            for (const [index, recorder] of recorders.entries()) {
                expect(lastCommit(recorder).value).toBe(index === 4 ? 'changed@y.z' : `user${index}@y.z`);
                if (index === 4) {
                    expect(commitsSince(recorder, baselines[index])).toBeGreaterThanOrEqual(1);
                    expect(commitsSince(recorder, baselines[index])).toBeLessThanOrEqual(1);
                } else {
                    expect(commitsSince(recorder, baselines[index])).toBe(0);
                }
            }
        });

        it('keeps the selected object reference when the selector returns a new but deep-equal object', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {profile: {name: 'a'}, other: 1}));
            const [recorder] = renderProbes([KEYS.SESSION], {selector: (data) => ({name: isRecord(data) && isRecord(data.profile) ? data.profile.name : undefined, tags: ['t']})});
            await settle();
            const selected = lastCommit(recorder).value;
            const baseline = recorder.commits.length;

            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {other: 2}));
            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {profile: {name: 'a'}}));

            expect(commitsSince(recorder, baseline)).toBe(0);
            expect(lastCommit(recorder).value).toBe(selected);
        });

        it('re-renders when a collection selector output changes and not otherwise', async () => {
            await act(async () =>
                Onyx.mergeCollection(KEYS.REPORT, {
                    [`${KEYS.REPORT}1`]: {reportID: '1', unread: false},
                    [`${KEYS.REPORT}2`]: {reportID: '2', unread: false},
                } as GenericCollection),
            );
            const selector: UseOnyxSelector<OnyxKey, unknown> = (data) =>
                isRecord(data)
                    ? Object.values(data)
                          .filter((report) => isRecord(report) && report.unread === true)
                          .map((report) => (isRecord(report) ? report.reportID : undefined))
                    : [];
            const [recorder] = renderProbes([KEYS.REPORT], {selector});
            await settle();
            const baseline = recorder.commits.length;

            await actAndSettle(() => Onyx.merge(`${KEYS.REPORT}1`, {name: 'ignored'}));
            expect(commitsSince(recorder, baseline)).toBe(0);

            await actAndSettle(() => Onyx.merge(`${KEYS.REPORT}2`, {unread: true}));
            expect(lastCommit(recorder).value).toEqual(['2']);
            expect(commitsSince(recorder, baseline)).toBeLessThanOrEqual(1);
        });
    });

    describe('consistency between hooks (no torn frames)', () => {
        it('shows the same value for two hooks on the same key in every committed frame', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {count: 0}));
            const frames: PairFrame[] = [];
            render(
                <PairProbe
                    firstKey={KEYS.SESSION}
                    secondKey={KEYS.SESSION}
                    frames={frames}
                />,
            );
            await settle();

            for (let count = 1; count <= 5; count++) {
                await actAndSettle(() => Onyx.merge(KEYS.SESSION, {count}));
            }

            expect(frames.length).toBeGreaterThan(1);
            for (const frame of frames) {
                expect(frame.first).toBe(frame.second);
            }
            expect(frames.at(-1)?.first).toEqual({count: 5});
        });

        it('keeps a selector hook consistent with a whole-value hook on the same key in every committed frame', async () => {
            await act(async () => Onyx.set(KEYS.SESSION, {count: 0}));
            const frames: PairFrame[] = [];
            render(
                <PairProbe
                    firstKey={KEYS.SESSION}
                    secondKey={KEYS.SESSION}
                    secondSelector={selectField('count')}
                    frames={frames}
                />,
            );
            await settle();

            await actAndSettle(() => {
                Onyx.merge(KEYS.SESSION, {count: 1});
                Onyx.merge(KEYS.SESSION, {count: 2});
            });
            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {count: 3}));

            for (const frame of frames) {
                expect(isRecord(frame.first) ? frame.first.count : undefined).toBe(frame.second);
            }
            expect(frames.at(-1)?.second).toBe(3);
        });

        it('keeps a collection root hook consistent with a member hook in every committed frame', async () => {
            await act(async () => Onyx.set(`${KEYS.REPORT}1`, {version: 0}));
            const frames: PairFrame[] = [];
            render(
                <PairProbe
                    firstKey={KEYS.REPORT}
                    secondKey={`${KEYS.REPORT}1`}
                    frames={frames}
                />,
            );
            await settle();

            await actAndSettle(() => Onyx.merge(`${KEYS.REPORT}1`, {version: 1}));
            await actAndSettle(() => Onyx.mergeCollection(KEYS.REPORT, {[`${KEYS.REPORT}1`]: {version: 2}} as GenericCollection));
            await actAndSettle(() => Onyx.set(`${KEYS.REPORT}1`, {version: 3}));
            await actAndSettle(() => Onyx.set(`${KEYS.REPORT}1`, null));

            for (const frame of frames) {
                expect(isRecord(frame.first) ? frame.first[`${KEYS.REPORT}1`] : undefined).toBe(frame.second);
            }
            expect(frames.at(-1)?.second).toBeUndefined();
        });
    });

    describe('writes during notifications', () => {
        it('delivers a write made synchronously inside another subscriber callback', async () => {
            const connection = Onyx.connectWithoutView({
                key: KEYS.SESSION,
                callback: (value) => {
                    if (!isRecord(value)) {
                        return;
                    }
                    Onyx.set(KEYS.DERIVED, {fromSession: value.counter});
                },
            });
            const [session, derived] = renderProbes([KEYS.SESSION, KEYS.DERIVED]);
            await settle();

            await actAndSettle(() => Onyx.set(KEYS.SESSION, {counter: 1}));
            await actAndSettle(() => Onyx.merge(KEYS.SESSION, {counter: 2}));

            expect(lastCommit(session).value).toEqual({counter: 2});
            expect(lastCommit(derived).value).toEqual({fromSession: 2});
            expectOrderedSubsequence(commitValues(derived), [undefined, {fromSession: 1}, {fromSession: 2}]);
            Onyx.disconnect(connection);
        });

        it('settles when a component writes a derived key from an effect, without render loops', async () => {
            const writer = createRecorder();
            const derived = createRecorder();
            render(
                <>
                    <DerivingWriter recorder={writer} />
                    <OnyxProbe
                        onyxKey={KEYS.DERIVED}
                        recorder={derived}
                    />
                </>,
            );
            await settle();

            for (let counter = 1; counter <= 3; counter++) {
                await actAndSettle(() => Onyx.merge(KEYS.SESSION, {counter}));
            }

            expect(lastCommit(derived).value).toEqual({fromSession: 3});
            expect(writer.renders.length).toBeLessThanOrEqual(5);
        });
    });
    describe('current behaviour (suspected bug)', () => {
        it('leaves hooks on members of a longer-prefix collection stale when Onyx.update batches two of them', async () => {
            const [draftMember, draftRoot, reportRoot] = renderProbes([`${KEYS.REPORT_DRAFT}1`, KEYS.REPORT_DRAFT, KEYS.REPORT]);
            await settle();

            await actAndSettle(() =>
                Onyx.update([
                    {onyxMethod: Onyx.METHOD.MERGE, key: `${KEYS.REPORT_DRAFT}1`, value: {draft: 1}},
                    {onyxMethod: Onyx.METHOD.MERGE, key: `${KEYS.REPORT_DRAFT}2`, value: {draft: 2}},
                ]),
            );

            expect(lastCommit(draftMember).value).toBeUndefined();
            expect(lastCommit(draftRoot).value).toBeUndefined();
            expect(lastCommit(reportRoot).value).not.toHaveProperty(`${KEYS.REPORT_DRAFT}1`);

            const remounted = createRecorder();
            render(
                <OnyxProbe
                    onyxKey={`${KEYS.REPORT_DRAFT}1`}
                    recorder={remounted}
                />,
            );
            await settle();
            expect(lastCommit(remounted).value).toEqual({draft: 1});
        });
    });
});
