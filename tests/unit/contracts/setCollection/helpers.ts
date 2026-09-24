import type {Connection} from '../../../../lib/OnyxConnectionManager';
import type MockedStorage from '../../../../lib/storage/__mocks__';
import type {OnyxKey} from '../../../../lib/types';

import Onyx from '../../../../lib';
import OnyxCache from '../../../../lib/OnyxCache';
import OnyxUtils from '../../../../lib/OnyxUtils';
import Storage from '../../../../lib/storage';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    COLLECTION: {
        ROUTES: 'routes_',
        // Shares the `routes` prefix but not the `routes_` prefix, so it must never be touched by a `routes_` write.
        ROUTES_ARCHIVE: 'routesArchive_',
        OTHER: 'other_',
        TEST: 'test_',
        // Nested under `test_`: every `test_level_*` key also starts with `test_`.
        TEST_LEVEL: 'test_level_',
        RAM_ONLY: 'ramOnlyCollection_',
        EVICTABLE: 'evictable_',
    },
} as const;

const SKIPPABLE_ID = 'skippable-id';

function isMockedStorage(storage: unknown): storage is typeof MockedStorage {
    return typeof storage === 'object' && storage !== null && 'getMockStore' in storage && 'setMockStore' in storage;
}

function getStorageMock(): typeof MockedStorage {
    if (!isMockedStorage(Storage)) {
        throw new Error('lib/storage is expected to resolve to its jest mock');
    }
    return Storage;
}

const StorageMock = getStorageMock();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows a delivered or cached value to an object so members can be compared by reference. */
function toRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`Expected an object, received ${JSON.stringify(value)}`);
    }
    return value;
}

type Delivery = {value: unknown; key: OnyxKey | undefined};

type Recorder = {
    calls: Delivery[];
    connection: Connection;
    values: () => unknown[];
    last: () => unknown;
    reset: () => void;
};

const openConnections: Connection[] = [];

function initOnyx(): Promise<void> {
    Onyx.init({
        keys: KEYS,
        ramOnlyKeys: [KEYS.COLLECTION.RAM_ONLY],
        skippableCollectionMemberIDs: [SKIPPABLE_ID],
        evictableKeys: [KEYS.COLLECTION.EVICTABLE],
    });
    return waitForPromisesToResolve();
}

/** Records every value an `Onyx.connect` callback receives. Call `settle()` before `reset()` to skip the initial delivery. */
function record(key: OnyxKey, onValue?: (value: unknown, matchedKey: OnyxKey | undefined) => void): Recorder {
    const calls: Delivery[] = [];
    const connection = Onyx.connect({
        key,
        callback: (value: unknown, matchedKey: OnyxKey | undefined) => {
            calls.push({value, key: matchedKey});
            onValue?.(value, matchedKey);
        },
    });
    openConnections.push(connection);

    return {
        calls,
        connection,
        values: () => calls.map((call) => call.value),
        last: () => calls.at(-1)?.value,
        reset: () => {
            calls.length = 0;
        },
    };
}

function settle(): Promise<void> {
    return waitForPromisesToResolve();
}

async function resetOnyx(): Promise<void> {
    while (openConnections.length > 0) {
        const connection = openConnections.pop();
        if (connection) {
            Onyx.disconnect(connection);
        }
    }
    await Onyx.clear();
    StorageMock.setMockStore({});
    jest.clearAllMocks();
}

/** Returns a plain copy of every persisted key that starts with the prefix. */
function storedWithPrefix(prefix: string): Record<string, unknown> {
    const store = StorageMock.getMockStore();
    return Object.fromEntries(Object.entries(store).filter(([key]) => key.startsWith(prefix)));
}

/** Returns a plain copy of every cached member of the collection, read key by key. */
function cachedMembers(collectionKey: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of OnyxCache.getAllKeys()) {
        if (isMemberOf(collectionKey, key)) {
            const value = OnyxCache.get(key);
            if (value !== undefined && value !== null) {
                result[key] = value;
            }
        }
    }
    return result;
}

function isMemberOf(collectionKey: string, key: string): boolean {
    return key.startsWith(collectionKey) && key.length > collectionKey.length;
}

/** Reads the collection the way `useOnyx` does on first render. */
function readCollection(collectionKey: string): unknown {
    return OnyxUtils.tryGetCachedValue(collectionKey);
}

/** Returns every key the cache would evict, least recently used first. */
function evictionOrder(): OnyxKey[] {
    const order: OnyxKey[] = [];
    const seen = new Set<OnyxKey>();
    let next = OnyxCache.getKeyForEviction(seen);
    while (next !== undefined) {
        order.push(next);
        seen.add(next);
        next = OnyxCache.getKeyForEviction(seen);
    }
    return order;
}

function createDeferred(): {promise: Promise<void>; resolve: () => void; reject: (error: Error) => void} {
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

// Jest treats every file under tests/unit as a suite, so this file carries its own sanity checks and runs them only as the entry file.
if (expect.getState().testPath === __filename) {
    describe('setCollection contract helpers', () => {
        beforeAll(initOnyx);
        afterEach(resetOnyx);

        it('reads storage and cache by collection without leaking lookalike keys', async () => {
            await Onyx.multiSet({routes_1: {id: 1}, routesArchive_1: {id: 2}});

            expect(storedWithPrefix(KEYS.COLLECTION.ROUTES)).toEqual({routes_1: {id: 1}});
            expect(cachedMembers(KEYS.COLLECTION.ROUTES)).toEqual({routes_1: {id: 1}});
        });

        it('lists evictable keys from least to most recently used', async () => {
            await Onyx.set('evictable_1', {id: 1});
            await Onyx.set('evictable_2', {id: 2});

            expect(evictionOrder()).toEqual(['evictable_1', 'evictable_2']);
        });
    });
}

export {KEYS, SKIPPABLE_ID, StorageMock, isRecord, toRecord, initOnyx, record, settle, resetOnyx, storedWithPrefix, cachedMembers, readCollection, evictionOrder, createDeferred};
export type {Recorder, Delivery};
