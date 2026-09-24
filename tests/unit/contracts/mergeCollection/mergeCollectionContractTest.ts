import lodashCloneDeep from 'lodash/cloneDeep';

import type {Connection} from '../../../../lib/OnyxConnectionManager';
import type {OnyxKey, OnyxUpdate} from '../../../../lib/types';
import type GenericCollection from '../../../utils/GenericCollection';

import Onyx from '../../../../lib';
import OnyxCache from '../../../../lib/OnyxCache';
import OnyxUtils from '../../../../lib/OnyxUtils';
import StorageMock from '../../../../lib/storage';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const ONYX_KEYS = {
    PLAIN: 'plain',
    // Shares the collection prefix of `report_` without its trailing separator.
    REPORT_PLAIN: 'report',
    COLLECTION: {
        REPORT: 'report_',
        // Starts with the same letters as `report_` but is a different collection.
        REPORT_ACTIONS: 'reportActions_',
        // Nested prefix: every member of this collection also starts with `report_`.
        REPORT_DRAFT: 'report_draft_',
        POLICY: 'policy_',
        RAM_REPORT: 'ramReport_',
    },
};

const SKIPPABLE_ID = 'skippable-id';

Onyx.init({
    keys: ONYX_KEYS,
    ramOnlyKeys: [ONYX_KEYS.COLLECTION.RAM_REPORT],
    skippableCollectionMemberIDs: [SKIPPABLE_ID],
});

const reportKey = (id: string) => `${ONYX_KEYS.COLLECTION.REPORT}${id}`;
const policyKey = (id: string) => `${ONYX_KEYS.COLLECTION.POLICY}${id}`;

type Delivery = {value: unknown; key: OnyxKey | undefined};

type SubscribeOptions = {
    reuseConnection?: boolean;
    onDelivery?: (value: unknown, key: OnyxKey | undefined) => void;
};

let connections: Connection[] = [];

function subscribe(key: OnyxKey, options: SubscribeOptions = {}): Delivery[] {
    const deliveries: Delivery[] = [];
    connections.push(
        Onyx.connect({
            key,
            reuseConnection: options.reuseConnection,
            callback: (value: unknown, matchedKey: OnyxKey | undefined) => {
                deliveries.push({value, key: matchedKey});
                options.onDelivery?.(value, matchedKey);
            },
        }),
    );
    return deliveries;
}

/** Subscribes, waits for the initial delivery and returns an empty list that only collects later deliveries. */
async function subscribeSettled(key: OnyxKey, options: SubscribeOptions = {}): Promise<Delivery[]> {
    const deliveries = subscribe(key, options);
    await waitForPromisesToResolve();
    deliveries.splice(0);
    return deliveries;
}

/** Reads what a brand new subscriber would receive right now. */
async function readThroughNewSubscriber(key: OnyxKey): Promise<unknown> {
    const deliveries = subscribe(key, {reuseConnection: false});
    await waitForPromisesToResolve();
    return deliveries.at(-1)?.value;
}

function readStorage(key: OnyxKey): Promise<unknown> {
    return StorageMock.getItem(key);
}

function toCollection(value: unknown): GenericCollection | undefined {
    return typeof value === 'object' && value !== null ? value : undefined;
}

function mergeInto(collectionKey: string, collection: GenericCollection): Promise<void> {
    return Onyx.mergeCollection(collectionKey, collection);
}

function values(deliveries: Delivery[]): unknown[] {
    return deliveries.map((delivery) => delivery.value);
}

function mergeReports(collection: GenericCollection): Promise<void> {
    return Onyx.mergeCollection(ONYX_KEYS.COLLECTION.REPORT, collection);
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}

function storageCallsTouching(key: OnyxKey): number {
    const pairCalls = [...jest.mocked(StorageMock.multiSet).mock.calls, ...jest.mocked(StorageMock.multiMerge).mock.calls];
    const pairHits = pairCalls.filter(([pairs]) => pairs.some(([pairKey]) => pairKey === key)).length;
    const singleHits = [...jest.mocked(StorageMock.setItem).mock.calls, ...jest.mocked(StorageMock.mergeItem).mock.calls, ...jest.mocked(StorageMock.removeItem).mock.calls].filter(
        ([callKey]) => callKey === key,
    ).length;
    const removeHits = jest.mocked(StorageMock.removeItems).mock.calls.filter(([keys]) => keys.includes(key)).length;
    return pairHits + singleHits + removeHits;
}

async function expectStorageToMatchCache(keys: OnyxKey[]): Promise<void> {
    for (const key of keys) {
        const cached = OnyxCache.get(key);
        expect(await readStorage(key)).toEqual(cached === undefined ? null : cached);
    }
}

beforeEach(async () => {
    await Onyx.clear();
    jest.clearAllMocks();
});

afterEach(() => {
    for (const connection of connections) {
        Onyx.disconnect(connection);
    }
    connections = [];
    jest.restoreAllMocks();
});

