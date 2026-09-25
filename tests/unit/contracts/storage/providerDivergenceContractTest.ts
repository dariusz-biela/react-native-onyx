import * as IDB from 'idb-keyval';
import StorageMock from '../../../../lib/storage/__mocks__';
import IDBKeyValProvider from '../../../../lib/storage/providers/IDBKeyValProvider';
import MemoryOnlyProvider, {mockStore, setMockStore} from '../../../../lib/storage/providers/MemoryOnlyProvider';
import type StorageProvider from '../../../../lib/storage/providers/types';
import utils from '../../../../lib/utils';
import {PROVIDER_TARGETS, resetIndexedDB} from './harness';
import type {OnyxKey} from '../../../../lib/types';

const KEY: OnyxKey = 'plain';
const OTHER: OnyxKey = 'other';
const NULLED_KEYS: OnyxKey[] = ['a', 'b', 'c', 'd'];
const [A, B, C, D] = NULLED_KEYS;
const MARK = utils.ONYX_INTERNALS__REPLACE_OBJECT_MARK;

const [memoryTarget, idbTarget] = PROVIDER_TARGETS;

function isStorageProvider(value: unknown): value is StorageProvider<unknown> {
    return typeof value === 'object' && value !== null && 'name' in value && 'getItem' in value;
}

/** A never-initialized IDBKeyValProvider from a fresh module registry. */
function loadUninitializedIDBProvider(): StorageProvider<unknown> {
    let loaded: unknown;
    jest.isolateModules(() => {
        loaded = jest.requireActual<{default: unknown}>('../../../../lib/storage/providers/IDBKeyValProvider').default;
    });
    if (!isStorageProvider(loaded)) {
        throw new Error('IDBKeyValProvider did not load');
    }
    return loaded;
}

function openDatabaseWithoutObjectStore(): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('OnyxDB', 1);
        request.onupgradeneeded = () => undefined;
        request.onsuccess = () => {
            request.result.close();
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
}

describe('MemoryOnlyProvider specifics', () => {
    beforeEach(() => memoryTarget.reset());

    it('exposes the module store as provider.store and mockStore', () => {
        expect(MemoryOnlyProvider.store).toBe(mockStore);
    });

    it('keeps the store object identity across clear, so a captured reference sees later writes', async () => {
        const captured = MemoryOnlyProvider.store;
        await MemoryOnlyProvider.setItem(KEY, 'old');

        await MemoryOnlyProvider.clear();
        await MemoryOnlyProvider.setItem(OTHER, 'new');

        expect(MemoryOnlyProvider.store).toBe(captured);
        expect(captured).toEqual({[OTHER]: 'new'});
    });

    it('setMockStore replaces the contents in place and the provider reads them', async () => {
        const captured = MemoryOnlyProvider.store;
        await MemoryOnlyProvider.setItem(KEY, 'dropped');

        setMockStore({[OTHER]: {seeded: true}});

        expect(MemoryOnlyProvider.store).toBe(captured);
        expect(captured).toEqual({[OTHER]: {seeded: true}});
        expect(await MemoryOnlyProvider.getItem(OTHER)).toEqual({seeded: true});
        expect(await MemoryOnlyProvider.getAllKeys()).toEqual([OTHER]);
    });

    it('the jest storage mock reads and seeds the same store', async () => {
        await StorageMock.clear();
        await MemoryOnlyProvider.setItem(KEY, 'through provider');

        expect(StorageMock.getMockStore()).toEqual({[KEY]: 'through provider'});

        StorageMock.setMockStore({[OTHER]: 1});
        expect(await StorageMock.getItem(OTHER)).toBe(1);
        expect(StorageMock.getMockStore()).toBe(mockStore);
    });

    it('reports an unlimited database size', async () => {
        expect(await MemoryOnlyProvider.getDatabaseSize()).toEqual({bytesRemaining: Number.POSITIVE_INFINITY, bytesUsed: 0});
    });

    it('init does not throw and keeps stored data', async () => {
        await MemoryOnlyProvider.setItem(KEY, 'kept');

        MemoryOnlyProvider.init();

        expect(await MemoryOnlyProvider.getItem(KEY)).toBe('kept');
    });
});

describe('IDBKeyValProvider specifics', () => {
    beforeEach(() => idbTarget.reset());

    it.each(['getItem', 'multiGet', 'setItem', 'multiSet', 'mergeItem', 'multiMerge', 'removeItem', 'removeItems', 'clear', 'getAllKeys', 'getAll'] as const)(
        '%s throws synchronously before init',
        (method) => {
            const provider = loadUninitializedIDBProvider();
            const callers: Record<typeof method, () => unknown> = {
                getItem: () => provider.getItem(KEY),
                multiGet: () => provider.multiGet([KEY]),
                setItem: () => provider.setItem(KEY, 1),
                multiSet: () => provider.multiSet([[KEY, 1]]),
                mergeItem: () => provider.mergeItem(KEY, {a: 1}),
                multiMerge: () => provider.multiMerge([[KEY, {a: 1}]]),
                removeItem: () => provider.removeItem(KEY),
                removeItems: () => provider.removeItems([KEY]),
                clear: () => provider.clear(),
                getAllKeys: () => provider.getAllKeys(),
                getAll: () => provider.getAll(),
            };

            expect(callers[method]).toThrow('Store not initialized!');
        },
    );

    it('init throws the degrade-trigger message when IndexedDB is missing', () => {
        const provider = loadUninitializedIDBProvider();
        const original = window.indexedDB;
        Reflect.deleteProperty(window, 'indexedDB');
        try {
            expect(() => provider.init()).toThrow('IDBKeyVal store could not be created');
        } finally {
            window.indexedDB = original;
        }
    });

    it('a second init over the same database still sees the stored data', async () => {
        await IDBKeyValProvider.setItem(KEY, {kept: true});

        IDBKeyValProvider.init();

        expect(await IDBKeyValProvider.getItem(KEY)).toEqual({kept: true});
    });

    it('creates the object store when the database exists without it', async () => {
        resetIndexedDB();
        await openDatabaseWithoutObjectStore();
        IDBKeyValProvider.init();

        await IDBKeyValProvider.setItem(KEY, 'written');

        expect(await IDBKeyValProvider.getItem(KEY)).toBe('written');
    });

    it('stores a copy, so later changes to the written or read object do not reach storage', async () => {
        const value = {nested: {a: 1}};
        await IDBKeyValProvider.setItem(KEY, value);
        value.nested.a = 2;

        const read = await IDBKeyValProvider.getItem(KEY);
        if (typeof read === 'object' && read !== null) {
            Reflect.set(read, 'added', true);
        }

        expect(await IDBKeyValProvider.getItem(KEY)).toEqual({nested: {a: 1}});
    });

    it('writes land in the OnyxDB database, keyvaluepairs store', async () => {
        await IDBKeyValProvider.setItem(KEY, 'value');

        expect(await IDB.get(KEY, IDB.createStore('OnyxDB', 'keyvaluepairs'))).toBe('value');
    });
});

