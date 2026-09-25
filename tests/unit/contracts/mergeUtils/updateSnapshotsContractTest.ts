/**
 * Contracts of `OnyxUtils.updateSnapshots`, which `Onyx.update` runs to keep the cached search snapshot rows
 * (`snapshot_<hash>` with a `data` map of Onyx key to value) in sync with the batch it applies. A row is only
 * updated for keys it already holds, and only with fields it already holds plus the configured snapshot merge keys.
 */
import type {OnyxKey, OnyxUpdate} from '../../../../lib/types';

import Onyx from '../../../../lib';
import OnyxUtils from '../../../../lib/OnyxUtils';
import {deepFreeze} from '../merge/helpers/model';
import {KEYS, initOnyx, resetOnyx} from './helpers';

type Update = OnyxUpdate<OnyxKey>;
type MergeCall = {key: string; changes: unknown};

const SNAPSHOT_1 = `${KEYS.COLLECTION.SNAPSHOT}1`;
const SNAPSHOT_2 = `${KEYS.COLLECTION.SNAPSHOT}2`;
const MEMBER_1 = `${KEYS.COLLECTION.A}1`;
const META_MEMBER = `${KEYS.COLLECTION.SNAPSHOT_META}1`;

let loggedMessages: string[] = [];

function createMergeRecorder(): {calls: MergeCall[]; mergeFn: typeof Onyx.merge} {
    const calls: MergeCall[] = [];
    const mergeFn: typeof Onyx.merge = (key, changes) => {
        calls.push({key, changes});
        return Promise.resolve();
    };
    return {calls, mergeFn};
}

/** Runs `updateSnapshots` and every thunk it returns, and gives back the merges it asked for by row key. */
async function snapshotMerges(data: Update[]): Promise<Record<string, unknown>> {
    const {calls, mergeFn} = createMergeRecorder();
    const thunks = OnyxUtils.updateSnapshots(data, mergeFn);
    await Promise.all(thunks.map((thunk) => thunk()));
    expect(calls).toHaveLength(thunks.length);
    return Object.fromEntries(calls.map(({key, changes}) => [key, changes]));
}

function keylessMultiSet(value: unknown): Update {
    // @ts-expect-error update() accepts multiset entries without a key, which the update type does not model
    return {onyxMethod: Onyx.METHOD.MULTI_SET, key: undefined, value};
}

function snapshotHoldsInvalidKeyMessages(): string[] {
    return loggedMessages.filter((message) => message.includes('Skipping snapshot update'));
}

