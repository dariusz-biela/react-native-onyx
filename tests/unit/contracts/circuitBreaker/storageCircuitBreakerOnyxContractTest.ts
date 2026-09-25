import type {Connection} from '../../../../lib/OnyxConnectionManager';

import Onyx from '../../../../lib';
import * as Logger from '../../../../lib/Logger';
import cache from '../../../../lib/OnyxCache';
import StorageMock from '../../../../lib/storage';
import StorageCircuitBreaker from '../../../../lib/StorageCircuitBreaker';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    TEST: 'test',
    OTHER: 'other',
    COLLECTION: {
        COLL: 'coll_',
        EVICTABLE: 'evictable_',
    },
};

const ROLLING_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 50;
const NO_PROGRESS_CAP = 5;
const EVICTABLE_KEY_COUNT = 7;

const EVICTABLE_KEYS = Array.from({length: EVICTABLE_KEY_COUNT}, (_, index) => `${KEYS.COLLECTION.EVICTABLE}${index}`);

const capacityError = new Error('database or disk is full');
const genericError = new Error('Generic storage error');
const fatalError = Object.assign(new Error('Internal error opening backing store for indexedDB.open.'), {name: 'UnknownError'});

let currentTime = 3_000_000;
let logAlertSpy: jest.SpiedFunction<typeof Logger.logAlert>;
const connections: Connection[] = [];

function advance(ms: number): void {
    currentTime += ms;
}

function tripAlerts(): string[] {
    return logAlertSpy.mock.calls.map((call) => call[0]).filter((message) => message.startsWith('Storage circuit breaker tripped'));
}

async function seedEvictableKeys(): Promise<void> {
    for (const [index, key] of EVICTABLE_KEYS.entries()) {
        await Onyx.set(key, {id: index});
    }
}

function cachedEvictableKeys(): string[] {
    return EVICTABLE_KEYS.filter((key) => cache.hasCacheForKey(key));
}

/** Leaves the breaker closed with NO_PROGRESS_CAP - 1 no-progress evictions and one eviction awaiting its verdict. */
function buildNoProgressStreakAwaitingVerdict(): void {
    for (let i = 0; i < NO_PROGRESS_CAP; i++) {
        StorageCircuitBreaker.recordCapacityFailure();
        StorageCircuitBreaker.recordEviction();
    }
}

const setItemMock = jest.mocked(StorageMock.setItem);
const originalSetItem = setItemMock.getMockImplementation();

function failSetItemAlways(error: Error): void {
    setItemMock.mockImplementation(() => Promise.reject(error));
}

function failSetItemOnce(error: Error): void {
    setItemMock.mockRejectedValueOnce(error);
}

function restoreSetItem(): void {
    setItemMock.mockReset();
    if (originalSetItem) {
        setItemMock.mockImplementation(originalSetItem);
    }
}

function tripBreakerByRate(): void {
    for (let i = 0; i <= FAILURE_THRESHOLD; i++) {
        StorageCircuitBreaker.recordCapacityFailure();
    }
    expect(StorageCircuitBreaker.peekState()).toBe('open');
}

