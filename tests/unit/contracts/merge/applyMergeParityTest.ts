/**
 * Direct contract tests for `OnyxMerge.applyMerge`, web (`index.ts`) and native (`index.native.ts`) side by
 * side: the returned value, the cache, the notification, which storage call is made and with what payload,
 * including the exact `mergeItem` batched change and `replaceNullPatches` the native variant hands to SQLite.
 * Every native payload is replayed into a real `SQLiteProvider` to prove it persists the merged value.
 */
import type {MergeVariant} from './helpers/mergeVariant';
import type {FastMergeReplaceNullPatch} from '../../../../lib/utils';

import Onyx from '../../../../lib';
import cache from '../../../../lib/OnyxCache';
import Storage from '../../../../lib/storage';
import SQLiteProvider from '../../../../lib/storage/providers/SQLiteProvider';
import {KEYS, disconnectAll, flush, initOnyxForMergeContracts, record} from './helpers/harness';
import {MERGE_VARIANTS, loadVariant} from './helpers/mergeVariant';
import {REPLACE_OBJECT_MARK, deepFreeze} from './helpers/model';

jest.mock('react-native-nitro-sqlite', () => require('../../mocks/sqliteMock'));

type ParityCase = {
    name: string;
    existing: unknown;
    changes: unknown[];
    merged: unknown;
    nativeBatch: unknown;
    nativePatches: FastMergeReplaceNullPatch[];
};

const PARITY_CASES: ParityCase[] = [
    {
        name: 'a nested patch',
        existing: {a: 1, b: {c: 1}},
        changes: [{b: {d: 1}}],
        merged: {a: 1, b: {c: 1, d: 1}},
        nativeBatch: {b: {d: 1}},
        nativePatches: [],
    },
    {
        name: 'several changes batched into one',
        existing: {a: 1},
        changes: [{b: 1}, {c: {d: 1}}, {b: 2}],
        merged: {a: 1, b: 2, c: {d: 1}},
        nativeBatch: {b: 2, c: {d: 1}},
        nativePatches: [],
    },
    {
        name: 'a nested null that removes a property',
        existing: {a: 1, b: {c: 1, d: 1}},
        changes: [{b: {c: null}}],
        merged: {a: 1, b: {d: 1}},
        nativeBatch: {b: {c: null}},
        nativePatches: [],
    },
    {
        name: 'a nulled property replaced by an object in the same batch',
        existing: {a: {old: 1}, k: 1},
        changes: [{a: null}, {a: {x: 1}}],
        merged: {a: {x: 1}, k: 1},
        nativeBatch: {a: {[REPLACE_OBJECT_MARK]: true, x: 1}},
        nativePatches: [[['a'], {x: 1}]],
    },
    {
        name: 'a deeper nulled property replaced by an object in the same batch',
        existing: {a: {b: {old: 1}, k: 1}},
        changes: [{a: {b: null}}, {a: {b: {c: {d: 1}}}}],
        merged: {a: {b: {c: {d: 1}}, k: 1}},
        nativeBatch: {a: {b: {[REPLACE_OBJECT_MARK]: true, c: {d: 1}}}},
        nativePatches: [[['a', 'b'], {c: {d: 1}}]],
    },
    {
        name: 'two nulled properties replaced in the same batch',
        existing: {a: {old: 1}, b: {old: 1}},
        changes: [{a: null, b: null}, {a: {x: 1}}, {b: {y: 1}}],
        merged: {a: {x: 1}, b: {y: 1}},
        nativeBatch: {a: {[REPLACE_OBJECT_MARK]: true, x: 1}, b: {[REPLACE_OBJECT_MARK]: true, y: 1}},
        nativePatches: [
            [['a'], {x: 1}],
            [['b'], {y: 1}],
        ],
    },
    {
        name: 'a nested array replacing an array',
        existing: {list: [1, 2], k: 1},
        changes: [{list: [3]}],
        merged: {list: [3], k: 1},
        nativeBatch: {list: [3]},
        nativePatches: [],
    },
    {
        name: 'a top-level array replacing an array',
        existing: [1, 2],
        changes: [[3]],
        merged: [3],
        nativeBatch: [3],
        nativePatches: [],
    },
    {
        name: 'a merge into a missing value',
        existing: undefined,
        changes: [{a: 1}, {b: {c: 1}}],
        merged: {a: 1, b: {c: 1}},
        nativeBatch: {a: 1, b: {c: 1}},
        nativePatches: [],
    },
    {
        name: 'a primitive replacing a primitive',
        existing: 'old',
        changes: ['mid', 'new'],
        merged: 'new',
        nativeBatch: 'new',
        nativePatches: [],
    },
];

const setItem = jest.mocked(Storage.setItem);
const mergeItem = jest.mocked(Storage.mergeItem);

async function seedCache(key: string, existing: unknown): Promise<void> {
    if (existing === undefined) {
        await Onyx.set(key, null);
    } else {
        await Onyx.set(key, existing);
    }
    await flush();
    setItem.mockClear();
    mergeItem.mockClear();
}

async function replayIntoSQLite(key: string, existing: unknown, batch: unknown, patches: FastMergeReplaceNullPatch[]): Promise<unknown> {
    await SQLiteProvider.removeItem(key);
    if (existing !== undefined) {
        await SQLiteProvider.setItem(key, existing);
    }
    await SQLiteProvider.mergeItem(key, batch, patches);
    return SQLiteProvider.getItem(key);
}

