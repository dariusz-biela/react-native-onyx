import lodashCloneDeep from 'lodash/cloneDeep';
import type {Connection} from '../../../../lib/OnyxConnectionManager';
import type MockedStorage from '../../../../lib/storage/__mocks__';
import type {OnyxKey, OnyxUpdate} from '../../../../lib/types';

import Onyx from '../../../../lib';
import cache from '../../../../lib/OnyxCache';
import onyxSnapshotCache from '../../../../lib/OnyxSnapshotCache';
import Storage from '../../../../lib/storage';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const ONYX_KEYS = {
    TEST_KEY: 'test',
    OTHER_KEY: 'other',
    WITH_DEFAULT: 'withDefault',
    // Not a collection key even though it contains an underscore.
    NVP_KEY: 'nvp_test',
    RAM_ONLY_KEY: 'ramOnly',
    COLLECTION: {
        A: 'colA_',
        B: 'colB_',
        // `nest_level_` members also start with `nest_`, so the two collections collide on their prefix.
        NEST: 'nest_',
        NEST_LEVEL: 'nest_level_',
        SNAPSHOT: 'snapshot_',
        RAM: 'ramCol_',
    },
} as const;

const DEFAULT_VALUE = 'default';
const SKIPPABLE_ID = 'skippable-id';

type State = Record<string, unknown>;
type Update = OnyxUpdate<OnyxKey>;

const ONYX_METHODS: readonly unknown[] = Object.values(Onyx.METHOD);

function isStorageMock(storage: unknown): storage is typeof MockedStorage {
    return typeof storage === 'object' && storage !== null && 'getMockStore' in storage;
}

function getStorageMock(): typeof MockedStorage {
    if (!isStorageMock(Storage)) {
        throw new Error('The storage module is expected to be mocked in unit tests');
    }
    return Storage;
}

const StorageMock = getStorageMock();

function isUpdate(entry: unknown): entry is Update {
    return typeof entry === 'object' && entry !== null && 'onyxMethod' in entry && ONYX_METHODS.includes(entry.onyxMethod);
}

/** Types a generated entry whose values the static collection types cannot express, such as null collection members. */
function toUpdate(entry: {onyxMethod: string; key: string; value?: unknown}): Update {
    if (!isUpdate(entry)) {
        throw new Error(`Unknown onyxMethod ${entry.onyxMethod}`);
    }
    return entry;
}

