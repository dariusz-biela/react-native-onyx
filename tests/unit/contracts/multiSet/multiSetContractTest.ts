import Onyx from '../../../../lib';
import type {Connection} from '../../../../lib/OnyxConnectionManager';
import OnyxCache from '../../../../lib/OnyxCache';
import DevTools from '../../../../lib/DevTools';
import StorageMock from '../../../../lib/storage';
import {mockStore} from '../../../../lib/storage/providers/MemoryOnlyProvider';
import createDeferredTask from '../../../../lib/createDeferredTask';
import type {OnyxKey, OnyxMultiSetInput} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN_A: 'plainA',
    PLAIN_B: 'plainB',
    PLAIN_C: 'plainC',
    UNDERSCORE_PLAIN: 'nvp_plain',
    WITH_DEFAULT: 'withDefault',
    RAM_ONLY: 'ramOnlyKey',
    COLLECTION: {
        TEST: 'test_',
        TEST_LEVEL: 'test_level_',
        ROUTES: 'routes_',
        RAM_ONLY: 'ramOnlyCollection_',
    },
};

const SKIPPABLE_ID = 'skippable-id';
// Only matches when a member key is split on the most specific collection key ('test_level_' + '2' is not skippable).
const LEVEL_TRAP_ID = 'level_2';

const member = (collectionKey: string, id: string | number) => `${collectionKey}${id}`;

type Delivery = {value: unknown; key: string | undefined};

let connections: Connection[] = [];

/** Connects a callback subscriber, waits for its initial delivery and returns a cleared delivery log. */
async function subscribe(key: OnyxKey): Promise<Delivery[]> {
    const deliveries: Delivery[] = [];
    connections.push(
        Onyx.connect({
            key,
            callback: (value: unknown, callbackKey: string | undefined) => {
                deliveries.push({value, key: callbackKey});
            },
        }),
    );
    await waitForPromisesToResolve();
    deliveries.length = 0;
    return deliveries;
}

function storedValue(key: OnyxKey): unknown {
    return mockStore[key];
}

function isStored(key: OnyxKey): boolean {
    return Object.prototype.hasOwnProperty.call(mockStore, key);
}

function valueAt(collection: unknown, key: string): unknown {
    if (collection === null || typeof collection !== 'object') {
        return undefined;
    }
    return Object.entries(collection).find(([entryKey]) => entryKey === key)?.[1];
}

function lastValue(deliveries: Delivery[]): unknown {
    return deliveries.at(-1)?.value;
}

function allStorageMultiSetKeys(): string[] {
    return jest.spyOn(StorageMock, 'multiSet').mock.calls.flatMap(([pairs]) => pairs.map(([key]) => key));
}

