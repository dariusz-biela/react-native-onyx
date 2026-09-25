import type OnyxDefault from '../../../../lib';
import type OnyxCache from '../../../../lib/OnyxCache';
import type OnyxUtilsDefault from '../../../../lib/OnyxUtils';
import type StorageMock from '../../../../lib/storage/__mocks__';
import type {InitOptions, OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    PLAIN_2: 'plain2',
    FALSY: 'falsy',
    RAM_ONLY: 'ramOnly',
    COLLECTION: {
        REPORT: 'report_',
        // Prefix-collides with REPORT: its members also start with 'report_'.
        REPORT_NESTED: 'report_nested_',
        // Shares the 'report' prefix without the underscore boundary.
        REPORT_ACTIONS: 'reportActions_',
        EMPTY: 'empty_',
        RAM_ONLY: 'ramCollection_',
    },
} as const;

const SKIPPABLE_ID = 'skipped';

type OnyxModules = {
    Onyx: typeof OnyxDefault;
    cache: typeof OnyxCache;
    storage: typeof StorageMock;
    OnyxUtils: typeof OnyxUtilsDefault;
};

type StartOptions = Omit<InitOptions, 'keys'> & {
    storedValues?: Record<string, unknown>;
};

/** Returns Onyx modules from a fresh module registry so no state leaks between tests. */
function loadFreshOnyx(): OnyxModules {
    jest.resetModules();

    return {
        Onyx: require('../../../../lib').default,
        cache: require('../../../../lib/OnyxCache').default,
        storage: require('../../../../lib/storage').default,
        OnyxUtils: require('../../../../lib/OnyxUtils').default,
    };
}

/** Loads fresh Onyx, seeds storage as a previous session would have left it, runs init and waits for it. */
async function startOnyx({storedValues = {}, ...initOptions}: StartOptions = {}): Promise<OnyxModules> {
    const modules = loadFreshOnyx();
    const pairs = Object.entries(storedValues);
    if (pairs.length > 0) {
        await modules.storage.multiSet(pairs);
    }
    modules.Onyx.init({
        keys: KEYS,
        ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.COLLECTION.RAM_ONLY],
        skippableCollectionMemberIDs: [SKIPPABLE_ID],
        ...initOptions,
    });
    await waitForPromisesToResolve();
    modules.storage.getItem.mockClear();
    modules.storage.multiGet.mockClear();
    modules.storage.getAllKeys.mockClear();
    return modules;
}

/** Forgets the cached value of a key that is still indexed, as eviction or a cross-instance write leaves it. */
function makeCold(modules: OnyxModules, key: OnyxKey): void {
    modules.cache.drop(key);
    modules.cache.addKey(key);
}

type Deferred = {promise: Promise<void>; resolve: () => void};

function createDeferred(): Deferred {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}

/**
 * Holds the next Storage.getItem call: it reads storage when called (like a real read transaction that
 * started before later writes) but only delivers the result once `release` is called.
 */
function holdNextGetItem(storage: typeof StorageMock): () => void {
    const gate = createDeferred();
    const read = storage.getItem.getMockImplementation();
    if (!read) {
        throw new Error('Storage.getItem has no implementation to wrap');
    }
    storage.getItem.mockImplementationOnce((key: OnyxKey) => {
        const snapshot = read(key);
        return gate.promise.then(() => snapshot);
    });
    return gate.resolve;
}

/** Same as `holdNextGetItem`, for the next Storage.multiGet call. */
function holdNextMultiGet(storage: typeof StorageMock): () => void {
    const gate = createDeferred();
    const read = storage.multiGet.getMockImplementation();
    if (!read) {
        throw new Error('Storage.multiGet has no implementation to wrap');
    }
    storage.multiGet.mockImplementationOnce((keys: OnyxKey[]) => {
        const snapshot = read(keys);
        return gate.promise.then(() => snapshot);
    });
    return gate.resolve;
}

/** Every key Storage.getItem and Storage.multiGet were asked for since the last mockClear. */
function keysReadFromStorage(storage: typeof StorageMock): OnyxKey[] {
    const single = storage.getItem.mock.calls.map((call: unknown[]) => call[0] as OnyxKey);
    const multi = storage.multiGet.mock.calls.flatMap((call: unknown[]) => call[0] as OnyxKey[]);
    return [...single, ...multi];
}

function countStorageReadsOf(storage: typeof StorageMock, key: OnyxKey): number {
    return keysReadFromStorage(storage).filter((readKey) => readKey === key).length;
}

export {KEYS, SKIPPABLE_ID, loadFreshOnyx, startOnyx, makeCold, createDeferred, holdNextGetItem, holdNextMultiGet, keysReadFromStorage, countStorageReadsOf};
export type {OnyxModules, StartOptions};

// Jest collects every file under tests/unit as a suite, so this helper checks itself only when run as the suite.
if (expect.getState().testPath === __filename) {
    describe('cachedReads harness', () => {
        it('gives every start its own Onyx state and a warm cache', async () => {
            const first = await startOnyx({storedValues: {[KEYS.PLAIN]: 'first'}});
            expect(first.cache.get(KEYS.PLAIN)).toBe('first');
            await first.Onyx.set(KEYS.PLAIN_2, 'written in first');

            const second = await startOnyx();
            expect(second.Onyx).not.toBe(first.Onyx);
            expect(second.cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(second.cache.get(KEYS.PLAIN_2)).toBeUndefined();
            expect(await second.storage.getItem(KEYS.PLAIN)).toBeNull();
        });

        it('holds a storage read until released and delivers the value storage had when the read started', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: 'old'}});
            const release = holdNextGetItem(modules.storage);
            let delivered: unknown = 'pending';
            modules.storage.getItem(KEYS.PLAIN).then((value: unknown) => {
                delivered = value;
            });
            await modules.storage.setItem(KEYS.PLAIN, 'new');
            await waitForPromisesToResolve();
            expect(delivered).toBe('pending');

            release();
            await waitForPromisesToResolve();
            expect(delivered).toBe('old');
        });
    });
}