describe('Onyx.mergeCollection contract', () => {
    describe('input validation and early returns', () => {
        it('resolves without writing or notifying for an empty collection', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);
            jest.clearAllMocks();

            await mergeReports({});

            expect(collectionDeliveries).toHaveLength(0);
            expect(StorageMock.multiSet).not.toHaveBeenCalled();
            expect(StorageMock.multiMerge).not.toHaveBeenCalled();
            expect(StorageMock.removeItems).not.toHaveBeenCalled();
            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1});
        });

        it('resolves without writing or notifying for an array input', async () => {
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);
            jest.clearAllMocks();

            const arrayInput: GenericCollection = [{a: 1}];
            await mergeReports(arrayInput);

            expect(collectionDeliveries).toHaveLength(0);
            expect(OnyxCache.get(`${ONYX_KEYS.COLLECTION.REPORT}0`)).toBeUndefined();
            expect(StorageMock.multiSet).not.toHaveBeenCalled();
            expect(StorageMock.multiMerge).not.toHaveBeenCalled();
        });

        it('rejects the whole batch when the last key belongs to another collection', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);
            const memberDeliveries = await subscribeSettled(reportKey('1'));
            const policyDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.POLICY);
            jest.clearAllMocks();

            await mergeReports({
                [reportKey('1')]: {a: 2},
                [reportKey('2')]: {b: 1},
                [policyKey('1')]: {c: 1},
            });

            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1});
            expect(OnyxCache.get(reportKey('2'))).toBeUndefined();
            expect(OnyxCache.get(policyKey('1'))).toBeUndefined();
            expect(await readStorage(reportKey('1'))).toEqual({a: 1});
            expect(await readStorage(reportKey('2'))).toBeNull();
            expect(await readStorage(policyKey('1'))).toBeNull();
            expect(collectionDeliveries).toHaveLength(0);
            expect(memberDeliveries).toHaveLength(0);
            expect(policyDeliveries).toHaveLength(0);
        });

        it('rejects the whole batch when the first key belongs to another collection', async () => {
            await mergeReports({
                [policyKey('1')]: {c: 1},
                [reportKey('1')]: {a: 1},
            });

            expect(OnyxCache.get(reportKey('1'))).toBeUndefined();
            expect(await readStorage(reportKey('1'))).toBeNull();
            expect(await readStorage(policyKey('1'))).toBeNull();
        });

        it('rejects a plain key that equals the collection prefix without its separator', async () => {
            await mergeReports({
                [reportKey('1')]: {a: 1},
                [ONYX_KEYS.REPORT_PLAIN]: {b: 1},
            });

            expect(OnyxCache.get(reportKey('1'))).toBeUndefined();
            expect(OnyxCache.get(ONYX_KEYS.REPORT_PLAIN)).toBeUndefined();
            expect(await readStorage(ONYX_KEYS.REPORT_PLAIN)).toBeNull();
        });

        it('rejects members of a collection that only starts with the same letters', async () => {
            const actionsDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT_ACTIONS);

            await mergeReports({
                [reportKey('1')]: {a: 1},
                [`${ONYX_KEYS.COLLECTION.REPORT_ACTIONS}1`]: {b: 1},
            });

            expect(OnyxCache.get(reportKey('1'))).toBeUndefined();
            expect(OnyxCache.get(`${ONYX_KEYS.COLLECTION.REPORT_ACTIONS}1`)).toBeUndefined();
            expect(actionsDeliveries).toHaveLength(0);
        });

        it('rejects a non-member key passed to the internal mergeCollectionWithPatches entry point', async () => {
            const collection: GenericCollection = {[reportKey('1')]: {a: 1}, [ONYX_KEYS.PLAIN]: {b: 1}};
            await OnyxUtils.mergeCollectionWithPatches({collectionKey: ONYX_KEYS.COLLECTION.REPORT, collection});

            expect(OnyxCache.get(reportKey('1'))).toBeUndefined();
            expect(OnyxCache.get(ONYX_KEYS.PLAIN)).toBeUndefined();
        });

        it('accepts member IDs that contain the separator character', async () => {
            const memberDeliveries = await subscribeSettled(reportKey('a_b'));
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);

            await mergeReports({[reportKey('a_b')]: {a: 1}});

            expect(OnyxCache.get(reportKey('a_b'))).toEqual({a: 1});
            expect(await readStorage(reportKey('a_b'))).toEqual({a: 1});
            expect(values(memberDeliveries)).toEqual([{a: 1}]);
            expect(collectionDeliveries.at(-1)?.value).toEqual({[reportKey('a_b')]: {a: 1}});
        });

        it('never mutates the caller collection object or its nested values', async () => {
            await mergeReports({
                [reportKey('1')]: {a: 1, nested: {x: 1, y: 1}, list: [1, 2]},
                [reportKey('2')]: {b: 1},
            });

            const input = deepFreeze({
                [reportKey('1')]: {a: null, nested: {x: 2, y: null}, list: [3]},
                [reportKey('2')]: null,
                [reportKey('3')]: {c: 1, gone: null, deep: {z: null, w: 1}},
            });
            const inputCopy = lodashCloneDeep(input);

            await mergeReports(input);

            expect(input).toEqual(inputCopy);
            expect(OnyxCache.get(reportKey('1'))).toEqual({nested: {x: 2}, list: [3]});
            expect(OnyxCache.get(reportKey('2'))).toBeUndefined();
            expect(OnyxCache.get(reportKey('3'))).toEqual({c: 1, deep: {w: 1}});
        });
    });

    describe('cache and storage values', () => {
        it('stores new members with nested nulls and undefined stripped, in cache and storage', async () => {
            await mergeReports({
                [reportKey('1')]: {a: 1, b: null, c: undefined, nested: {d: null, e: 2, deeper: {f: null, g: 3}}},
                [reportKey('2')]: 'plain string',
                [reportKey('3')]: 7,
                [reportKey('4')]: [1, {h: null}],
            });

            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1, nested: {e: 2, deeper: {g: 3}}});
            expect(OnyxCache.get(reportKey('1'))).not.toHaveProperty('b');
            expect(OnyxCache.get(reportKey('1'))).not.toHaveProperty('c');
            expect(OnyxCache.get(reportKey('2'))).toBe('plain string');
            expect(OnyxCache.get(reportKey('3'))).toBe(7);
            expect(OnyxCache.get(reportKey('4'))).toEqual([1, {h: null}]);
            expect(await readStorage(reportKey('1'))).toEqual({a: 1, nested: {e: 2, deeper: {g: 3}}});
            expect(await readStorage(reportKey('1'))).not.toHaveProperty('b');
            await expectStorageToMatchCache([reportKey('1'), reportKey('2'), reportKey('3'), reportKey('4')]);
            expect(await readThroughNewSubscriber(ONYX_KEYS.COLLECTION.REPORT)).toEqual({
                [reportKey('1')]: {a: 1, nested: {e: 2, deeper: {g: 3}}},
                [reportKey('2')]: 'plain string',
                [reportKey('3')]: 7,
                [reportKey('4')]: [1, {h: null}],
            });
        });

        it('deep merges existing members: objects merge, arrays and primitives replace', async () => {
            await mergeReports({
                [reportKey('1')]: {name: 'old', count: 1, list: [1, 2, 3], nested: {keep: true, change: 'old', inner: {a: 1}}},
                [reportKey('2')]: 'old string',
                [reportKey('3')]: 5,
            });

            await mergeReports({
                [reportKey('1')]: {name: 'new', list: [9], nested: {change: 'new', inner: {b: 2}}, added: {z: 1}},
                [reportKey('2')]: 'new string',
                [reportKey('3')]: {now: 'object'},
            });

            const expected = {name: 'new', count: 1, list: [9], nested: {keep: true, change: 'new', inner: {a: 1, b: 2}}, added: {z: 1}};
            expect(OnyxCache.get(reportKey('1'))).toEqual(expected);
            expect(OnyxCache.get(reportKey('2'))).toBe('new string');
            expect(OnyxCache.get(reportKey('3'))).toEqual({now: 'object'});
            expect(await readStorage(reportKey('1'))).toEqual(expected);
            await expectStorageToMatchCache([reportKey('1'), reportKey('2'), reportKey('3')]);
        });

        it('removes nested keys set to null on existing members, in cache and storage', async () => {
            await mergeReports({
                [reportKey('1')]: {a: 1, b: 2, nested: {c: 3, d: 4, deeper: {e: 5, f: 6}}, obj: {x: 1}},
            });

            await mergeReports({
                [reportKey('1')]: {b: null, nested: {d: null, deeper: {e: null}}, obj: null},
            });

            const expected = {a: 1, nested: {c: 3, deeper: {f: 6}}};
            expect(OnyxCache.get(reportKey('1'))).toEqual(expected);
            expect(OnyxCache.get(reportKey('1'))).not.toHaveProperty('b');
            expect(OnyxCache.get(reportKey('1'))).not.toHaveProperty('obj');
            expect(await readStorage(reportKey('1'))).toEqual(expected);
            expect(await readStorage(reportKey('1'))).not.toHaveProperty('b');
        });

        it('removes a member set to null from cache, storage and later reads while keeping its siblings', async () => {
            await mergeReports({
                [reportKey('1')]: {a: 1},
                [reportKey('2')]: {b: 1},
                [reportKey('3')]: {c: 1},
            });

            await mergeReports({[reportKey('2')]: null});

            expect(OnyxCache.get(reportKey('2'))).toBeUndefined();
            expect(await readStorage(reportKey('2'))).toBeNull();
            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1});
            expect(OnyxCache.get(reportKey('3'))).toEqual({c: 1});
            expect(await readThroughNewSubscriber(ONYX_KEYS.COLLECTION.REPORT)).toEqual({
                [reportKey('1')]: {a: 1},
                [reportKey('3')]: {c: 1},
            });
            expect(await readThroughNewSubscriber(reportKey('2'))).toBeUndefined();

            // A later merge into the removed member starts from nothing instead of the removed value.
            await mergeReports({[reportKey('2')]: {fresh: true}});
            expect(OnyxCache.get(reportKey('2'))).toEqual({fresh: true});
            expect(await readStorage(reportKey('2'))).toEqual({fresh: true});
        });

        it('treats null for a member that never existed as a no-op without storage removal or notification', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);
            const missingDeliveries = await subscribeSettled(reportKey('missing'));
            jest.clearAllMocks();

            await mergeReports({[reportKey('missing')]: null});

            expect(collectionDeliveries).toHaveLength(0);
            expect(missingDeliveries).toHaveLength(0);
            expect(StorageMock.removeItems).not.toHaveBeenCalled();
            expect(StorageMock.removeItem).not.toHaveBeenCalled();
            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1});
        });

        it('ignores top-level undefined member values for existing and missing members', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const memberDeliveries = await subscribeSettled(reportKey('1'));
            const missingDeliveries = await subscribeSettled(reportKey('missing'));
            jest.clearAllMocks();

            await mergeReports({[reportKey('1')]: undefined, [reportKey('missing')]: undefined});

            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1});
            expect(await readStorage(reportKey('1'))).toEqual({a: 1});
            expect(OnyxCache.get(reportKey('missing'))).toBeUndefined();
            expect(await readStorage(reportKey('missing'))).toBeNull();
            expect(memberDeliveries).toHaveLength(0);
            expect(missingDeliveries).toHaveLength(0);
            expect(storageCallsTouching(reportKey('1'))).toBe(0);
            expect(storageCallsTouching(reportKey('missing'))).toBe(0);
        });

        it('applies a mixed batch of new, existing, removed and unchanged members in one call', async () => {
            await mergeReports({
                [reportKey('existing')]: {a: 1, nested: {b: 1}},
                [reportKey('removed')]: {gone: true},
                [reportKey('unchanged')]: {same: true},
            });

            await mergeReports({
                [reportKey('existing')]: {nested: {c: 2}},
                [reportKey('removed')]: null,
                [reportKey('unchanged')]: {same: true},
                [reportKey('new')]: {fresh: 1, empty: null},
            });

            expect(OnyxCache.get(reportKey('existing'))).toEqual({a: 1, nested: {b: 1, c: 2}});
            expect(OnyxCache.get(reportKey('removed'))).toBeUndefined();
            expect(OnyxCache.get(reportKey('unchanged'))).toEqual({same: true});
            expect(OnyxCache.get(reportKey('new'))).toEqual({fresh: 1});
            await expectStorageToMatchCache([reportKey('existing'), reportKey('removed'), reportKey('unchanged'), reportKey('new')]);
            expect(await readThroughNewSubscriber(ONYX_KEYS.COLLECTION.REPORT)).toEqual({
                [reportKey('existing')]: {a: 1, nested: {b: 1, c: 2}},
                [reportKey('unchanged')]: {same: true},
                [reportKey('new')]: {fresh: 1},
            });
        });

        it('leaves other collections, plain keys and untouched members reference-identical', async () => {
            await Onyx.set(ONYX_KEYS.PLAIN, {plain: 1});
            await Onyx.set(ONYX_KEYS.REPORT_PLAIN, {reportPlain: 1});
            await mergeInto(ONYX_KEYS.COLLECTION.POLICY, {[policyKey('1')]: {p: 1}});
            await mergeInto(ONYX_KEYS.COLLECTION.REPORT_ACTIONS, {[`${ONYX_KEYS.COLLECTION.REPORT_ACTIONS}1`]: {ra: 1}});
            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('untouched')]: {u: 1}});

            const before = {
                plain: OnyxCache.get(ONYX_KEYS.PLAIN),
                reportPlain: OnyxCache.get(ONYX_KEYS.REPORT_PLAIN),
                policy: OnyxCache.get(policyKey('1')),
                action: OnyxCache.get(`${ONYX_KEYS.COLLECTION.REPORT_ACTIONS}1`),
                untouched: OnyxCache.get(reportKey('untouched')),
            };

            await mergeReports({[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 1}});

            expect(OnyxCache.get(ONYX_KEYS.PLAIN)).toBe(before.plain);
            expect(OnyxCache.get(ONYX_KEYS.REPORT_PLAIN)).toBe(before.reportPlain);
            expect(OnyxCache.get(policyKey('1'))).toBe(before.policy);
            expect(OnyxCache.get(`${ONYX_KEYS.COLLECTION.REPORT_ACTIONS}1`)).toBe(before.action);
            expect(OnyxCache.get(reportKey('untouched'))).toBe(before.untouched);
            expect(await readStorage(policyKey('1'))).toEqual({p: 1});
            expect(await readStorage(ONYX_KEYS.PLAIN)).toEqual({plain: 1});
        });

        it('keeps the member reference when the merge does not change its content', async () => {
            await mergeReports({[reportKey('1')]: {a: 1, nested: {b: [1, 2]}}});
            const before = OnyxCache.get(reportKey('1'));

            await mergeReports({[reportKey('1')]: {a: 1, nested: {}}});
            expect(OnyxCache.get(reportKey('1'))).toBe(before);

            await mergeReports({[reportKey('1')]: {a: 1}});
            expect(OnyxCache.get(reportKey('1'))).toBe(before);
        });

        it('shares unchanged nested objects between the previous and the merged member', async () => {
            await mergeReports({[reportKey('1')]: {changed: {x: 1}, sibling: {y: 1}, list: [1]}});
            const before = toCollection(OnyxCache.get(reportKey('1')));

            await mergeReports({[reportKey('1')]: {changed: {x: 2}}});
            const after = toCollection(OnyxCache.get(reportKey('1')));

            expect(after).not.toBe(before);
            expect(after?.changed).not.toBe(before?.changed);
            expect(after?.sibling).toBe(before?.sibling);
            expect(after?.list).toBe(before?.list);
        });

        it('never mutates a previously cached member object', async () => {
            await mergeReports({[reportKey('1')]: {a: 1, remove: 'me', nested: {b: 1, c: 1}}});
            const beforeReference = OnyxCache.get(reportKey('1'));
            const beforeCopy = lodashCloneDeep(beforeReference);

            await mergeReports({[reportKey('1')]: {a: 2, remove: null, nested: {b: 2, c: null}, added: true}});

            expect(beforeReference).toEqual(beforeCopy);
            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 2, nested: {b: 2}, added: true});
        });

        it('skips a member whose existing value has an incompatible array/object shape and applies the rest', async () => {
            await mergeReports({
                [reportKey('array')]: [1, 2],
                [reportKey('object')]: {a: 1},
                [reportKey('other')]: {o: 1},
            });
            const arrayDeliveries = await subscribeSettled(reportKey('array'));
            const objectDeliveries = await subscribeSettled(reportKey('object'));

            await mergeReports({
                [reportKey('array')]: {not: 'an array'},
                [reportKey('object')]: ['not', 'an', 'object'],
                [reportKey('other')]: {o: 2},
            });

            expect(OnyxCache.get(reportKey('array'))).toEqual([1, 2]);
            expect(OnyxCache.get(reportKey('object'))).toEqual({a: 1});
            expect(OnyxCache.get(reportKey('other'))).toEqual({o: 2});
            expect(await readStorage(reportKey('array'))).toEqual([1, 2]);
            expect(await readStorage(reportKey('object'))).toEqual({a: 1});
            expect(await readStorage(reportKey('other'))).toEqual({o: 2});
            expect(arrayDeliveries).toHaveLength(0);
            expect(objectDeliveries).toHaveLength(0);
        });

        it('coerces an existing empty array into an object when an object is merged', async () => {
            await mergeReports({[reportKey('1')]: []});

            await mergeReports({[reportKey('1')]: {a: 1}});

            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1});
            expect(await readStorage(reportKey('1'))).toEqual({a: 1});
        });

        it('replaces an existing array with a new array', async () => {
            await mergeReports({[reportKey('1')]: [1, 2, 3]});

            await mergeReports({[reportKey('1')]: [4]});

            expect(OnyxCache.get(reportKey('1'))).toEqual([4]);
            expect(await readStorage(reportKey('1'))).toEqual([4]);
        });

        it('turns skippable member IDs into removals while applying the other members', async () => {
            const skippableKey = reportKey(SKIPPABLE_ID);
            const skippableDeliveries = await subscribeSettled(skippableKey);

            await mergeReports({[skippableKey]: {a: 1}, [reportKey('1')]: {b: 1}});

            expect(OnyxCache.get(skippableKey)).toBeUndefined();
            expect(await readStorage(skippableKey)).toBeNull();
            expect(skippableDeliveries).toHaveLength(0);
            expect(OnyxCache.get(reportKey('1'))).toEqual({b: 1});
            expect(await readStorage(reportKey('1'))).toEqual({b: 1});
        });

        it('keeps a RAM-only collection out of storage, including removals', async () => {
            const ramKey = (id: string) => `${ONYX_KEYS.COLLECTION.RAM_REPORT}${id}`;
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.RAM_REPORT);

            await mergeInto(ONYX_KEYS.COLLECTION.RAM_REPORT, {[ramKey('1')]: {a: 1}, [ramKey('2')]: {b: 1}});
            await mergeInto(ONYX_KEYS.COLLECTION.RAM_REPORT, {[ramKey('1')]: {a: 2}, [ramKey('2')]: null});

            expect(OnyxCache.get(ramKey('1'))).toEqual({a: 2});
            expect(OnyxCache.get(ramKey('2'))).toBeUndefined();
            expect(await readStorage(ramKey('1'))).toBeNull();
            expect(storageCallsTouching(ramKey('1'))).toBe(0);
            expect(storageCallsTouching(ramKey('2'))).toBe(0);
            expect(collectionDeliveries.at(-1)?.value).toEqual({[ramKey('1')]: {a: 2}});
        });

        it('merges into the persisted value when the member value is no longer in the cache', async () => {
            await mergeReports({[reportKey('1')]: {persisted: 1, nested: {a: 1}}, [reportKey('2')]: {warm: 1}});
            const memberDeliveries = await subscribeSettled(reportKey('1'));
            // Drops only the cached value, the key stays known, like an evicted value that is still on disk.
            OnyxCache.set(reportKey('1'), undefined);

            await mergeReports({[reportKey('1')]: {added: 2, nested: {b: 2}}, [reportKey('2')]: {warm: 2}});

            const expected = {persisted: 1, added: 2, nested: {a: 1, b: 2}};
            expect(OnyxCache.get(reportKey('1'))).toEqual(expected);
            expect(await readStorage(reportKey('1'))).toEqual(expected);
            expect(values(memberDeliveries).at(-1)).toEqual(expected);
            expect(OnyxCache.get(reportKey('2'))).toEqual({warm: 2});
        });

        it('still merges from the cache when the pre-warm storage read fails', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const memberDeliveries = await subscribeSettled(reportKey('1'));
            OnyxCache.set(reportKey('1'), undefined);
            const failedRead = jest.fn(() => Promise.reject(new Error('read failed')));
            jest.mocked(StorageMock.multiGet).mockImplementationOnce(failedRead);

            await mergeReports({[reportKey('1')]: {b: 2}});

            expect(failedRead).toHaveBeenCalledTimes(1);
            expect(OnyxCache.get(reportKey('1'))).toEqual(expect.objectContaining({b: 2}));
            expect(values(memberDeliveries).at(-1)).toEqual(expect.objectContaining({b: 2}));
        });
    });

    describe('collection-root subscribers', () => {
        it('receive exactly one full collection per call, including untouched members', async () => {
            await mergeReports({[reportKey('untouched')]: {u: 1}, [reportKey('1')]: {a: 1}});
            const deliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);

            await mergeReports({
                [reportKey('1')]: {a: 2},
                [reportKey('2')]: {b: 1},
                [reportKey('3')]: {c: 1},
            });

            expect(deliveries).toHaveLength(1);
            expect(deliveries[0].key).toBe(ONYX_KEYS.COLLECTION.REPORT);
            expect(deliveries[0].value).toEqual({
                [reportKey('untouched')]: {u: 1},
                [reportKey('1')]: {a: 2},
                [reportKey('2')]: {b: 1},
                [reportKey('3')]: {c: 1},
            });
        });

        it('receive a new collection reference whose unchanged members keep their references', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: {b: 1}, [reportKey('3')]: {c: 1}});
            const deliveries = subscribe(ONYX_KEYS.COLLECTION.REPORT);
            await waitForPromisesToResolve();
            const previous = toCollection(deliveries.at(-1)?.value);

            await mergeReports({[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 1}});

            const next = toCollection(deliveries.at(-1)?.value);
            expect(next).not.toBe(previous);
            expect(next?.[reportKey('1')]).not.toBe(previous?.[reportKey('1')]);
            expect(next?.[reportKey('2')]).toBe(previous?.[reportKey('2')]);
            expect(next?.[reportKey('3')]).toBe(previous?.[reportKey('3')]);
        });

        it('receive nothing or the identical collection reference when nothing changed', async () => {
            await mergeReports({[reportKey('1')]: {a: 1, nested: {b: 1}}, [reportKey('2')]: 'text'});
            const deliveries = subscribe(ONYX_KEYS.COLLECTION.REPORT);
            await waitForPromisesToResolve();
            const previous = deliveries.at(-1)?.value;
            deliveries.splice(0);

            await mergeReports({[reportKey('1')]: {a: 1, nested: {b: 1}}, [reportKey('2')]: 'text'});

            expect(deliveries.length).toBeLessThanOrEqual(1);
            for (const delivery of deliveries) {
                expect(delivery.value).toBe(previous);
            }
        });

        it('never see a previously delivered collection object mutated by later merges', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: {b: 1}});
            const deliveries = subscribe(ONYX_KEYS.COLLECTION.REPORT);
            await waitForPromisesToResolve();
            const previous = deliveries.at(-1)?.value;
            const previousCopy = lodashCloneDeep(previous);

            await mergeReports({[reportKey('1')]: {a: 2}, [reportKey('2')]: null, [reportKey('3')]: {c: 1}});

            expect(previous).toEqual(previousCopy);
        });

        it('see removed members disappear and an empty collection after the last removal', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: {b: 1}});
            const deliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);

            await mergeReports({[reportKey('1')]: null});
            expect(deliveries.at(-1)?.value).toEqual({[reportKey('2')]: {b: 1}});

            await mergeReports({[reportKey('2')]: null});
            expect(deliveries.at(-1)?.value).toEqual({});
            expect(deliveries).toHaveLength(2);
        });

        it('deliver the same collection object to every independent subscription in one dispatch', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const first = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT, {reuseConnection: false});
            const second = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT, {reuseConnection: false});
            const shared = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);

            await mergeReports({[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 2}});

            expect(first).toHaveLength(1);
            expect(second).toHaveLength(1);
            expect(shared).toHaveLength(1);
            expect(second[0].value).toBe(first[0].value);
            expect(shared[0].value).toBe(first[0].value);
            expect(first[0].value).toEqual({[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 2}});
        });

        it('are not called for other collections, including ones sharing a prefix, or plain keys', async () => {
            const actionsDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT_ACTIONS);
            const draftDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT_DRAFT);
            const policyDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.POLICY);
            const reportPlainDeliveries = await subscribeSettled(ONYX_KEYS.REPORT_PLAIN);
            const plainDeliveries = await subscribeSettled(ONYX_KEYS.PLAIN);

            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: null});

            expect(actionsDeliveries).toHaveLength(0);
            expect(draftDeliveries).toHaveLength(0);
            expect(policyDeliveries).toHaveLength(0);
            expect(reportPlainDeliveries).toHaveLength(0);
            expect(plainDeliveries).toHaveLength(0);
        });

        it('are not called after disconnecting', async () => {
            const deliveries: unknown[] = [];
            const connection = Onyx.connect({key: ONYX_KEYS.COLLECTION.REPORT, callback: (value: unknown) => deliveries.push(value)});
            await waitForPromisesToResolve();
            Onyx.disconnect(connection);
            deliveries.splice(0);

            await mergeReports({[reportKey('1')]: {a: 1}});

            expect(deliveries).toHaveLength(0);
        });

        it('are not notified and nothing is written when an Onyx.update MERGE_COLLECTION holds a foreign key', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);
            const policyDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.POLICY);

            const updates: Array<OnyxUpdate<OnyxKey>> = [
                {onyxMethod: Onyx.METHOD.MERGE_COLLECTION, key: ONYX_KEYS.COLLECTION.REPORT, value: {[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 1}, [policyKey('1')]: {p: 1}}},
            ];
            await Onyx.update(updates);

            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1});
            expect(OnyxCache.get(reportKey('2'))).toBeUndefined();
            expect(OnyxCache.get(policyKey('1'))).toBeUndefined();
            expect(await readStorage(reportKey('2'))).toBeNull();
            expect(await readStorage(policyKey('1'))).toBeNull();
            expect(collectionDeliveries).toHaveLength(0);
            expect(policyDeliveries).toHaveLength(0);
        });

        it('are notified once per collection when members arrive through Onyx.update', async () => {
            await mergeReports({[reportKey('1')]: {a: 1, nested: {x: 1}}});
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);
            const memberDeliveries = await subscribeSettled(reportKey('1'));

            const updates: Array<OnyxUpdate<OnyxKey>> = [
                {onyxMethod: Onyx.METHOD.MERGE_COLLECTION, key: ONYX_KEYS.COLLECTION.REPORT, value: {[reportKey('1')]: {nested: {y: 2}}, [reportKey('2')]: {b: 1}}},
                {onyxMethod: Onyx.METHOD.MERGE, key: reportKey('3'), value: {c: 1}},
            ];
            await Onyx.update(updates);

            expect(collectionDeliveries.length).toBeGreaterThanOrEqual(1);
            expect(collectionDeliveries.length).toBeLessThanOrEqual(1);
            expect(collectionDeliveries.at(-1)?.value).toEqual({
                [reportKey('1')]: {a: 1, nested: {x: 1, y: 2}},
                [reportKey('2')]: {b: 1},
                [reportKey('3')]: {c: 1},
            });
            expect(values(memberDeliveries)).toEqual([{a: 1, nested: {x: 1, y: 2}}]);
            await expectStorageToMatchCache([reportKey('1'), reportKey('2'), reportKey('3')]);
        });
    });

    describe('member subscribers', () => {
        it('each receive their own merged value exactly once', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const first = await subscribeSettled(reportKey('1'));
            const second = await subscribeSettled(reportKey('2'));

            await mergeReports({[reportKey('1')]: {b: 2}, [reportKey('2')]: {c: 3}});

            expect(first).toEqual([{value: {a: 1, b: 2}, key: reportKey('1')}]);
            expect(second).toEqual([{value: {c: 3}, key: reportKey('2')}]);
        });

        it('are not notified when their merged value is unchanged', async () => {
            await mergeReports({[reportKey('1')]: {a: 1, nested: {b: [1]}}, [reportKey('2')]: 'same', [reportKey('3')]: 3});
            const first = await subscribeSettled(reportKey('1'));
            const second = await subscribeSettled(reportKey('2'));
            const third = await subscribeSettled(reportKey('3'));
            const changed = await subscribeSettled(reportKey('4'));

            await mergeReports({[reportKey('1')]: {a: 1, nested: {}}, [reportKey('2')]: 'same', [reportKey('3')]: 3, [reportKey('4')]: {new: 1}});

            expect(first).toHaveLength(0);
            expect(second).toHaveLength(0);
            expect(third).toHaveLength(0);
            expect(values(changed)).toEqual([{new: 1}]);
        });

        it('are not notified when their member is not part of the batch', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: {b: 1}});
            const untouched = await subscribeSettled(reportKey('2'));
            const neverWritten = await subscribeSettled(reportKey('99'));

            await mergeReports({[reportKey('1')]: {a: 2}, [reportKey('3')]: null});

            expect(untouched).toHaveLength(0);
            expect(neverWritten).toHaveLength(0);
        });

        it('receive undefined once when their member is removed', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: {b: 1}});
            const removed = await subscribeSettled(reportKey('1'));
            const kept = await subscribeSettled(reportKey('2'));

            await mergeReports({[reportKey('1')]: null, [reportKey('2')]: {b: 2}});

            expect(removed).toEqual([{value: undefined, key: reportKey('1')}]);
            expect(values(kept)).toEqual([{b: 2}]);
        });

        it('keep receiving values when an earlier subscriber throws', async () => {
            const collectionThrowing = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT, {
                reuseConnection: false,
                onDelivery: () => {
                    throw new Error('collection subscriber failure');
                },
            });
            const healthyCollection = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT, {reuseConnection: false});
            const throwing = await subscribeSettled(reportKey('1'), {
                reuseConnection: false,
                onDelivery: () => {
                    throw new Error('subscriber failure');
                },
            });
            const healthySameKey = await subscribeSettled(reportKey('1'), {reuseConnection: false});
            const healthy = await subscribeSettled(reportKey('2'), {reuseConnection: false});
            const sharedThrowing = await subscribeSettled(reportKey('3'), {
                onDelivery: () => {
                    throw new Error('shared subscriber failure');
                },
            });
            const sharedHealthy = await subscribeSettled(reportKey('3'));

            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: {b: 1}, [reportKey('3')]: {c: 1}});

            expect(collectionThrowing).toHaveLength(1);
            expect(healthyCollection).toHaveLength(1);
            expect(throwing).toHaveLength(1);
            expect(values(healthySameKey)).toEqual([{a: 1}]);
            expect(values(healthy)).toEqual([{b: 1}]);
            expect(sharedThrowing).toHaveLength(1);
            expect(values(sharedHealthy)).toEqual([{c: 1}]);
            expect(OnyxCache.get(reportKey('2'))).toEqual({b: 1});
            expect(await readStorage(reportKey('2'))).toEqual({b: 1});
        });

        it('observe the merged cache state from inside their callback', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: {b: 1}});
            const seenFromFirst: unknown[] = [];
            await subscribeSettled(reportKey('1'), {
                onDelivery: () => {
                    seenFromFirst.push([OnyxCache.get(reportKey('1')), OnyxCache.get(reportKey('2'))]);
                },
            });
            seenFromFirst.splice(0);

            await mergeReports({[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 2}});

            expect(seenFromFirst).toEqual([[{a: 2}, {b: 2}]]);
        });
    });

    describe('ordering and consistency', () => {
        it('updates the cache and notifies before the storage write settles', async () => {
            await mergeReports({[reportKey('existing')]: {a: 1}});
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);
            const memberDeliveries = await subscribeSettled(reportKey('new'));

            let releaseSet: () => void = () => undefined;
            let releaseMerge: () => void = () => undefined;
            jest.mocked(StorageMock.multiSet).mockImplementationOnce(
                (pairs) =>
                    new Promise((resolve) => {
                        releaseSet = () => resolve(StorageMock.getStorageProvider().multiSet(pairs));
                    }),
            );
            jest.mocked(StorageMock.multiMerge).mockImplementationOnce(
                (pairs) =>
                    new Promise((resolve) => {
                        releaseMerge = () => resolve(StorageMock.getStorageProvider().multiMerge(pairs));
                    }),
            );

            let settled = false;
            const pending = mergeReports({[reportKey('existing')]: {a: 2}, [reportKey('new')]: {n: 1}}).then(() => {
                settled = true;
            });
            await waitForPromisesToResolve();

            expect(settled).toBe(false);
            expect(OnyxCache.get(reportKey('existing'))).toEqual({a: 2});
            expect(OnyxCache.get(reportKey('new'))).toEqual({n: 1});
            expect(values(memberDeliveries)).toEqual([{n: 1}]);
            expect(collectionDeliveries.at(-1)?.value).toEqual({[reportKey('existing')]: {a: 2}, [reportKey('new')]: {n: 1}});

            releaseSet();
            releaseMerge();
            await pending;

            expect(settled).toBe(true);
            await expectStorageToMatchCache([reportKey('existing'), reportKey('new')]);
        });

        it('keeps the cache and notifies once when a storage write fails and is retried', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            const memberDeliveries = await subscribeSettled(reportKey('1'));
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);
            jest.mocked(StorageMock.multiMerge).mockImplementationOnce(() => Promise.reject(new Error('write failed')));

            await mergeReports({[reportKey('1')]: {b: 2}, [reportKey('2')]: {c: 3}});
            await waitForPromisesToResolve();

            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1, b: 2});
            expect(OnyxCache.get(reportKey('2'))).toEqual({c: 3});
            expect(values(memberDeliveries)).toEqual([{a: 1, b: 2}]);
            expect(collectionDeliveries).toHaveLength(1);
            await expectStorageToMatchCache([reportKey('1'), reportKey('2')]);
        });

        it('applies two calls issued in the same tick in call order', async () => {
            await mergeReports({[reportKey('1')]: {a: 0, nested: {x: 0}}});
            const memberDeliveries = await subscribeSettled(reportKey('1'));
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);

            const first = mergeReports({[reportKey('1')]: {a: 1, nested: {y: 1}}, [reportKey('2')]: {b: 1}});
            const second = mergeReports({[reportKey('1')]: {a: 2, nested: {x: null}}, [reportKey('2')]: {b: 2}});
            await Promise.all([first, second]);

            const finalFirst = {a: 2, nested: {y: 1}};
            expect(OnyxCache.get(reportKey('1'))).toEqual(finalFirst);
            expect(OnyxCache.get(reportKey('2'))).toEqual({b: 2});
            await expectStorageToMatchCache([reportKey('1'), reportKey('2')]);

            const validMemberStates = [{a: 1, nested: {x: 0, y: 1}}, finalFirst];
            expect(memberDeliveries.length).toBeGreaterThanOrEqual(1);
            expect(memberDeliveries.length).toBeLessThanOrEqual(2);
            for (const delivery of memberDeliveries) {
                expect(validMemberStates).toContainEqual(delivery.value);
            }
            expect(memberDeliveries.at(-1)?.value).toEqual(finalFirst);
            expect(collectionDeliveries.length).toBeGreaterThanOrEqual(1);
            expect(collectionDeliveries.length).toBeLessThanOrEqual(2);
            expect(collectionDeliveries.at(-1)?.value).toEqual({[reportKey('1')]: finalFirst, [reportKey('2')]: {b: 2}});
        });

        it('leaves only the new value when a removal and a re-add are issued in the same tick', async () => {
            await mergeReports({[reportKey('1')]: {old: true, shared: 'old'}});
            const memberDeliveries = await subscribeSettled(reportKey('1'));

            const removal = mergeReports({[reportKey('1')]: null});
            const readd = mergeReports({[reportKey('1')]: {shared: 'new'}});
            await Promise.all([removal, readd]);

            expect(OnyxCache.get(reportKey('1'))).toEqual({shared: 'new'});
            expect(await readStorage(reportKey('1'))).toEqual({shared: 'new'});
            expect(memberDeliveries.at(-1)?.value).toEqual({shared: 'new'});
            for (const delivery of memberDeliveries) {
                expect([undefined, {shared: 'new'}]).toContainEqual(delivery.value);
            }
        });

        it('applies an Onyx.merge issued before it in the same tick first', async () => {
            await mergeReports({[reportKey('1')]: {base: 1}});

            const merge = Onyx.merge(reportKey('1'), {x: 1, fromMerge: true});
            const collection = mergeReports({[reportKey('1')]: {x: 2}});
            await Promise.all([merge, collection]);

            expect(OnyxCache.get(reportKey('1'))).toEqual({base: 1, x: 2, fromMerge: true});
            await expectStorageToMatchCache([reportKey('1')]);
        });

        it('merges on top of an Onyx.set issued before it in the same tick', async () => {
            await mergeReports({[reportKey('1')]: {base: 1}});

            const set = Onyx.set(reportKey('1'), {replaced: true});
            const collection = mergeReports({[reportKey('1')]: {x: 2}});
            await Promise.all([set, collection]);

            expect(OnyxCache.get(reportKey('1'))).toEqual({replaced: true, x: 2});
            await expectStorageToMatchCache([reportKey('1')]);
        });

        it('applies a write issued from inside a collection callback and delivers the final state', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}});
            let hasWritten = false;
            const collectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT, {
                onDelivery: (value) => {
                    const collection = toCollection(value);
                    if (hasWritten || collection?.[reportKey('1')]?.a !== 2) {
                        return;
                    }
                    hasWritten = true;
                    mergeReports({[reportKey('derived')]: {fromCallback: true}});
                },
            });
            const memberDeliveries = await subscribeSettled(reportKey('1'));

            await mergeReports({[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 2}});
            await waitForPromisesToResolve();

            const finalState = {[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 2}, [reportKey('derived')]: {fromCallback: true}};
            expect(collectionDeliveries.at(-1)?.value).toEqual(finalState);
            expect(collectionDeliveries[0].value).toEqual({[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 2}});
            expect(values(memberDeliveries)).toEqual([{a: 2}]);
            await expectStorageToMatchCache([reportKey('1'), reportKey('2'), reportKey('derived')]);
        });

        it('delivers consistent values to later subscribers when a member callback writes to another member', async () => {
            await mergeReports({[reportKey('1')]: {a: 1}, [reportKey('2')]: {b: 1}});
            let hasWritten = false;
            await subscribeSettled(reportKey('1'), {
                onDelivery: () => {
                    if (hasWritten) {
                        return;
                    }
                    hasWritten = true;
                    Onyx.merge(reportKey('2'), {fromCallback: true});
                },
            });
            const secondDeliveries = await subscribeSettled(reportKey('2'));

            await mergeReports({[reportKey('1')]: {a: 2}, [reportKey('2')]: {b: 2}});
            await waitForPromisesToResolve();

            expect(OnyxCache.get(reportKey('2'))).toEqual({b: 2, fromCallback: true});
            expect(secondDeliveries.at(-1)?.value).toEqual({b: 2, fromCallback: true});
            for (const delivery of secondDeliveries) {
                expect([{b: 2}, {b: 2, fromCallback: true}]).toContainEqual(delivery.value);
            }
            await expectStorageToMatchCache([reportKey('1'), reportKey('2')]);
        });
    });

    describe('mergeCollectionWithPatches', () => {
        it('forwards replace-null patches of existing members to the storage merge', async () => {
            await mergeReports({[reportKey('existing')]: {nested: {old: 1}, keep: 1}});
            jest.clearAllMocks();
            const existingPatches: Array<[string[], unknown]> = [[['nested'], {fresh: 1}]];
            const patches = {[reportKey('existing')]: existingPatches};

            const collection: GenericCollection = {[reportKey('existing')]: {keep: 2}, [reportKey('new')]: {n: 1}};
            await OnyxUtils.mergeCollectionWithPatches({collectionKey: ONYX_KEYS.COLLECTION.REPORT, collection, mergeReplaceNullPatches: patches});

            const mergedPairs = jest.mocked(StorageMock.multiMerge).mock.calls.flatMap(([pairs]) => pairs);
            const existingPair = mergedPairs.find(([key]) => key === reportKey('existing'));
            expect(existingPair?.[2]).toEqual(patches[reportKey('existing')]);
            expect(OnyxCache.get(reportKey('existing'))).toEqual({nested: {old: 1}, keep: 2});
            expect(OnyxCache.get(reportKey('new'))).toEqual({n: 1});
            await expectStorageToMatchCache([reportKey('existing'), reportKey('new')]);
        });

        it('replaces a nested object entirely when a batched update nulls it and then sets it', async () => {
            await mergeReports({[reportKey('1')]: {nested: {a: 1, b: 2}, keep: true}, [reportKey('2')]: {z: 1}});
            jest.clearAllMocks();

            const updates: Array<OnyxUpdate<OnyxKey>> = [
                {onyxMethod: Onyx.METHOD.MERGE, key: reportKey('1'), value: {nested: null}},
                {onyxMethod: Onyx.METHOD.MERGE, key: reportKey('1'), value: {nested: {c: 3}}},
                {onyxMethod: Onyx.METHOD.MERGE, key: reportKey('2'), value: {z: 2}},
            ];
            await Onyx.update(updates);

            expect(OnyxCache.get(reportKey('1'))).toEqual({nested: {c: 3}, keep: true});
            expect(OnyxCache.get(reportKey('2'))).toEqual({z: 2});
            await expectStorageToMatchCache([reportKey('1'), reportKey('2')]);
            const mergedPairs = jest.mocked(StorageMock.multiMerge).mock.calls.flatMap(([pairs]) => pairs);
            const pairForFirst = mergedPairs.find(([key]) => key === reportKey('1'));
            if (pairForFirst) {
                expect(pairForFirst[2]).toEqual([[['nested'], {c: 3}]]);
            }
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('accepts a member of a nested-prefix collection and notifies none of its subscribers', async () => {
            const draftKey = `${ONYX_KEYS.COLLECTION.REPORT_DRAFT}1`;
            const draftCollectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT_DRAFT);
            const draftMemberDeliveries = await subscribeSettled(draftKey);
            const reportDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT);

            await mergeReports({[draftKey]: {d: 1}, [reportKey('1')]: {a: 1}});

            expect(OnyxCache.get(draftKey)).toEqual({d: 1});
            expect(await readStorage(draftKey)).toEqual({d: 1});
            expect(draftCollectionDeliveries).toHaveLength(0);
            expect(draftMemberDeliveries).toHaveLength(0);
            expect(reportDeliveries.at(-1)?.value).toEqual({[reportKey('1')]: {a: 1}});
        });

        it('drops a removal issued in the same tick right after the member was first added', async () => {
            const memberDeliveries = await subscribeSettled(reportKey('1'));

            const add = mergeReports({[reportKey('1')]: {a: 1}});
            const removal = mergeReports({[reportKey('1')]: null});
            await Promise.all([add, removal]);

            expect(OnyxCache.get(reportKey('1'))).toEqual({a: 1});
            expect(await readStorage(reportKey('1'))).toEqual({a: 1});
            expect(values(memberDeliveries)).toEqual([{a: 1}]);
        });

        it('groups Onyx.update merges of a nested-prefix collection under the outer collection and notifies nobody', async () => {
            const draftKey = (id: string) => `${ONYX_KEYS.COLLECTION.REPORT_DRAFT}${id}`;
            const draftCollectionDeliveries = await subscribeSettled(ONYX_KEYS.COLLECTION.REPORT_DRAFT);
            const draftMemberDeliveries = await subscribeSettled(draftKey('1'));

            const updates: Array<OnyxUpdate<OnyxKey>> = [
                {onyxMethod: Onyx.METHOD.MERGE, key: draftKey('1'), value: {a: 1}},
                {onyxMethod: Onyx.METHOD.MERGE, key: draftKey('2'), value: {b: 1}},
            ];
            await Onyx.update(updates);

            expect(OnyxCache.get(draftKey('1'))).toEqual({a: 1});
            expect(await readStorage(draftKey('1'))).toEqual({a: 1});
            expect(draftCollectionDeliveries).toHaveLength(0);
            expect(draftMemberDeliveries).toHaveLength(0);
        });

        it('accepts the collection key itself as a member and stores a value under it', async () => {
            await mergeReports({[ONYX_KEYS.COLLECTION.REPORT]: {self: 1}});

            expect(OnyxCache.get(ONYX_KEYS.COLLECTION.REPORT)).toEqual({self: 1});
            expect(await readStorage(ONYX_KEYS.COLLECTION.REPORT)).toEqual({self: 1});
        });

        it('lets a mergeCollection overwrite an Onyx.merge that was issued after it in the same tick', async () => {
            await mergeReports({[reportKey('1')]: {base: 1}});

            const collection = mergeReports({[reportKey('1')]: {x: 2}});
            const laterMerge = Onyx.merge(reportKey('1'), {x: 3});
            await Promise.all([collection, laterMerge]);

            expect(OnyxCache.get(reportKey('1'))).toEqual({base: 1, x: 2});
            await expectStorageToMatchCache([reportKey('1')]);
        });

        it('merges a mergeCollection into an Onyx.set that was issued after it in the same tick', async () => {
            await mergeReports({[reportKey('1')]: {base: 1}});

            const collection = mergeReports({[reportKey('1')]: {x: 2}});
            const laterSet = Onyx.set(reportKey('1'), {replaced: true});
            await Promise.all([collection, laterSet]);

            expect(OnyxCache.get(reportKey('1'))).toEqual({replaced: true, x: 2});
            await expectStorageToMatchCache([reportKey('1')]);
        });
    });
});