function allStorageRemovedKeys(): string[] {
    return [...jest.spyOn(StorageMock, 'removeItems').mock.calls.flatMap(([keys]) => keys), ...jest.spyOn(StorageMock, 'removeItem').mock.calls.map(([key]) => key)];
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

describe('Onyx.multiSet contract', () => {
    beforeAll(() => {
        Onyx.init({
            keys: KEYS,
            initialKeyStates: {[KEYS.WITH_DEFAULT]: 'default'},
            ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.COLLECTION.RAM_ONLY],
            skippableCollectionMemberIDs: [SKIPPABLE_ID, LEVEL_TRAP_ID],
        });
    });

    beforeEach(async () => {
        await Onyx.clear();
        await waitForPromisesToResolve();
        jest.clearAllMocks();
    });

    afterEach(() => {
        for (const connection of connections) {
            Onyx.disconnect(connection);
        }
        connections = [];
        jest.restoreAllMocks();
    });

    describe('cache and storage', () => {
        it('writes plain keys and members of several collections to cache and storage in one call', async () => {
            const payload: OnyxMultiSetInput = {
                [KEYS.PLAIN_A]: 'a',
                [KEYS.PLAIN_B]: {nested: {deep: 1}},
                [KEYS.UNDERSCORE_PLAIN]: [1, 2, 3],
                [member(KEYS.COLLECTION.TEST, 1)]: {id: 1},
                [member(KEYS.COLLECTION.TEST, 2)]: {id: 2},
                [member(KEYS.COLLECTION.TEST_LEVEL, 1)]: {id: 'level1'},
                [member(KEYS.COLLECTION.ROUTES, 'A')]: {name: 'A'},
                [KEYS.PLAIN_C]: 0,
            };

            await Onyx.multiSet(payload);

            for (const [key, value] of Object.entries(payload)) {
                expect(OnyxCache.get(key)).toEqual(value);
                expect(storedValue(key)).toEqual(value);
            }
            for (const key of Object.keys(payload)) {
                expect(OnyxCache.getAllKeys().has(key)).toBe(true);
            }
        });

        it('keeps falsy primitives (0, false, empty string) as real values', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: 0, [KEYS.PLAIN_B]: false, [KEYS.PLAIN_C]: '', [member(KEYS.COLLECTION.TEST, 1)]: 0});

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe(0);
            expect(OnyxCache.get(KEYS.PLAIN_B)).toBe(false);
            expect(OnyxCache.get(KEYS.PLAIN_C)).toBe('');
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toBe(0);
            expect(storedValue(KEYS.PLAIN_A)).toBe(0);
            expect(storedValue(KEYS.PLAIN_B)).toBe(false);
            expect(storedValue(KEYS.PLAIN_C)).toBe('');
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toBe(0);
        });

        it('replaces existing values wholesale instead of merging them, including type changes', async () => {
            await Onyx.multiSet({
                [KEYS.PLAIN_A]: {keep: 1, drop: 2},
                [KEYS.PLAIN_B]: {an: 'object'},
                [member(KEYS.COLLECTION.TEST, 1)]: {a: 1, b: 2},
            });

            await Onyx.multiSet({
                [KEYS.PLAIN_A]: {keep: 10},
                [KEYS.PLAIN_B]: ['now', 'an', 'array'],
                [member(KEYS.COLLECTION.TEST, 1)]: 'now a string',
            });

            expect(OnyxCache.get(KEYS.PLAIN_A)).toEqual({keep: 10});
            expect(OnyxCache.get(KEYS.PLAIN_B)).toEqual(['now', 'an', 'array']);
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toBe('now a string');
            expect(storedValue(KEYS.PLAIN_A)).toEqual({keep: 10});
            expect(storedValue(KEYS.PLAIN_B)).toEqual(['now', 'an', 'array']);
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toBe('now a string');
        });

        it('does not remove collection members that are absent from the payload', async () => {
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}, [member(KEYS.COLLECTION.TEST, 2)]: {id: 2}});

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 3)]: {id: 3}});

            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toEqual({id: 1});
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 2))).toEqual({id: 2});
            expect(OnyxCache.getCollectionData(KEYS.COLLECTION.TEST)).toEqual({
                [member(KEYS.COLLECTION.TEST, 1)]: {id: 1},
                [member(KEYS.COLLECTION.TEST, 2)]: {id: 2},
                [member(KEYS.COLLECTION.TEST, 3)]: {id: 3},
            });
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toEqual({id: 1});
        });

        it('strips nested null and undefined properties from objects in cache, callbacks and storage', async () => {
            const plainDeliveries = await subscribe(KEYS.PLAIN_A);
            const memberDeliveries = await subscribe(member(KEYS.COLLECTION.TEST, 1));

            const value = {keep: 1, gone: null, alsoGone: undefined, nested: {inner: null, stays: 'x', deeper: {x: null}}, list: [null, {y: null}]};
            await Onyx.multiSet({[KEYS.PLAIN_A]: value, [member(KEYS.COLLECTION.TEST, 1)]: value});

            const expected = {keep: 1, nested: {stays: 'x', deeper: {}}, list: [null, {y: null}]};
            for (const key of [KEYS.PLAIN_A, member(KEYS.COLLECTION.TEST, 1)]) {
                expect(OnyxCache.get(key)).toStrictEqual(expected);
                expect(storedValue(key)).toStrictEqual(expected);
            }
            expect(lastValue(plainDeliveries)).toStrictEqual(expected);
            expect(lastValue(memberDeliveries)).toStrictEqual(expected);
        });

        it('keeps arrays and their null entries untouched', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: [null, 1, {a: null}], [member(KEYS.COLLECTION.TEST, 1)]: [null]});

            expect(OnyxCache.get(KEYS.PLAIN_A)).toStrictEqual([null, 1, {a: null}]);
            expect(storedValue(KEYS.PLAIN_A)).toStrictEqual([null, 1, {a: null}]);
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toStrictEqual([null]);
        });

        it('leaves nested nulls in the caller objects while stripping them from the stored copy', async () => {
            const inner = {c: null, d: 1};
            const value = {a: null, b: inner};

            await Onyx.multiSet({[KEYS.PLAIN_A]: value, [member(KEYS.COLLECTION.TEST, 1)]: value});

            expect(value).toStrictEqual({a: null, b: {c: null, d: 1}});
            expect(inner).toStrictEqual({c: null, d: 1});
            expect(OnyxCache.get(KEYS.PLAIN_A)).toStrictEqual({b: {d: 1}});
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toStrictEqual({b: {d: 1}});
        });

        it('never mutates the caller payload or its nested objects', async () => {
            const payload = deepFreeze({
                [KEYS.PLAIN_A]: {a: null, b: {c: null, d: 1}},
                [KEYS.PLAIN_B]: null,
                [member(KEYS.COLLECTION.TEST, 1)]: {x: undefined, y: 2},
                [member(KEYS.COLLECTION.TEST, SKIPPABLE_ID)]: {z: 1},
            });
            const snapshot = JSON.stringify(payload);

            await Onyx.multiSet(payload);

            expect(JSON.stringify(payload)).toBe(snapshot);
            expect(payload[member(KEYS.COLLECTION.TEST, SKIPPABLE_ID)]).toEqual({z: 1});
            expect(OnyxCache.get(KEYS.PLAIN_A)).toStrictEqual({b: {d: 1}});
        });

        it('does not let later caller mutations of a payload with nested nulls leak into the cache', async () => {
            const nested: {inner: number; gone: number | null} = {inner: 1, gone: null};
            const value = {nested};
            await Onyx.multiSet({[KEYS.PLAIN_A]: value});

            nested.inner = 99;

            expect(OnyxCache.get(KEYS.PLAIN_A)).toStrictEqual({nested: {inner: 1}});
        });

        it('ignores top-level undefined values: existing values, storage and subscribers are untouched', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: 'keep', [member(KEYS.COLLECTION.TEST, 1)]: {id: 1}});
            const plainDeliveries = await subscribe(KEYS.PLAIN_A);
            const collectionDeliveries = await subscribe(KEYS.COLLECTION.TEST);
            jest.clearAllMocks();

            await Onyx.multiSet({[KEYS.PLAIN_A]: undefined, [member(KEYS.COLLECTION.TEST, 1)]: undefined, [member(KEYS.COLLECTION.TEST, 2)]: undefined});

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe('keep');
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toEqual({id: 1});
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 2))).toBeUndefined();
            expect(storedValue(KEYS.PLAIN_A)).toBe('keep');
            expect(isStored(member(KEYS.COLLECTION.TEST, 2))).toBe(false);
            expect(plainDeliveries).toHaveLength(0);
            expect(collectionDeliveries).toHaveLength(0);
            expect(allStorageMultiSetKeys()).toEqual([]);
            expect(allStorageRemovedKeys()).toEqual([]);
        });

        it('resolves an empty payload without notifying anyone or touching data', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: 'a'});
            const deliveries = await subscribe(KEYS.PLAIN_A);
            const collectionDeliveries = await subscribe(KEYS.COLLECTION.TEST);

            await expect(Onyx.multiSet({})).resolves.toBeUndefined();

            expect(deliveries).toHaveLength(0);
            expect(collectionDeliveries).toHaveLength(0);
            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe('a');
            expect(storedValue(KEYS.PLAIN_A)).toBe('a');
        });

        it('overrides a key that has an initialKeyStates default and removes it with null', async () => {
            await Onyx.multiSet({[KEYS.WITH_DEFAULT]: 'custom'});
            expect(OnyxCache.get(KEYS.WITH_DEFAULT)).toBe('custom');
            expect(storedValue(KEYS.WITH_DEFAULT)).toBe('custom');

            await Onyx.multiSet({[KEYS.WITH_DEFAULT]: null});
            expect(OnyxCache.get(KEYS.WITH_DEFAULT)).toBeUndefined();
            expect(isStored(KEYS.WITH_DEFAULT)).toBe(false);
        });
    });

    describe('null removes keys', () => {
        it('removes plain keys and collection members from cache and storage and notifies undefined', async () => {
            await Onyx.multiSet({
                [KEYS.PLAIN_A]: 'a',
                [KEYS.PLAIN_B]: 'b',
                [member(KEYS.COLLECTION.TEST, 1)]: {id: 1},
                [member(KEYS.COLLECTION.TEST, 2)]: {id: 2},
            });
            const plainA = await subscribe(KEYS.PLAIN_A);
            const plainB = await subscribe(KEYS.PLAIN_B);
            const member1 = await subscribe(member(KEYS.COLLECTION.TEST, 1));
            const member2 = await subscribe(member(KEYS.COLLECTION.TEST, 2));
            const collection = await subscribe(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[KEYS.PLAIN_A]: null, [member(KEYS.COLLECTION.TEST, 1)]: null});

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBeUndefined();
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toBeUndefined();
            expect(OnyxCache.getAllKeys().has(KEYS.PLAIN_A)).toBe(false);
            expect(OnyxCache.getAllKeys().has(member(KEYS.COLLECTION.TEST, 1))).toBe(false);
            expect(isStored(KEYS.PLAIN_A)).toBe(false);
            expect(isStored(member(KEYS.COLLECTION.TEST, 1))).toBe(false);
            expect(storedValue(KEYS.PLAIN_B)).toBe('b');
            expect(storedValue(member(KEYS.COLLECTION.TEST, 2))).toEqual({id: 2});

            expect(plainA).toEqual([{value: undefined, key: KEYS.PLAIN_A}]);
            expect(member1).toEqual([{value: undefined, key: member(KEYS.COLLECTION.TEST, 1)}]);
            expect(plainB).toHaveLength(0);
            expect(member2).toHaveLength(0);
            expect(collection).toHaveLength(1);
            expect(lastValue(collection)).toEqual({[member(KEYS.COLLECTION.TEST, 2)]: {id: 2}});
        });

        it('sets and removes members of one collection in the same call with a single consistent collection delivery', async () => {
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}, [member(KEYS.COLLECTION.TEST, 2)]: {id: 2}});
            const collection = await subscribe(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: null, [member(KEYS.COLLECTION.TEST, 3)]: {id: 3}, [member(KEYS.COLLECTION.TEST, 2)]: {id: 22}});

            expect(collection).toHaveLength(1);
            expect(lastValue(collection)).toEqual({
                [member(KEYS.COLLECTION.TEST, 2)]: {id: 22},
                [member(KEYS.COLLECTION.TEST, 3)]: {id: 3},
            });
            expect(OnyxCache.getCollectionData(KEYS.COLLECTION.TEST)).toEqual(lastValue(collection));
        });

        it('delivers an empty collection when the last member is removed', async () => {
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}});
            const collection = await subscribe(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: null});

            expect(collection).toHaveLength(1);
            expect(lastValue(collection)).toEqual({});
        });

        it('treats null for a key that exists nowhere as a no-op for subscribers and storage values', async () => {
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}});
            const plain = await subscribe(KEYS.PLAIN_A);
            const missingMember = await subscribe(member(KEYS.COLLECTION.TEST, 9));
            const collection = await subscribe(KEYS.COLLECTION.TEST);
            const collectionBefore = OnyxCache.getCollectionData(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[KEYS.PLAIN_A]: null, [member(KEYS.COLLECTION.TEST, 9)]: null});

            expect(plain).toHaveLength(0);
            expect(missingMember).toHaveLength(0);
            expect(collection).toHaveLength(0);
            expect(OnyxCache.getCollectionData(KEYS.COLLECTION.TEST)).toBe(collectionBefore);
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toEqual({id: 1});
        });

        it('keeps the cached collection reference when removing a member that is persisted but was not loaded into the cache', async () => {
            const kept = {id: 1};
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: kept, [member(KEYS.COLLECTION.TEST, 2)]: {id: 2}});
            // Simulates member 2 being indexed in storage while its value was never loaded into the cache.
            OnyxCache.drop(member(KEYS.COLLECTION.TEST, 2));
            OnyxCache.addKey(member(KEYS.COLLECTION.TEST, 2));
            const before = OnyxCache.getCollectionData(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 2)]: null});

            expect(before).toEqual({[member(KEYS.COLLECTION.TEST, 1)]: kept});
            expect(OnyxCache.getCollectionData(KEYS.COLLECTION.TEST)).toBe(before);
            expect(isStored(member(KEYS.COLLECTION.TEST, 2))).toBe(false);
        });

        it('removes a key that exists only in storage (not yet read into the cache)', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: 'a'});
            // Simulates a key that is persisted and indexed but whose value was never loaded into the cache.
            OnyxCache.drop(KEYS.PLAIN_A);
            OnyxCache.addKey(KEYS.PLAIN_A);

            await Onyx.multiSet({[KEYS.PLAIN_A]: null});

            expect(isStored(KEYS.PLAIN_A)).toBe(false);
            expect(OnyxCache.get(KEYS.PLAIN_A)).toBeUndefined();
        });
    });

    describe('notifications', () => {
        it('notifies every plain key subscriber once with its own value and key, and nobody else', async () => {
            const a = await subscribe(KEYS.PLAIN_A);
            const b = await subscribe(KEYS.PLAIN_B);
            const underscore = await subscribe(KEYS.UNDERSCORE_PLAIN);
            const untouched = await subscribe(KEYS.PLAIN_C);
            const collection = await subscribe(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[KEYS.PLAIN_A]: 'a', [KEYS.PLAIN_B]: {b: 1}, [KEYS.UNDERSCORE_PLAIN]: 'u'});

            expect(a).toEqual([{value: 'a', key: KEYS.PLAIN_A}]);
            expect(b).toEqual([{value: {b: 1}, key: KEYS.PLAIN_B}]);
            expect(underscore).toEqual([{value: 'u', key: KEYS.UNDERSCORE_PLAIN}]);
            expect(untouched).toHaveLength(0);
            expect(collection).toHaveLength(0);
        });

        it('delivers one full collection per touched collection, merged with members already present', async () => {
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}});
            const test = await subscribe(KEYS.COLLECTION.TEST);
            const routes = await subscribe(KEYS.COLLECTION.ROUTES);
            const level = await subscribe(KEYS.COLLECTION.TEST_LEVEL);

            await Onyx.multiSet({
                [member(KEYS.COLLECTION.TEST, 2)]: {id: 2},
                [KEYS.PLAIN_A]: 'a',
                [member(KEYS.COLLECTION.ROUTES, 'A')]: {name: 'A'},
                [member(KEYS.COLLECTION.TEST, 3)]: {id: 3},
                [member(KEYS.COLLECTION.ROUTES, 'B')]: {name: 'B'},
            });

            expect(test).toEqual([
                {
                    value: {
                        [member(KEYS.COLLECTION.TEST, 1)]: {id: 1},
                        [member(KEYS.COLLECTION.TEST, 2)]: {id: 2},
                        [member(KEYS.COLLECTION.TEST, 3)]: {id: 3},
                    },
                    key: KEYS.COLLECTION.TEST,
                },
            ]);
            expect(routes).toEqual([
                {
                    value: {[member(KEYS.COLLECTION.ROUTES, 'A')]: {name: 'A'}, [member(KEYS.COLLECTION.ROUTES, 'B')]: {name: 'B'}},
                    key: KEYS.COLLECTION.ROUTES,
                },
            ]);
            expect(level).toHaveLength(0);
        });

        it('routes prefix-colliding members only to their most specific collection', async () => {
            const test = await subscribe(KEYS.COLLECTION.TEST);
            const level = await subscribe(KEYS.COLLECTION.TEST_LEVEL);

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST_LEVEL, 1)]: {id: 'L1'}});

            expect(test).toHaveLength(0);
            expect(level).toEqual([{value: {[member(KEYS.COLLECTION.TEST_LEVEL, 1)]: {id: 'L1'}}, key: KEYS.COLLECTION.TEST_LEVEL}]);

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 'T1'}});

            expect(level).toHaveLength(1);
            expect(test).toEqual([{value: {[member(KEYS.COLLECTION.TEST, 1)]: {id: 'T1'}}, key: KEYS.COLLECTION.TEST}]);
            expect(OnyxCache.getCollectionData(KEYS.COLLECTION.TEST)).toEqual({[member(KEYS.COLLECTION.TEST, 1)]: {id: 'T1'}});
            expect(OnyxCache.getCollectionData(KEYS.COLLECTION.TEST_LEVEL)).toEqual({[member(KEYS.COLLECTION.TEST_LEVEL, 1)]: {id: 'L1'}});
        });

        it('notifies member subscribers only for members whose reference changed', async () => {
            const unchanged = {id: 2};
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}, [member(KEYS.COLLECTION.TEST, 2)]: unchanged, [member(KEYS.COLLECTION.TEST, 3)]: {id: 3}});
            const m1 = await subscribe(member(KEYS.COLLECTION.TEST, 1));
            const m2 = await subscribe(member(KEYS.COLLECTION.TEST, 2));
            const m3 = await subscribe(member(KEYS.COLLECTION.TEST, 3));
            const m4 = await subscribe(member(KEYS.COLLECTION.TEST, 4));

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 11}, [member(KEYS.COLLECTION.TEST, 2)]: unchanged, [member(KEYS.COLLECTION.TEST, 4)]: {id: 4}});

            expect(m1).toEqual([{value: {id: 11}, key: member(KEYS.COLLECTION.TEST, 1)}]);
            expect(m2).toHaveLength(0);
            expect(m3).toHaveLength(0);
            expect(m4).toEqual([{value: {id: 4}, key: member(KEYS.COLLECTION.TEST, 4)}]);
        });

        it('does not notify a plain key subscriber when the same reference is set again', async () => {
            const value = {same: true};
            await Onyx.multiSet({[KEYS.PLAIN_A]: value, [KEYS.PLAIN_B]: 'b'});
            const a = await subscribe(KEYS.PLAIN_A);
            const b = await subscribe(KEYS.PLAIN_B);
            await Onyx.multiSet({[KEYS.PLAIN_A]: {other: 1}});
            await Onyx.multiSet({[KEYS.PLAIN_A]: value});
            a.length = 0;

            await Onyx.multiSet({[KEYS.PLAIN_A]: value, [KEYS.PLAIN_B]: 'b'});

            expect(a).toHaveLength(0);
            // The first write after connecting may still deliver the unchanged primitive once.
            expect(b.length).toBeLessThanOrEqual(1);
            expect(b.every((delivery) => delivery.value === 'b')).toBe(true);
            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe(value);
        });

        it('delivers at most one valid value when a new reference with deep-equal content is set', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: {n: 1}, [member(KEYS.COLLECTION.TEST, 1)]: {n: 1}});
            const a = await subscribe(KEYS.PLAIN_A);
            const m = await subscribe(member(KEYS.COLLECTION.TEST, 1));

            await Onyx.multiSet({[KEYS.PLAIN_A]: {n: 1}, [member(KEYS.COLLECTION.TEST, 1)]: {n: 1}});

            expect(a.length).toBeLessThanOrEqual(1);
            expect(m.length).toBeLessThanOrEqual(1);
            for (const delivery of [...a, ...m]) {
                expect(delivery.value).toEqual({n: 1});
            }
            expect(OnyxCache.get(KEYS.PLAIN_A)).toEqual({n: 1});
            expect(storedValue(KEYS.PLAIN_A)).toEqual({n: 1});
        });

        it('keeps the collection reference when every member in the batch keeps its reference', async () => {
            const v1 = {id: 1};
            const v2 = {id: 2};
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: v1, [member(KEYS.COLLECTION.TEST, 2)]: v2});
            const collection = await subscribe(KEYS.COLLECTION.TEST);
            const before = OnyxCache.getCollectionData(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: v1, [member(KEYS.COLLECTION.TEST, 2)]: v2});

            expect(collection.length).toBeLessThanOrEqual(1);
            for (const delivery of collection) {
                expect(delivery.value).toBe(before);
            }
            expect(OnyxCache.getCollectionData(KEYS.COLLECTION.TEST)).toBe(before);
        });

        it('gives a changed collection a new reference while untouched members keep theirs', async () => {
            const untouched = {id: 2, nested: {deep: true}};
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}, [member(KEYS.COLLECTION.TEST, 2)]: untouched});
            const collection = await subscribe(KEYS.COLLECTION.TEST);
            const before = OnyxCache.getCollectionData(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 11}});

            expect(collection).toHaveLength(1);
            const after = lastValue(collection);
            expect(after).not.toBe(before);
            expect(valueAt(after, member(KEYS.COLLECTION.TEST, 2))).toBe(untouched);
            expect(valueAt(after, member(KEYS.COLLECTION.TEST, 1))).toEqual({id: 11});
            expect(before).toEqual({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}, [member(KEYS.COLLECTION.TEST, 2)]: untouched});
        });

        it('delivers the stored object by reference to plain and member subscribers when no nulls needed stripping', async () => {
            const plainValue = {p: 1};
            const memberValue = {m: 1};
            const a = await subscribe(KEYS.PLAIN_A);
            const m = await subscribe(member(KEYS.COLLECTION.TEST, 1));

            await Onyx.multiSet({[KEYS.PLAIN_A]: plainValue, [member(KEYS.COLLECTION.TEST, 1)]: memberValue});

            expect(lastValue(a)).toBe(OnyxCache.get(KEYS.PLAIN_A));
            expect(lastValue(m)).toBe(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1)));
        });

        it('has every value of the batch in the cache by the time any collection subscriber runs', async () => {
            const seen: Array<Record<string, unknown>> = [];
            connections.push(
                Onyx.connect({
                    key: KEYS.COLLECTION.TEST,
                    callback: () => {
                        seen.push({
                            plainA: OnyxCache.get(KEYS.PLAIN_A),
                            plainB: OnyxCache.get(KEYS.PLAIN_B),
                            m1: OnyxCache.get(member(KEYS.COLLECTION.TEST, 1)),
                            m2: OnyxCache.get(member(KEYS.COLLECTION.TEST, 2)),
                            route: OnyxCache.get(member(KEYS.COLLECTION.ROUTES, 'A')),
                        });
                    },
                }),
            );
            await waitForPromisesToResolve();
            seen.length = 0;

            await Onyx.multiSet({
                [member(KEYS.COLLECTION.TEST, 1)]: 1,
                [KEYS.PLAIN_A]: 'a',
                [member(KEYS.COLLECTION.ROUTES, 'A')]: 'r',
                [member(KEYS.COLLECTION.TEST, 2)]: 2,
                [KEYS.PLAIN_B]: 'b',
            });

            expect(seen).toEqual([{plainA: 'a', plainB: 'b', m1: 1, m2: 2, route: 'r'}]);
        });

        it('has the new value of a plain key in the cache when its subscriber runs', async () => {
            const seenInCache: unknown[] = [];
            connections.push(
                Onyx.connect({
                    key: KEYS.PLAIN_B,
                    callback: () => {
                        seenInCache.push(OnyxCache.get(KEYS.PLAIN_B));
                    },
                }),
            );
            await waitForPromisesToResolve();
            seenInCache.length = 0;

            await Onyx.multiSet({[KEYS.PLAIN_A]: 'a', [KEYS.PLAIN_B]: 'b'});

            expect(seenInCache).toEqual(['b']);
        });

        it('keeps notifying other subscribers when one subscriber callback throws', async () => {
            connections.push(
                Onyx.connect({
                    key: KEYS.PLAIN_A,
                    reuseConnection: false,
                    callback: (value: unknown) => {
                        if (value !== 'boom') {
                            return;
                        }
                        throw new Error('subscriber failure');
                    },
                }),
            );
            connections.push(
                Onyx.connect({
                    key: KEYS.COLLECTION.TEST,
                    reuseConnection: false,
                    callback: (value: unknown) => {
                        if (!value || Object.keys(value).length === 0) {
                            return;
                        }
                        throw new Error('collection subscriber failure');
                    },
                }),
            );
            const a = await subscribe(KEYS.PLAIN_A);
            const b = await subscribe(KEYS.PLAIN_B);
            const collection = await subscribe(KEYS.COLLECTION.TEST);
            const m1 = await subscribe(member(KEYS.COLLECTION.TEST, 1));

            await expect(Onyx.multiSet({[KEYS.PLAIN_A]: 'boom', [KEYS.PLAIN_B]: 'b', [member(KEYS.COLLECTION.TEST, 1)]: 1})).resolves.toBeUndefined();

            expect(a).toEqual([{value: 'boom', key: KEYS.PLAIN_A}]);
            expect(b).toEqual([{value: 'b', key: KEYS.PLAIN_B}]);
            expect(collection).toHaveLength(1);
            expect(m1).toEqual([{value: 1, key: member(KEYS.COLLECTION.TEST, 1)}]);
            expect(storedValue(KEYS.PLAIN_B)).toBe('b');
        });

        it('delivers the batch to multiple callbacks sharing one connection and to non-reused connections alike', async () => {
            const shared1 = await subscribe(KEYS.COLLECTION.TEST);
            const shared2 = await subscribe(KEYS.COLLECTION.TEST);
            const unique: unknown[] = [];
            connections.push(Onyx.connect({key: KEYS.COLLECTION.TEST, reuseConnection: false, callback: (value: unknown) => unique.push(value)}));
            await waitForPromisesToResolve();
            unique.length = 0;

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: 1, [member(KEYS.COLLECTION.TEST, 2)]: 2});

            const expected = {[member(KEYS.COLLECTION.TEST, 1)]: 1, [member(KEYS.COLLECTION.TEST, 2)]: 2};
            expect(shared1.map(({value}) => value)).toEqual([expected]);
            expect(shared2.map(({value}) => value)).toEqual([expected]);
            expect(unique).toEqual([expected]);
        });
    });

    describe('writes during notifications and interleaved writes', () => {
        it('lets a collection subscriber write to a member of the same collection during delivery', async () => {
            const deliveries: unknown[] = [];
            let hasWritten = false;
            connections.push(
                Onyx.connect({
                    key: KEYS.COLLECTION.TEST,
                    callback: (value: unknown) => {
                        deliveries.push(value);
                        if (!hasWritten && valueAt(value, member(KEYS.COLLECTION.TEST, 1)) === 'from multiSet') {
                            hasWritten = true;
                            Onyx.set(member(KEYS.COLLECTION.TEST, 1), 'from callback');
                        }
                    },
                }),
            );
            await waitForPromisesToResolve();
            deliveries.length = 0;

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: 'from multiSet', [member(KEYS.COLLECTION.TEST, 2)]: 'other'});
            await waitForPromisesToResolve();

            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toBe('from callback');
            expect(storedValue(member(KEYS.COLLECTION.TEST, 2))).toBe('other');
            expect(deliveries.at(0)).toEqual({[member(KEYS.COLLECTION.TEST, 1)]: 'from multiSet', [member(KEYS.COLLECTION.TEST, 2)]: 'other'});
            expect(deliveries.at(-1)).toEqual({[member(KEYS.COLLECTION.TEST, 1)]: 'from callback', [member(KEYS.COLLECTION.TEST, 2)]: 'other'});
        });

        it('lets a plain key subscriber start another multiSet during delivery without losing either write', async () => {
            const b = await subscribe(KEYS.PLAIN_B);
            connections.push(
                Onyx.connect({
                    key: KEYS.PLAIN_A,
                    callback: (value: unknown) => {
                        if (value !== 'trigger') {
                            return;
                        }
                        Onyx.multiSet({[KEYS.PLAIN_C]: 'nested', [member(KEYS.COLLECTION.TEST, 5)]: 'nested member'});
                    },
                }),
            );
            const c = await subscribe(KEYS.PLAIN_C);
            const collection = await subscribe(KEYS.COLLECTION.TEST);

            await Onyx.multiSet({[KEYS.PLAIN_A]: 'trigger', [KEYS.PLAIN_B]: 'b', [member(KEYS.COLLECTION.TEST, 1)]: 'outer member'});
            await waitForPromisesToResolve();

            expect(OnyxCache.get(KEYS.PLAIN_C)).toBe('nested');
            expect(storedValue(KEYS.PLAIN_C)).toBe('nested');
            expect(lastValue(b)).toBe('b');
            expect(lastValue(c)).toBe('nested');
            expect(lastValue(collection)).toEqual({[member(KEYS.COLLECTION.TEST, 1)]: 'outer member', [member(KEYS.COLLECTION.TEST, 5)]: 'nested member'});
            expect(OnyxCache.getCollectionData(KEYS.COLLECTION.TEST)).toEqual(lastValue(collection));
        });

        it('applies interleaved writes to the same key in call order (last write wins everywhere)', async () => {
            const a = await subscribe(KEYS.PLAIN_A);
            const m = await subscribe(member(KEYS.COLLECTION.TEST, 1));

            const promises = [
                Onyx.multiSet({[KEYS.PLAIN_A]: 1, [member(KEYS.COLLECTION.TEST, 1)]: 1}),
                Onyx.set(KEYS.PLAIN_A, 2),
                Onyx.multiSet({[KEYS.PLAIN_A]: 3, [member(KEYS.COLLECTION.TEST, 1)]: 3}),
                Onyx.set(member(KEYS.COLLECTION.TEST, 1), 4),
            ];
            await Promise.all(promises);
            await waitForPromisesToResolve();

            expect(a.map(({value}) => value)).toEqual([1, 2, 3]);
            expect(m.map(({value}) => value)).toEqual([1, 3, 4]);
            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe(3);
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toBe(4);
            expect(storedValue(KEYS.PLAIN_A)).toBe(3);
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toBe(4);
        });

        it('delivers every state of consecutive multiSets of one collection in order', async () => {
            const collection = await subscribe(KEYS.COLLECTION.TEST);

            const promises = [
                Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: 'a'}),
                Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 2)]: 'b'}),
                Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: null}),
            ];
            await Promise.all(promises);

            const states = collection.map(({value}) => value);
            expect(states).toEqual([
                {[member(KEYS.COLLECTION.TEST, 1)]: 'a'},
                {[member(KEYS.COLLECTION.TEST, 1)]: 'a', [member(KEYS.COLLECTION.TEST, 2)]: 'b'},
                {[member(KEYS.COLLECTION.TEST, 2)]: 'b'},
            ]);
            expect(storedValue(member(KEYS.COLLECTION.TEST, 2))).toBe('b');
            expect(isStored(member(KEYS.COLLECTION.TEST, 1))).toBe(false);
        });

        it('cancels an Onyx.merge queued earlier in the same tick for a key it sets', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: {base: true}, [member(KEYS.COLLECTION.TEST, 1)]: {base: true}});

            const mergePromise = Onyx.merge(KEYS.PLAIN_A, {merged: true});
            const memberMergePromise = Onyx.merge(member(KEYS.COLLECTION.TEST, 1), {merged: true});
            const setPromise = Onyx.multiSet({[KEYS.PLAIN_A]: {fromMultiSet: true}, [member(KEYS.COLLECTION.TEST, 1)]: {fromMultiSet: true}});
            await Promise.all([mergePromise, memberMergePromise, setPromise]);
            await waitForPromisesToResolve();

            expect(OnyxCache.get(KEYS.PLAIN_A)).toEqual({fromMultiSet: true});
            expect(storedValue(KEYS.PLAIN_A)).toEqual({fromMultiSet: true});
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toEqual({fromMultiSet: true});
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toEqual({fromMultiSet: true});
        });

        it('cancels a queued Onyx.merge even when it sets the same reference that is already cached', async () => {
            const value = {base: true};
            await Onyx.multiSet({[KEYS.PLAIN_A]: value, [member(KEYS.COLLECTION.TEST, 1)]: value});

            const mergePromise = Onyx.merge(KEYS.PLAIN_A, {merged: true});
            const memberMergePromise = Onyx.merge(member(KEYS.COLLECTION.TEST, 1), {merged: true});
            const setPromise = Onyx.multiSet({[KEYS.PLAIN_A]: value, [member(KEYS.COLLECTION.TEST, 1)]: value});
            await Promise.all([mergePromise, memberMergePromise, setPromise]);
            await waitForPromisesToResolve();

            expect(OnyxCache.get(KEYS.PLAIN_A)).toEqual({base: true});
            expect(storedValue(KEYS.PLAIN_A)).toEqual({base: true});
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toEqual({base: true});
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toEqual({base: true});
        });

        it('lets an Onyx.merge issued after it in the same tick apply on top of the set value', async () => {
            const a = await subscribe(KEYS.PLAIN_A);

            const setPromise = Onyx.multiSet({[KEYS.PLAIN_A]: {fromMultiSet: true}});
            const mergePromise = Onyx.merge(KEYS.PLAIN_A, {merged: true});
            await Promise.all([setPromise, mergePromise]);
            await waitForPromisesToResolve();

            expect(OnyxCache.get(KEYS.PLAIN_A)).toEqual({fromMultiSet: true, merged: true});
            expect(storedValue(KEYS.PLAIN_A)).toEqual({fromMultiSet: true, merged: true});
            expect(lastValue(a)).toEqual({fromMultiSet: true, merged: true});
        });
    });

    describe('RAM-only keys inside a batch', () => {
        it('keeps RAM-only keys and members in the cache and notifies them, but never persists them', async () => {
            const ram = await subscribe(KEYS.RAM_ONLY);
            const ramCollection = await subscribe(KEYS.COLLECTION.RAM_ONLY);

            await Onyx.multiSet({
                [KEYS.RAM_ONLY]: 'ram',
                [member(KEYS.COLLECTION.RAM_ONLY, 1)]: {ram: 1},
                [KEYS.PLAIN_A]: 'persisted',
                [member(KEYS.COLLECTION.TEST, 1)]: 'persisted member',
            });

            expect(OnyxCache.get(KEYS.RAM_ONLY)).toBe('ram');
            expect(OnyxCache.get(member(KEYS.COLLECTION.RAM_ONLY, 1))).toEqual({ram: 1});
            expect(ram).toEqual([{value: 'ram', key: KEYS.RAM_ONLY}]);
            expect(ramCollection.map(({value}) => value)).toEqual([{[member(KEYS.COLLECTION.RAM_ONLY, 1)]: {ram: 1}}]);

            expect(isStored(KEYS.RAM_ONLY)).toBe(false);
            expect(isStored(member(KEYS.COLLECTION.RAM_ONLY, 1))).toBe(false);
            expect(allStorageMultiSetKeys()).not.toContain(KEYS.RAM_ONLY);
            expect(allStorageMultiSetKeys()).not.toContain(member(KEYS.COLLECTION.RAM_ONLY, 1));
            expect(jest.spyOn(StorageMock, 'setItem').mock.calls.map(([key]) => key)).not.toContain(KEYS.RAM_ONLY);
            expect(storedValue(KEYS.PLAIN_A)).toBe('persisted');
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toBe('persisted member');
        });

        it('removes RAM-only keys from the cache on null without asking storage to remove them', async () => {
            await Onyx.multiSet({[KEYS.RAM_ONLY]: 'ram', [member(KEYS.COLLECTION.RAM_ONLY, 1)]: 1, [KEYS.PLAIN_A]: 'a'});
            const ram = await subscribe(KEYS.RAM_ONLY);
            const ramMember = await subscribe(member(KEYS.COLLECTION.RAM_ONLY, 1));
            jest.clearAllMocks();

            await Onyx.multiSet({[KEYS.RAM_ONLY]: null, [member(KEYS.COLLECTION.RAM_ONLY, 1)]: null, [KEYS.PLAIN_A]: null});

            expect(OnyxCache.get(KEYS.RAM_ONLY)).toBeUndefined();
            expect(OnyxCache.get(member(KEYS.COLLECTION.RAM_ONLY, 1))).toBeUndefined();
            expect(ram).toEqual([{value: undefined, key: KEYS.RAM_ONLY}]);
            expect(ramMember).toEqual([{value: undefined, key: member(KEYS.COLLECTION.RAM_ONLY, 1)}]);
            expect(allStorageRemovedKeys()).not.toContain(KEYS.RAM_ONLY);
            expect(allStorageRemovedKeys()).not.toContain(member(KEYS.COLLECTION.RAM_ONLY, 1));
            expect(isStored(KEYS.PLAIN_A)).toBe(false);
        });

        it('still reports the batch to DevTools when it holds only RAM-only keys', async () => {
            const registerAction = jest.spyOn(DevTools, 'registerAction');

            await Onyx.multiSet({[KEYS.RAM_ONLY]: 'ram'});

            const multiSetActions = registerAction.mock.calls.filter(([type]) => type === 'MULTISET');
            expect(multiSetActions).toHaveLength(1);
            expect(multiSetActions.at(0)?.[1]).toEqual({[KEYS.RAM_ONLY]: 'ram'});
        });

        it('persists nothing when the batch holds only RAM-only keys', async () => {
            await Onyx.multiSet({[KEYS.RAM_ONLY]: 'ram', [member(KEYS.COLLECTION.RAM_ONLY, 1)]: 1});

            expect(allStorageMultiSetKeys()).toEqual([]);
            expect(isStored(KEYS.RAM_ONLY)).toBe(false);
            expect(OnyxCache.get(KEYS.RAM_ONLY)).toBe('ram');
        });
    });

    describe('skippable collection member IDs inside a batch', () => {
        it('drops skippable members while writing the rest of the batch', async () => {
            const collection = await subscribe(KEYS.COLLECTION.TEST);
            const skipped = await subscribe(member(KEYS.COLLECTION.TEST, SKIPPABLE_ID));

            await Onyx.multiSet({
                [member(KEYS.COLLECTION.TEST, SKIPPABLE_ID)]: {skip: true},
                [member(KEYS.COLLECTION.TEST, 1)]: {id: 1},
                [KEYS.PLAIN_A]: 'a',
            });

            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, SKIPPABLE_ID))).toBeUndefined();
            expect(isStored(member(KEYS.COLLECTION.TEST, SKIPPABLE_ID))).toBe(false);
            expect(skipped).toHaveLength(0);
            expect(collection.map(({value}) => value)).toEqual([{[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}}]);
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toEqual({id: 1});
            expect(storedValue(KEYS.PLAIN_A)).toBe('a');
        });

        it('removes an already present skippable member, as if it were set to null', async () => {
            const skippableKey = member(KEYS.COLLECTION.TEST, SKIPPABLE_ID);
            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: 1});
            await StorageMock.setItem(skippableKey, {stale: true});
            OnyxCache.set(skippableKey, {stale: true});
            const collection = await subscribe(KEYS.COLLECTION.TEST);
            const skipped = await subscribe(skippableKey);

            await Onyx.multiSet({[skippableKey]: {fresh: true}});

            expect(OnyxCache.get(skippableKey)).toBeUndefined();
            expect(isStored(skippableKey)).toBe(false);
            expect(skipped).toEqual([{value: undefined, key: skippableKey}]);
            expect(lastValue(collection)).toEqual({[member(KEYS.COLLECTION.TEST, 1)]: 1});
        });

        it('only skips exact member IDs of the most specific collection and never plain keys', async () => {
            const payload: OnyxMultiSetInput = {
                [member(KEYS.COLLECTION.TEST, `${SKIPPABLE_ID}2`)]: 'suffix',
                [member(KEYS.COLLECTION.TEST, `x${SKIPPABLE_ID}`)]: 'prefix',
                [member(KEYS.COLLECTION.TEST_LEVEL, 2)]: 'level member two',
                [`nvp_${SKIPPABLE_ID}`]: 'plain with underscore',
            };

            await Onyx.multiSet({...payload, [member(KEYS.COLLECTION.TEST_LEVEL, SKIPPABLE_ID)]: 'skipped'});

            for (const [key, value] of Object.entries(payload)) {
                expect(OnyxCache.get(key)).toBe(value);
                expect(storedValue(key)).toBe(value);
            }
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST_LEVEL, SKIPPABLE_ID))).toBeUndefined();
            expect(isStored(member(KEYS.COLLECTION.TEST_LEVEL, SKIPPABLE_ID))).toBe(false);
        });
    });

    describe('promise timing', () => {
        it('updates the cache and notifies subscribers before storage finishes, and resolves only after storage finishes', async () => {
            const a = await subscribe(KEYS.PLAIN_A);
            const collection = await subscribe(KEYS.COLLECTION.TEST);
            const storageWrite = createDeferredTask();
            const originalMultiSet = jest.spyOn(StorageMock, 'multiSet').getMockImplementation();
            jest.spyOn(StorageMock, 'multiSet').mockImplementationOnce((pairs) => storageWrite.promise.then(() => originalMultiSet?.(pairs)));

            let isResolved = false;
            const promise = Onyx.multiSet({[KEYS.PLAIN_A]: 'a', [member(KEYS.COLLECTION.TEST, 1)]: 1}).then(() => {
                isResolved = true;
            });

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe('a');
            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toBe(1);
            await waitForPromisesToResolve();

            expect(a.map(({value}) => value)).toEqual(['a']);
            expect(collection.map(({value}) => value)).toEqual([{[member(KEYS.COLLECTION.TEST, 1)]: 1}]);
            expect(isResolved).toBe(false);
            expect(isStored(KEYS.PLAIN_A)).toBe(false);

            storageWrite.resolve();
            await promise;

            expect(isResolved).toBe(true);
            expect(storedValue(KEYS.PLAIN_A)).toBe('a');
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toBe(1);
        });

        it('resolves only after removals of null keys have reached storage', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: 'a', [member(KEYS.COLLECTION.TEST, 1)]: 1});
            const removal = createDeferredTask();
            const originalRemoveItems = jest.spyOn(StorageMock, 'removeItems').getMockImplementation();
            jest.spyOn(StorageMock, 'removeItems').mockImplementationOnce((keys) => removal.promise.then(() => originalRemoveItems?.(keys)));

            let isResolved = false;
            const promise = Onyx.multiSet({[KEYS.PLAIN_A]: null, [member(KEYS.COLLECTION.TEST, 1)]: null, [KEYS.PLAIN_B]: 'b'}).then(() => {
                isResolved = true;
            });
            await waitForPromisesToResolve();

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBeUndefined();
            expect(isResolved).toBe(false);

            removal.resolve();
            await promise;

            expect(isStored(KEYS.PLAIN_A)).toBe(false);
            expect(isStored(member(KEYS.COLLECTION.TEST, 1))).toBe(false);
            expect(storedValue(KEYS.PLAIN_B)).toBe('b');
        });

        it('still resolves when removing null keys from storage fails', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: 'a'});
            jest.spyOn(StorageMock, 'removeItems').mockRejectedValueOnce(new Error('remove failed'));

            await expect(Onyx.multiSet({[KEYS.PLAIN_A]: null, [KEYS.PLAIN_B]: 'b'})).resolves.toBeUndefined();

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBeUndefined();
            expect(storedValue(KEYS.PLAIN_B)).toBe('b');
        });

        it('still resolves when removing null keys fails with an error that a failed write would reject with', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: 'a'});
            jest.spyOn(StorageMock, 'removeItems').mockRejectedValueOnce(new Error("Failed to execute 'put' on 'IDBObjectStore'"));

            await expect(Onyx.multiSet({[KEYS.PLAIN_A]: null, [KEYS.PLAIN_B]: 'b'})).resolves.toBeUndefined();

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBeUndefined();
            expect(storedValue(KEYS.PLAIN_B)).toBe('b');
        });

        it('keeps skippable members out of the cache and storage when the write is retried', async () => {
            const skippableKey = member(KEYS.COLLECTION.TEST, SKIPPABLE_ID);
            const skipped = await subscribe(skippableKey);
            jest.spyOn(StorageMock, 'multiSet').mockRejectedValueOnce(new Error('Transient storage error'));

            await Onyx.multiSet({[skippableKey]: {skip: true}, [member(KEYS.COLLECTION.TEST, 1)]: 1});

            expect(OnyxCache.get(skippableKey)).toBeUndefined();
            expect(isStored(skippableKey)).toBe(false);
            expect(skipped).toHaveLength(0);
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toBe(1);
        });

        it('retries a failed storage write without re-notifying subscribers and resolves once the data is stored', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_C]: 'to remove', [member(KEYS.COLLECTION.TEST, 9)]: 'to remove'});
            const a = await subscribe(KEYS.PLAIN_A);
            const c = await subscribe(KEYS.PLAIN_C);
            const m1 = await subscribe(member(KEYS.COLLECTION.TEST, 1));
            const collection = await subscribe(KEYS.COLLECTION.TEST);
            jest.spyOn(StorageMock, 'multiSet').mockRejectedValueOnce(new Error('Transient storage error'));

            await expect(Onyx.multiSet({[KEYS.PLAIN_A]: 'a', [KEYS.PLAIN_C]: null, [member(KEYS.COLLECTION.TEST, 1)]: 1, [member(KEYS.COLLECTION.TEST, 9)]: null})).resolves.toBeUndefined();

            expect(a).toEqual([{value: 'a', key: KEYS.PLAIN_A}]);
            expect(c).toEqual([{value: undefined, key: KEYS.PLAIN_C}]);
            expect(m1).toEqual([{value: 1, key: member(KEYS.COLLECTION.TEST, 1)}]);
            expect(collection.map(({value}) => value)).toEqual([{[member(KEYS.COLLECTION.TEST, 1)]: 1}]);
            expect(storedValue(KEYS.PLAIN_A)).toBe('a');
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toBe(1);
            expect(isStored(KEYS.PLAIN_C)).toBe(false);
            expect(isStored(member(KEYS.COLLECTION.TEST, 9))).toBe(false);
            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe('a');
        });

        it('rejects when storage reports invalid (non-serializable) data, after the cache was already updated', async () => {
            jest.spyOn(StorageMock, 'multiSet').mockRejectedValueOnce(new Error("Failed to execute 'put' on 'IDBObjectStore'"));

            await expect(Onyx.multiSet({[KEYS.PLAIN_A]: 'a'})).rejects.toThrow("Failed to execute 'put' on 'IDBObjectStore'");

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe('a');
        });

        it('reports one MULTI_SET action to DevTools after the write, with skippable members as null', async () => {
            const registerAction = jest.spyOn(DevTools, 'registerAction');

            await Onyx.multiSet({[KEYS.PLAIN_A]: 'a', [member(KEYS.COLLECTION.TEST, SKIPPABLE_ID)]: 1});

            const multiSetActions = registerAction.mock.calls.filter(([type]) => type === 'MULTISET');
            expect(multiSetActions).toHaveLength(1);
            expect(multiSetActions.at(0)?.[1]).toEqual({[KEYS.PLAIN_A]: 'a', [member(KEYS.COLLECTION.TEST, SKIPPABLE_ID)]: null});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('does not cancel an Onyx.merge queued earlier in the same tick when the key is set to null', async () => {
            await Onyx.multiSet({[KEYS.PLAIN_A]: {base: true}});

            const mergePromise = Onyx.merge(KEYS.PLAIN_A, {merged: true});
            const setPromise = Onyx.multiSet({[KEYS.PLAIN_A]: null});
            await Promise.all([mergePromise, setPromise]);
            await waitForPromisesToResolve();

            // Onyx.set(key, null) cancels the queued merge; here the merge resurrects the removed value.
            expect(OnyxCache.get(KEYS.PLAIN_A)).toEqual({base: true, merged: true});
            expect(storedValue(KEYS.PLAIN_A)).toEqual({base: true, merged: true});
        });

        it('persists its own value over a write made by a collection subscriber during delivery, leaving storage out of sync with the cache', async () => {
            let hasWritten = false;
            connections.push(
                Onyx.connect({
                    key: KEYS.COLLECTION.TEST,
                    callback: (value: unknown) => {
                        if (hasWritten || valueAt(value, member(KEYS.COLLECTION.TEST, 1)) !== 'from multiSet') {
                            return;
                        }
                        hasWritten = true;
                        Onyx.set(member(KEYS.COLLECTION.TEST, 1), 'from callback');
                    },
                }),
            );
            await waitForPromisesToResolve();

            await Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: 'from multiSet'});
            await waitForPromisesToResolve();

            expect(OnyxCache.get(member(KEYS.COLLECTION.TEST, 1))).toBe('from callback');
            expect(storedValue(member(KEYS.COLLECTION.TEST, 1))).toBe('from multiSet');
        });

        it('persists its own value over a write made by a plain key subscriber of the same key during delivery', async () => {
            connections.push(
                Onyx.connect({
                    key: KEYS.PLAIN_A,
                    callback: (value: unknown) => {
                        if (value !== 'from multiSet') {
                            return;
                        }
                        Onyx.set(KEYS.PLAIN_A, 'from callback');
                    },
                }),
            );
            await waitForPromisesToResolve();

            await Onyx.multiSet({[KEYS.PLAIN_A]: 'from multiSet'});
            await waitForPromisesToResolve();

            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe('from callback');
            expect(storedValue(KEYS.PLAIN_A)).toBe('from multiSet');
        });

        it('re-applies its stale value to the cache and storage on a storage retry after a newer write, without notifying', async () => {
            const a = await subscribe(KEYS.PLAIN_A);
            jest.spyOn(StorageMock, 'multiSet').mockRejectedValueOnce(new Error('Transient storage error'));

            const multiSetPromise = Onyx.multiSet({[KEYS.PLAIN_A]: 'from multiSet'});
            const setPromise = Onyx.set(KEYS.PLAIN_A, 'newer set');
            await Promise.all([multiSetPromise, setPromise]);
            await waitForPromisesToResolve();

            expect(a.map(({value}) => value)).toEqual(['from multiSet', 'newer set']);
            expect(OnyxCache.get(KEYS.PLAIN_A)).toBe('from multiSet');
            expect(storedValue(KEYS.PLAIN_A)).toBe('from multiSet');
        });
    });
});