describe('OnyxMerge.applyMerge parity', () => {
    beforeAll(async () => {
        initOnyxForMergeContracts();
        await SQLiteProvider.init();
    });

    afterEach(async () => {
        disconnectAll();
        await Onyx.clear();
        await flush();
    });

    describe.each(MERGE_VARIANTS)('%s variant', (variant: MergeVariant) => {
        const applyMerge = loadVariant(variant);

        it.each(PARITY_CASES)('returns, caches, delivers and persists $name', async ({existing, changes, merged, nativeBatch, nativePatches}) => {
            const key = KEYS.OBJECT;
            await seedCache(key, existing);
            const recorder = record(key);
            await flush();
            recorder.reset();
            const frozenExisting = deepFreeze(existing);
            const frozenChanges = deepFreeze(changes);

            const {mergedValue} = await applyMerge(key, frozenExisting, frozenChanges);

            expect(mergedValue).toStrictEqual(merged);
            expect(cache.get(key)).toBe(mergedValue);
            expect(recorder.values()).toStrictEqual([merged]);
            expect(recorder.values()[0]).toBe(mergedValue);

            if (variant === 'web') {
                expect(mergeItem).not.toHaveBeenCalled();
                expect(setItem).toHaveBeenCalledTimes(1);
                expect(setItem.mock.calls[0][0]).toBe(key);
                expect(setItem.mock.calls[0][1]).toBe(mergedValue);
                return;
            }

            expect(setItem).not.toHaveBeenCalled();
            expect(mergeItem).toHaveBeenCalledTimes(1);
            const [calledKey, batch, patches] = mergeItem.mock.calls[0];
            expect(calledKey).toBe(key);
            expect(batch).toStrictEqual(nativeBatch);
            expect(patches).toStrictEqual(nativePatches);
            expect(await replayIntoSQLite(key, existing, batch, patches ?? [])).toStrictEqual(merged);
        });

        it('neither writes nor notifies nor replaces the cached value when nothing changes', async () => {
            const key = KEYS.OBJECT;
            await seedCache(key, {a: 1, b: {c: 1}});
            const cached = cache.get(key);
            const recorder = record(key);
            await flush();
            recorder.reset();

            const {mergedValue} = await applyMerge(key, cached, deepFreeze([{a: 1}, {b: {c: 1}}]));

            expect(mergedValue).toStrictEqual({a: 1, b: {c: 1}});
            expect(cache.get(key)).toBe(cached);
            expect(recorder.values()).toStrictEqual([]);
            expect(setItem).not.toHaveBeenCalled();
            expect(mergeItem).not.toHaveBeenCalled();
        });

        it('updates the cache and subscribers of a RAM-only key without touching storage', async () => {
            const key = KEYS.RAM_ONLY;
            await seedCache(key, {a: 1});
            const recorder = record(key);
            await flush();
            recorder.reset();

            const {mergedValue} = await applyMerge(key, cache.get(key), [{b: 1}]);

            expect(mergedValue).toStrictEqual({a: 1, b: 1});
            expect(cache.get(key)).toBe(mergedValue);
            expect(recorder.values()).toStrictEqual([{a: 1, b: 1}]);
            expect(setItem).not.toHaveBeenCalled();
            expect(mergeItem).not.toHaveBeenCalled();
        });

        it('caches the batch alone when a top-level null precedes an object', async () => {
            const key = KEYS.OBJECT;
            await seedCache(key, {old: 1});

            const {mergedValue} = await applyMerge(key, cache.get(key), deepFreeze([null, {a: 1}]));

            expect(mergedValue).toStrictEqual({a: 1});
            expect(cache.get(key)).toBe(mergedValue);
        });

        it('keeps the references of untouched nested objects', async () => {
            const key = KEYS.OBJECT;
            await seedCache(key, {a: {x: 1}, b: {y: 1}});
            const cached = cache.get(key) as {a: object; b: object};

            const {mergedValue} = await applyMerge(key, cached, [{a: {x: 2}}]);

            const merged = mergedValue as unknown as {a: object; b: object};
            expect(merged.b).toBe(cached.b);
            expect(merged.a).not.toBe(cached.a);
        });

        it('returns the existing references when a batch restates equal values', async () => {
            const key = KEYS.OBJECT;
            await seedCache(key, {a: {x: 1}, b: {y: 1, z: {deep: 1}}});
            const cached = cache.get(key) as {a: object; b: object};

            const {mergedValue} = await applyMerge(key, cached, deepFreeze([{a: {x: 1}}, {b: {y: 1, z: {deep: 1}}}]));

            expect(mergedValue).toBe(cached);
        });
    });
});

describe('current behaviour (suspected bug)', () => {
    beforeAll(async () => {
        initOnyxForMergeContracts();
        await SQLiteProvider.init();
    });

    afterEach(async () => {
        await Onyx.clear();
        await flush();
    });

    it('native hands SQLite only the batch after a top-level null, so the old row survives the merge', async () => {
        const key = KEYS.OBJECT;
        await seedCache(key, {old: 1});
        const applyMerge = loadVariant('native');

        await applyMerge(key, cache.get(key), deepFreeze([null, {a: 1}]));

        expect(mergeItem).toHaveBeenCalledTimes(1);
        const [, batch, patches] = mergeItem.mock.calls[0];
        expect(batch).toStrictEqual({a: 1});
        expect(patches).toStrictEqual([]);
        expect(await replayIntoSQLite(key, {old: 1}, batch, patches ?? [])).toStrictEqual({old: 1, a: 1});
    });
});
