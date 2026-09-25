import type * as LoggerModule from '../../../../lib/Logger';
import type StorageProvider from '../../../../lib/storage/providers/types';
import type {StorageKeyValuePair} from '../../../../lib/storage/providers/types';
import {StorageErrorClass} from '../../../../lib/storage/errors';
import type {ProviderName} from './harness';
import {flush, loadFacade, sorted} from './harness';
import type {OnyxKey} from '../../../../lib/types';

const KEY: OnyxKey = 'plain';
const OTHER: OnyxKey = 'other';
const MEMBER_1: OnyxKey = 'test_1';
const MEMBER_10: OnyxKey = 'test_10';
type LogData = Parameters<Parameters<typeof LoggerModule.registerLogger>[0]>[0];

const BACKENDS: ProviderName[] = ['MemoryOnlyProvider', 'IDBKeyValProvider'];

type FacadeMethod = 'getItem' | 'multiGet' | 'setItem' | 'multiSet' | 'mergeItem' | 'multiMerge' | 'removeItem' | 'removeItems' | 'clear' | 'getAllKeys' | 'getAll' | 'getDatabaseSize';

const FACADE_METHODS: FacadeMethod[] = [
    'getItem',
    'multiGet',
    'setItem',
    'multiSet',
    'mergeItem',
    'multiMerge',
    'removeItem',
    'removeItems',
    'clear',
    'getAllKeys',
    'getAll',
    'getDatabaseSize',
];

type Callable = Pick<StorageProvider<unknown>, FacadeMethod>;

/** Calls one method with arguments that are valid for it. */
function callMethod(target: Callable, method: FacadeMethod): Promise<unknown> {
    switch (method) {
        case 'getItem':
            return target.getItem(KEY);
        case 'multiGet':
            return target.multiGet([KEY]);
        case 'setItem':
            return target.setItem(KEY, 'value');
        case 'multiSet':
            return target.multiSet([[KEY, 'value']]);
        case 'mergeItem':
            return target.mergeItem(KEY, {a: 1});
        case 'multiMerge':
            return target.multiMerge([[KEY, {a: 1}]]);
        case 'removeItem':
            return target.removeItem(KEY);
        case 'removeItems':
            return target.removeItems([KEY]);
        case 'clear':
            return target.clear();
        case 'getAllKeys':
            return target.getAllKeys();
        case 'getAll':
            return target.getAll();
        case 'getDatabaseSize':
            return target.getDatabaseSize();
        default:
            return Promise.reject(new Error(`Unknown method ${String(method)}`));
    }
}

/** Collects what the storage layer logs, through the Logger of the registry the facade was loaded in. */
function captureLogs(): LogData[] {
    const logs: LogData[] = [];
    const {registerLogger} = jest.requireActual<typeof LoggerModule>('../../../../lib/Logger');
    registerLogger((data) => logs.push(data));
    return logs;
}