function initOnyx(): void {
    Onyx.init({
        keys: ONYX_KEYS,
        initialKeyStates: {[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE},
        ramOnlyKeys: [ONYX_KEYS.RAM_ONLY_KEY, ONYX_KEYS.COLLECTION.RAM],
        skippableCollectionMemberIDs: [SKIPPABLE_ID],
        snapshotMergeKeys: ['pendingAction'],
    });
}

const openConnections: Connection[] = [];

function track(connection: Connection): Connection {
    openConnections.push(connection);
    return connection;
}

async function resetOnyx(): Promise<void> {
    for (const connection of openConnections.splice(0)) {
        Onyx.disconnect(connection);
    }
    await Onyx.clear();
    await waitForPromisesToResolve();
    onyxSnapshotCache.clear();
    onyxSnapshotCache.clearSelectorIds();
    jest.clearAllMocks();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
    return lodashCloneDeep(value);
}

/** Returns every non-nullish value the cache holds, keyed by Onyx key. */
function readCache(): State {
    const state: State = {};
    for (const key of cache.getAllKeys()) {
        const value = cache.get(key);
        if (value !== undefined && value !== null) {
            state[key] = value;
        }
    }
    return state;
}

/** Returns a deep copy of the persisted storage. */
function readStorage(): State {
    const state: State = {};
    for (const [key, value] of Object.entries(StorageMock.getMockStore())) {
        if (value !== undefined && value !== null) {
            state[key] = deepClone(value);
        }
    }
    return state;
}

/** Puts a value in storage and in the key index but not in the value cache, the shape an evicted key has. */
function seedColdKey(key: OnyxKey, value: unknown): void {
    StorageMock.getMockStore()[key] = deepClone(value);
    cache.addKey(key);
}

/** Seeds the state, leaving the keys picked by `isCold` in storage only. */
async function seedPartlyCold(initial: State, isCold: () => boolean): Promise<void> {
    const warm: State = {};
    for (const [key, value] of Object.entries(initial)) {
        if (isCold()) {
            seedColdKey(key, value);
        } else {
            warm[key] = value;
        }
    }
    await Onyx.multiSet(warm);
}

/** Records every value a `connectWithoutView` callback receives. */
function recordConnection(key: OnyxKey): {calls: unknown[]; last: () => unknown} {
    const calls: unknown[] = [];
    track(
        Onyx.connectWithoutView({
            key,
            callback: (value) => {
                calls.push(value);
            },
        }),
    );
    return {calls, last: () => calls.at(-1)};
}

/** Connects and waits until the initial callback has been delivered, then forgets it. */
async function recordConnectionAfterInitial(key: OnyxKey): Promise<{calls: unknown[]; last: () => unknown}> {
    const recorder = recordConnection(key);
    await waitForPromisesToResolve();
    recorder.calls.splice(0);
    return recorder;
}

/** Records every whole-collection value a collection key subscriber receives. */
async function recordCollectionAfterInitial(collectionKey: OnyxKey): Promise<{calls: unknown[]; last: () => unknown}> {
    const calls: unknown[] = [];
    track(
        Onyx.connectWithoutView({
            key: collectionKey,
            callback: (value) => {
                calls.push(deepClone(value));
            },
        }),
    );
    await waitForPromisesToResolve();
    calls.splice(0);
    return {calls, last: () => calls.at(-1)};
}

/** Reads a key through a fresh subscriber, the public read path that falls back from the cache to the storage. */
async function readThroughConnection(key: OnyxKey): Promise<unknown> {
    let received: unknown;
    const connection = Onyx.connectWithoutView({
        key,
        callback: (value) => {
            received = value;
        },
    });
    await waitForPromisesToResolve();
    Onyx.disconnect(connection);
    return received;
}

/** Reads every given key through fresh subscribers and drops the missing ones. */
async function readKeysThroughConnections(keys: readonly string[]): Promise<State> {
    const state: State = {};
    for (const key of keys) {
        const value = await readThroughConnection(key);
        if (value !== undefined && value !== null) {
            state[key] = value;
        }
    }
    return state;
}

export {
    ONYX_KEYS,
    StorageMock,
    toUpdate,
    DEFAULT_VALUE,
    SKIPPABLE_ID,
    initOnyx,
    resetOnyx,
    track,
    isPlainObject,
    deepClone,
    readCache,
    readStorage,
    seedColdKey,
    seedPartlyCold,
    recordConnection,
    recordConnectionAfterInitial,
    recordCollectionAfterInitial,
    readThroughConnection,
    readKeysThroughConnections,
    waitForPromisesToResolve,
    isRunningAsSuite,
};
export type {State, Update};

/** Tells whether the helper module is the test file jest is running, so its self-checks do not run inside importers. */
function isRunningAsSuite(filename: string): boolean {
    return expect.getState().testPath === filename;
}

if (isRunningAsSuite(__filename)) {
    describe('update contract harness', () => {
        beforeAll(initOnyx);
        beforeEach(resetOnyx);

        it('reads written values back from the cache and the storage', async () => {
            await Onyx.set(ONYX_KEYS.TEST_KEY, {a: 1});
            expect(readCache()).toEqual({[ONYX_KEYS.TEST_KEY]: {a: 1}, [ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE});
            expect(readStorage()).toEqual({[ONYX_KEYS.TEST_KEY]: {a: 1}, [ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE});
        });

        it('starts every test from the default state', () => {
            expect(readCache()).toEqual({[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE});
            expect(readStorage()).toEqual({[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE});
        });
    });
}
