import type {Connection} from '../../../../lib/OnyxConnectionManager';
import type {OnyxKey} from '../../../../lib/types';

import Onyx from '../../../../lib';
import * as Logger from '../../../../lib/Logger';
import cache from '../../../../lib/OnyxCache';
import OnyxUtils from '../../../../lib/OnyxUtils';
import StorageMock from '../../../../lib/storage';
import StorageCircuitBreaker from '../../../../lib/StorageCircuitBreaker';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    TEST: 'test',
    TEST_LONGER: 'testLonger',
    OTHER: 'other',
    WITH_DEFAULT: 'withDefault',
    NVP: 'nvp_test',
    RAM_ONLY: 'ramOnly',
    COLLECTION: {
        COLL: 'coll_',
        COLL_SUB: 'coll_sub_',
        OTHER_COLL: 'otherColl_',
        RAM_COLL: 'ramColl_',
        EVICTABLE: 'evictable_',
    },
};

const SKIPPABLE_ID = 'skippable-id';

type Delivery = {value: unknown; key: string | undefined};

type SubscribeOptions = {reuseConnection?: boolean};

const connections: Connection[] = [];

let logAlertSpy: jest.SpiedFunction<typeof Logger.logAlert>;
let logInfoSpy: jest.SpiedFunction<typeof Logger.logInfo>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function memberOf(collection: unknown, key: string): unknown {
    return isRecord(collection) ? collection[key] : undefined;
}

/** Connects a recording callback to the key and drops the initial delivery so only later writes are recorded. */
async function subscribe(key: OnyxKey, options?: SubscribeOptions): Promise<Delivery[]> {
    const deliveries: Delivery[] = [];
    connections.push(
        Onyx.connect({
            key,
            reuseConnection: options?.reuseConnection,
            callback: (value: unknown, matchedKey: string | undefined) => {
                deliveries.push({value, key: matchedKey});
            },
        }),
    );
    await waitForPromisesToResolve();
    deliveries.length = 0;
    return deliveries;
}

