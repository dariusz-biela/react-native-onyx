import * as IDB from 'idb-keyval';
import {IDBFactory} from 'fake-indexeddb';
import type OnyxDefault from '../../../../lib';
import type OnyxCacheDefault from '../../../../lib/OnyxCache';
import IDBKeyValProvider from '../../../../lib/storage/providers/IDBKeyValProvider';
import MemoryOnlyProvider from '../../../../lib/storage/providers/MemoryOnlyProvider';
import type StorageFacade from '../../../../lib/storage';
import type StorageProvider from '../../../../lib/storage/providers/types';
import type {InitOptions, OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

type ProviderName = 'MemoryOnlyProvider' | 'IDBKeyValProvider';

type ProviderTarget = {
    name: ProviderName;
    provider: StorageProvider<unknown>;
    /** Leaves the provider initialized over an empty backing store. */
    reset: () => Promise<void>;
    /** Everything the backing store holds, read around the provider API so a provider bug cannot hide itself. */
    readRaw: () => Promise<Record<string, unknown>>;
};

/** Swaps the global IndexedDB factory for an empty one, so no database survives from an earlier test. */
function resetIndexedDB(): void {
    window.indexedDB = new IDBFactory();
}

function readIDBStore(): Promise<Record<string, unknown>> {
    return IDB.entries(IDBKeyValProvider.store).then((entries) => Object.fromEntries(entries.map(([key, value]) => [String(key), value])));
}

const memoryTarget: ProviderTarget = {
    name: 'MemoryOnlyProvider',
    provider: MemoryOnlyProvider,
    reset: () => MemoryOnlyProvider.clear(),
    readRaw: () => Promise.resolve({...MemoryOnlyProvider.store}),
};

const idbTarget: ProviderTarget = {
    name: 'IDBKeyValProvider',
    provider: IDBKeyValProvider,
    reset: () => {
        resetIndexedDB();
        IDBKeyValProvider.init();
        return Promise.resolve();
    },
    readRaw: readIDBStore,
};

const PROVIDER_TARGETS: ProviderTarget[] = [memoryTarget, idbTarget];

/** Sorted copy, for comparing key lists whose order is not part of the contract. */
function sorted(values: readonly string[]): string[] {
    return [...values].sort();
}

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}

/** Lets every queued promise job and one macrotask run. */
function flush(): Promise<void> {
    return waitForPromisesToResolve();
}

type LoadFacadeOptions = {
    /** The provider the facade finds as its platform provider. */
    backend: ProviderName;
    /** `web` swaps in the real cross-tab InstanceSync; `native` keeps the no-op one Jest resolves by default. */
    instanceSync?: 'web' | 'native';
};

type LoadedFacade = {
    storage: typeof StorageFacade;
    platformProvider: StorageProvider<unknown>;
};

/**
 * Loads the real storage facade (not the mock `jestSetup.js` installs) in a fresh module registry, backed by the
 * chosen provider. Onyx modules required after this call in the same test share that registry.
 */
function loadFacade({backend, instanceSync = 'native'}: LoadFacadeOptions): LoadedFacade {
    jest.resetModules();
    resetIndexedDB();

    const providerModule = backend === 'IDBKeyValProvider' ? '../../../../lib/storage/providers/IDBKeyValProvider' : '../../../../lib/storage/providers/MemoryOnlyProvider';
    const platformFactory = () => jest.requireActual<Record<string, unknown>>(providerModule);
    jest.doMock('../../../../lib/storage/platforms/index', platformFactory);
    jest.doMock('../../../../lib/storage/platforms/index.native', platformFactory);
    jest.doMock('../../../../lib/storage', () => jest.requireActual<Record<string, unknown>>('../../../../lib/storage'));

    if (instanceSync === 'web') {
        jest.doMock('../../../../lib/storage/InstanceSync', () => jest.requireActual<Record<string, unknown>>('../../../../lib/storage/InstanceSync/index.web'));
    } else {
        jest.doMock('../../../../lib/storage/InstanceSync', () => jest.requireActual<Record<string, unknown>>('../../../../lib/storage/InstanceSync/index'));
    }

    const storage: typeof StorageFacade = require('../../../../lib/storage').default;
    return {storage, platformProvider: storage.getStorageProvider()};
}

type LoadedOnyx = LoadedFacade & {
    Onyx: typeof OnyxDefault;
    cache: typeof OnyxCacheDefault;
};

const ONYX_KEYS = {
    PLAIN: 'plain',
    OTHER: 'other',
    WITH_DEFAULT: 'withDefault',
    COLLECTION: {
        REPORT: 'report_',
        // Prefix-collides with REPORT: its members also start with 'report_'.
        REPORT_META: 'report_meta_',
    },
} as const;

/**
 * Loads Onyx over the real storage facade and provider, optionally over data a previous session left in the
 * backing store, and waits until Onyx finished loading it.
 */
async function loadOnyx(
    backend: ProviderName,
    seed: Record<string, unknown> = {},
    initOptions: Partial<InitOptions> = {},
    instanceSync: LoadFacadeOptions['instanceSync'] = 'native',
): Promise<LoadedOnyx> {
    const facade = loadFacade({backend, instanceSync});
    const seedPairs = Object.entries(seed);
    if (seedPairs.length > 0) {
        facade.platformProvider.init();
        await facade.platformProvider.multiSet(seedPairs);
    }

    const Onyx: typeof OnyxDefault = require('../../../../lib').default;
    const cache: typeof OnyxCacheDefault = require('../../../../lib/OnyxCache').default;
    Onyx.init({keys: ONYX_KEYS, ...initOptions});
    await flush();

    return {...facade, Onyx, cache};
}

export {PROVIDER_TARGETS, ONYX_KEYS, createDeferred, flush, loadFacade, loadOnyx, resetIndexedDB, sorted};
export type {ProviderName, ProviderTarget, LoadedFacade, LoadedOnyx};

// Jest treats every file under tests/unit as a suite, so the harness checks its own isolation guarantees,
// but only when it runs as its own suite and not in every file that imports it.
if (expect.getState().testPath === __filename) {
    const SELF_CHECK_KEY: OnyxKey = ONYX_KEYS.PLAIN;

    describe('storage contract harness', () => {
        it.each(PROVIDER_TARGETS)('reset leaves $name empty', async (target) => {
            await target.reset();
            await target.provider.setItem(SELF_CHECK_KEY, 'value');

            await target.reset();

            expect(await target.readRaw()).toEqual({});
        });

        it.each<ProviderName>(['MemoryOnlyProvider', 'IDBKeyValProvider'])('every facade load over %s starts from an empty store', async (backend) => {
            const first = loadFacade({backend});
            first.storage.init();
            await first.storage.setItem(SELF_CHECK_KEY, 'value');

            const second = loadFacade({backend});
            second.storage.init();

            expect(second.storage).not.toBe(first.storage);
            expect(second.platformProvider.name).toBe(backend);
            expect(await second.storage.getAllKeys()).toEqual([]);
        });
    });
}
