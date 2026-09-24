import {act, renderHook} from '@testing-library/react-native';
import React from 'react';
import type OnyxDefault from '../../../../lib';
import type {useOnyx as useOnyxHook} from '../../../../lib';
import type * as LoggerModule from '../../../../lib/Logger';
import type OnyxCacheDefault from '../../../../lib/OnyxCache';
import type {Connection} from '../../../../lib/OnyxConnectionManager';
import type OnyxUtilsDefault from '../../../../lib/OnyxUtils';
import type StorageMockDefault from '../../../../lib/storage/__mocks__';
import type {InitOptions, OnyxKey} from '../../../../lib/types';

import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    OTHER: 'other',
    OBJECT: 'object',
    NVP: 'nvp_test',
    NVP_LONGER: 'nvp_test2',
    RAM_ONLY: 'ramOnly',
    RAM_ONLY_DEFAULT: 'ramOnlyDefault',
    COLLECTION: {
        TEST: 'test_',
        TEST_LEVEL: 'test_level_',
        RAM_ONLY: 'ramCollection_',
        SNAPSHOT: 'snapshot_',
    },
} as const;

const SKIP_ID = 'skip-id';

type FreshOnyx = {
    Onyx: typeof OnyxDefault;
    useOnyx: typeof useOnyxHook;
    OnyxUtils: typeof OnyxUtilsDefault;
    cache: typeof OnyxCacheDefault;
    storage: typeof StorageMockDefault;
    Logger: typeof LoggerModule;
};

type Recorder = {
    values: unknown[];
    keys: unknown[];
    connection: Connection;
};

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
};

/** Throws away the whole Onyx module graph so every test starts with an uninitialised Onyx, an empty cache and an empty storage. */
function loadFreshOnyx(): FreshOnyx {
    jest.resetModules();
    // The fresh lib graph must share React with the renderer imported above.
    jest.doMock('react', () => React);

    const onyxModule: {default: typeof OnyxDefault; useOnyx: typeof useOnyxHook} = require('../../../../lib');
    const onyxUtilsModule: {default: typeof OnyxUtilsDefault} = require('../../../../lib/OnyxUtils');
    const cacheModule: {default: typeof OnyxCacheDefault} = require('../../../../lib/OnyxCache');
    const storageModule: {default: typeof StorageMockDefault} = require('../../../../lib/storage');
    const loggerModule: typeof LoggerModule = require('../../../../lib/Logger');

    return {
        Onyx: onyxModule.default,
        useOnyx: onyxModule.useOnyx,
        OnyxUtils: onyxUtilsModule.default,
        cache: cacheModule.default,
        storage: storageModule.default,
        Logger: loggerModule,
    };
}

function createDeferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}

function record(fresh: FreshOnyx, key: OnyxKey): Recorder {
    const values: unknown[] = [];
    const keys: unknown[] = [];
    const connection = fresh.Onyx.connect({
        key,
        callback: (value, callbackKey) => {
            values.push(value);
            keys.push(callbackKey);
        },
    });
    return {values, keys, connection};
}

function initOptions(overrides: Partial<InitOptions> = {}): InitOptions {
    return {keys: KEYS, shouldSyncMultipleInstances: false, enableDevTools: false, ...overrides};
}

async function initAndSettle(fresh: FreshOnyx, overrides: Partial<InitOptions> = {}): Promise<void> {
    fresh.Onyx.init(initOptions(overrides));
    await waitForPromisesToResolve();
}

function isInitResolved(fresh: FreshOnyx): boolean {
    return fresh.OnyxUtils.getDeferredInitTask().isResolved;
}

/** Walks the eviction candidates in order without mutating the recently accessed list. */
function evictionOrder(fresh: FreshOnyx): OnyxKey[] {
    const seen: OnyxKey[] = [];
    for (let candidate = fresh.cache.getKeyForEviction(); candidate !== undefined; candidate = fresh.cache.getKeyForEviction(new Set(seen))) {
        seen.push(candidate);
    }
    return seen;
}

function storedValue(fresh: FreshOnyx, key: OnyxKey): unknown {
    const store: Record<string, unknown> = fresh.storage.getMockStore();
    return store[key];
}

function hasStoredKey(fresh: FreshOnyx, key: OnyxKey): boolean {
    const store: Record<string, unknown> = fresh.storage.getMockStore();
    return key in store;
}

let fresh: FreshOnyx;

beforeEach(() => {
    fresh = loadFreshOnyx();
});