describe('null writes', () => {
    describe.each(PROVIDER_TARGETS)('$name', (target) => {
        beforeEach(() => target.reset());

        it('getItem of a key written as null is null', async () => {
            await target.provider.setItem(KEY, 'value');

            await target.provider.setItem(KEY, null);

            expect(await target.provider.getItem(KEY)).toBeNull();
        });

        it('a null pair in multiSet does not disturb the other pairs', async () => {
            await target.provider.multiSet([
                [KEY, 'value'],
                [OTHER, 'kept'],
            ]);

            await target.provider.multiSet([
                [KEY, null],
                [OTHER, 'changed'],
            ]);

            expect(await target.provider.getItem(KEY)).toBeNull();
            expect(await target.provider.getItem(OTHER)).toBe('changed');
        });
    });

    it('IDBKeyValProvider deletes the key for setItem, multiSet and multiMerge with null', async () => {
        await idbTarget.reset();
        await IDBKeyValProvider.multiSet([
            [A, 1],
            [B, 2],
            [C, 3],
            [D, 4],
        ]);

        await IDBKeyValProvider.setItem(A, null);
        await IDBKeyValProvider.multiSet([[B, null]]);
        await IDBKeyValProvider.multiMerge([[C, null]]);
        await IDBKeyValProvider.mergeItem(D, null);

        expect(await idbTarget.readRaw()).toEqual({});
        expect(await IDBKeyValProvider.getAllKeys()).toEqual([]);
    });
});

describe('current behaviour (suspected bug)', () => {
    it('MemoryOnlyProvider keeps a key written as null, while IDBKeyValProvider deletes it', async () => {
        await memoryTarget.reset();
        await MemoryOnlyProvider.multiSet([
            [A, 1],
            [B, 2],
            [C, 3],
            [D, 4],
        ]);

        await MemoryOnlyProvider.setItem(A, null);
        await MemoryOnlyProvider.multiSet([[B, null]]);
        await MemoryOnlyProvider.multiMerge([[C, null]]);
        await MemoryOnlyProvider.mergeItem(D, null);

        expect(await memoryTarget.readRaw()).toEqual({a: null, b: null, c: null, d: null});
        expect([...(await MemoryOnlyProvider.getAllKeys())].sort()).toEqual(['a', 'b', 'c', 'd']);
        expect(await MemoryOnlyProvider.getAll()).toHaveLength(4);
    });

    it('IDBKeyValProvider multiMerge keeps only the last change for a key repeated in one batch', async () => {
        await idbTarget.reset();
        await IDBKeyValProvider.setItem(KEY, {base: true});

        await IDBKeyValProvider.multiMerge([
            [KEY, {first: 1}],
            [KEY, {second: 2}],
        ]);

        expect(await IDBKeyValProvider.getItem(KEY)).toEqual({base: true, second: 2});
    });

    it('MemoryOnlyProvider multiMerge applies every change for a key repeated in one batch', async () => {
        await memoryTarget.reset();
        await MemoryOnlyProvider.setItem(KEY, {base: true});

        await MemoryOnlyProvider.multiMerge([
            [KEY, {first: 1}],
            [KEY, {second: 2}],
        ]);

        expect(await MemoryOnlyProvider.getItem(KEY)).toEqual({base: true, first: 1, second: 2});
    });

    it('multiGet returns undefined for a missing key on IDBKeyValProvider but null on MemoryOnlyProvider', async () => {
        await idbTarget.reset();
        await memoryTarget.reset();

        expect(await IDBKeyValProvider.multiGet([KEY])).toEqual([[KEY, undefined]]);
        expect((await IDBKeyValProvider.multiGet([KEY]))[0][1]).toBeUndefined();
        expect((await MemoryOnlyProvider.multiGet([KEY]))[0][1]).toBeNull();
    });

    it.each(PROVIDER_TARGETS)('$name keeps nested nulls inside a marked replacement object', async (target) => {
        await target.reset();
        await target.provider.setItem(KEY, {nested: {a: 1}});

        await target.provider.mergeItem(KEY, {nested: {[MARK]: true, b: null, c: {d: null}}});

        expect(await target.provider.getItem(KEY)).toEqual({nested: {b: null, c: {d: null}}});
    });
});
