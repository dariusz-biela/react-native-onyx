import type * as LoggerModule from '../../../../lib/Logger';
import type {LoadedFacade, ProviderName} from './harness';
import {createDeferred, flush, loadFacade, sorted} from './harness';
import type {OnyxKey} from '../../../../lib/types';

const SYNC_ONYX = 'SYNC_ONYX';
const MAX_SYNC_PAYLOAD_LENGTH = 1_000_000;
const KEY: OnyxKey = 'plain';
const OTHER: OnyxKey = 'other';
const MEMBER_1: OnyxKey = 'test_1';
const MEMBER_10: OnyxKey = 'test_10';
const BACKENDS: ProviderName[] = ['MemoryOnlyProvider', 'IDBKeyValProvider'];

type WriteMethod = 'setItem' | 'mergeItem' | 'removeItem' | 'multiSet' | 'multiMerge' | 'removeItems';

type WriteCase = {
    method: WriteMethod;
    run: (storage: LoadedFacade['storage']) => Promise<unknown>;
    /** The exact SYNC_ONYX value other tabs receive. */
    payload: string;
};

const WRITE_CASES: WriteCase[] = [
    {method: 'setItem', run: (storage) => storage.setItem(KEY, 'value'), payload: KEY},
    {method: 'mergeItem', run: (storage) => storage.mergeItem(KEY, {a: 1}), payload: KEY},
    {method: 'removeItem', run: (storage) => storage.removeItem(KEY), payload: KEY},
    {
        method: 'multiSet',
        run: (storage) =>
            storage.multiSet([
                [MEMBER_10, 10],
                [KEY, 'value'],
                [MEMBER_1, 1],
            ]),
        payload: JSON.stringify([MEMBER_10, KEY, MEMBER_1]),
    },
    {
        method: 'multiMerge',
        run: (storage) =>
            storage.multiMerge([
                [MEMBER_1, {a: 1}],
                [KEY, {b: 2}],
            ]),
        payload: JSON.stringify([MEMBER_1, KEY]),
    },
    {method: 'removeItems', run: (storage) => storage.removeItems([OTHER, MEMBER_1]), payload: JSON.stringify([OTHER, MEMBER_1])},
];

/** Records SYNC_ONYX values written to localStorage, which is what other tabs observe as storage events. */
function recordSyncEvents(): string[] {
    const events: string[] = [];
    const realSetItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function recordSetItem(this: Storage, key: string, value: string) {
        if (key === SYNC_ONYX) {
            events.push(value);
        }
        realSetItem.call(this, key, value);
    });
    return events;
}

const storageListeners: EventListenerOrEventListenerObject[] = [];

/** Keeps the storage listeners InstanceSync adds, so each test can remove its own. */
function trackStorageListeners(): void {
    const realAddEventListener = window.addEventListener.bind(window);
    jest.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === 'storage') {
            storageListeners.push(listener);
        }
        realAddEventListener(type, listener, options);
    });
}

function dispatchSyncEvent(newValue: string | null, key: string | null = SYNC_ONYX): void {
    window.dispatchEvent(new StorageEvent('storage', {key, newValue}));
}

beforeEach(() => {
    trackStorageListeners();
    localStorage.clear();
});

afterEach(() => {
    for (const listener of storageListeners.splice(0)) {
        window.removeEventListener('storage', listener);
    }
    jest.restoreAllMocks();
});