describe('Onyx.init contract', () => {
    describe('cache hydration from storage', () => {
        it('loads every stored key into the cache and the key index', async () => {
            fresh.storage.setMockStore({
                [KEYS.PLAIN]: 'stored plain',
                [KEYS.OBJECT]: {a: 1, nested: {b: 2}},
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
                [`${KEYS.COLLECTION.TEST}2`]: {id: 2},
                [KEYS.NVP]: 0,
                [KEYS.OTHER]: false,
            });

            await initAndSettle(fresh);

            expect(fresh.cache.get(KEYS.PLAIN)).toBe('stored plain');
            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 1, nested: {b: 2}});
            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}1`)).toEqual({id: 1});
            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}2`)).toEqual({id: 2});
            expect(fresh.cache.get(KEYS.NVP)).toBe(0);
            expect(fresh.cache.get(KEYS.OTHER)).toBe(false);
            expect([...fresh.cache.getAllKeys()].sort()).toEqual([KEYS.PLAIN, KEYS.OBJECT, `${KEYS.COLLECTION.TEST}1`, `${KEYS.COLLECTION.TEST}2`, KEYS.NVP, KEYS.OTHER].sort());
            await expect(fresh.OnyxUtils.getAllKeys()).resolves.toEqual(new Set([KEYS.PLAIN, KEYS.OBJECT, `${KEYS.COLLECTION.TEST}1`, `${KEYS.COLLECTION.TEST}2`, KEYS.NVP, KEYS.OTHER]));
        });

        it('serves hydrated values to new connections without reading storage again', async () => {
            fresh.storage.setMockStore({
                [KEYS.PLAIN]: 'stored plain',
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
            });
            await initAndSettle(fresh);
            fresh.storage.getItem.mockClear();
            fresh.storage.multiGet.mockClear();
            fresh.storage.getAllKeys.mockClear();

            const plain = record(fresh, KEYS.PLAIN);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            await waitForPromisesToResolve();

            expect(plain.values).toEqual(['stored plain']);
            expect(collection.values).toEqual([{[`${KEYS.COLLECTION.TEST}1`]: {id: 1}}]);
            expect(fresh.storage.getItem).not.toHaveBeenCalled();
            expect(fresh.storage.multiGet).not.toHaveBeenCalled();
            expect(fresh.storage.getAllKeys).not.toHaveBeenCalled();
        });

        it('reads the whole storage once at init', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'a', [KEYS.OTHER]: 'b'});

            await initAndSettle(fresh);

            expect(fresh.storage.getAll).toHaveBeenCalledTimes(1);
        });

        it('strips nested nulls from hydrated values without mutating the stored object', async () => {
            const stored = deepFreeze({a: 1, gone: null, nested: {keep: 'x', gone: null}});
            fresh.storage.setMockStore({[KEYS.OBJECT]: stored});

            await initAndSettle(fresh);

            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 1, nested: {keep: 'x'}});
            expect(stored).toEqual({a: 1, gone: null, nested: {keep: 'x', gone: null}});
            expect(storedValue(fresh, KEYS.OBJECT)).toBe(stored);
        });

        it('treats a stored top-level null as a known empty key', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: null, [`${KEYS.COLLECTION.TEST}1`]: null, [`${KEYS.COLLECTION.TEST}2`]: {id: 2}});

            await initAndSettle(fresh);
            fresh.storage.getItem.mockClear();

            expect(fresh.cache.hasCacheForKey(KEYS.PLAIN)).toBe(true);
            expect(fresh.cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(fresh.cache.getAllKeys().has(KEYS.PLAIN)).toBe(true);

            const plain = record(fresh, KEYS.PLAIN);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            await waitForPromisesToResolve();

            expect(plain.values).toEqual([undefined]);
            expect(collection.values).toHaveLength(1);
            expect(collection.values[0]).toEqual({[`${KEYS.COLLECTION.TEST}2`]: {id: 2}});
            expect(fresh.storage.getItem).not.toHaveBeenCalled();
        });

        it('keeps members of prefix-colliding collections apart', async () => {
            fresh.storage.setMockStore({
                [`${KEYS.COLLECTION.TEST}1`]: {owner: 'test'},
                [`${KEYS.COLLECTION.TEST_LEVEL}1`]: {owner: 'level'},
                [`${KEYS.COLLECTION.TEST_LEVEL}2`]: {owner: 'level'},
            });

            await initAndSettle(fresh);
            const test = record(fresh, KEYS.COLLECTION.TEST);
            const level = record(fresh, KEYS.COLLECTION.TEST_LEVEL);
            await waitForPromisesToResolve();

            expect(test.values.at(-1)).toEqual({[`${KEYS.COLLECTION.TEST}1`]: {owner: 'test'}});
            expect(level.values.at(-1)).toEqual({
                [`${KEYS.COLLECTION.TEST_LEVEL}1`]: {owner: 'level'},
                [`${KEYS.COLLECTION.TEST_LEVEL}2`]: {owner: 'level'},
            });
            expect(test.values).toHaveLength(1);
            expect(level.values).toHaveLength(1);
        });

        it('does not treat a plain key with an underscore as a collection member', async () => {
            fresh.storage.setMockStore({[KEYS.NVP]: 'nvp value', [`${KEYS.COLLECTION.TEST}1`]: {id: 1}});

            await initAndSettle(fresh);
            const nvp = record(fresh, KEYS.NVP);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            await waitForPromisesToResolve();

            expect(nvp.values).toEqual(['nvp value']);
            expect(collection.values).toEqual([{[`${KEYS.COLLECTION.TEST}1`]: {id: 1}}]);
        });

        it('delivers undefined once to a collection subscriber when the collection is empty', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'not a member'});

            await initAndSettle(fresh);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            await waitForPromisesToResolve();

            expect(collection.values).toEqual([undefined]);
            expect(collection.keys).toEqual([KEYS.COLLECTION.TEST]);
        });

        it('delivers undefined once to a collection subscriber when storage is completely empty', async () => {
            await initAndSettle(fresh);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            const plain = record(fresh, KEYS.PLAIN);
            await waitForPromisesToResolve();

            expect(collection.values).toEqual([undefined]);
            expect(plain.values).toEqual([undefined]);
            expect(fresh.cache.getAllKeys().size).toBe(0);
        });

        it('hands the same collection reference to subscribers when nothing changed in between', async () => {
            fresh.storage.setMockStore({[`${KEYS.COLLECTION.TEST}1`]: {id: 1}, [`${KEYS.COLLECTION.TEST}2`]: {id: 2}});

            await initAndSettle(fresh);
            const first = record(fresh, KEYS.COLLECTION.TEST);
            await waitForPromisesToResolve();
            const secondValues: unknown[] = [];
            fresh.Onyx.connect({key: KEYS.COLLECTION.TEST, reuseConnection: false, callback: (value) => secondValues.push(value)});
            await waitForPromisesToResolve();

            expect(first.values).toHaveLength(1);
            expect(secondValues).toHaveLength(1);
            expect(secondValues[0]).toBe(first.values[0]);
            expect(Object.isFrozen(first.values[0])).toBe(true);
        });

        it('keeps a hydrated value by reference so later reads return the same object', async () => {
            fresh.storage.setMockStore({[KEYS.OBJECT]: {a: 1, nested: {b: 2}}});

            await initAndSettle(fresh);

            expect(fresh.cache.get(KEYS.OBJECT)).toBe(fresh.cache.get(KEYS.OBJECT));
            expect(fresh.OnyxUtils.tryGetCachedValue(KEYS.OBJECT)).toBe(fresh.cache.get(KEYS.OBJECT));
        });

        it('lets a useOnyx hook mounted after init render the stored value on its first render', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'stored plain', [`${KEYS.COLLECTION.TEST}1`]: {id: 1}});
            await initAndSettle(fresh);

            const renders: Array<{value: unknown; status: string}> = [];
            const collectionRenders: Array<{value: unknown; status: string}> = [];
            renderHook(() => {
                const [value, metadata] = fresh.useOnyx(KEYS.PLAIN);
                renders.push({value, status: metadata.status});
            });
            renderHook(() => {
                const [value, metadata] = fresh.useOnyx(KEYS.COLLECTION.TEST);
                collectionRenders.push({value, status: metadata.status});
            });

            expect(renders[0]).toEqual({value: 'stored plain', status: 'loaded'});
            expect(collectionRenders[0]).toEqual({value: {[`${KEYS.COLLECTION.TEST}1`]: {id: 1}}, status: 'loaded'});

            await act(async () => waitForPromisesToResolve());

            expect(renders.every((render) => render.value === 'stored plain' && render.status === 'loaded')).toBe(true);
        });
    });

    describe('initialKeyStates', () => {
        it('puts defaults for keys missing from storage into the cache without persisting them', async () => {
            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'default', [KEYS.OBJECT]: {a: 1}}});

            expect(fresh.cache.get(KEYS.PLAIN)).toBe('default');
            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 1});
            expect(fresh.cache.getAllKeys().has(KEYS.PLAIN)).toBe(true);
            expect(hasStoredKey(fresh, KEYS.PLAIN)).toBe(false);
            expect(hasStoredKey(fresh, KEYS.OBJECT)).toBe(false);
        });

        it('deep merges stored objects with defaults, the default winning on overlapping leaves', async () => {
            fresh.storage.setMockStore({[KEYS.OBJECT]: {a: 'stored', keep: 1, nested: {x: 'stored', y: 1}}});

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.OBJECT]: {a: 'default', added: true, nested: {x: 'default', z: 2}}}});

            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 'default', keep: 1, added: true, nested: {x: 'default', y: 1, z: 2}});
            expect(storedValue(fresh, KEYS.OBJECT)).toEqual({a: 'stored', keep: 1, nested: {x: 'stored', y: 1}});
        });

        it('replaces stored primitives and arrays with the default', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'stored', [KEYS.OTHER]: [1, 2, 3], [KEYS.NVP]: {a: 1}});

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'default', [KEYS.OTHER]: [9], [KEYS.NVP]: [7]}});

            expect(fresh.cache.get(KEYS.PLAIN)).toBe('default');
            expect(fresh.cache.get(KEYS.OTHER)).toEqual([9]);
            expect(fresh.cache.get(KEYS.NVP)).toEqual([7]);
        });

        it('never stores a nested null from a default for a key missing from storage', async () => {
            const object = record(fresh, KEYS.OBJECT);

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.OBJECT]: {a: 1, gone: null, nested: {gone: null, kept: 2}}}});

            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 1, nested: {kept: 2}});
            expect(object.values.length).toBeLessThanOrEqual(2);
            for (const value of object.values) {
                expect(value).toEqual({a: 1, nested: {kept: 2}});
            }
        });

        it('does not mutate the initialKeyStates object or the stored values', async () => {
            const stored = deepFreeze({a: 'stored', nested: {x: 1}});
            const defaults = deepFreeze({[KEYS.OBJECT]: {a: 'default', nested: {y: 2}}, [KEYS.PLAIN]: {fresh: true}});
            fresh.storage.setMockStore({[KEYS.OBJECT]: stored});
            const alertSpy = jest.spyOn(fresh.Logger, 'logAlert');

            await initAndSettle(fresh, {initialKeyStates: defaults});

            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 'default', nested: {x: 1, y: 2}});
            expect(fresh.cache.get(KEYS.PLAIN)).toEqual({fresh: true});
            expect(defaults).toEqual({[KEYS.OBJECT]: {a: 'default', nested: {y: 2}}, [KEYS.PLAIN]: {fresh: true}});
            expect(stored).toEqual({a: 'stored', nested: {x: 1}});
            expect(alertSpy).not.toHaveBeenCalled();
        });

        it('adds a default collection member to the collection', async () => {
            fresh.storage.setMockStore({[`${KEYS.COLLECTION.TEST}1`]: {id: 1}});

            await initAndSettle(fresh, {initialKeyStates: {[`${KEYS.COLLECTION.TEST}2`]: {id: 'default'}}});
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            await waitForPromisesToResolve();

            expect(collection.values.at(-1)).toEqual({[`${KEYS.COLLECTION.TEST}1`]: {id: 1}, [`${KEYS.COLLECTION.TEST}2`]: {id: 'default'}});
        });

        it('notifies a subscriber connected before init with the merged default exactly once', async () => {
            fresh.storage.setMockStore({[KEYS.OBJECT]: {stored: true, a: 'stored'}});
            const object = record(fresh, KEYS.OBJECT);
            const plain = record(fresh, KEYS.PLAIN);

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.OBJECT]: {a: 'default'}, [KEYS.PLAIN]: 'default'}});

            expect(object.values).toEqual([{stored: true, a: 'default'}]);
            expect(object.keys).toEqual([KEYS.OBJECT]);
            expect(plain.values).toEqual(['default']);
        });

        it('delivers defaults to early subscribers before the deferred init task resolves', async () => {
            const getAll = createDeferred<Array<[OnyxKey, unknown]>>();
            fresh.storage.getAll.mockImplementationOnce(() => getAll.promise);
            const plain = record(fresh, KEYS.PLAIN);
            const seenWhileUnresolved: boolean[] = [];
            fresh.Onyx.connect({key: KEYS.OTHER, callback: () => seenWhileUnresolved.push(!isInitResolved(fresh))});

            fresh.Onyx.init(initOptions({initialKeyStates: {[KEYS.PLAIN]: 'default', [KEYS.OTHER]: 'other default'}}));
            await waitForPromisesToResolve();
            expect(plain.values).toEqual([]);

            getAll.resolve([]);
            await waitForPromisesToResolve();

            expect(plain.values).toEqual(['default']);
            expect(seenWhileUnresolved).toEqual([true]);
            expect(isInitResolved(fresh)).toBe(true);
        });

        it('does not call a subscriber when the default key is not the one it listens to', async () => {
            const other = record(fresh, KEYS.OTHER);

            fresh.Onyx.init(initOptions({initialKeyStates: {[KEYS.PLAIN]: 'default'}}));
            await waitForPromisesToResolve();

            expect(other.values).toEqual([undefined]);
        });

        it('lets a useOnyx hook mounted before init go from loading to the default value', async () => {
            const renders: Array<{value: unknown; status: string}> = [];
            renderHook(() => {
                const [value, metadata] = fresh.useOnyx(KEYS.OBJECT);
                renders.push({value, status: metadata.status});
            });

            expect(renders[0]).toEqual({value: undefined, status: 'loading'});

            fresh.storage.setMockStore({[KEYS.OBJECT]: {stored: 1}});
            fresh.Onyx.init(initOptions({initialKeyStates: {[KEYS.OBJECT]: {fromDefault: 1}}}));
            await act(async () => waitForPromisesToResolve());

            expect(renders.at(-1)).toEqual({value: {stored: 1, fromDefault: 1}, status: 'loaded'});
            const loadedRenders = renders.filter((render) => render.status === 'loaded');
            expect(loadedRenders.every((render) => JSON.stringify(render.value) === JSON.stringify({stored: 1, fromDefault: 1}))).toBe(true);
        });
    });

    describe('connections made before init', () => {
        it('receive the stored value once after init', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'stored', [`${KEYS.COLLECTION.TEST}1`]: {id: 1}, [`${KEYS.COLLECTION.TEST}2`]: {id: 2}});
            const plain = record(fresh, KEYS.PLAIN);
            const member = record(fresh, `${KEYS.COLLECTION.TEST}1`);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            const missing = record(fresh, KEYS.OTHER);

            await waitForPromisesToResolve();
            expect(plain.values).toEqual([]);
            expect(collection.values).toEqual([]);

            await initAndSettle(fresh);

            expect(plain.values).toEqual(['stored']);
            expect(plain.keys).toEqual([KEYS.PLAIN]);
            expect(member.values).toEqual([{id: 1}]);
            expect(member.keys).toEqual([`${KEYS.COLLECTION.TEST}1`]);
            expect(collection.values).toEqual([{[`${KEYS.COLLECTION.TEST}1`]: {id: 1}, [`${KEYS.COLLECTION.TEST}2`]: {id: 2}}]);
            expect(collection.keys).toEqual([KEYS.COLLECTION.TEST]);
            expect(missing.values).toEqual([undefined]);
        });

        it('see a collection with a default member at most twice and end with the full collection', async () => {
            fresh.storage.setMockStore({[`${KEYS.COLLECTION.TEST}1`]: {id: 1}});
            const collection = record(fresh, KEYS.COLLECTION.TEST);

            await initAndSettle(fresh, {initialKeyStates: {[`${KEYS.COLLECTION.TEST}2`]: {id: 'default'}}});

            const full = {[`${KEYS.COLLECTION.TEST}1`]: {id: 1}, [`${KEYS.COLLECTION.TEST}2`]: {id: 'default'}};
            expect(collection.values.length).toBeGreaterThanOrEqual(1);
            expect(collection.values.length).toBeLessThanOrEqual(2);
            expect(collection.values.at(-1)).toEqual(full);
            for (const value of collection.values) {
                expect(value).toEqual(full);
            }
        });

        it('share a value between two connections to the same key', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'stored'});
            const first = record(fresh, KEYS.PLAIN);
            const second = record(fresh, KEYS.PLAIN);

            await initAndSettle(fresh);

            expect(first.values).toEqual(['stored']);
            expect(second.values).toEqual(['stored']);
        });

        it('get the value written before init instead of the stale stored value', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'stale', [KEYS.OBJECT]: {stale: true}});
            const plain = record(fresh, KEYS.PLAIN);
            const object = record(fresh, KEYS.OBJECT);
            fresh.Onyx.set(KEYS.PLAIN, 'fresh');
            fresh.Onyx.merge(KEYS.OBJECT, {merged: true});

            await initAndSettle(fresh);

            expect(plain.values).toEqual(['fresh']);
            expect(object.values).toEqual([{stale: true, merged: true}]);
        });

        it('do not receive anything after being disconnected before init', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'stored'});
            const plain = record(fresh, KEYS.PLAIN);
            fresh.Onyx.disconnect(plain.connection);

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'default'}});

            expect(plain.values).toEqual([]);
        });

        it('keep init going when one subscriber throws during the default notification', async () => {
            const alertSpy = jest.spyOn(fresh.Logger, 'logAlert').mockImplementation(() => undefined);
            fresh.Onyx.connect({
                key: KEYS.PLAIN,
                callback: () => {
                    throw new Error('subscriber failure');
                },
            });
            const other = record(fresh, KEYS.OTHER);

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'default', [KEYS.OTHER]: 'other default'}});
            await fresh.Onyx.set(KEYS.OBJECT, {after: true});

            expect(other.values).toEqual(['other default']);
            expect(isInitResolved(fresh)).toBe(true);
            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({after: true});
            expect(alertSpy).toHaveBeenCalled();
        });

        it('let a subscriber write from its default notification and have the write applied after init', async () => {
            const writes: Array<Promise<void>> = [];
            fresh.Onyx.connect({
                key: KEYS.PLAIN,
                callback: (value) => {
                    const received: unknown = value;
                    if (received !== 'default') {
                        return;
                    }
                    writes.push(fresh.Onyx.set(KEYS.OTHER, 'written from callback'));
                },
            });
            const other = record(fresh, KEYS.OTHER);

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'default'}});
            await Promise.all(writes);

            expect(writes).toHaveLength(1);
            expect(fresh.cache.get(KEYS.OTHER)).toBe('written from callback');
            expect(storedValue(fresh, KEYS.OTHER)).toBe('written from callback');
            expect(other.values.at(-1)).toBe('written from callback');
            expect(other.values.filter((value) => value !== undefined)).toEqual(['written from callback']);
        });
    });

    describe('deferred init', () => {
        it('holds writes issued before init and does not touch cache or storage', async () => {
            let resolved = false;
            fresh.Onyx.set(KEYS.PLAIN, 'early').then(() => {
                resolved = true;
            });
            fresh.Onyx.merge(KEYS.OBJECT, {a: 1});
            await waitForPromisesToResolve();

            expect(resolved).toBe(false);
            expect(fresh.cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(fresh.cache.get(KEYS.OBJECT)).toBeUndefined();
            expect(hasStoredKey(fresh, KEYS.PLAIN)).toBe(false);
            expect(fresh.storage.setItem).not.toHaveBeenCalled();
            expect(fresh.storage.mergeItem).not.toHaveBeenCalled();
            expect(fresh.storage.multiMerge).not.toHaveBeenCalled();
            expect(fresh.storage.multiSet).not.toHaveBeenCalled();

            await initAndSettle(fresh);

            expect(resolved).toBe(true);
            expect(fresh.cache.get(KEYS.PLAIN)).toBe('early');
            expect(storedValue(fresh, KEYS.PLAIN)).toBe('early');
            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 1});
            expect(storedValue(fresh, KEYS.OBJECT)).toEqual({a: 1});
        });

        it('applies early writes on top of hydrated values and defaults', async () => {
            fresh.storage.setMockStore({
                [KEYS.PLAIN]: 'stored',
                [KEYS.OBJECT]: {stored: 0},
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
                [`${KEYS.COLLECTION.TEST}2`]: {id: 2, name: 'two'},
            });
            fresh.Onyx.set(KEYS.PLAIN, 'written');
            fresh.Onyx.merge(KEYS.OBJECT, {a: 1});
            fresh.Onyx.merge(KEYS.OBJECT, {b: 2});
            fresh.Onyx.merge(KEYS.OTHER, {c: 3});
            fresh.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {[`${KEYS.COLLECTION.TEST}2`]: {name: 'renamed'}, [`${KEYS.COLLECTION.TEST}3`]: {id: 3}});

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'default', [KEYS.OTHER]: {fromDefault: true, c: 0}}});

            expect(fresh.cache.get(KEYS.PLAIN)).toBe('written');
            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({stored: 0, a: 1, b: 2});
            expect(fresh.cache.get(KEYS.OTHER)).toEqual({fromDefault: true, c: 3});
            expect(storedValue(fresh, KEYS.PLAIN)).toBe('written');
            expect(storedValue(fresh, KEYS.OBJECT)).toEqual({stored: 0, a: 1, b: 2});
            expect(storedValue(fresh, KEYS.OTHER)).toEqual({fromDefault: true, c: 3});

            const collection = record(fresh, KEYS.COLLECTION.TEST);
            await waitForPromisesToResolve();
            expect(collection.values.at(-1)).toEqual({
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
                [`${KEYS.COLLECTION.TEST}2`]: {id: 2, name: 'renamed'},
                [`${KEYS.COLLECTION.TEST}3`]: {id: 3},
            });
        });

        it('runs early writes to one key in the order they were issued', async () => {
            fresh.storage.setMockStore({[KEYS.OBJECT]: {stored: true}});
            const object = record(fresh, KEYS.OBJECT);
            fresh.Onyx.set(KEYS.OBJECT, {a: 1});
            fresh.Onyx.merge(KEYS.OBJECT, {b: 2});
            fresh.Onyx.set(KEYS.OBJECT, {c: 3});
            fresh.Onyx.merge(KEYS.OBJECT, {d: 4});

            await initAndSettle(fresh);

            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({c: 3, d: 4});
            expect(storedValue(fresh, KEYS.OBJECT)).toEqual({c: 3, d: 4});

            const validStates = [{a: 1}, {a: 1, b: 2}, {c: 3}, {c: 3, d: 4}].map((state) => JSON.stringify(state));
            const positions = object.values.map((value) => validStates.indexOf(JSON.stringify(value)));
            expect(positions.every((position) => position >= 0)).toBe(true);
            expect([...positions].sort((a, b) => a - b)).toEqual(positions);
            expect(object.values.at(-1)).toEqual({c: 3, d: 4});
            expect(object.values).not.toContainEqual({stored: true});
        });

        it('runs early writes across keys in issue order', async () => {
            const order: string[] = [];
            fresh.Onyx.connect({key: KEYS.PLAIN, callback: (value) => value !== undefined && order.push(`plain:${String(value)}`)});
            fresh.Onyx.connect({key: KEYS.OTHER, callback: (value) => value !== undefined && order.push(`other:${String(value)}`)});
            fresh.Onyx.set(KEYS.PLAIN, 'one');
            fresh.Onyx.set(KEYS.OTHER, 'two');
            fresh.Onyx.set(KEYS.PLAIN, 'three');

            await initAndSettle(fresh);

            expect(order.at(-1)).toBe('plain:three');
            expect(order.indexOf('other:two')).toBeGreaterThanOrEqual(0);
            expect(order.findLast((entry) => entry.startsWith('plain:'))).toBe('plain:three');
            if (order.includes('plain:one')) {
                expect(order.indexOf('plain:one')).toBeLessThan(order.indexOf('other:two'));
            }
            expect(order.indexOf('other:two')).toBeLessThan(order.indexOf('plain:three'));
        });

        it('holds writes issued while storage is still being read', async () => {
            const getAll = createDeferred<Array<[OnyxKey, unknown]>>();
            fresh.storage.getAll.mockImplementationOnce(() => getAll.promise);

            fresh.Onyx.init(initOptions());
            fresh.Onyx.set(KEYS.PLAIN, 'written during init');
            fresh.Onyx.merge(KEYS.OBJECT, {merged: true});
            const plain = record(fresh, KEYS.PLAIN);
            await waitForPromisesToResolve();

            expect(isInitResolved(fresh)).toBe(false);
            expect(fresh.cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(plain.values).toEqual([]);

            getAll.resolve([
                [KEYS.PLAIN, 'stored'],
                [KEYS.OBJECT, {stored: true}],
            ]);
            await waitForPromisesToResolve();

            expect(isInitResolved(fresh)).toBe(true);
            expect(fresh.cache.get(KEYS.PLAIN)).toBe('written during init');
            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({stored: true, merged: true});
            expect(plain.values).toEqual(['written during init']);
        });

        it('queues Onyx.update and multiSet issued before init', async () => {
            fresh.storage.setMockStore({[KEYS.OBJECT]: {stored: true}});
            fresh.Onyx.update([
                {onyxMethod: 'merge', key: KEYS.OBJECT, value: {updated: true}},
                {onyxMethod: 'set', key: KEYS.PLAIN, value: 'from update'},
            ]);
            fresh.Onyx.multiSet({[KEYS.OTHER]: 'from multiSet', [`${KEYS.COLLECTION.TEST}1`]: {id: 1}});
            await waitForPromisesToResolve();
            expect(fresh.cache.get(KEYS.PLAIN)).toBeUndefined();

            await initAndSettle(fresh);

            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({stored: true, updated: true});
            expect(fresh.cache.get(KEYS.PLAIN)).toBe('from update');
            expect(fresh.cache.get(KEYS.OTHER)).toBe('from multiSet');
            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}1`)).toEqual({id: 1});
        });

        it('resolves writes issued after init without waiting for anything else', async () => {
            await initAndSettle(fresh);

            let resolved = false;
            fresh.Onyx.set(KEYS.PLAIN, 'after').then(() => {
                resolved = true;
            });
            await waitForPromisesToResolve();

            expect(resolved).toBe(true);
            expect(fresh.cache.get(KEYS.PLAIN)).toBe('after');
        });
    });

    describe('storage read failure', () => {
        it('boots with the defaults, resolves init and keeps writes working', async () => {
            const alertSpy = jest.spyOn(fresh.Logger, 'logAlert').mockImplementation(() => undefined);
            fresh.storage.setMockStore({[KEYS.OTHER]: 'unreachable'});
            fresh.storage.getAll.mockImplementationOnce(() => Promise.reject(new Error('disk gone')));
            const plain = record(fresh, KEYS.PLAIN);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            fresh.Onyx.set(KEYS.OBJECT, {early: true});

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'default', [`${KEYS.COLLECTION.TEST}1`]: {id: 'default'}}});

            expect(alertSpy).toHaveBeenCalled();
            expect(isInitResolved(fresh)).toBe(true);
            expect(fresh.cache.get(KEYS.PLAIN)).toBe('default');
            expect(plain.values).toEqual(['default']);
            expect(collection.values.at(-1)).toEqual({[`${KEYS.COLLECTION.TEST}1`]: {id: 'default'}});
            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({early: true});
            expect(fresh.cache.getAllKeys().has(KEYS.PLAIN)).toBe(true);
            expect(fresh.cache.getAllKeys().has(`${KEYS.COLLECTION.TEST}1`)).toBe(true);
            expect(fresh.cache.get(KEYS.OTHER)).toBeUndefined();
        });
    });

    describe('storage read failure, early subscribers', () => {
        it('notifies early subscribers of the defaults before init resolves', async () => {
            jest.spyOn(fresh.Logger, 'logAlert').mockImplementation(() => undefined);
            fresh.storage.getAll.mockImplementationOnce(() => Promise.reject(new Error('disk gone')));
            const resolvedAtCallback: boolean[] = [];
            fresh.Onyx.connect({key: KEYS.PLAIN, callback: () => resolvedAtCallback.push(isInitResolved(fresh))});

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'default'}});

            expect(resolvedAtCallback).toEqual([false]);
        });
    });

    describe('enableDevTools', () => {
        it('hands the initial key states to the Redux DevTools extension', async () => {
            const devToolsInit = jest.fn();
            Object.defineProperty(window, '__REDUX_DEVTOOLS_EXTENSION__', {
                configurable: true,
                value: {connect: () => ({init: devToolsInit, send: jest.fn()})},
            });
            const defaults = {[KEYS.PLAIN]: 'default'};

            try {
                await initAndSettle(fresh, {enableDevTools: true, initialKeyStates: defaults});
            } finally {
                Reflect.deleteProperty(window, '__REDUX_DEVTOOLS_EXTENSION__');
            }

            expect(devToolsInit).toHaveBeenCalledWith(defaults);
        });
    });

    describe('ramOnlyKeys', () => {
        const ramOnlyKeys = [KEYS.RAM_ONLY, KEYS.RAM_ONLY_DEFAULT, KEYS.COLLECTION.RAM_ONLY];

        it('delivers a RAM-only default to early subscribers without persisting it', async () => {
            const ramDefault = record(fresh, KEYS.RAM_ONLY_DEFAULT);

            await initAndSettle(fresh, {ramOnlyKeys, initialKeyStates: {[KEYS.RAM_ONLY_DEFAULT]: {ram: true}}});

            expect(ramDefault.values).toEqual([{ram: true}]);
            expect(fresh.cache.get(KEYS.RAM_ONLY_DEFAULT)).toEqual({ram: true});
            expect(hasStoredKey(fresh, KEYS.RAM_ONLY_DEFAULT)).toBe(false);
        });

        it('delivers early writes to RAM-only keys and collection members without persisting them', async () => {
            const ram = record(fresh, KEYS.RAM_ONLY);
            const ramCollection = record(fresh, KEYS.COLLECTION.RAM_ONLY);
            fresh.Onyx.set(KEYS.RAM_ONLY, 'in memory');
            fresh.Onyx.merge(`${KEYS.COLLECTION.RAM_ONLY}1`, {id: 1});
            fresh.Onyx.set(KEYS.PLAIN, 'persisted');

            await initAndSettle(fresh, {ramOnlyKeys});

            expect(ram.values.at(-1)).toBe('in memory');
            expect(ramCollection.values.at(-1)).toEqual({[`${KEYS.COLLECTION.RAM_ONLY}1`]: {id: 1}});
            expect(hasStoredKey(fresh, KEYS.RAM_ONLY)).toBe(false);
            expect(hasStoredKey(fresh, `${KEYS.COLLECTION.RAM_ONLY}1`)).toBe(false);
            expect(storedValue(fresh, KEYS.PLAIN)).toBe('persisted');
        });

        it('ignores stale stored RAM-only values while keeping stored neighbours', async () => {
            fresh.storage.setMockStore({
                [KEYS.RAM_ONLY]: 'stale',
                [`${KEYS.COLLECTION.RAM_ONLY}1`]: {stale: true},
                [KEYS.PLAIN]: 'stored',
            });
            const ram = record(fresh, KEYS.RAM_ONLY);
            const ramCollection = record(fresh, KEYS.COLLECTION.RAM_ONLY);

            await initAndSettle(fresh, {ramOnlyKeys});

            expect(ram.values).toEqual([undefined]);
            expect(ramCollection.values).toEqual([undefined]);
            expect(fresh.cache.get(KEYS.PLAIN)).toBe('stored');
            expect(fresh.cache.getAllKeys().has(KEYS.RAM_ONLY)).toBe(false);
            expect(storedValue(fresh, KEYS.RAM_ONLY)).toBe('stale');
        });

        it('persists keys that merely share a prefix with a RAM-only plain key', async () => {
            await initAndSettle(fresh, {ramOnlyKeys: [KEYS.NVP]});

            await fresh.Onyx.set(KEYS.NVP, 'ram');
            await fresh.Onyx.set(KEYS.NVP_LONGER, 'disk');

            expect(hasStoredKey(fresh, KEYS.NVP)).toBe(false);
            expect(storedValue(fresh, KEYS.NVP_LONGER)).toBe('disk');
        });
    });

    describe('skippableCollectionMemberIDs', () => {
        const skippable = `${KEYS.COLLECTION.TEST}${SKIP_ID}`;

        it('does not hydrate skipped members but keeps them in storage', async () => {
            fresh.storage.setMockStore({
                [skippable]: {skipped: true},
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
                [`${KEYS.COLLECTION.TEST_LEVEL}${SKIP_ID}`]: {skipped: true},
            });
            const member = record(fresh, skippable);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            const level = record(fresh, KEYS.COLLECTION.TEST_LEVEL);

            await initAndSettle(fresh, {skippableCollectionMemberIDs: [SKIP_ID]});

            expect(fresh.cache.get(skippable)).toBeUndefined();
            expect(fresh.cache.getAllKeys().has(skippable)).toBe(false);
            expect(fresh.cache.getAllKeys().has(`${KEYS.COLLECTION.TEST_LEVEL}${SKIP_ID}`)).toBe(false);
            expect(member.values).toEqual([undefined]);
            expect(collection.values).toEqual([{[`${KEYS.COLLECTION.TEST}1`]: {id: 1}}]);
            expect(level.values).toEqual([undefined]);
            expect(storedValue(fresh, skippable)).toEqual({skipped: true});
        });

        it('only skips exact member IDs of registered collections', async () => {
            fresh.storage.setMockStore({
                [`${KEYS.COLLECTION.TEST}${SKIP_ID}2`]: 'longer id',
                [`${KEYS.COLLECTION.TEST}x${SKIP_ID}`]: 'prefixed id',
                [SKIP_ID]: 'plain key named like the id',
                [`unregistered_${SKIP_ID}`]: 'not a collection',
            });

            await initAndSettle(fresh, {skippableCollectionMemberIDs: [SKIP_ID]});

            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}${SKIP_ID}2`)).toBe('longer id');
            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}x${SKIP_ID}`)).toBe('prefixed id');
            expect(fresh.cache.get(SKIP_ID)).toBe('plain key named like the id');
            expect(fresh.cache.get(`unregistered_${SKIP_ID}`)).toBe('not a collection');
        });

        it('drops every kind of write to a skipped member while writing its siblings', async () => {
            await initAndSettle(fresh, {skippableCollectionMemberIDs: [SKIP_ID]});
            const member = record(fresh, skippable);
            const collection = record(fresh, KEYS.COLLECTION.TEST);
            await waitForPromisesToResolve();

            await fresh.Onyx.set(skippable, {via: 'set'});
            await fresh.Onyx.merge(skippable, {via: 'merge'});
            await fresh.Onyx.multiSet({[skippable]: {via: 'multiSet'}, [`${KEYS.COLLECTION.TEST}1`]: {id: 1}});
            await fresh.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {[skippable]: {via: 'mergeCollection'}, [`${KEYS.COLLECTION.TEST}2`]: {id: 2}});
            await fresh.Onyx.update([
                {onyxMethod: 'merge', key: skippable, value: {via: 'update'}},
                {onyxMethod: 'merge', key: `${KEYS.COLLECTION.TEST}3`, value: {id: 3}},
            ]);
            await waitForPromisesToResolve();

            expect(fresh.cache.get(skippable)).toBeUndefined();
            expect(hasStoredKey(fresh, skippable)).toBe(false);
            expect(member.values.every((value) => value === undefined || value === null)).toBe(true);
            for (const value of collection.values) {
                expect(value ?? {}).not.toHaveProperty(skippable);
            }
            expect(collection.values.at(-1)).toEqual({
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
                [`${KEYS.COLLECTION.TEST}2`]: {id: 2},
                [`${KEYS.COLLECTION.TEST}3`]: {id: 3},
            });
        });

        it('drops a setCollection entry for a skipped member', async () => {
            await initAndSettle(fresh, {skippableCollectionMemberIDs: [SKIP_ID]});

            await fresh.Onyx.setCollection(KEYS.COLLECTION.TEST, {[skippable]: {via: 'setCollection'}, [`${KEYS.COLLECTION.TEST}1`]: {id: 1}});

            expect(fresh.cache.get(skippable)).toBeUndefined();
            expect(hasStoredKey(fresh, skippable)).toBe(false);
            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}1`)).toEqual({id: 1});
        });

        it('drops early writes to a skipped member', async () => {
            fresh.Onyx.set(skippable, {early: true});
            fresh.Onyx.merge(skippable, {early: 'merge'});
            fresh.Onyx.set(`${KEYS.COLLECTION.TEST}1`, {id: 1});

            await initAndSettle(fresh, {skippableCollectionMemberIDs: [SKIP_ID]});

            expect(fresh.cache.get(skippable)).toBeUndefined();
            expect(hasStoredKey(fresh, skippable)).toBe(false);
            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}1`)).toEqual({id: 1});
        });

        it('skips nothing when the list is empty', async () => {
            fresh.storage.setMockStore({[skippable]: {kept: true}});

            await initAndSettle(fresh);
            await fresh.Onyx.merge(skippable, {merged: true});

            expect(fresh.cache.get(skippable)).toEqual({kept: true, merged: true});
        });
    });

    describe('evictableKeys', () => {
        it('seeds exactly the stored keys that match an evictable pattern', async () => {
            fresh.storage.setMockStore({
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
                [`${KEYS.COLLECTION.TEST}2`]: {id: 2},
                [KEYS.NVP]: 'evictable plain',
                [KEYS.NVP_LONGER]: 'not evictable',
                [KEYS.PLAIN]: 'not evictable',
                [`${KEYS.COLLECTION.RAM_ONLY}1`]: 'not evictable',
            });

            await initAndSettle(fresh, {evictableKeys: [KEYS.COLLECTION.TEST, KEYS.NVP]});

            expect(evictionOrder(fresh).sort()).toEqual([`${KEYS.COLLECTION.TEST}1`, `${KEYS.COLLECTION.TEST}2`, KEYS.NVP].sort());
        });

        it('seeds the keys in evictable pattern order, then in storage order', async () => {
            fresh.storage.setMockStore({
                [`${KEYS.COLLECTION.TEST}2`]: {id: 2},
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
                [KEYS.NVP]: 'evictable plain',
            });

            await initAndSettle(fresh, {evictableKeys: [KEYS.NVP, KEYS.COLLECTION.TEST]});

            expect(evictionOrder(fresh)).toEqual([KEYS.NVP, `${KEYS.COLLECTION.TEST}2`, `${KEYS.COLLECTION.TEST}1`]);
        });

        it('treats a nested collection member as a member of the shorter evictable collection', async () => {
            fresh.storage.setMockStore({[`${KEYS.COLLECTION.TEST_LEVEL}1`]: {id: 1}});

            await initAndSettle(fresh, {evictableKeys: [KEYS.COLLECTION.TEST]});

            expect(evictionOrder(fresh)).toEqual([`${KEYS.COLLECTION.TEST_LEVEL}1`]);
        });

        it('does not seed RAM-only or skipped stored keys', async () => {
            fresh.storage.setMockStore({
                [`${KEYS.COLLECTION.TEST}${SKIP_ID}`]: {skipped: true},
                [`${KEYS.COLLECTION.RAM_ONLY}1`]: {ram: true},
                [`${KEYS.COLLECTION.TEST}1`]: {id: 1},
            });

            await initAndSettle(fresh, {
                evictableKeys: [KEYS.COLLECTION.TEST, KEYS.COLLECTION.RAM_ONLY],
                ramOnlyKeys: [KEYS.COLLECTION.RAM_ONLY],
                skippableCollectionMemberIDs: [SKIP_ID],
            });

            expect(evictionOrder(fresh)).toEqual([`${KEYS.COLLECTION.TEST}1`]);
        });

        it('seeds evictable keys that only have a default value', async () => {
            await initAndSettle(fresh, {evictableKeys: [KEYS.NVP], initialKeyStates: {[KEYS.NVP]: 'default'}});

            expect(evictionOrder(fresh)).toEqual([KEYS.NVP]);
        });

        it('has nothing to evict without evictable keys', async () => {
            fresh.storage.setMockStore({[`${KEYS.COLLECTION.TEST}1`]: {id: 1}});

            await initAndSettle(fresh);

            expect(fresh.cache.getKeyForEviction()).toBeUndefined();
        });

        it('moves a seeded key behind the others once it is written after init', async () => {
            fresh.storage.setMockStore({[`${KEYS.COLLECTION.TEST}1`]: {id: 1}, [`${KEYS.COLLECTION.TEST}2`]: {id: 2}});
            await initAndSettle(fresh, {evictableKeys: [KEYS.COLLECTION.TEST]});
            const [firstCandidate, secondCandidate] = evictionOrder(fresh);

            await fresh.Onyx.merge(firstCandidate, {touched: true});

            expect(evictionOrder(fresh)).toEqual([secondCandidate, firstCandidate]);
        });

        it('seeds the keys before init resolves so early writes see them', async () => {
            fresh.storage.setMockStore({[`${KEYS.COLLECTION.TEST}1`]: {id: 1}, [`${KEYS.COLLECTION.TEST}2`]: {id: 2}});
            let candidateAtFirstWrite: OnyxKey | undefined;
            fresh.Onyx.set(KEYS.PLAIN, 'early').then(() => {
                candidateAtFirstWrite = fresh.cache.getKeyForEviction();
            });

            await initAndSettle(fresh, {evictableKeys: [KEYS.COLLECTION.TEST]});

            expect(candidateAtFirstWrite).toBeDefined();
            expect([`${KEYS.COLLECTION.TEST}1`, `${KEYS.COLLECTION.TEST}2`]).toContain(candidateAtFirstWrite);
        });
    });

    describe('snapshotMergeKeys', () => {
        const snapshotKey = `${KEYS.COLLECTION.SNAPSHOT}1`;
        const memberKey = `${KEYS.COLLECTION.TEST}1`;

        async function mergeIntoSnapshottedMember(overrides: Partial<InitOptions>): Promise<unknown> {
            fresh.storage.setMockStore({[snapshotKey]: {data: {[memberKey]: {a: 1}}}, [memberKey]: {a: 1}});
            await initAndSettle(fresh, overrides);
            await fresh.Onyx.update([{onyxMethod: 'merge', key: memberKey, value: {a: 2, pendingAction: 'add', other: 'x'}}]);
            await waitForPromisesToResolve();
            return fresh.cache.get(snapshotKey);
        }

        it('only merges fields the snapshot already has by default', async () => {
            await expect(mergeIntoSnapshottedMember({})).resolves.toEqual({data: {[memberKey]: {a: 2}}});
        });

        it('also merges the configured fields into snapshots', async () => {
            await expect(mergeIntoSnapshottedMember({snapshotMergeKeys: ['pendingAction']})).resolves.toEqual({data: {[memberKey]: {a: 2, pendingAction: 'add'}}});
        });

        it('does not update snapshots when the keys do not declare a snapshot collection', async () => {
            fresh.storage.setMockStore({other_1: {data: {[memberKey]: {a: 1}}}, [memberKey]: {a: 1}});
            await initAndSettle(fresh, {keys: {...KEYS, COLLECTION: {TEST: KEYS.COLLECTION.TEST, OTHER: 'other_'}}, snapshotMergeKeys: ['pendingAction']});

            await fresh.Onyx.update([{onyxMethod: 'merge', key: memberKey, value: {a: 2, pendingAction: 'add'}}]);

            expect(fresh.cache.get('other_1')).toEqual({data: {[memberKey]: {a: 1}}});
        });
    });

    describe('keys option', () => {
        it('only treats keys listed under COLLECTION as collections', async () => {
            fresh.storage.setMockStore({[`${KEYS.COLLECTION.TEST}1`]: {id: 1}, unlisted_1: {id: 'unlisted'}});

            await initAndSettle(fresh);
            const listed = record(fresh, KEYS.COLLECTION.TEST);
            const unlisted = record(fresh, 'unlisted_');
            await waitForPromisesToResolve();

            expect(listed.values).toEqual([{[`${KEYS.COLLECTION.TEST}1`]: {id: 1}}]);
            expect(unlisted.values).toEqual([undefined]);
            expect(unlisted.keys).toEqual([undefined]);
        });
    });

    describe('shouldSyncMultipleInstances', () => {
        it('registers the cross-instance listener only when enabled', async () => {
            await initAndSettle(fresh, {shouldSyncMultipleInstances: false});
            expect(fresh.storage.keepInstancesSync).not.toHaveBeenCalled();

            fresh = loadFreshOnyx();
            await initAndSettle(fresh, {shouldSyncMultipleInstances: true});
            expect(fresh.storage.keepInstancesSync).toHaveBeenCalledTimes(1);
        });

        it('defaults to enabled when localStorage exists', async () => {
            fresh.Onyx.init({keys: KEYS, enableDevTools: false});
            await waitForPromisesToResolve();

            expect(fresh.storage.keepInstancesSync).toHaveBeenCalledTimes(1);
        });

        it('applies a remote batch that honours RAM-only keys configured at init', async () => {
            await initAndSettle(fresh, {shouldSyncMultipleInstances: true, ramOnlyKeys: [KEYS.RAM_ONLY]});
            const onRemoteChange: (pairs: Array<[OnyxKey, unknown]>) => void = fresh.storage.keepInstancesSync.mock.calls[0][0];
            const plain = record(fresh, KEYS.PLAIN);
            const ram = record(fresh, KEYS.RAM_ONLY);
            await waitForPromisesToResolve();

            onRemoteChange([
                [KEYS.PLAIN, 'remote'],
                [KEYS.RAM_ONLY, 'remote ram'],
            ]);

            expect(plain.values.at(-1)).toBe('remote');
            expect(ram.values).toEqual([undefined]);
            expect(fresh.cache.get(KEYS.RAM_ONLY)).toBeUndefined();
        });
    });

    describe('re-init', () => {
        it('re-applies defaults over the current cache and notifies subscribers', async () => {
            await initAndSettle(fresh, {initialKeyStates: {[KEYS.OBJECT]: {a: 'default1'}}});
            await fresh.Onyx.merge(KEYS.OBJECT, {a: 'written', b: 1});
            const object = record(fresh, KEYS.OBJECT);
            await waitForPromisesToResolve();

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.OBJECT]: {a: 'default2'}}});

            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 'default2', b: 1});
            expect(object.values.at(-1)).toEqual({a: 'default2', b: 1});
            expect(storedValue(fresh, KEYS.OBJECT)).toEqual({a: 'written', b: 1});
        });

        it('makes Onyx.clear reset to the latest defaults', async () => {
            await initAndSettle(fresh, {initialKeyStates: {[KEYS.PLAIN]: 'first'}});
            await initAndSettle(fresh, {initialKeyStates: {[KEYS.OTHER]: 'second'}});
            await fresh.Onyx.set(KEYS.PLAIN, 'written');

            await fresh.Onyx.clear();

            expect(fresh.cache.get(KEYS.OTHER)).toBe('second');
            expect(fresh.cache.get(KEYS.PLAIN)).toBeUndefined();
        });

        it('swaps the skippable member IDs', async () => {
            await initAndSettle(fresh, {skippableCollectionMemberIDs: ['old']});
            await initAndSettle(fresh, {skippableCollectionMemberIDs: ['new']});

            await fresh.Onyx.set(`${KEYS.COLLECTION.TEST}old`, 'now allowed');
            await fresh.Onyx.set(`${KEYS.COLLECTION.TEST}new`, 'now skipped');

            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}old`)).toBe('now allowed');
            expect(fresh.cache.get(`${KEYS.COLLECTION.TEST}new`)).toBeUndefined();
        });

        it('swaps the RAM-only keys', async () => {
            await initAndSettle(fresh, {ramOnlyKeys: [KEYS.PLAIN]});
            await initAndSettle(fresh, {ramOnlyKeys: [KEYS.OTHER]});

            await fresh.Onyx.set(KEYS.PLAIN, 'persisted now');
            await fresh.Onyx.set(KEYS.OTHER, 'memory only now');

            expect(storedValue(fresh, KEYS.PLAIN)).toBe('persisted now');
            expect(hasStoredKey(fresh, KEYS.OTHER)).toBe(false);
            expect(fresh.cache.get(KEYS.OTHER)).toBe('memory only now');
        });

        it('swaps the snapshot merge keys', async () => {
            const snapshotKey = `${KEYS.COLLECTION.SNAPSHOT}1`;
            const memberKey = `${KEYS.COLLECTION.TEST}1`;
            fresh.storage.setMockStore({[snapshotKey]: {data: {[memberKey]: {a: 1}}}, [memberKey]: {a: 1}});
            await initAndSettle(fresh, {snapshotMergeKeys: ['pendingAction']});
            await initAndSettle(fresh, {snapshotMergeKeys: []});

            await fresh.Onyx.update([{onyxMethod: 'merge', key: memberKey, value: {a: 2, pendingAction: 'add'}}]);
            await waitForPromisesToResolve();

            expect(fresh.cache.get(snapshotKey)).toEqual({data: {[memberKey]: {a: 2}}});
        });

        it('keeps values written between the two inits', async () => {
            fresh.storage.setMockStore({[KEYS.PLAIN]: 'stored'});
            await initAndSettle(fresh);
            await fresh.Onyx.set(KEYS.PLAIN, 'written');
            await fresh.Onyx.set(KEYS.OTHER, {nested: {a: 1}});

            await initAndSettle(fresh);

            expect(fresh.cache.get(KEYS.PLAIN)).toBe('written');
            expect(fresh.cache.get(KEYS.OTHER)).toEqual({nested: {a: 1}});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('tells early subscribers a default null removed a stored field while the cache keeps it', async () => {
            fresh.storage.setMockStore({[KEYS.OBJECT]: {a: 1, removed: 'stored', nested: {gone: 1, kept: 2}}});
            const object = record(fresh, KEYS.OBJECT);

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.OBJECT]: {removed: null, nested: {gone: null}}}});

            expect(object.values).toEqual([
                {a: 1, nested: {kept: 2}},
                {a: 1, removed: 'stored', nested: {gone: 1, kept: 2}},
            ]);
            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 1, removed: 'stored', nested: {gone: 1, kept: 2}});
        });

        it('calls an early subscriber twice with equal values when the default has a nested object', async () => {
            const object = record(fresh, KEYS.OBJECT);

            await initAndSettle(fresh, {initialKeyStates: {[KEYS.OBJECT]: {nested: {a: 1}}}});

            expect(object.values).toEqual([{nested: {a: 1}}, {nested: {a: 1}}]);
        });

        it('lets a stale storage read during re-init overwrite leaves of a newer write while keeping its other fields', async () => {
            await initAndSettle(fresh);
            const getAll = createDeferred<Array<[OnyxKey, unknown]>>();
            fresh.storage.getAll.mockImplementationOnce(() => getAll.promise);
            fresh.Onyx.init(initOptions());
            await fresh.Onyx.set(KEYS.OBJECT, {a: 'written', b: 'written'});

            getAll.resolve([[KEYS.OBJECT, {a: 'stale'}]]);
            await waitForPromisesToResolve();

            expect(fresh.cache.get(KEYS.OBJECT)).toEqual({a: 'stale', b: 'written'});
        });
    });
});