function silenceConsoleError(): void {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe.each(BACKENDS)('storage facade over %s', (backend) => {
    describe('initialization gate', () => {
        it.each(FACADE_METHODS.filter((method) => method !== 'getDatabaseSize'))('%s does not reach the provider before init', async (method) => {
            const {storage, platformProvider} = loadFacade({backend});
            const spy = jest.spyOn(platformProvider, method);

            const pending = callMethod(storage, method);
            await flush();
            expect(spy).not.toHaveBeenCalled();

            storage.init();
            await pending;
            expect(spy).toHaveBeenCalled();
        });

        it('runs writes queued before init in call order once init finishes', async () => {
            const {storage} = loadFacade({backend});

            const writes = [storage.setItem(KEY, 1), storage.mergeItem(KEY, {a: 1}), storage.multiSet([[OTHER, 'other']]), storage.removeItem(OTHER)];
            storage.init();
            await Promise.all(writes);

            expect(await storage.getItem(KEY)).toEqual({a: 1});
            expect(await storage.getAllKeys()).toEqual([KEY]);
        });

        it('a failing init that is not a degrade trigger still releases waiting operations and keeps the provider', async () => {
            const {storage, platformProvider} = loadFacade({backend});
            const logs = captureLogs();
            const realInit = platformProvider.init;
            jest.spyOn(platformProvider, 'init').mockImplementation(() => {
                realInit();
                throw new Error('boom');
            });

            const pending = storage.setItem(KEY, 'value');
            storage.init();
            await pending;

            expect(storage.getStorageProvider()).toBe(platformProvider);
            expect(await storage.getItem(KEY)).toBe('value');
            expect(logs.some((log) => log.level === 'alert' && log.message.includes('boom'))).toBe(true);
        });
    });

    describe('errors', () => {
        it.each(FACADE_METHODS)('%s turns a synchronous provider throw into a rejection with the same error', async (method) => {
            const {storage, platformProvider} = loadFacade({backend});
            storage.init();
            const error = new Error('sync failure');
            jest.spyOn(platformProvider, method).mockImplementation(() => {
                throw error;
            });

            let pending: Promise<unknown> = Promise.resolve();
            expect(() => {
                pending = callMethod(storage, method);
            }).not.toThrow();

            await expect(pending).rejects.toBe(error);
        });

        it('passes an ordinary provider rejection through and keeps using the provider', async () => {
            const {storage, platformProvider} = loadFacade({backend});
            storage.init();
            const error = new Error('write failed');
            jest.spyOn(platformProvider, 'setItem').mockRejectedValueOnce(error);

            await expect(storage.setItem(KEY, 'lost')).rejects.toBe(error);

            expect(storage.getStorageProvider()).toBe(platformProvider);
            await storage.setItem(KEY, 'kept');
            expect(await storage.getItem(KEY)).toBe('kept');
        });

        it('falls back to memory after a store-creation error during an operation and still rejects that operation', async () => {
            silenceConsoleError();
            const {storage, platformProvider} = loadFacade({backend});
            storage.init();
            await storage.setItem(OTHER, 'persisted before the failure');
            const error = new Error('IDBKeyVal store could not be created');
            jest.spyOn(platformProvider, 'getItem').mockRejectedValueOnce(error);

            await expect(storage.getItem(KEY)).rejects.toBe(error);

            expect(storage.getStorageProvider().name).toBe('MemoryOnlyProvider');
            await storage.setItem(KEY, 'in memory');
            expect(await storage.getItem(KEY)).toBe('in memory');
        });
    });

    describe('round trips through the facade', () => {
        it('returns null for a key that was never written', async () => {
            const {storage} = loadFacade({backend});
            storage.init();

            expect(await storage.getItem(KEY)).toBeNull();
        });

        it('writes, merges, reads and removes like the provider', async () => {
            const {storage} = loadFacade({backend});
            storage.init();

            await storage.setItem(KEY, {a: 1, nested: {b: 2}});
            await storage.multiSet([
                [MEMBER_1, {id: 1}],
                [MEMBER_10, {id: 10}],
            ]);
            await storage.mergeItem(KEY, {nested: {b: null, c: 3}});
            await storage.multiMerge([
                [MEMBER_1, {name: 'one'}],
                [OTHER, {created: true}],
            ]);

            expect(await storage.getItem(KEY)).toEqual({a: 1, nested: {c: 3}});
            expect(await storage.multiGet([MEMBER_10, MEMBER_1])).toEqual([
                [MEMBER_10, {id: 10}],
                [MEMBER_1, {id: 1, name: 'one'}],
            ]);
            expect(sorted(await storage.getAllKeys())).toEqual(sorted([KEY, MEMBER_1, MEMBER_10, OTHER]));

            await storage.removeItem(MEMBER_10);
            await storage.removeItems([OTHER]);
            const all: StorageKeyValuePair[] = await storage.getAll();
            expect(Object.fromEntries(all)).toEqual({[KEY]: {a: 1, nested: {c: 3}}, [MEMBER_1]: {id: 1, name: 'one'}});

            await storage.clear();
            expect(await storage.getAll()).toEqual([]);
        });

        it('forwards replace-null patches to the provider mergeItem', async () => {
            const {storage, platformProvider} = loadFacade({backend});
            storage.init();
            const spy = jest.spyOn(platformProvider, 'mergeItem');
            const patches: Array<[string[], Record<string, unknown>]> = [[['nested'], {b: 2}]];

            await storage.mergeItem(KEY, {nested: {b: 2}}, patches);

            expect(spy).toHaveBeenCalledWith(KEY, {nested: {b: 2}}, patches);
        });

        it('keepInstancesSync is a no-op when the platform has no instance sync', async () => {
            const {storage} = loadFacade({backend});
            storage.init();
            const localStorageSpy = jest.spyOn(Storage.prototype, 'setItem');
            const callback = jest.fn();

            storage.keepInstancesSync?.(callback);
            await storage.setItem(KEY, 'value');
            await storage.clear();
            await flush();

            expect(localStorageSpy).not.toHaveBeenCalled();
            expect(callback).not.toHaveBeenCalled();
        });
    });
});

describe('storage facade over IDBKeyValProvider without IndexedDB', () => {
    it('degrades to memory at init, keeps working and keeps classifying with the IndexedDB classifier', async () => {
        silenceConsoleError();
        const {storage} = loadFacade({backend: 'IDBKeyValProvider'});
        const logs = captureLogs();
        const original = window.indexedDB;
        Reflect.deleteProperty(window, 'indexedDB');
        try {
            const pending = storage.setItem(KEY, 'queued before init');
            storage.init();
            await pending;

            expect(storage.getStorageProvider().name).toBe('MemoryOnlyProvider');
            expect(await storage.getItem(KEY)).toBe('queued before init');
            expect(storage.classifyError(new DOMException('full', 'QuotaExceededError'))).toBe(StorageErrorClass.CAPACITY);
            expect(logs.some((log) => log.level === 'alert')).toBe(false);
        } finally {
            window.indexedDB = original;
        }
    });

    it('degrades when an operation reports IndexedDB as unavailable', async () => {
        silenceConsoleError();
        const {storage, platformProvider} = loadFacade({backend: 'IDBKeyValProvider'});
        storage.init();
        await storage.getAllKeys();
        const error = new Error('indexedDB is not available in this environment');
        jest.spyOn(platformProvider, 'multiSet').mockRejectedValueOnce(error);

        await expect(storage.multiSet([[KEY, 'lost']])).rejects.toBe(error);

        expect(storage.getStorageProvider().name).toBe('MemoryOnlyProvider');
    });

    it('does not degrade on a quota error', async () => {
        const {storage, platformProvider} = loadFacade({backend: 'IDBKeyValProvider'});
        storage.init();
        const error = new DOMException('full', 'QuotaExceededError');
        jest.spyOn(platformProvider, 'setItem').mockRejectedValueOnce(error);

        await expect(storage.setItem(KEY, 'lost')).rejects.toBe(error);

        expect(storage.getStorageProvider()).toBe(platformProvider);
        expect(storage.classifyError(error)).toBe(StorageErrorClass.CAPACITY);
    });
});