describe('OnyxUtils.updateSnapshots', () => {
    beforeAll(() => {
        initOnyx();
    });

    beforeEach(async () => {
        await resetOnyx();
        loggedMessages = [];
        Onyx.registerLogger(({message}) => {
            loggedMessages.push(message);
        });
    });

    describe('rows and thunks', () => {
        it('returns no thunks when there is no snapshot row', () => {
            const {calls, mergeFn} = createMergeRecorder();

            expect(OnyxUtils.updateSnapshots([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 1}}], mergeFn)).toStrictEqual([]);
            expect(calls).toStrictEqual([]);
        });

        it('returns lazy thunks that merge the synced data into the row only when called', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {a: 1}}});
            const {calls, mergeFn} = createMergeRecorder();

            const thunks = OnyxUtils.updateSnapshots([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 2}}], mergeFn);

            expect(thunks).toHaveLength(1);
            expect(calls).toStrictEqual([]);

            await thunks[0]();

            expect(calls).toStrictEqual([{key: SNAPSHOT_1, changes: {data: {[KEYS.TEST]: {a: 2}}}}]);
        });

        it('returns one thunk per row that holds a changed key and none for the other rows', async () => {
            await Onyx.multiSet({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 1}}},
                [SNAPSHOT_2]: {data: {[KEYS.OTHER]: {a: 1}}},
            });

            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 2}}])).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 2}}},
            });
            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: MEMBER_1, value: {a: 2}}])).toStrictEqual({});
        });

        it('gives every row its own data built from the entries that row holds', async () => {
            await Onyx.multiSet({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 1}}},
                [SNAPSHOT_2]: {data: {[KEYS.TEST]: {a: 1, b: 1}, [KEYS.OTHER]: {c: 1}}},
            });

            const merges = await snapshotMerges([
                {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 2, b: 2}},
                {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.OTHER, value: {c: 2}},
            ]);

            expect(merges).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 2}}},
                [SNAPSHOT_2]: {data: {[KEYS.TEST]: {a: 2, b: 2}, [KEYS.OTHER]: {c: 2}}},
            });
        });

        it('skips rows that are missing, have no data or hold a falsy entry for the key', async () => {
            await Onyx.multiSet({
                [`${KEYS.COLLECTION.SNAPSHOT}empty`]: {},
                [`${KEYS.COLLECTION.SNAPSHOT}text`]: 'text',
                [`${KEYS.COLLECTION.SNAPSHOT}list`]: [1],
                [`${KEYS.COLLECTION.SNAPSHOT}nulled`]: {data: null},
                [`${KEYS.COLLECTION.SNAPSHOT}zero`]: {data: {[KEYS.TEST]: 0}},
                [`${KEYS.COLLECTION.SNAPSHOT}blank`]: {data: {[KEYS.TEST]: ''}},
                [`${KEYS.COLLECTION.SNAPSHOT}false`]: {data: {[KEYS.TEST]: false}},
                [`${KEYS.COLLECTION.SNAPSHOT}other`]: {data: {[KEYS.OTHER]: {a: 1}}},
            });

            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 2, pendingAction: 'add'}}])).toStrictEqual({});
        });
    });

    describe('fields', () => {
        it('copies only the fields the entry already holds plus the configured merge keys present in the value', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {a: 1, b: 1}}});

            expect(
                await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 2, c: 2, pendingAction: 'update', pendingFields: {a: 'update'}, errors: {x: 'y'}}}]),
            ).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 2, pendingAction: 'update', pendingFields: {a: 'update'}}}},
            });
        });

        it('copies nested values of copied fields whole instead of picking inside them', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {nested: {a: 1}}}});

            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {nested: {a: 2, b: 2}}}])).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {nested: {a: 2, b: 2}}}},
            });
        });

        it('uses the snapshot merge keys set at call time', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {a: 1}}});
            OnyxUtils.setSnapshotMergeKeys(new Set(['custom']));

            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {custom: 1, pendingAction: 'add'}}])).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {custom: 1}}},
            });
        });

        it('accumulates the fields of several entries for the same key, later entries winning', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {a: 1, b: 1, c: 1}}});

            expect(
                await snapshotMerges([
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 2, b: 2}},
                    {onyxMethod: Onyx.METHOD.SET, key: KEYS.TEST, value: {b: 3}},
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {pendingAction: 'add'}},
                ]),
            ).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 2, b: 3, pendingAction: 'add'}}},
            });
        });

        it('sends null for an object entry set to null', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {a: 1}}});

            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: null}])).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: null}},
            });
        });

        it('sends an array value as is for an array entry', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[MEMBER_1]: [1, 2]}});
            const list = [3];

            const merges = await snapshotMerges([{onyxMethod: Onyx.METHOD.SET, key: MEMBER_1, value: list}]);

            expect(merges).toStrictEqual({[SNAPSHOT_1]: {data: {[MEMBER_1]: [3]}}});
        });

        it('does not mutate the updates it reads', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {a: 1, nested: {b: 1}}, [KEYS.OTHER]: {c: 1}}});
            const data: Update[] = deepFreeze([
                {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 2, nested: {b: 2}}},
                {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 3, pendingFields: {a: 'update'}}},
                keylessMultiSet({[KEYS.OTHER]: {c: 2}}),
            ]);

            expect(await snapshotMerges(data)).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 3, nested: {b: 2}, pendingFields: {a: 'update'}}, [KEYS.OTHER]: {c: 2}}},
            });
        });
    });

    describe('entries', () => {
        it('skips writes to snapshot keys themselves', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[SNAPSHOT_2]: {a: 1}}});

            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: SNAPSHOT_2, value: {a: 2}}])).toStrictEqual({});
        });

        it('expands a multiset without a key into one entry per key of its value', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {a: 1}, [MEMBER_1]: {b: 1}}});

            expect(await snapshotMerges([keylessMultiSet({[KEYS.TEST]: {a: 2}, [MEMBER_1]: {b: 2}, [KEYS.OTHER]: {c: 2}})])).toStrictEqual({
                [SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 2}, [MEMBER_1]: {b: 2}}},
            });
        });

        it('logs entries with an invalid key and skips them, except keyless clear and multiset entries', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.TEST]: {a: 1}}});

            expect(
                await snapshotMerges([
                    // @ts-expect-error update() accepts clear entries without a key, which the update type does not model
                    {onyxMethod: Onyx.METHOD.CLEAR, key: undefined},
                    keylessMultiSet('text'),
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {a: 2}},
                ]),
            ).toStrictEqual({[SNAPSHOT_1]: {data: {[KEYS.TEST]: {a: 2}}}});
            expect(snapshotHoldsInvalidKeyMessages()).toStrictEqual([]);

            // @ts-expect-error a numeric key is invalid input
            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.SET, key: 7, value: {a: 3}}])).toStrictEqual({});
            expect(snapshotHoldsInvalidKeyMessages().length).toBeGreaterThan(0);
            expect(snapshotHoldsInvalidKeyMessages().every((message) => message.includes('Invalid number key'))).toBe(true);
        });
    });

    describe('through Onyx.update', () => {
        it('adds the pending fields of an optimistic update to the snapshot entry', async () => {
            await Onyx.multiSet({[MEMBER_1]: {name: 'old', total: 1}, [SNAPSHOT_1]: {data: {[MEMBER_1]: {name: 'old'}}}});

            await Onyx.update([{onyxMethod: Onyx.METHOD.MERGE, key: MEMBER_1, value: {name: 'new', total: 2, pendingFields: {name: 'update'}}}]);

            expect(await OnyxUtils.get(MEMBER_1)).toStrictEqual({name: 'new', total: 2, pendingFields: {name: 'update'}});
            expect(await OnyxUtils.get(SNAPSHOT_1)).toStrictEqual({data: {[MEMBER_1]: {name: 'new', pendingFields: {name: 'update'}}}});
        });

        it('removes an object entry from the snapshot when the key is set to null', async () => {
            await Onyx.multiSet({[MEMBER_1]: {name: 'old'}, [KEYS.TEST]: {a: 1}, [SNAPSHOT_1]: {data: {[MEMBER_1]: {name: 'old'}, [KEYS.TEST]: {a: 1}}}});

            await Onyx.update([{onyxMethod: Onyx.METHOD.SET, key: MEMBER_1, value: null}]);

            expect(await OnyxUtils.get(SNAPSHOT_1)).toStrictEqual({data: {[KEYS.TEST]: {a: 1}}});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('merges nested fields of several entries for the same key shallowly, so the snapshot keeps an overwritten nested field', async () => {
            await Onyx.multiSet({[KEYS.TEST]: {n: {x: 1, y: 1}}, [SNAPSHOT_1]: {data: {[KEYS.TEST]: {n: {x: 1, y: 1}}}}});

            await Onyx.update([
                {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {n: {x: 2}}},
                {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.TEST, value: {n: {y: 3}}},
            ]);

            expect(await OnyxUtils.get(KEYS.TEST)).toStrictEqual({n: {x: 2, y: 3}});
            expect(await OnyxUtils.get(SNAPSHOT_1)).toStrictEqual({data: {[KEYS.TEST]: {n: {x: 1, y: 3}}}});
        });

        it('replaces a primitive snapshot entry with an empty object', async () => {
            await Onyx.multiSet({[KEYS.TEST]: 'old', [SNAPSHOT_1]: {data: {[KEYS.TEST]: 'old'}}});

            await Onyx.update([{onyxMethod: Onyx.METHOD.SET, key: KEYS.TEST, value: 'new'}]);

            expect(await OnyxUtils.get(KEYS.TEST)).toBe('new');
            expect(await OnyxUtils.get(SNAPSHOT_1)).toStrictEqual({data: {[KEYS.TEST]: {}}});
        });

        it('leaves an object snapshot entry stale when the key is set to a primitive', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.OTHER]: {a: 1}}});

            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.SET, key: KEYS.OTHER, value: 5}])).toStrictEqual({[SNAPSHOT_1]: {data: {[KEYS.OTHER]: {}}}});
        });

        it('sends an empty array instead of null for an array entry set to null', async () => {
            await Onyx.multiSet({[MEMBER_1]: [1, 2], [SNAPSHOT_1]: {data: {[MEMBER_1]: [1, 2]}}});

            await Onyx.update([{onyxMethod: Onyx.METHOD.SET, key: MEMBER_1, value: null}]);

            expect((await OnyxUtils.get(MEMBER_1)) ?? undefined).toBeUndefined();
            expect(await OnyxUtils.get(SNAPSHOT_1)).toStrictEqual({data: {[MEMBER_1]: []}});
        });

        it('writes the fields of a later object value into the array of an earlier entry for the same key, mutating the caller array', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[KEYS.OTHER]: {a: 1}}});
            const list: unknown[] = [9];

            const merges = await snapshotMerges([
                {onyxMethod: Onyx.METHOD.SET, key: KEYS.OTHER, value: list},
                {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.OTHER, value: {a: 2}},
            ]);

            expect(Object.keys(list)).toStrictEqual(['0', 'a']);
            expect(merges).toStrictEqual({[SNAPSHOT_1]: {data: {[KEYS.OTHER]: list}}});
        });

        it('treats members of a collection whose prefix starts with the snapshot prefix as snapshot keys and skips them', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[META_MEMBER]: {a: 1}}});

            expect(await snapshotMerges([{onyxMethod: Onyx.METHOD.MERGE, key: META_MEMBER, value: {a: 2}}])).toStrictEqual({});
        });

        it('leaves snapshots stale for mergecollection and setcollection entries and for a multiset that carries a key', async () => {
            await Onyx.set(SNAPSHOT_1, {data: {[MEMBER_1]: {a: 1}, [KEYS.TEST]: {b: 1}}});

            expect(
                await snapshotMerges([
                    {onyxMethod: Onyx.METHOD.MERGE_COLLECTION, key: KEYS.COLLECTION.A, value: {[MEMBER_1]: {a: 2}}},
                    {onyxMethod: Onyx.METHOD.SET_COLLECTION, key: KEYS.COLLECTION.A, value: {[MEMBER_1]: {a: 3}}},
                    {onyxMethod: Onyx.METHOD.MULTI_SET, key: '', value: {[KEYS.TEST]: {b: 2}}},
                ]),
            ).toStrictEqual({});
        });
    });
});