describe('StorageCircuitBreaker wiring through Onyx writes', () => {
    beforeAll(() => {
        Onyx.init({
            keys: KEYS,
            evictableKeys: [KEYS.COLLECTION.EVICTABLE],
        });
    });

    beforeEach(() => {
        currentTime = 3_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
        logAlertSpy = jest.spyOn(Logger, 'logAlert').mockReturnValue(undefined);
        jest.spyOn(Logger, 'logInfo').mockReturnValue(undefined);
        StorageCircuitBreaker.reset();
    });

    afterEach(async () => {
        restoreSetItem();
        jest.restoreAllMocks();
        for (const connection of connections) {
            Onyx.disconnect(connection);
        }
        connections.length = 0;
        await Onyx.clear();
        await waitForPromisesToResolve();
        StorageCircuitBreaker.reset();
    });

    describe('healthy writes', () => {
        it('passes every write method through to cache and storage and leaves the breaker closed and silent', async () => {
            await Onyx.set(KEYS.TEST, {a: 1});
            await Onyx.multiSet({[KEYS.OTHER]: 'other'});
            await Onyx.merge(KEYS.TEST, {b: 2});
            await Onyx.mergeCollection(KEYS.COLLECTION.COLL, {[`${KEYS.COLLECTION.COLL}1`]: {id: 1}});
            await Onyx.setCollection(KEYS.COLLECTION.COLL, {[`${KEYS.COLLECTION.COLL}2`]: {id: 2}});
            await Onyx.update([
                {onyxMethod: Onyx.METHOD.SET, key: `${KEYS.COLLECTION.COLL}3`, value: {id: 3}},
                {onyxMethod: Onyx.METHOD.SET, key: `${KEYS.COLLECTION.COLL}4`, value: {id: 4}},
            ]);
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toEqual({a: 1, b: 2});
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({a: 1, b: 2});
            expect(await StorageMock.getItem(KEYS.OTHER)).toBe('other');
            expect(await StorageMock.getItem(`${KEYS.COLLECTION.COLL}2`)).toEqual({id: 2});
            expect(await StorageMock.getItem(`${KEYS.COLLECTION.COLL}4`)).toEqual({id: 4});
            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
            expect(tripAlerts()).toEqual([]);
        });
    });

    describe('a successful storage write settles a pending eviction', () => {
        it.each([
            ['Onyx.set', () => Onyx.set(KEYS.TEST, {id: 'set'})],
            ['Onyx.multiSet', () => Onyx.multiSet({[KEYS.TEST]: {id: 'multiSet'}, [KEYS.OTHER]: 'x'})],
            ['Onyx.setCollection', () => Onyx.setCollection(KEYS.COLLECTION.COLL, {[`${KEYS.COLLECTION.COLL}1`]: {id: 1}})],
            ['Onyx.mergeCollection', () => Onyx.mergeCollection(KEYS.COLLECTION.COLL, {[`${KEYS.COLLECTION.COLL}1`]: {id: 1}})],
            [
                'Onyx.update with a batched collection set',
                () =>
                    Onyx.update([
                        {onyxMethod: Onyx.METHOD.SET, key: `${KEYS.COLLECTION.COLL}1`, value: {id: 1}},
                        {onyxMethod: Onyx.METHOD.SET, key: `${KEYS.COLLECTION.COLL}2`, value: {id: 2}},
                    ]),
            ],
        ])('%s clears the no-progress streak', async (_, write) => {
            buildNoProgressStreakAwaitingVerdict();

            await write();
            await waitForPromisesToResolve();

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
            expect(StorageCircuitBreaker.peekState()).toBe('closed');
        });

        it.each([
            ['Onyx.set', () => Onyx.set(KEYS.TEST, {id: 'set'})],
            ['Onyx.multiSet', () => Onyx.multiSet({[KEYS.TEST]: {id: 'multiSet'}})],
            ['Onyx.setCollection', () => Onyx.setCollection(KEYS.COLLECTION.COLL, {[`${KEYS.COLLECTION.COLL}1`]: {id: 1}})],
            ['Onyx.mergeCollection', () => Onyx.mergeCollection(KEYS.COLLECTION.COLL, {[`${KEYS.COLLECTION.COLL}1`]: {id: 1}})],
        ])('%s closes a halfOpen breaker whose probe evicted', async (_, write) => {
            tripBreakerByRate();
            advance(ROLLING_WINDOW_MS);
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
            StorageCircuitBreaker.recordEviction();

            await write();
            await waitForPromisesToResolve();

            expect(StorageCircuitBreaker.peekState()).toBe('closed');
        });

        it('Onyx.merge does not feed the breaker, so the streak survives it', async () => {
            await Onyx.set(KEYS.TEST, {a: 1});
            buildNoProgressStreakAwaitingVerdict();

            await Onyx.merge(KEYS.TEST, {b: 2});
            await waitForPromisesToResolve();

            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({a: 1, b: 2});
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });
    });

    describe('non-capacity failures', () => {
        it.each([
            ['an unclassified error retried once', genericError],
            ['a fatal connection error', fatalError],
        ])('never counts %s toward the breaker', async (_, error) => {
            for (let i = 0; i <= FAILURE_THRESHOLD; i++) {
                failSetItemOnce(error);
                await Onyx.set(KEYS.TEST, {i});
            }
            await waitForPromisesToResolve();

            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(tripAlerts()).toEqual([]);
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
            }
        });
    });

    describe('capacity failures', () => {
        it('evicts once per failing write whose retry lands, and never trips on progress', async () => {
            await seedEvictableKeys();

            for (let i = 0; i < NO_PROGRESS_CAP + 1; i++) {
                failSetItemOnce(capacityError);
                await Onyx.set(KEYS.TEST, {i});
            }
            await waitForPromisesToResolve();

            expect(cachedEvictableKeys()).toEqual([EVICTABLE_KEYS[NO_PROGRESS_CAP + 1]]);
            expect(cache.get(KEYS.TEST)).toEqual({i: NO_PROGRESS_CAP});
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({i: NO_PROGRESS_CAP});
            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(tripAlerts()).toEqual([]);
        });

        it('trips on no-progress evictions and then stops evicting while the value stays in the cache', async () => {
            await seedEvictableKeys();
            failSetItemAlways(capacityError);

            await Onyx.set(KEYS.TEST, {attempt: 1});
            await waitForPromisesToResolve();
            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            const survivorsAfterFirstWrite = cachedEvictableKeys();

            await Onyx.set(KEYS.TEST, {attempt: 2});
            await Onyx.set(KEYS.TEST, {attempt: 3});
            await waitForPromisesToResolve();

            expect(survivorsAfterFirstWrite).toEqual(EVICTABLE_KEYS.slice(NO_PROGRESS_CAP));
            expect(cachedEvictableKeys()).toEqual(survivorsAfterFirstWrite);
            expect(StorageCircuitBreaker.peekState()).toBe('open');
            expect(tripAlerts()).toEqual([
                `Storage circuit breaker tripped: ${NO_PROGRESS_CAP} consecutive evictions freed no usable space. Halting eviction/retry for 60s to stop a storage failure storm.`,
            ]);
            expect(cache.get(KEYS.TEST)).toEqual({attempt: 3});
        });

        it('does not count a concurrent write failure as no-progress while another eviction is still pending', async () => {
            await seedEvictableKeys();
            for (let i = 0; i < NO_PROGRESS_CAP - 1; i++) {
                StorageCircuitBreaker.recordCapacityFailure();
                StorageCircuitBreaker.recordEviction();
            }
            StorageCircuitBreaker.recordCapacityFailure();
            failSetItemOnce(capacityError);
            failSetItemOnce(capacityError);

            await Promise.all([Onyx.set(KEYS.TEST, {id: 'a'}), Onyx.set(KEYS.OTHER, {id: 'b'})]);
            await waitForPromisesToResolve();

            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(tripAlerts()).toEqual([]);
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({id: 'a'});
            expect(await StorageMock.getItem(KEYS.OTHER)).toEqual({id: 'b'});
            expect(cachedEvictableKeys()).toEqual(EVICTABLE_KEYS.slice(2));
        });

        it('delivers the value to subscribers and keeps evictable keys while the breaker is open', async () => {
            await seedEvictableKeys();
            const deliveries: unknown[] = [];
            connections.push(Onyx.connect({key: KEYS.TEST, callback: (value) => deliveries.push(value)}));
            await waitForPromisesToResolve();
            deliveries.length = 0;
            tripBreakerByRate();
            failSetItemAlways(capacityError);

            await Onyx.set(KEYS.TEST, {id: 'dropped'});
            await waitForPromisesToResolve();

            expect(deliveries).toEqual([{id: 'dropped'}]);
            expect(cache.get(KEYS.TEST)).toEqual({id: 'dropped'});
            expect(cachedEvictableKeys()).toEqual(EVICTABLE_KEYS);
            expect(StorageCircuitBreaker.peekState()).toBe('open');
        });
    });

    describe('halfOpen probe through Onyx', () => {
        it('reopens after a failing probe that evicted exactly one key, without a second alert', async () => {
            await seedEvictableKeys();
            tripBreakerByRate();
            advance(ROLLING_WINDOW_MS);
            failSetItemAlways(capacityError);

            await Onyx.set(KEYS.TEST, {id: 'probe'});
            await waitForPromisesToResolve();

            expect(cachedEvictableKeys()).toEqual(EVICTABLE_KEYS.slice(1));
            expect(StorageCircuitBreaker.peekState()).toBe('open');
            expect(tripAlerts()).toHaveLength(1);

            advance(ROLLING_WINDOW_MS - 1);
            expect(StorageCircuitBreaker.isAllowed()).toBe(false);
            advance(1);
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
        });

        it('drops the other writes of the same halfOpen window without evicting', async () => {
            await seedEvictableKeys();
            tripBreakerByRate();
            advance(ROLLING_WINDOW_MS);
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
            failSetItemAlways(capacityError);

            await Onyx.set(KEYS.OTHER, {id: 'not the probe'});
            await waitForPromisesToResolve();

            expect(cachedEvictableKeys()).toEqual(EVICTABLE_KEYS);
            expect(cache.get(KEYS.OTHER)).toEqual({id: 'not the probe'});
            expect(StorageCircuitBreaker.peekState()).toBe('open');
        });

        it('closes after a probe whose eviction let the retry land, and a later write storm needs a full count again', async () => {
            await seedEvictableKeys();
            tripBreakerByRate();
            advance(ROLLING_WINDOW_MS);
            failSetItemOnce(capacityError);

            await Onyx.set(KEYS.TEST, {id: 'recovered'});
            await waitForPromisesToResolve();

            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({id: 'recovered'});
            expect(cachedEvictableKeys()).toEqual(EVICTABLE_KEYS.slice(1));
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
            }
        });
    });
});