describe.each(BACKENDS)('instance sync through the facade over %s', (backend) => {
    type SyncedFacade = LoadedFacade & {
        /** Runs the batching timer, then waits for the reads it started and the callback after them. */
        deliver: () => Promise<void>;
    };

    function loadSyncedFacade(callback: jest.Mock = jest.fn()): SyncedFacade {
        const facade = loadFacade({backend, instanceSync: 'web'});
        facade.storage.init();
        facade.storage.keepInstancesSync?.(callback);

        const reads: Array<Promise<unknown>> = [];
        const realMultiGet = facade.storage.multiGet;
        jest.spyOn(facade.storage, 'multiGet').mockImplementation((keys) => {
            const read = realMultiGet(keys);
            reads.push(read);
            return read;
        });

        const deliver = async () => {
            await flush();
            await Promise.all(reads.splice(0));
            await flush();
        };
        return {...facade, deliver};
    }

    describe('sending', () => {
        it.each(WRITE_CASES)('$method raises one event with the changed keys', async ({run, payload}) => {
            const {storage} = loadSyncedFacade();
            await storage.multiSet([
                [OTHER, 'other'],
                [MEMBER_1, 1],
            ]);
            const events = recordSyncEvents();

            await run(storage);

            expect(events).toEqual([payload]);
        });

        it.each(WRITE_CASES)('$method raises its event only after the provider write resolved', async ({method, run, payload}) => {
            const {storage, platformProvider} = loadSyncedFacade();
            const events = recordSyncEvents();
            const write = createDeferred<void>();
            jest.spyOn(platformProvider, method).mockImplementation(() => write.promise);

            const pending = run(storage);
            await flush();
            expect(events).toEqual([]);

            write.resolve();
            await pending;
            expect(events).toEqual([payload]);
        });

        it('raises no event for a write the provider rejected', async () => {
            const {storage, platformProvider} = loadSyncedFacade();
            const events = recordSyncEvents();
            jest.spyOn(platformProvider, 'setItem').mockRejectedValueOnce(new Error('write failed'));

            await expect(storage.setItem(KEY, 'value')).rejects.toThrow('write failed');

            expect(events).toEqual([]);
        });

        it('removes the SYNC_ONYX entry again, so the same key written twice raises two events', async () => {
            const {storage} = loadSyncedFacade();
            const events = recordSyncEvents();

            await storage.setItem(KEY, 1);
            expect(localStorage.getItem(SYNC_ONYX)).toBeNull();
            await storage.setItem(KEY, 2);

            expect(events).toEqual([KEY, KEY]);
            expect(localStorage.getItem(SYNC_ONYX)).toBeNull();
        });

        it('raises no event for an empty batch', async () => {
            const {storage} = loadSyncedFacade();
            const events = recordSyncEvents();

            await storage.multiSet([]);
            await storage.multiMerge([]);
            await storage.removeItems([]);

            expect(events).toEqual([]);
        });

        it('clear raises the keys that existed before it, after they are gone', async () => {
            const {storage, platformProvider} = loadSyncedFacade();
            await storage.multiSet([
                [KEY, 'value'],
                [MEMBER_1, 1],
                [MEMBER_10, 10],
            ]);
            const events = recordSyncEvents();
            const clearSpy = jest.spyOn(platformProvider, 'clear');

            await storage.clear();

            expect(clearSpy).toHaveBeenCalled();
            expect(events).toHaveLength(1);
            expect(sorted(JSON.parse(events[0]))).toEqual(sorted([KEY, MEMBER_1, MEMBER_10]));
            expect(await storage.getAllKeys()).toEqual([]);
        });

        it('clear raises its event only after the provider clear resolved', async () => {
            const {storage, platformProvider} = loadSyncedFacade();
            await storage.setItem(KEY, 'value');
            const events = recordSyncEvents();
            const cleared = createDeferred<void>();
            jest.spyOn(platformProvider, 'clear').mockImplementation(() => cleared.promise);

            const pending = storage.clear();
            await flush();
            expect(events).toEqual([]);

            cleared.resolve();
            await pending;
            expect(events).toEqual([JSON.stringify([KEY])]);
        });

        it('clear on an empty store raises nothing', async () => {
            const {storage} = loadSyncedFacade();
            const events = recordSyncEvents();

            await storage.clear();

            expect(events).toEqual([]);
        });

        it('splits a very large batch into payloads under the size limit that together list every key in order', async () => {
            const {storage} = loadSyncedFacade();
            const keys = Array.from({length: 1100}, (_, index) => `test_${String(index).padStart(4, '0')}_${'x'.repeat(1000)}`);
            const events = recordSyncEvents();

            await storage.removeItems(keys);

            expect(events.length).toBeGreaterThan(1);
            for (const event of events) {
                expect(event.length).toBeLessThanOrEqual(MAX_SYNC_PAYLOAD_LENGTH);
            }
            expect(events.flatMap((event) => JSON.parse(event))).toEqual(keys);
        });

        it('fills each payload with as many keys as fit before starting the next one', async () => {
            const {storage} = loadSyncedFacade();
            // 999 keys whose JSON array is exactly 999,999 chars, one below the limit, then one more key.
            const keys = [...Array.from({length: 998}, (_, index) => `test_${String(index).padStart(4, '0')}_${'x'.repeat(988)}`), `test_last_${'y'.repeat(987)}`, 'test_next'];
            const events = recordSyncEvents();

            await storage.removeItems(keys);

            expect(events.map((event) => JSON.parse(event).length)).toEqual([999, 1]);
            expect(events[0]).toHaveLength(MAX_SYNC_PAYLOAD_LENGTH - 1);
        });

        it('a failing localStorage signal is logged and does not fail the write', async () => {
            const {storage} = loadSyncedFacade();
            const logs: string[] = [];
            const {registerLogger} = jest.requireActual<typeof LoggerModule>('../../../../lib/Logger');
            registerLogger(({level, message}) => logs.push(`${level}: ${message}`));
            jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new DOMException('full', 'QuotaExceededError');
            });

            await expect(storage.setItem(KEY, 'value')).resolves.toBeUndefined();
            await expect(storage.multiSet([[OTHER, 'value']])).resolves.toBeUndefined();

            expect(await storage.getItem(KEY)).toBe('value');
            expect(logs.filter((log) => log.startsWith('alert: [Onyx] [InstanceSync] Failed to raise storage sync event'))).toHaveLength(2);
        });

        it('raises nothing when keepInstancesSync was never called', async () => {
            const {storage} = loadFacade({backend, instanceSync: 'web'});
            storage.init();
            const events = recordSyncEvents();

            await storage.setItem(KEY, 'value');
            await storage.multiSet([[OTHER, 'value']]);
            await storage.clear();

            expect(events).toEqual([]);
        });
    });

    describe('receiving', () => {
        it('reads the keys of a batched event through the facade and hands the pairs to the callback', async () => {
            const callback = jest.fn();
            const {storage, deliver} = loadSyncedFacade(callback);
            await storage.multiSet([
                [MEMBER_1, {id: 1}],
                [KEY, 'value'],
            ]);

            dispatchSyncEvent(JSON.stringify([MEMBER_1, KEY]));
            await deliver();

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith([
                [MEMBER_1, {id: 1}],
                [KEY, 'value'],
            ]);
        });

        it('accepts the single raw key format', async () => {
            const callback = jest.fn();
            const {storage, deliver} = loadSyncedFacade(callback);
            await storage.setItem(KEY, {a: 1});

            dispatchSyncEvent(KEY);
            await deliver();

            expect(callback).toHaveBeenCalledWith([[KEY, {a: 1}]]);
        });

        it('coalesces events raised in the same tick into one callback without duplicates', async () => {
            const callback = jest.fn();
            const {storage, deliver} = loadSyncedFacade(callback);
            await storage.multiSet([
                [KEY, 'value'],
                [MEMBER_1, 1],
                [MEMBER_10, 10],
            ]);

            dispatchSyncEvent(KEY);
            dispatchSyncEvent(JSON.stringify([MEMBER_1, KEY]));
            dispatchSyncEvent(JSON.stringify([MEMBER_10]));
            await deliver();

            expect(callback).toHaveBeenCalledTimes(1);
            const [pairs] = callback.mock.calls[0];
            expect(Object.fromEntries(pairs)).toEqual({[KEY]: 'value', [MEMBER_1]: 1, [MEMBER_10]: 10});
            expect(pairs).toHaveLength(3);
        });

        it('starts a new batch after the previous one was delivered', async () => {
            const callback = jest.fn();
            const {storage, deliver} = loadSyncedFacade(callback);
            await storage.multiSet([
                [KEY, 'value'],
                [OTHER, 'other'],
            ]);

            dispatchSyncEvent(KEY);
            await deliver();
            dispatchSyncEvent(OTHER);
            await deliver();

            expect(callback.mock.calls).toEqual([[[[KEY, 'value']]], [[[OTHER, 'other']]]]);
        });

        it('reads the value current at delivery time, not at event time', async () => {
            const callback = jest.fn();
            const {storage, deliver} = loadSyncedFacade(callback);
            await storage.setItem(KEY, 'old');

            dispatchSyncEvent(KEY);
            await storage.setItem(KEY, 'new');
            await deliver();

            expect(callback).toHaveBeenCalledWith([[KEY, 'new']]);
        });

        it('delivers a nullish value for a key removed by the other tab', async () => {
            const callback = jest.fn();
            const {deliver} = loadSyncedFacade(callback);

            dispatchSyncEvent(JSON.stringify([KEY]));
            await deliver();

            expect(callback).toHaveBeenCalledTimes(1);
            const [[[key, value]]] = callback.mock.calls[0];
            expect(key).toBe(KEY);
            expect(value == null).toBe(true);
        });

        it('reads a raw key that happens to be valid JSON as the raw key', async () => {
            const callback = jest.fn();
            const {storage, deliver} = loadSyncedFacade(callback);
            const jsonLikeKey: OnyxKey = '"quoted"';
            await storage.setItem(jsonLikeKey, 'value');

            dispatchSyncEvent(jsonLikeKey);
            await deliver();

            expect(callback).toHaveBeenCalledWith([[jsonLikeKey, 'value']]);
        });

        it('ignores storage events that are not SYNC_ONYX events or have no value', async () => {
            const callback = jest.fn();
            const {deliver} = loadSyncedFacade(callback);

            dispatchSyncEvent(JSON.stringify([KEY]), 'someOtherKey');
            dispatchSyncEvent(null);
            dispatchSyncEvent('');
            await deliver();

            expect(callback).not.toHaveBeenCalled();
        });
    });
});