function lastValue(deliveries: Delivery[]): unknown {
    return deliveries.at(-1)?.value;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function isAnyNodeFrozen(value: unknown): boolean {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    return Object.isFrozen(value) || Object.values(value).some(isAnyNodeFrozen);
}

function storageWritesFor(key: OnyxKey): unknown[] {
    return jest
        .mocked(StorageMock.setItem)
        .mock.calls.filter(([writtenKey]) => writtenKey === key)
        .map(([, value]) => value);
}

function storageRemovalsFor(key: OnyxKey): number {
    return jest.mocked(StorageMock.removeItem).mock.calls.filter(([removedKey]) => removedKey === key).length;
}

function clearStorageCalls() {
    jest.mocked(StorageMock.setItem).mockClear();
    jest.mocked(StorageMock.removeItem).mockClear();
}

/** Keeps the ordered subsequence check readable: every delivered value must appear in `written`, in the same order. */
function isOrderedSubsequence(delivered: unknown[], written: unknown[]): boolean {
    let writtenIndex = 0;
    for (const value of delivered) {
        while (writtenIndex < written.length && written[writtenIndex] !== value) {
            writtenIndex++;
        }
        if (writtenIndex === written.length) {
            return false;
        }
        writtenIndex++;
    }
    return true;
}

describe('Onyx.set contract', () => {
    beforeAll(() => {
        Onyx.init({
            keys: KEYS,
            initialKeyStates: {[KEYS.WITH_DEFAULT]: 'default'},
            ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.COLLECTION.RAM_COLL],
            skippableCollectionMemberIDs: [SKIPPABLE_ID],
            evictableKeys: [KEYS.COLLECTION.EVICTABLE],
        });
    });

    beforeEach(() => {
        clearStorageCalls();
        logAlertSpy = jest.spyOn(Logger, 'logAlert').mockReturnValue(undefined);
        logInfoSpy = jest.spyOn(Logger, 'logInfo').mockReturnValue(undefined);
    });

    afterEach(async () => {
        logAlertSpy.mockRestore();
        logInfoSpy.mockRestore();
        for (const connection of connections) {
            Onyx.disconnect(connection);
        }
        connections.length = 0;
        await Onyx.clear();
        clearStorageCalls();
    });

    describe('cache and storage', () => {
        it.each([
            ['a string', 'value'],
            ['zero', 0],
            ['false', false],
            ['an empty string', ''],
            ['a number', 42.5],
            ['an object', {id: 1, name: 'name'}],
            ['a nested object', {a: {b: {c: {d: 'deep'}}}, list: [1, 2, 3]}],
            ['an empty object', {}],
            ['an array', [1, 'two', {three: 3}]],
            ['an empty array', []],
        ])('stores %s in the cache and in storage', async (_, value) => {
            await Onyx.set(KEYS.TEST, value);

            expect(cache.get(KEYS.TEST)).toStrictEqual(value);
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual(value);
            expect(cache.getAllKeys().has(KEYS.TEST)).toBe(true);
        });

        it('updates the cache synchronously, before the returned promise settles', () => {
            const value = {id: 1};
            const promise = Onyx.set(KEYS.TEST, value);

            expect(cache.get(KEYS.TEST)).toEqual(value);
            return promise;
        });

        it('keeps the input reference in the cache when the value holds no nullish nested values', async () => {
            const value = {id: 1, nested: {list: [1, 2]}};
            await Onyx.set(KEYS.TEST, value);

            expect(cache.get(KEYS.TEST)).toBe(value);
        });

        it('replaces the previous object instead of merging into it', async () => {
            await Onyx.set(KEYS.TEST, {a: 1, b: {c: 2, d: 3}});
            await Onyx.set(KEYS.TEST, {b: {c: 5}, e: 4});

            expect(cache.get(KEYS.TEST)).toStrictEqual({b: {c: 5}, e: 4});
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual({b: {c: 5}, e: 4});
        });

        it('replaces the previous array instead of merging into it', async () => {
            await Onyx.set(KEYS.TEST, [1, 2, 3, 4]);
            await Onyx.set(KEYS.TEST, [9]);

            expect(cache.get(KEYS.TEST)).toStrictEqual([9]);
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual([9]);
        });

        it('writes only the target key', async () => {
            await Onyx.set(KEYS.OTHER, 'other');
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});
            clearStorageCalls();

            await Onyx.set(KEYS.TEST, 'value');

            expect(cache.get(KEYS.OTHER)).toBe('other');
            expect(cache.get(`${KEYS.COLLECTION.COLL}1`)).toEqual({id: 1});
            expect(cache.get(KEYS.TEST_LONGER)).toBeUndefined();
            expect(jest.mocked(StorageMock.setItem).mock.calls.every(([key]) => key === KEYS.TEST)).toBe(true);
        });

        it('resolves the returned promise with undefined only after the storage write has finished', async () => {
            let finishWrite: (() => void) | undefined;
            jest.mocked(StorageMock.setItem).mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        finishWrite = resolve;
                    }),
            );

            let isSettled = false;
            const promise = Onyx.set(KEYS.TEST, 'value').then((result) => {
                isSettled = true;
                return result;
            });

            await waitForPromisesToResolve();
            expect(isSettled).toBe(false);

            finishWrite?.();
            await expect(promise).resolves.toBeUndefined();
            expect(isSettled).toBe(true);
        });
    });

    describe('notifications', () => {
        it('delivers the new value and the key to a key subscriber synchronously during the call', async () => {
            const deliveries = await subscribe(KEYS.TEST);
            const value = {id: 1};

            const promise = Onyx.set(KEYS.TEST, value);

            expect(deliveries).toEqual([{value, key: KEYS.TEST}]);
            await promise;
            expect(deliveries).toHaveLength(1);
        });

        it('delivers the same reference that the cache holds', async () => {
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, {id: 1, nested: {a: null, b: 1}});

            expect(lastValue(deliveries)).toBe(cache.get(KEYS.TEST));
            expect(lastValue(deliveries)).toStrictEqual({id: 1, nested: {b: 1}});
        });

        it('notifies every connection to the key, shared or not', async () => {
            const shared1 = await subscribe(KEYS.TEST);
            const shared2 = await subscribe(KEYS.TEST);
            const unique = await subscribe(KEYS.TEST, {reuseConnection: false});

            await Onyx.set(KEYS.TEST, 'value');

            for (const deliveries of [shared1, shared2, unique]) {
                expect(deliveries).toEqual([{value: 'value', key: KEYS.TEST}]);
            }
        });

        it('does not notify subscribers of unrelated keys, including keys that share a prefix', async () => {
            const longer = await subscribe(KEYS.TEST_LONGER);
            const other = await subscribe(KEYS.OTHER);
            const collection = await subscribe(KEYS.COLLECTION.COLL);
            const member = await subscribe(`${KEYS.COLLECTION.COLL}1`);

            await Onyx.set(KEYS.TEST, 'value');

            expect(longer).toEqual([]);
            expect(other).toEqual([]);
            expect(collection).toEqual([]);
            expect(member).toEqual([]);
        });

        it('leaves the subscriber on the latest value after every awaited write', async () => {
            const deliveries = await subscribe(KEYS.TEST);

            for (const value of ['a', 'b', {c: 1}, {c: 2}, 'd', 0, false, 'e']) {
                await Onyx.set(KEYS.TEST, value);
                expect(lastValue(deliveries)).toEqual(value);
            }
        });

        it('delivers interleaved writes from one tick in order and ends on the last one', async () => {
            const deliveries = await subscribe(KEYS.TEST);
            const written = [{v: 1}, {v: 2}, {v: 3}, {v: 4}];

            await Promise.all(written.map((value) => Onyx.set(KEYS.TEST, value)));

            const delivered = deliveries.map((delivery) => delivery.value);
            expect(delivered.length).toBeGreaterThanOrEqual(1);
            expect(delivered.length).toBeLessThanOrEqual(written.length);
            expect(isOrderedSubsequence(delivered, written)).toBe(true);
            expect(lastValue(deliveries)).toBe(written.at(-1));
            expect(cache.get(KEYS.TEST)).toBe(written.at(-1));
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({v: 4});
        });

        it('stores the last value when the same key is written with A, B, A in one tick', async () => {
            const deliveries = await subscribe(KEYS.TEST);

            await Promise.all([Onyx.set(KEYS.TEST, 'A'), Onyx.set(KEYS.TEST, 'B'), Onyx.set(KEYS.TEST, 'A')]);

            expect(lastValue(deliveries)).toBe('A');
            expect(cache.get(KEYS.TEST)).toBe('A');
            expect(await StorageMock.getItem(KEYS.TEST)).toBe('A');
        });

        it('keeps notifying the remaining subscribers when one callback throws', async () => {
            connections.push(
                Onyx.connect({
                    key: KEYS.TEST,
                    reuseConnection: false,
                    callback: (value: unknown) => {
                        if (value !== 'boom') {
                            return;
                        }
                        throw new Error('subscriber failure');
                    },
                }),
            );
            const deliveries = await subscribe(KEYS.TEST, {reuseConnection: false});

            await Onyx.set(KEYS.TEST, 'boom');

            expect(lastValue(deliveries)).toBe('boom');
            expect(cache.get(KEYS.TEST)).toBe('boom');
            expect(await StorageMock.getItem(KEYS.TEST)).toBe('boom');
        });
    });

    describe('unchanged values', () => {
        it('skips the notification and the storage write for a deep-equal new object and keeps the cached reference', async () => {
            const original = {id: 1, nested: {list: [1, {a: 'b'}]}};
            await Onyx.set(KEYS.TEST, original);
            const deliveries = await subscribe(KEYS.TEST);
            const collectionDeliveries = await subscribe(KEYS.COLLECTION.COLL);
            clearStorageCalls();

            await expect(Onyx.set(KEYS.TEST, {id: 1, nested: {list: [1, {a: 'b'}]}})).resolves.toBeUndefined();

            expect(deliveries).toEqual([]);
            expect(collectionDeliveries).toEqual([]);
            expect(storageWritesFor(KEYS.TEST)).toEqual([]);
            expect(cache.get(KEYS.TEST)).toBe(original);
        });

        it('skips the notification and the storage write for the same reference', async () => {
            const original = {id: 1};
            await Onyx.set(KEYS.TEST, original);
            const deliveries = await subscribe(KEYS.TEST);
            clearStorageCalls();

            await Onyx.set(KEYS.TEST, original);

            expect(deliveries).toEqual([]);
            expect(storageWritesFor(KEYS.TEST)).toEqual([]);
            expect(cache.get(KEYS.TEST)).toBe(original);
        });

        it.each([
            ['the same primitive', 'value', 'value'],
            ['the same number', 7, 7],
            ['the same boolean', false, false],
            ['keys in another order', {a: 1, b: {c: 2, d: 3}}, {b: {d: 3, c: 2}, a: 1}],
            ['extra nested null values', {a: 1, b: {c: 2}}, {a: 1, b: {c: 2, d: null}, e: null}],
            ['extra nested undefined values', {a: 1}, {a: 1, b: undefined}],
            ['an equal array of objects', [{id: 1}, {id: 2}], [{id: 1}, {id: 2}]],
        ])('treats %s as unchanged', async (_, first, second) => {
            await Onyx.set(KEYS.TEST, first);
            const cachedBefore = cache.get(KEYS.TEST);
            const deliveries = await subscribe(KEYS.TEST);
            clearStorageCalls();

            await Onyx.set(KEYS.TEST, second);

            expect(deliveries).toEqual([]);
            expect(storageWritesFor(KEYS.TEST)).toEqual([]);
            expect(cache.get(KEYS.TEST)).toBe(cachedBefore);
        });

        it.each([
            ['a change four levels deep', {a: {b: {c: {d: 1}}}}, {a: {b: {c: {d: 2}}}}],
            ['a change inside an array element', {list: [{id: 1, name: 'a'}]}, {list: [{id: 1, name: 'b'}]}],
            ['a longer array', [1, 2], [1, 2, 3]],
            ['a shorter array', [1, 2, 3], [1, 2]],
            ['reordered array elements', [1, 2], [2, 1]],
            ['an added key', {a: 1}, {a: 1, b: 2}],
            ['a removed key', {a: 1, b: 2}, {a: 1}],
            ['a nested removed key', {a: {b: 1, c: 2}}, {a: {b: 1}}],
            ['a number replaced by its string', {a: 1}, {a: '1'}],
            ['zero replaced by false', 0, false],
            ['an empty string replaced by zero', '', 0],
            ['a null array element replaced by zero', [1, null], [1, 0]],
            ['an object replaced by a primitive', {a: 1}, 'a'],
            ['an empty object replaced by a non-empty one', {}, {a: 1}],
            ['a non-empty object replaced by an empty one', {a: 1}, {}],
        ])('detects %s', async (_, first, second) => {
            await Onyx.set(KEYS.TEST, first);
            const deliveries = await subscribe(KEYS.TEST);
            clearStorageCalls();

            await Onyx.set(KEYS.TEST, second);

            expect(deliveries).toHaveLength(1);
            expect(lastValue(deliveries)).toStrictEqual(second);
            expect(cache.get(KEYS.TEST)).toStrictEqual(second);
            expect(storageWritesFor(KEYS.TEST)).toHaveLength(1);
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual(second);
        });

        it('detects a change after the previous value was mutated in place by its owner', async () => {
            const original: Record<string, number> = {a: 1};
            await Onyx.set(KEYS.TEST, original);
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, {a: 2});

            expect(lastValue(deliveries)).toEqual({a: 2});
            expect(original).toEqual({a: 1});
        });
    });

    describe('top-level null', () => {
        it('removes the key from the cache, the key list and storage, and delivers undefined synchronously', async () => {
            await Onyx.set(KEYS.TEST, {id: 1});
            const deliveries = await subscribe(KEYS.TEST);

            const promise = Onyx.set(KEYS.TEST, null);

            expect(deliveries).toEqual([{value: undefined, key: KEYS.TEST}]);
            expect(cache.get(KEYS.TEST)).toBeUndefined();
            expect(cache.hasCacheForKey(KEYS.TEST)).toBe(false);
            expect(cache.getAllKeys().has(KEYS.TEST)).toBe(false);
            await promise;
            await waitForPromisesToResolve();
            expect(await StorageMock.getItem(KEYS.TEST)).toBeNull();
            expect(await StorageMock.getAllKeys()).not.toContain(KEYS.TEST);
            expect(deliveries).toHaveLength(1);
        });

        it('removes a collection member and hands collection subscribers the remaining members by reference', async () => {
            const member1 = {id: 1};
            const member2 = {id: 2};
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, member1);
            await Onyx.set(`${KEYS.COLLECTION.COLL}2`, member2);
            const collection = await subscribe(KEYS.COLLECTION.COLL);
            const removedMember = await subscribe(`${KEYS.COLLECTION.COLL}1`);
            const keptMember = await subscribe(`${KEYS.COLLECTION.COLL}2`);

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, null);

            expect(collection.length).toBeGreaterThanOrEqual(1);
            const latest = lastValue(collection);
            expect(latest).toEqual({[`${KEYS.COLLECTION.COLL}2`]: member2});
            expect(memberOf(latest, `${KEYS.COLLECTION.COLL}2`)).toBe(member2);
            expect(collection.at(-1)?.key).toBe(KEYS.COLLECTION.COLL);
            expect(removedMember).toEqual([{value: undefined, key: `${KEYS.COLLECTION.COLL}1`}]);
            expect(keptMember).toEqual([]);
        });

        it('hands collection subscribers an empty object when the last member is removed', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});
            const collection = await subscribe(KEYS.COLLECTION.COLL);

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, null);

            expect(lastValue(collection)).toEqual({});
        });

        it('does nothing for a key that holds no value', async () => {
            const deliveries = await subscribe(KEYS.TEST);
            clearStorageCalls();

            await expect(Onyx.set(KEYS.TEST, null)).resolves.toBeUndefined();

            expect(deliveries).toEqual([]);
            expect(storageRemovalsFor(KEYS.TEST)).toBe(0);
            expect(storageWritesFor(KEYS.TEST)).toEqual([]);
            expect(cache.get(KEYS.TEST)).toBeUndefined();
        });

        it('removes a key that has an initial state instead of restoring the default', async () => {
            expect(cache.get(KEYS.WITH_DEFAULT)).toBe('default');
            const deliveries = await subscribe(KEYS.WITH_DEFAULT);

            await Onyx.set(KEYS.WITH_DEFAULT, null);

            expect(deliveries).toEqual([{value: undefined, key: KEYS.WITH_DEFAULT}]);
            expect(cache.get(KEYS.WITH_DEFAULT)).toBeUndefined();
            await waitForPromisesToResolve();
            expect(await StorageMock.getItem(KEYS.WITH_DEFAULT)).toBeNull();
        });

        it('lets the key be written again after removal', async () => {
            await Onyx.set(KEYS.TEST, {id: 1});
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, null);
            await Onyx.set(KEYS.TEST, {id: 1});

            expect(deliveries.map((delivery) => delivery.value)).toEqual([undefined, {id: 1}]);
            expect(cache.get(KEYS.TEST)).toEqual({id: 1});
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({id: 1});
        });

        it('ignores skipCacheCheck and still removes the key', async () => {
            await Onyx.set(KEYS.TEST, 'value');
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, null, {skipCacheCheck: true});

            expect(deliveries).toEqual([{value: undefined, key: KEYS.TEST}]);
            expect(cache.get(KEYS.TEST)).toBeUndefined();
        });
    });

    describe('nested nullish values', () => {
        it('removes nested null and undefined values at every depth from the cache, storage and deliveries', async () => {
            const deliveries = await subscribe(KEYS.TEST);
            const expected = {a: 1, b: {c: {e: 'kept'}, g: {}}, list: [1, null, {x: null}]};

            await Onyx.set(KEYS.TEST, {a: 1, n: null, u: undefined, b: {c: {d: null, e: 'kept'}, f: undefined, g: {h: null}}, list: [1, null, {x: null}]});

            expect(cache.get(KEYS.TEST)).toStrictEqual(expected);
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual(expected);
            expect(storageWritesFor(KEYS.TEST)).toStrictEqual([expected]);
            expect(lastValue(deliveries)).toStrictEqual(expected);
        });

        it('keeps null elements of arrays and null properties of objects inside arrays', async () => {
            await Onyx.set(KEYS.TEST, [null, {a: null, b: 1}]);

            expect(cache.get(KEYS.TEST)).toStrictEqual([null, {a: null, b: 1}]);
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual([null, {a: null, b: 1}]);
        });

        it('stores an empty object when every property is null', async () => {
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, {a: null, b: null});

            expect(cache.get(KEYS.TEST)).toStrictEqual({});
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual({});
            expect(lastValue(deliveries)).toStrictEqual({});
        });

        it('treats a value that only loses nested nulls against the stored one as changed when other fields differ', async () => {
            await Onyx.set(KEYS.TEST, {a: 1, b: 2});
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, {a: 1, b: null});

            expect(lastValue(deliveries)).toStrictEqual({a: 1});
            expect(cache.get(KEYS.TEST)).toStrictEqual({a: 1});
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual({a: 1});
        });
    });

    describe('top-level undefined', () => {
        it('is ignored: no cache change, no notification, no storage call', async () => {
            await Onyx.set(KEYS.TEST, {id: 1});
            const cachedBefore = cache.get(KEYS.TEST);
            const deliveries = await subscribe(KEYS.TEST);
            clearStorageCalls();

            await expect(Onyx.set(KEYS.TEST, undefined)).resolves.toBeUndefined();

            expect(deliveries).toEqual([]);
            expect(cache.get(KEYS.TEST)).toBe(cachedBefore);
            expect(storageWritesFor(KEYS.TEST)).toEqual([]);
            expect(storageRemovalsFor(KEYS.TEST)).toBe(0);
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({id: 1});
        });

        it('does not create a missing key', async () => {
            await Onyx.set(KEYS.TEST, undefined);

            expect(cache.getAllKeys().has(KEYS.TEST)).toBe(false);
            expect(cache.hasCacheForKey(KEYS.TEST)).toBe(false);
        });
    });

    describe('skipCacheCheck', () => {
        it('writes and delivers a deep-equal new object as a change', async () => {
            const original = {id: 1, name: 'n'};
            await Onyx.set(KEYS.TEST, original);
            const deliveries = await subscribe(KEYS.TEST);
            clearStorageCalls();
            const replacement = {id: 1, name: 'n'};

            await Onyx.set(KEYS.TEST, replacement, {skipCacheCheck: true});

            expect(cache.get(KEYS.TEST)).toBe(replacement);
            expect(deliveries).toHaveLength(1);
            expect(lastValue(deliveries)).toBe(replacement);
            expect(storageWritesFor(KEYS.TEST)).toEqual([replacement]);
        });

        it('behaves like a plain set for a different value', async () => {
            await Onyx.set(KEYS.TEST, {id: 1});
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, {id: 2, extra: null}, {skipCacheCheck: true});

            expect(lastValue(deliveries)).toStrictEqual({id: 2});
            expect(cache.get(KEYS.TEST)).toStrictEqual({id: 2});
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual({id: 2});
        });

        it('delivers a deep-equal new collection member to collection subscribers', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});
            const collection = await subscribe(KEYS.COLLECTION.COLL);
            const replacement = {id: 1};

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, replacement, {skipCacheCheck: true});

            expect(collection.length).toBeGreaterThanOrEqual(1);
            expect(memberOf(lastValue(collection), `${KEYS.COLLECTION.COLL}1`)).toBe(replacement);
        });

        it('still ignores undefined', async () => {
            await Onyx.set(KEYS.TEST, 'value');

            await Onyx.set(KEYS.TEST, undefined, {skipCacheCheck: true});

            expect(cache.get(KEYS.TEST)).toBe('value');
        });
    });

    describe('incompatible types', () => {
        it.each([
            ['an array over an object', {a: 1}, ['x']],
            ['an object over a non-empty array', [1], {a: 1}],
            ['a string over a non-empty array', [1], 'text'],
            ['a number over a non-empty array', [1], 5],
            ['an array over a string', 'text', [1]],
        ])('rejects %s without touching the cache, storage or subscribers', async (_, existing, incoming) => {
            await Onyx.set(KEYS.TEST, existing);
            const cachedBefore = cache.get(KEYS.TEST);
            const deliveries = await subscribe(KEYS.TEST);
            clearStorageCalls();

            await expect(Onyx.set(KEYS.TEST, incoming)).resolves.toBeUndefined();

            expect(deliveries).toEqual([]);
            expect(cache.get(KEYS.TEST)).toBe(cachedBefore);
            expect(storageWritesFor(KEYS.TEST)).toEqual([]);
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual(existing);
            expect(logAlertSpy.mock.calls.some(([message]) => message.includes(KEYS.TEST))).toBe(true);
        });

        it.each([
            ['an object over an empty array', [], {a: 1}],
            ['a string over an object', {a: 1}, 'text'],
            ['an object over a string', 'text', {a: 1}],
            ['zero over a non-empty array', [1], 0],
            ['false over a non-empty array', [1], false],
            ['an empty string over a non-empty array', [1], ''],
            ['an array over zero', 0, [1]],
            ['an array over an array', [1], [2, 3]],
        ])('accepts %s', async (_, existing, incoming) => {
            await Onyx.set(KEYS.TEST, existing);
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, incoming);

            expect(lastValue(deliveries)).toStrictEqual(incoming);
            expect(cache.get(KEYS.TEST)).toStrictEqual(incoming);
            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual(incoming);
        });

        it('accepts null over an array and removes the key', async () => {
            await Onyx.set(KEYS.TEST, [1]);

            await Onyx.set(KEYS.TEST, null);

            expect(cache.get(KEYS.TEST)).toBeUndefined();
        });
    });

    describe('collections', () => {
        it('hands collection subscribers the whole collection with the collection key and keeps unchanged members by reference', async () => {
            const member1 = {id: 1};
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, member1);
            const collection = await subscribe(KEYS.COLLECTION.COLL);
            const member2 = {id: 2};

            await Onyx.set(`${KEYS.COLLECTION.COLL}2`, member2);

            expect(collection).toHaveLength(1);
            expect(collection[0].key).toBe(KEYS.COLLECTION.COLL);
            const latest = collection[0].value;
            expect(latest).toEqual({[`${KEYS.COLLECTION.COLL}1`]: member1, [`${KEYS.COLLECTION.COLL}2`]: member2});
            expect(memberOf(latest, `${KEYS.COLLECTION.COLL}1`)).toBe(member1);
            expect(memberOf(latest, `${KEYS.COLLECTION.COLL}2`)).toBe(member2);
        });

        it('delivers the first member of an empty collection', async () => {
            const collection = await subscribe(KEYS.COLLECTION.COLL);

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});

            expect(lastValue(collection)).toEqual({[`${KEYS.COLLECTION.COLL}1`]: {id: 1}});
        });

        it('hands out a new collection object on change and never mutates one handed out before', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});
            const collection = await subscribe(KEYS.COLLECTION.COLL);

            await Onyx.set(`${KEYS.COLLECTION.COLL}2`, {id: 2});
            const first = lastValue(collection);
            const firstCopy: unknown = JSON.parse(JSON.stringify(first));

            await Onyx.set(`${KEYS.COLLECTION.COLL}3`, {id: 3});
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 10});
            await Onyx.set(`${KEYS.COLLECTION.COLL}2`, null);

            const latest = lastValue(collection);
            expect(latest).not.toBe(first);
            expect(first).toEqual(firstCopy);
            expect(latest).toEqual({[`${KEYS.COLLECTION.COLL}1`]: {id: 10}, [`${KEYS.COLLECTION.COLL}3`]: {id: 3}});
        });

        it('does not let a subscriber corrupt the cache by mutating a delivered collection', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});
            const collection = await subscribe(KEYS.COLLECTION.COLL);
            await Onyx.set(`${KEYS.COLLECTION.COLL}2`, {id: 2});
            const delivered = lastValue(collection);

            try {
                Object.assign(isRecord(delivered) ? delivered : {}, {[`${KEYS.COLLECTION.COLL}3`]: {id: 3}});
            } catch {
                // Frozen snapshots throw in strict mode, which is an acceptable outcome.
            }

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.COLL)).toEqual({[`${KEYS.COLLECTION.COLL}1`]: {id: 1}, [`${KEYS.COLLECTION.COLL}2`]: {id: 2}});
            expect(cache.get(`${KEYS.COLLECTION.COLL}3`)).toBeUndefined();
        });

        it('keeps every collection delivery consistent with the writes that happened so far', async () => {
            const collection = await subscribe(KEYS.COLLECTION.COLL);

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {v: 1});
            expect(lastValue(collection)).toEqual({[`${KEYS.COLLECTION.COLL}1`]: {v: 1}});
            await Onyx.set(`${KEYS.COLLECTION.COLL}2`, {v: 2});
            expect(lastValue(collection)).toEqual({[`${KEYS.COLLECTION.COLL}1`]: {v: 1}, [`${KEYS.COLLECTION.COLL}2`]: {v: 2}});
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {v: 3});
            expect(lastValue(collection)).toEqual({[`${KEYS.COLLECTION.COLL}1`]: {v: 3}, [`${KEYS.COLLECTION.COLL}2`]: {v: 2}});
        });

        it('notifies only the written member, not sibling members or members whose key extends it', async () => {
            const target = await subscribe(`${KEYS.COLLECTION.COLL}1`);
            const sibling = await subscribe(`${KEYS.COLLECTION.COLL}2`);
            const extended = await subscribe(`${KEYS.COLLECTION.COLL}10`);

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});

            expect(target).toEqual([{value: {id: 1}, key: `${KEYS.COLLECTION.COLL}1`}]);
            expect(sibling).toEqual([]);
            expect(extended).toEqual([]);
        });

        it('does not notify subscribers of other collections or of plain keys', async () => {
            const otherCollection = await subscribe(KEYS.COLLECTION.OTHER_COLL);
            const plain = await subscribe(KEYS.TEST);

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});

            expect(otherCollection).toEqual([]);
            expect(plain).toEqual([]);
        });

        it('routes a member of a nested collection key to the longest matching collection only', async () => {
            const parent = await subscribe(KEYS.COLLECTION.COLL);
            const child = await subscribe(KEYS.COLLECTION.COLL_SUB);

            await Onyx.set(`${KEYS.COLLECTION.COLL_SUB}1`, {id: 1});

            expect(lastValue(child)).toEqual({[`${KEYS.COLLECTION.COLL_SUB}1`]: {id: 1}});
            expect(parent).toEqual([]);
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.COLL)).not.toHaveProperty(`${KEYS.COLLECTION.COLL_SUB}1`);
        });

        it('treats a parent collection member that shares the child prefix text as a parent member', async () => {
            const parent = await subscribe(KEYS.COLLECTION.COLL);
            const child = await subscribe(KEYS.COLLECTION.COLL_SUB);

            await Onyx.set(`${KEYS.COLLECTION.COLL}sub`, {id: 1});

            expect(lastValue(parent)).toEqual({[`${KEYS.COLLECTION.COLL}sub`]: {id: 1}});
            expect(child).toEqual([]);
        });

        it('does not notify the collection when a member is set to a deep-equal value', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1, nested: {a: 1}});
            const collection = await subscribe(KEYS.COLLECTION.COLL);
            const member = await subscribe(`${KEYS.COLLECTION.COLL}1`);

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1, nested: {a: 1}});

            expect(collection).toEqual([]);
            expect(member).toEqual([]);
        });

        it('stores collection members in storage under their member key', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1, drop: null});

            expect(await StorageMock.getItem(`${KEYS.COLLECTION.COLL}1`)).toStrictEqual({id: 1});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.COLL)).toStrictEqual({[`${KEYS.COLLECTION.COLL}1`]: {id: 1}});
        });

        it('lets a new collection subscriber read the members written before it connected', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});
            await Onyx.set(`${KEYS.COLLECTION.COLL}2`, {id: 2});
            const deliveries: Delivery[] = [];

            connections.push(
                Onyx.connect({
                    key: KEYS.COLLECTION.COLL,
                    callback: (value: unknown, key: string | undefined) => {
                        deliveries.push({value, key});
                    },
                }),
            );
            await waitForPromisesToResolve();

            expect(lastValue(deliveries)).toEqual({[`${KEYS.COLLECTION.COLL}1`]: {id: 1}, [`${KEYS.COLLECTION.COLL}2`]: {id: 2}});
        });
    });

    describe('RAM-only keys', () => {
        it('keeps a RAM-only key in the cache and notifies subscribers without writing storage', async () => {
            const deliveries = await subscribe(KEYS.RAM_ONLY);

            await Onyx.set(KEYS.RAM_ONLY, {id: 1});

            expect(lastValue(deliveries)).toEqual({id: 1});
            expect(cache.get(KEYS.RAM_ONLY)).toEqual({id: 1});
            expect(storageWritesFor(KEYS.RAM_ONLY)).toEqual([]);
            expect(await StorageMock.getItem(KEYS.RAM_ONLY)).toBeNull();
        });

        it('keeps a RAM-only collection member in the cache and notifies the collection without writing storage', async () => {
            const collection = await subscribe(KEYS.COLLECTION.RAM_COLL);
            const memberKey = `${KEYS.COLLECTION.RAM_COLL}1`;

            await Onyx.set(memberKey, {id: 1});

            expect(lastValue(collection)).toEqual({[memberKey]: {id: 1}});
            expect(cache.get(memberKey)).toEqual({id: 1});
            expect(storageWritesFor(memberKey)).toEqual([]);
            expect(await StorageMock.getItem(memberKey)).toBeNull();
        });

        it('removes a RAM-only key on null without a storage call', async () => {
            await Onyx.set(KEYS.RAM_ONLY, 'value');
            const deliveries = await subscribe(KEYS.RAM_ONLY);
            clearStorageCalls();

            await Onyx.set(KEYS.RAM_ONLY, null);

            expect(deliveries).toEqual([{value: undefined, key: KEYS.RAM_ONLY}]);
            expect(cache.get(KEYS.RAM_ONLY)).toBeUndefined();
            expect(storageRemovalsFor(KEYS.RAM_ONLY)).toBe(0);
        });

        it('does not treat a key that only starts with the RAM-only key as RAM-only', async () => {
            await Onyx.set(`${KEYS.RAM_ONLY}Other`, 'value');

            expect(await StorageMock.getItem(`${KEYS.RAM_ONLY}Other`)).toBe('value');
        });
    });

    describe('skippable collection member IDs', () => {
        it('ignores a write to a skippable member', async () => {
            const memberKey = `${KEYS.COLLECTION.COLL}${SKIPPABLE_ID}`;
            const collection = await subscribe(KEYS.COLLECTION.COLL);
            const member = await subscribe(memberKey);
            clearStorageCalls();

            await expect(Onyx.set(memberKey, {id: 1})).resolves.toBeUndefined();

            expect(cache.get(memberKey)).toBeUndefined();
            expect(storageWritesFor(memberKey)).toEqual([]);
            expect(await StorageMock.getItem(memberKey)).toBeNull();
            expect(collection).toEqual([]);
            expect(member).toEqual([]);
        });

        it('removes an existing value when its member ID becomes skippable', async () => {
            const memberKey = `${KEYS.COLLECTION.COLL}${SKIPPABLE_ID}`;
            const skippableIDs = OnyxUtils.getSkippableCollectionMemberIDs();
            OnyxUtils.setSkippableCollectionMemberIDs(new Set());
            await Onyx.set(memberKey, {id: 1});
            OnyxUtils.setSkippableCollectionMemberIDs(skippableIDs);
            const member = await subscribe(memberKey);

            await Onyx.set(memberKey, {id: 2});

            expect(member).toEqual([{value: undefined, key: memberKey}]);
            expect(cache.get(memberKey)).toBeUndefined();
            await waitForPromisesToResolve();
            expect(await StorageMock.getItem(memberKey)).toBeNull();
        });

        it('skips a skippable member of a nested collection key', async () => {
            const memberKey = `${KEYS.COLLECTION.COLL_SUB}${SKIPPABLE_ID}`;

            await Onyx.set(memberKey, {id: 1});

            expect(cache.get(memberKey)).toBeUndefined();
        });

        it.each([
            ['a member ID that extends the skippable one', `${KEYS.COLLECTION.COLL}${SKIPPABLE_ID}2`],
            ['a member ID that ends with the skippable one', `${KEYS.COLLECTION.COLL}x${SKIPPABLE_ID}`],
            ['a plain key equal to the skippable ID', SKIPPABLE_ID],
            ['a non-collection key with an underscore', `nvp_${SKIPPABLE_ID}`],
        ])('writes %s normally', async (_, key) => {
            await Onyx.set(key, {id: 1});

            expect(cache.get(key)).toEqual({id: 1});
            expect(await StorageMock.getItem(key)).toEqual({id: 1});
        });
    });

    describe('pending merges', () => {
        it('drops merges queued earlier in the same tick', async () => {
            await Onyx.set(KEYS.TEST, {a: 1});
            const deliveries = await subscribe(KEYS.TEST);

            const mergePromise = Onyx.merge(KEYS.TEST, {b: 2});
            const setPromise = Onyx.set(KEYS.TEST, {c: 3});
            await Promise.all([mergePromise, setPromise]);
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toEqual({c: 3});
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({c: 3});
            expect(lastValue(deliveries)).toEqual({c: 3});
        });

        it('applies a merge queued after the set on top of the set value', async () => {
            await Onyx.set(KEYS.TEST, {a: 1});

            await Promise.all([Onyx.set(KEYS.TEST, {b: 2}), Onyx.merge(KEYS.TEST, {c: 3})]);
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toEqual({b: 2, c: 3});
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({b: 2, c: 3});
        });

        it('keeps only the merges queued after the set when merges surround it', async () => {
            await Onyx.set(KEYS.TEST, {a: 1});

            await Promise.all([Onyx.merge(KEYS.TEST, {b: 2}), Onyx.set(KEYS.TEST, {c: 3}), Onyx.merge(KEYS.TEST, {d: 4})]);
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toEqual({c: 3, d: 4});
            expect(await StorageMock.getItem(KEYS.TEST)).toEqual({c: 3, d: 4});
        });

        it('does not drop merges queued on other keys', async () => {
            await Onyx.set(KEYS.OTHER, {a: 1});

            await Promise.all([Onyx.merge(KEYS.OTHER, {b: 2}), Onyx.set(KEYS.TEST, {c: 3})]);
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.OTHER)).toEqual({a: 1, b: 2});
        });
    });

    describe('storage failures', () => {
        beforeEach(() => {
            StorageCircuitBreaker.reset();
        });

        it('retries a failed write so storage ends up with the value', async () => {
            jest.mocked(StorageMock.setItem).mockRejectedValueOnce(new Error('Generic storage error'));

            await Onyx.set(KEYS.TEST, {id: 1, drop: null});

            expect(await StorageMock.getItem(KEYS.TEST)).toStrictEqual({id: 1});
            expect(cache.get(KEYS.TEST)).toStrictEqual({id: 1});
        });

        it('retries a failed write of a RAM-backed value only once it changed, and notifies subscribers once', async () => {
            const deliveries = await subscribe(KEYS.TEST);
            jest.mocked(StorageMock.setItem).mockRejectedValueOnce(new Error('Generic storage error'));

            await Onyx.set(KEYS.TEST, 'value');

            expect(deliveries).toEqual([{value: 'value', key: KEYS.TEST}]);
            expect(storageWritesFor(KEYS.TEST)).toEqual(['value', 'value']);
        });

        it('resolves and keeps the cached value when every write attempt fails', async () => {
            const deliveries = await subscribe(KEYS.TEST);
            const setItemMock = jest.mocked(StorageMock.setItem);
            for (let attempt = 0; attempt < 6; attempt++) {
                setItemMock.mockRejectedValueOnce(new Error('Generic storage error'));
            }

            await expect(Onyx.set(KEYS.TEST, 'value')).resolves.toBeUndefined();

            expect(cache.get(KEYS.TEST)).toBe('value');
            expect(lastValue(deliveries)).toBe('value');
            expect(await StorageMock.getItem(KEYS.TEST)).toBeNull();
        });

        it('rejects on invalid data but has already updated the cache and subscribers', async () => {
            const deliveries = await subscribe(KEYS.TEST);
            const invalidDataError = new Error("Failed to execute 'put' on 'IDBObjectStore': invalid data");
            jest.mocked(StorageMock.setItem).mockRejectedValueOnce(invalidDataError);

            await expect(Onyx.set(KEYS.TEST, 'value')).rejects.toThrow(invalidDataError);

            expect(cache.get(KEYS.TEST)).toBe('value');
            expect(lastValue(deliveries)).toBe('value');
        });
    });

    describe('input immutability', () => {
        it('accepts a deeply frozen value with nested nulls without throwing', async () => {
            const value = deepFreeze({a: 1, b: null, c: {d: null, e: [1, null]}});

            await expect(Onyx.set(KEYS.TEST, value)).resolves.toBeUndefined();

            expect(cache.get(KEYS.TEST)).toStrictEqual({a: 1, c: {e: [1, null]}});
        });

        it('leaves the input value unchanged and unfrozen', async () => {
            const value = {a: 1, b: null, u: undefined, c: {d: null, e: {f: 'x'}}, list: [{g: null}]};
            const snapshot = {a: 1, b: null, u: undefined, c: {d: null, e: {f: 'x'}}, list: [{g: null}]};

            await Onyx.set(KEYS.TEST, value);

            expect(value).toStrictEqual(snapshot);
            expect(Object.keys(value)).toEqual(['a', 'b', 'u', 'c', 'list']);
            expect(isAnyNodeFrozen(value)).toBe(false);
        });

        it('leaves a collection member input unfrozen after collection subscribers read it', async () => {
            await subscribe(KEYS.COLLECTION.COLL);
            const value = {id: 1, nested: {a: 1}};

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, value);
            OnyxUtils.getCachedCollection(KEYS.COLLECTION.COLL);

            expect(isAnyNodeFrozen(value)).toBe(false);
            expect(value).toStrictEqual({id: 1, nested: {a: 1}});
        });

        it('does not alter the cached value when a later write replaces the key', async () => {
            const first = {a: 1, nested: {b: 2}};
            await Onyx.set(KEYS.TEST, first);

            await Onyx.set(KEYS.TEST, {a: 2});

            expect(first).toStrictEqual({a: 1, nested: {b: 2}});
        });
    });

    describe('writes during notifications', () => {
        it('lets a subscriber write another key from its callback', async () => {
            const otherDeliveries = await subscribe(KEYS.OTHER);
            connections.push(
                Onyx.connect({
                    key: KEYS.TEST,
                    callback: (value: unknown) => {
                        if (value !== 'trigger') {
                            return;
                        }
                        Onyx.set(KEYS.OTHER, 'written from callback');
                    },
                }),
            );
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.TEST, 'trigger');
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toBe('trigger');
            expect(cache.get(KEYS.OTHER)).toBe('written from callback');
            expect(lastValue(otherDeliveries)).toBe('written from callback');
            expect(await StorageMock.getItem(KEYS.TEST)).toBe('trigger');
            expect(await StorageMock.getItem(KEYS.OTHER)).toBe('written from callback');
        });

        it('lets a subscriber overwrite the same key from its callback and ends with the overwrite in the cache', async () => {
            connections.push(
                Onyx.connect({
                    key: KEYS.TEST,
                    callback: (value: unknown) => {
                        if (value !== 'first') {
                            return;
                        }
                        Onyx.set(KEYS.TEST, 'second');
                    },
                }),
            );
            const deliveries = await subscribe(KEYS.TEST);

            await Onyx.set(KEYS.TEST, 'first');
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toBe('second');
            expect(lastValue(deliveries)).toBe('second');
        });

        it('lets a collection subscriber write another member from its callback', async () => {
            connections.push(
                Onyx.connect({
                    key: KEYS.COLLECTION.COLL,
                    callback: (value: unknown) => {
                        if (!memberOf(value, `${KEYS.COLLECTION.COLL}1`) || memberOf(value, `${KEYS.COLLECTION.COLL}2`)) {
                            return;
                        }
                        Onyx.set(`${KEYS.COLLECTION.COLL}2`, {id: 2});
                    },
                }),
            );
            const collection = await subscribe(KEYS.COLLECTION.COLL);

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});
            await waitForPromisesToResolve();

            const expected = {[`${KEYS.COLLECTION.COLL}1`]: {id: 1}, [`${KEYS.COLLECTION.COLL}2`]: {id: 2}};
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.COLL)).toEqual(expected);
            expect(await StorageMock.getItem(`${KEYS.COLLECTION.COLL}2`)).toEqual({id: 2});
            expect(lastValue(collection)).toEqual(expected);
        });
    });

    describe('eviction bookkeeping', () => {
        it('marks a written evictable member as the most recently used and forgets it on null', async () => {
            await Onyx.set(`${KEYS.COLLECTION.EVICTABLE}1`, {id: 1});
            await Onyx.set(`${KEYS.COLLECTION.EVICTABLE}2`, {id: 2});
            expect(cache.getKeyForEviction()).toBe(`${KEYS.COLLECTION.EVICTABLE}1`);

            await Onyx.set(`${KEYS.COLLECTION.EVICTABLE}1`, {id: 10});
            expect(cache.getKeyForEviction()).toBe(`${KEYS.COLLECTION.EVICTABLE}2`);

            await Onyx.set(`${KEYS.COLLECTION.EVICTABLE}2`, null);
            expect(cache.getKeyForEviction()).toBe(`${KEYS.COLLECTION.EVICTABLE}1`);
        });

        it('never offers a non-evictable key for eviction', async () => {
            await Onyx.set(KEYS.TEST, 'value');
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});

            expect(cache.getKeyForEviction()).toBeUndefined();
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('leaves storage on the outer value when a subscriber overwrites the same key during the notification', async () => {
            connections.push(
                Onyx.connect({
                    key: KEYS.TEST,
                    callback: (value: unknown) => {
                        if (value !== 'first') {
                            return;
                        }
                        Onyx.set(KEYS.TEST, 'second');
                    },
                }),
            );
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.TEST, 'first');
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toBe('second');
            expect(await StorageMock.getItem(KEYS.TEST)).toBe('first');
        });

        it('leaves an independent subscriber on the stale outer value after a nested overwrite', async () => {
            connections.push(
                Onyx.connect({
                    key: KEYS.TEST,
                    reuseConnection: false,
                    callback: (value: unknown) => {
                        if (value !== 'first') {
                            return;
                        }
                        Onyx.set(KEYS.TEST, 'second');
                    },
                }),
            );
            const deliveries = await subscribe(KEYS.TEST, {reuseConnection: false});

            await Onyx.set(KEYS.TEST, 'first');
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toBe('second');
            expect(deliveries.map((delivery) => delivery.value)).toEqual(['second', 'first']);
        });

        it('leaves an independent collection subscriber on a stale snapshot after another subscriber writes a member', async () => {
            connections.push(
                Onyx.connect({
                    key: KEYS.COLLECTION.COLL,
                    reuseConnection: false,
                    callback: (value: unknown) => {
                        if (!memberOf(value, `${KEYS.COLLECTION.COLL}1`) || memberOf(value, `${KEYS.COLLECTION.COLL}2`)) {
                            return;
                        }
                        Onyx.set(`${KEYS.COLLECTION.COLL}2`, {id: 2});
                    },
                }),
            );
            const collection = await subscribe(KEYS.COLLECTION.COLL, {reuseConnection: false});

            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {id: 1});
            await waitForPromisesToResolve();

            const complete = {[`${KEYS.COLLECTION.COLL}1`]: {id: 1}, [`${KEYS.COLLECTION.COLL}2`]: {id: 2}};
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.COLL)).toEqual(complete);
            expect(collection.map((delivery) => delivery.value)).toEqual([complete, {[`${KEYS.COLLECTION.COLL}1`]: {id: 1}}]);
        });

        it('drops a pending merge even when the set itself is ignored because the value is undefined', async () => {
            await Onyx.set(KEYS.TEST, {a: 1});

            await Promise.all([Onyx.merge(KEYS.TEST, {b: 2}), Onyx.set(KEYS.TEST, undefined)]);
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toEqual({a: 1});
        });

        it('drops a pending merge even when the set itself is rejected as incompatible', async () => {
            await Onyx.set(KEYS.TEST, {a: 1});

            await Promise.all([Onyx.merge(KEYS.TEST, {b: 2}), Onyx.set(KEYS.TEST, ['x'])]);
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.TEST)).toEqual({a: 1});
        });

        it('resolves a removal before the storage removal has finished', async () => {
            await Onyx.set(KEYS.TEST, 'value');
            let finishRemoval: (() => void) | undefined;
            jest.mocked(StorageMock.removeItem).mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        finishRemoval = resolve;
                    }),
            );

            let isSettled = false;
            const promise = Onyx.set(KEYS.TEST, null).then(() => {
                isSettled = true;
            });
            await waitForPromisesToResolve();

            expect(isSettled).toBe(true);
            finishRemoval?.();
            await promise;
        });

        it('does not remove a key that exists in storage but not in the cache', async () => {
            await StorageMock.setItem(KEYS.TEST, 'stored only');

            await Onyx.set(KEYS.TEST, null);

            expect(await StorageMock.getItem(KEYS.TEST)).toBe('stored only');
        });
    });
});
