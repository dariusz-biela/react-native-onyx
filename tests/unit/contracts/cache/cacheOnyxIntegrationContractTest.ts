import type {FreshOnyx} from './cacheHelpers';
import {COLLECTION, PLAIN, isRecord, loadFreshOnyx} from './cacheHelpers';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const MEMBER_1 = `${COLLECTION.COLL}1`;
const MEMBER_2 = `${COLLECTION.COLL}2`;
const EVICTABLE_PLAIN = 'evictablePlain';

let onyx: FreshOnyx;

async function initOnyx(): Promise<void> {
    onyx.Onyx.init({
        keys: {PLAIN_KEY: PLAIN.KEY, EVICTABLE_PLAIN, COLLECTION: {COLL: COLLECTION.COLL, OTHER: COLLECTION.OTHER}},
        evictableKeys: [COLLECTION.COLL, EVICTABLE_PLAIN],
    });
    await waitForPromisesToResolve();
}

beforeEach(() => {
    onyx = loadFreshOnyx();
});

describe('OnyxCache contract through the Onyx API', () => {
    describe('read deduplication', () => {
        it('reads an uncached key from storage at most once for concurrent get calls and caches the result', async () => {
            await initOnyx();
            await onyx.storage.setItem(PLAIN.KEY, {fromDisk: true});
            onyx.storage.getItem.mockClear();

            const [first, second] = await Promise.all([onyx.OnyxUtils.get(PLAIN.KEY), onyx.OnyxUtils.get(PLAIN.KEY)]);

            expect(onyx.storage.getItem.mock.calls.length).toBeLessThanOrEqual(1);
            expect(first).toEqual({fromDisk: true});
            expect(second).toBe(first);
            expect(onyx.cache.get(PLAIN.KEY)).toBe(first);
            expect(onyx.cache.hasPendingTask(`get:${PLAIN.KEY}`)).toBe(false);

            await onyx.OnyxUtils.get(PLAIN.KEY);
            expect(onyx.storage.getItem.mock.calls.length).toBeLessThanOrEqual(1);
        });

        it('reads all keys from storage at most once for concurrent getAllKeys calls', async () => {
            await onyx.storage.setItem(PLAIN.KEY, 1);
            await onyx.storage.setItem(MEMBER_1, {id: 1});
            onyx.storage.getAllKeys.mockClear();

            const [first, second] = await Promise.all([onyx.OnyxUtils.getAllKeys(), onyx.OnyxUtils.getAllKeys()]);

            expect(onyx.storage.getAllKeys.mock.calls.length).toBeLessThanOrEqual(1);
            expect([...first].sort()).toEqual([MEMBER_1, PLAIN.KEY]);
            expect([...second].sort()).toEqual([MEMBER_1, PLAIN.KEY]);
            expect(onyx.cache.getAllKeys()).toEqual(new Set([MEMBER_1, PLAIN.KEY]));
        });
    });

    describe('collection snapshots delivered to subscribers', () => {
        it('delivers the frozen cache snapshot to a collection subscriber', async () => {
            await initOnyx();
            const received: unknown[] = [];
            onyx.Onyx.connect({key: COLLECTION.COLL, callback: (value) => received.push(value)});
            await waitForPromisesToResolve();

            await onyx.Onyx.set(MEMBER_1, {id: 1});
            await onyx.Onyx.merge(MEMBER_2, {id: 2});
            await waitForPromisesToResolve();

            const last = received.at(-1);
            expect(last).toEqual({[MEMBER_1]: {id: 1}, [MEMBER_2]: {id: 2}});
            expect(Object.isFrozen(last)).toBe(true);
            expect(last).toBe(onyx.cache.getCollectionData(COLLECTION.COLL));
        });

        it('keeps the cached member and the snapshot reference when Onyx.merge changes nothing', async () => {
            await initOnyx();
            await onyx.Onyx.set(MEMBER_1, {id: 1, nested: {a: 1}});
            const member = onyx.cache.get(MEMBER_1);
            const snapshot = onyx.cache.getCollectionData(COLLECTION.COLL);

            await onyx.Onyx.merge(MEMBER_1, {nested: {a: 1}});
            await waitForPromisesToResolve();

            expect(onyx.cache.get(MEMBER_1)).toBe(member);
            expect(onyx.cache.getCollectionData(COLLECTION.COLL)).toBe(snapshot);
        });

        it('removes a member from the snapshot after Onyx.remove', async () => {
            await initOnyx();
            await onyx.Onyx.set(MEMBER_1, {id: 1});
            await onyx.Onyx.set(MEMBER_2, {id: 2});

            await onyx.OnyxUtils.remove(MEMBER_1);

            const snapshot = onyx.cache.getCollectionData(COLLECTION.COLL);
            expect(isRecord(snapshot) && Object.keys(snapshot)).toEqual([MEMBER_2]);
            expect(onyx.cache.get(MEMBER_1)).toBeUndefined();
        });
    });

    describe('eviction bookkeeping', () => {
        it('makes written evictable keys eviction candidates in write order and drops them when set to null', async () => {
            await initOnyx();

            await onyx.Onyx.set(MEMBER_1, {id: 1});
            await onyx.Onyx.set(EVICTABLE_PLAIN, 'value');
            await onyx.Onyx.set(PLAIN.KEY, 'not evictable');

            expect(onyx.cache.getKeyForEviction()).toBe(MEMBER_1);
            expect(onyx.cache.getKeyForEviction(new Set([MEMBER_1]))).toBe(EVICTABLE_PLAIN);
            expect(onyx.cache.getKeyForEviction(new Set([MEMBER_1, EVICTABLE_PLAIN]))).toBeUndefined();

            await onyx.Onyx.set(MEMBER_1, null);

            expect(onyx.cache.getKeyForEviction()).toBe(EVICTABLE_PLAIN);
        });

        it('moves a key written again to the most recent position', async () => {
            await initOnyx();
            await onyx.Onyx.set(MEMBER_1, {id: 1});
            await onyx.Onyx.set(MEMBER_2, {id: 2});

            await onyx.Onyx.merge(MEMBER_1, {id: 11});

            expect(onyx.cache.getKeyForEviction()).toBe(MEMBER_2);
        });

        it('seeds eviction candidates from storage on init', async () => {
            await onyx.storage.setItem(MEMBER_2, {id: 2});
            await onyx.storage.setItem(PLAIN.KEY, 1);
            await onyx.storage.setItem(MEMBER_1, {id: 1});

            await initOnyx();

            const first = onyx.cache.getKeyForEviction();
            const second = onyx.cache.getKeyForEviction(new Set([first ?? '']));

            expect([first, second].sort()).toEqual([MEMBER_1, MEMBER_2]);
            expect(onyx.cache.getKeyForEviction(new Set([MEMBER_1, MEMBER_2]))).toBeUndefined();
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('reads storage again on every get of a key missing from storage, because providers report a miss as null', async () => {
            await initOnyx();
            onyx.storage.getItem.mockClear();

            expect((await onyx.OnyxUtils.get('missing')) ?? undefined).toBeUndefined();
            expect((await onyx.OnyxUtils.get('missing')) ?? undefined).toBeUndefined();

            expect(onyx.storage.getItem).toHaveBeenCalledTimes(2);
            expect(onyx.cache.hasCacheForKey('missing')).toBe(false);
        });
    });
});
