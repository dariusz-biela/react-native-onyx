import type OnyxDefault from '../../../../lib';
import type OnyxCacheDefault from '../../../../lib/OnyxCache';
import type OnyxKeysDefault from '../../../../lib/OnyxKeys';
import type OnyxUtilsDefault from '../../../../lib/OnyxUtils';
import type StorageMockDefault from '../../../../lib/storage/__mocks__';

type Cache = typeof OnyxCacheDefault;

type FreshCache = {
    cache: Cache;
    OnyxKeys: typeof OnyxKeysDefault;
};

type FreshOnyx = FreshCache & {
    Onyx: typeof OnyxDefault;
    OnyxUtils: typeof OnyxUtilsDefault;
    storage: typeof StorageMockDefault;
};

const COLLECTION = {
    COLL: 'coll_',
    // Prefix-collides with COLL: every member of it also starts with 'coll_'.
    COLL_SUB: 'coll_sub_',
    OTHER: 'other_',
    EMPTY: 'empty_',
} as const;

const PLAIN = {
    KEY: 'plain',
    // Shares the 'coll' prefix but is not a member of 'coll_'.
    COLL_LOOKALIKE: 'coll',
    // Has an underscore but no registered collection matches it.
    UNDERSCORED: 'nvp_value',
} as const;

const ALL_COLLECTION_KEYS: string[] = Object.values(COLLECTION);

/** Throws away the module graph and returns an empty cache that knows the given collection keys. */
function loadFreshCache(collectionKeys: string[] = ALL_COLLECTION_KEYS): FreshCache {
    jest.resetModules();

    const cacheModule: {default: Cache} = require('../../../../lib/OnyxCache');
    const keysModule: {default: typeof OnyxKeysDefault} = require('../../../../lib/OnyxKeys');

    cacheModule.default.setCollectionKeys(new Set(collectionKeys));

    return {cache: cacheModule.default, OnyxKeys: keysModule.default};
}

/** Throws away the module graph and returns uninitialised Onyx modules that share one cache. */
function loadFreshOnyx(): FreshOnyx {
    jest.resetModules();

    const onyxModule: {default: typeof OnyxDefault} = require('../../../../lib');
    const onyxUtilsModule: {default: typeof OnyxUtilsDefault} = require('../../../../lib/OnyxUtils');
    const cacheModule: {default: Cache} = require('../../../../lib/OnyxCache');
    const keysModule: {default: typeof OnyxKeysDefault} = require('../../../../lib/OnyxKeys');
    const storageModule: {default: typeof StorageMockDefault} = require('../../../../lib/storage');

    return {
        Onyx: onyxModule.default,
        OnyxUtils: onyxUtilsModule.default,
        cache: cacheModule.default,
        OnyxKeys: keysModule.default,
        storage: storageModule.default,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns the snapshot as a plain record, failing the test when the cache has none. */
function readSnapshot(cache: Cache, collectionKey: string): Record<string, unknown> {
    const snapshot = cache.getCollectionData(collectionKey);
    if (!isRecord(snapshot)) {
        throw new Error(`Expected a collection snapshot for '${collectionKey}', got ${String(snapshot)}`);
    }
    return snapshot;
}

/**
 * Asserts the invariants every consumer of a collection snapshot relies on: it is frozen, every member is the very
 * reference `cache.get()` returns, it never holds nullish members, it holds only members of this exact collection,
 * and it holds every cached member of the collection.
 */
function expectSnapshotConsistent(cache: Cache, OnyxKeys: typeof OnyxKeysDefault, collectionKey: string): void {
    const snapshot = readSnapshot(cache, collectionKey);

    expect(Object.isFrozen(snapshot)).toBe(true);

    for (const [memberKey, memberValue] of Object.entries(snapshot)) {
        expect(memberValue).not.toBeNull();
        expect(memberValue).not.toBeUndefined();
        expect(memberValue).toBe(cache.get(memberKey));
        expect(OnyxKeys.getCollectionKey(memberKey)).toBe(collectionKey);
    }

    for (const key of cache.getAllKeys()) {
        if (key === collectionKey || OnyxKeys.getCollectionKey(key) !== collectionKey) {
            continue;
        }
        const value = cache.get(key);
        if (value === undefined || value === null) {
            expect(snapshot).not.toHaveProperty([key]);
        } else {
            expect(snapshot[key]).toBe(value);
        }
    }
}

// Jest treats every file under tests/unit as a suite, so this file carries its own sanity checks and runs them only as the entry file.
if (expect.getState().testPath === __filename) {
    describe('cache contract helpers', () => {
        it('accepts a snapshot whose members are the cached references', () => {
            const {cache, OnyxKeys} = loadFreshCache();
            cache.set(`${COLLECTION.COLL}1`, {id: 1});
            cache.set(`${COLLECTION.COLL_SUB}1`, {id: 2});

            expectSnapshotConsistent(cache, OnyxKeys, COLLECTION.COLL);
            expectSnapshotConsistent(cache, OnyxKeys, COLLECTION.COLL_SUB);
        });

        it('rejects a missing snapshot', () => {
            const {cache} = loadFreshCache();

            expect(() => readSnapshot(cache, COLLECTION.COLL)).toThrow();
        });
    });
}

export {COLLECTION, PLAIN, ALL_COLLECTION_KEYS, loadFreshCache, loadFreshOnyx, readSnapshot, expectSnapshotConsistent, isRecord};
export type {Cache, FreshCache, FreshOnyx};
