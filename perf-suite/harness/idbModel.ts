import type {StorageKeyValuePair} from 'react-native-onyx/dist/storage/providers/types';

import provider from 'react-native-onyx/dist/storage/providers/IDBKeyValProvider';

import {getActiveArmFile} from './hotswap/runtime';

/**
 * An in-memory model of the IndexedDB object store behind `IDBKeyValProvider`, for the rows that time what an
 * Onyx write costs on web once it reaches storage. `fake-indexeddb` cannot run the provider's `multiMerge` (see
 * `suites/storage/idb.perf.ts`), and `multiMerge` is what every `mergeCollection` of existing members calls.
 *
 * The provider is the arm's real one; only its `store` (idb-keyval's `UseStore`) is replaced. The model clones
 * every value on get and put, the structured clone a browser runs on the main thread, and fires request and
 * transaction events on microtasks. The backend (LevelDB, IPC, disk) is not modelled, so a transaction costs
 * nothing by itself: the counters are what shows how many of them a write opens.
 */
type UseStore = NonNullable<typeof provider.store>;

type IDBModelCounters = {
    readTransactions: number;
    writeTransactions: number;

    /** Values structured-cloned out of the store. */
    reads: number;

    /** Values structured-cloned into the store. */
    writes: number;
    deletes: number;
};

type IDBModel = {
    counters: IDBModelCounters;
    resetCounters: () => void;

    /** Puts rows straight into the model, uncounted, for the keys a row expects storage to hold already. */
    seed: (pairs: readonly StorageKeyValuePair[]) => void;

    /** Puts the arm's storage mock and provider back the way `installIDBModel` found them. */
    uninstall: () => void;
};

const ROUTED_METHODS = ['getItem', 'multiGet', 'setItem', 'multiSet', 'mergeItem', 'multiMerge', 'removeItem', 'removeItems', 'clear', 'getAllKeys', 'getAll'] as const;

type RoutedMethod = (typeof ROUTED_METHODS)[number];

/**
 * An `IDBRequest` or `IDBTransaction` as idb-keyval's `promisifyRequest` drives it: it assigns the success and
 * complete handlers (sometimes long after the request was made, for a transaction), then waits for one of them.
 */
class FakeRequest {
    readonly result: unknown;

    readonly error = null;

    private handler: ((this: FakeRequest) => void) | undefined;

    private isScheduled = false;

    constructor(result?: unknown) {
        this.result = result;
    }

    set onsuccess(handler: (this: FakeRequest) => void) {
        this.schedule(handler);
    }

    set oncomplete(handler: (this: FakeRequest) => void) {
        this.schedule(handler);
    }

    // Nothing in the model fails, so the error handlers are accepted and never called.
    set onerror(handler: unknown) {}

    set onabort(handler: unknown) {}

    private schedule(handler: (this: FakeRequest) => void): void {
        this.handler = handler;

        if (this.isScheduled) {
            return;
        }
        this.isScheduled = true;
        queueMicrotask(() => this.handler?.call(this));
    }
}

function createFakeObjectStore(rows: Map<string, unknown>, counters: IDBModelCounters) {
    return {
        transaction: new FakeRequest(),
        get: (key: string) => {
            counters.reads++;
            return new FakeRequest(structuredClone(rows.get(key)));
        },
        put: (value: unknown, key: string) => {
            counters.writes++;
            rows.set(key, structuredClone(value));
            return new FakeRequest(key);
        },
        delete: (key: string) => {
            counters.deletes++;
            rows.delete(key);
            return new FakeRequest();
        },
        clear: () => {
            rows.clear();
            return new FakeRequest();
        },
        getAll: () => {
            counters.reads += rows.size;
            return new FakeRequest(Array.from(rows.values(), (value) => structuredClone(value)));
        },
        getAllKeys: () => new FakeRequest(Array.from(rows.keys())),
    };
}

/** idb-keyval's `createStore` result: one transaction per call, handed to the callback after a microtask hop. */
function createFakeUseStore(rows: Map<string, unknown>, counters: IDBModelCounters): UseStore {
    return (txMode, callback) => {
        if (txMode === 'readwrite') {
            counters.writeTransactions++;
        } else {
            counters.readTransactions++;
        }

        const objectStore = createFakeObjectStore(rows, counters);

        // The model implements only the IDBObjectStore members idb-keyval and IDBKeyValProvider call; the
        // rest of the interface (indexes, cursors, key ranges) has no caller here to implement it for.
        return Promise.resolve().then(() => callback(objectStore as unknown as IDBObjectStore));
    };
}

/**
 * The active arm's own storage mock. Through the hot-swap shim a method comes back as a late-bound wrapper,
 * not the `jest.fn` itself, so the mock module is required from the arm's directory.
 */
function loadActiveStorageMock(): Map<RoutedMethod, jest.Mock> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded: unknown = require(getActiveArmFile('storage/index.js'));
    const storage: unknown = typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : undefined;
    const methods = new Map<RoutedMethod, jest.Mock>();

    for (const name of ROUTED_METHODS) {
        const method: unknown = typeof storage === 'object' && storage !== null ? Reflect.get(storage, name) : undefined;

        if (!jest.isMockFunction(method)) {
            throw new Error(`installIDBModel: Storage.${name} of the active arm is not a jest mock; is the storage layer mocked?`);
        }
        methods.set(name, method);
    }

    return methods;
}

/**
 * Routes the active arm's storage layer through its `IDBKeyValProvider` on an empty model. Seed Onyx first,
 * while the in-memory mock is still in place, then `seed` the model with only the keys the row touches.
 */
function installIDBModel(): IDBModel {
    const rows = new Map<string, unknown>();
    const counters: IDBModelCounters = {readTransactions: 0, writeTransactions: 0, reads: 0, writes: 0, deletes: 0};
    const storageMock = loadActiveStorageMock();
    const previousStore = provider.store;
    const previousImplementations = new Map<RoutedMethod, ReturnType<jest.Mock['getMockImplementation']>>();

    provider.store = createFakeUseStore(rows, counters);

    for (const [name, method] of storageMock) {
        previousImplementations.set(name, method.getMockImplementation());
        method.mockImplementation(provider[name]);
    }

    return {
        counters,
        resetCounters: () => {
            counters.readTransactions = 0;
            counters.writeTransactions = 0;
            counters.reads = 0;
            counters.writes = 0;
            counters.deletes = 0;
        },
        seed: (pairs) => {
            for (const [key, value] of pairs) {
                rows.set(key, structuredClone(value));
            }
        },
        uninstall: () => {
            for (const [name, method] of storageMock) {
                method.mockImplementation(previousImplementations.get(name));
            }
            provider.store = previousStore;
        },
    };
}

export default installIDBModel;
export type {IDBModel, IDBModelCounters};
