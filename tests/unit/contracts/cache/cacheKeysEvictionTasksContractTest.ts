import type {Cache} from './cacheHelpers';
import {COLLECTION, PLAIN, loadFreshCache} from './cacheHelpers';
import type OnyxKeysDefault from '../../../../lib/OnyxKeys';

const MEMBER_1 = `${COLLECTION.COLL}1`;
const MEMBER_2 = `${COLLECTION.COLL}2`;
const MEMBER_3 = `${COLLECTION.COLL}3`;
const SUB_MEMBER = `${COLLECTION.COLL_SUB}1`;
const OTHER_MEMBER = `${COLLECTION.OTHER}1`;
const EVICTABLE_PLAIN = 'evictablePlain';

let cache: Cache;
let OnyxKeys: typeof OnyxKeysDefault;

beforeEach(() => {
    ({cache, OnyxKeys} = loadFreshCache());
});

/** Reads the eviction order by repeatedly asking for the next candidate while excluding the ones already returned. */
function evictionOrder(): string[] {
    const order: string[] = [];
    const excluded = new Set<string>();
    for (let candidate = cache.getKeyForEviction(excluded); candidate !== undefined; candidate = cache.getKeyForEviction(excluded)) {
        order.push(candidate);
        excluded.add(candidate);
    }
    return order;
}

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

describe('OnyxCache storage keys, eviction and pending tasks contract', () => {
    describe('storage key set', () => {
        it('starts empty', () => {
            expect([...cache.getAllKeys()]).toEqual([]);
        });

        it('replaces the whole key set with setAllKeys', () => {
            cache.set(PLAIN.KEY, 1);

            cache.setAllKeys([MEMBER_1, OTHER_MEMBER]);

            expect([...cache.getAllKeys()].sort()).toEqual([MEMBER_1, OTHER_MEMBER]);
            expect(cache.get(PLAIN.KEY)).toBe(1);
        });

        it('keeps a key added by addKey only once', () => {
            cache.addKey(PLAIN.KEY);
            cache.addKey(PLAIN.KEY);
            cache.set(PLAIN.KEY, 1);

            expect([...cache.getAllKeys()]).toEqual([PLAIN.KEY]);
        });

        it('registers keys added through setAllKeys and addKey as members of their collection', () => {
            cache.setAllKeys([MEMBER_1, SUB_MEMBER]);
            cache.addKey(OTHER_MEMBER);

            expect(OnyxKeys.getMembersOfCollection(COLLECTION.COLL)).toEqual(new Set([MEMBER_1]));
            expect(OnyxKeys.getMembersOfCollection(COLLECTION.COLL_SUB)).toEqual(new Set([SUB_MEMBER]));
            expect(OnyxKeys.getMembersOfCollection(COLLECTION.OTHER)).toEqual(new Set([OTHER_MEMBER]));
        });

        it('adds keys written by set, merge and hydrate, including nullish writes', () => {
            cache.set('a', 1);
            cache.set('b', null);
            cache.merge({c: {x: 1}, d: null, e: undefined});
            cache.hydrate({f: 1, g: null});

            expect([...cache.getAllKeys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
        });

        it('removes a dropped key from the key set and from its collection members', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(MEMBER_2, {id: 2});

            cache.drop(MEMBER_1);

            expect(cache.getAllKeys().has(MEMBER_1)).toBe(false);
            expect(OnyxKeys.getMembersOfCollection(COLLECTION.COLL)).toEqual(new Set([MEMBER_2]));
        });
    });

    describe('isEvictableKey', () => {
        it('matches a plain allowlist entry exactly', () => {
            cache.setEvictionAllowList([EVICTABLE_PLAIN]);

            expect(cache.isEvictableKey(EVICTABLE_PLAIN)).toBe(true);
            expect(cache.isEvictableKey(`${EVICTABLE_PLAIN}2`)).toBe(false);
            expect(cache.isEvictableKey('evictable')).toBe(false);
        });

        it('matches every key starting with a registered collection allowlist entry', () => {
            cache.setEvictionAllowList([COLLECTION.COLL]);

            expect(cache.isEvictableKey(MEMBER_1)).toBe(true);
            expect(cache.isEvictableKey(SUB_MEMBER)).toBe(true);
            expect(cache.isEvictableKey(COLLECTION.COLL)).toBe(true);
            expect(cache.isEvictableKey(PLAIN.COLL_LOOKALIKE)).toBe(false);
            expect(cache.isEvictableKey(OTHER_MEMBER)).toBe(false);
        });

        it('does not prefix-match an allowlist entry that is not a registered collection', () => {
            cache.setEvictionAllowList(['unregistered_']);

            expect(cache.isEvictableKey('unregistered_')).toBe(true);
            expect(cache.isEvictableKey('unregistered_1')).toBe(false);
        });

        it('treats nothing as evictable with an empty allowlist', () => {
            expect(cache.isEvictableKey(MEMBER_1)).toBe(false);
            expect(cache.isEvictableKey(PLAIN.KEY)).toBe(false);
        });

        it('forgets the previous allowlist when a new one is set', () => {
            cache.setEvictionAllowList([COLLECTION.COLL]);
            cache.setEvictionAllowList([COLLECTION.OTHER]);

            expect(cache.isEvictableKey(MEMBER_1)).toBe(false);
            expect(cache.isEvictableKey(OTHER_MEMBER)).toBe(true);
        });
    });

    describe('recently accessed keys', () => {
        beforeEach(() => {
            cache.setEvictionAllowList([COLLECTION.COLL, EVICTABLE_PLAIN]);
        });

        it('returns undefined when nothing was accessed', () => {
            expect(cache.getKeyForEviction()).toBeUndefined();
            expect(cache.getKeyForEviction(new Set())).toBeUndefined();
        });

        it('offers the least recently accessed key first', () => {
            cache.addLastAccessedKey(MEMBER_1, false);
            cache.addLastAccessedKey(MEMBER_2, false);
            cache.addLastAccessedKey(EVICTABLE_PLAIN, false);

            expect(cache.getKeyForEviction()).toBe(MEMBER_1);
            expect(evictionOrder()).toEqual([MEMBER_1, MEMBER_2, EVICTABLE_PLAIN]);
        });

        it('moves a key accessed again to the most recent position', () => {
            cache.addLastAccessedKey(MEMBER_1, false);
            cache.addLastAccessedKey(MEMBER_2, false);
            cache.addLastAccessedKey(MEMBER_3, false);

            cache.addLastAccessedKey(MEMBER_1, false);

            expect(evictionOrder()).toEqual([MEMBER_2, MEMBER_3, MEMBER_1]);
        });

        it('ignores keys flagged as collection keys and keys outside the allowlist', () => {
            cache.addLastAccessedKey(COLLECTION.COLL, true);
            cache.addLastAccessedKey(MEMBER_1, true);
            cache.addLastAccessedKey(OTHER_MEMBER, false);
            cache.addLastAccessedKey(PLAIN.KEY, false);

            expect(cache.getKeyForEviction()).toBeUndefined();
        });

        it('keeps the position of a key when an ignored access for it arrives', () => {
            cache.addLastAccessedKey(MEMBER_1, false);
            cache.addLastAccessedKey(MEMBER_2, false);

            cache.addLastAccessedKey(MEMBER_1, true);

            expect(evictionOrder()).toEqual([MEMBER_1, MEMBER_2]);
        });

        it('removes a key with removeLastAccessedKey and tolerates unknown keys', () => {
            cache.addLastAccessedKey(MEMBER_1, false);
            cache.addLastAccessedKey(MEMBER_2, false);

            cache.removeLastAccessedKey(MEMBER_1);
            cache.removeLastAccessedKey('never-accessed');

            expect(evictionOrder()).toEqual([MEMBER_2]);
        });

        it('skips excluded keys and returns undefined when every key is excluded', () => {
            cache.addLastAccessedKey(MEMBER_1, false);
            cache.addLastAccessedKey(MEMBER_2, false);

            expect(cache.getKeyForEviction(new Set([MEMBER_1]))).toBe(MEMBER_2);
            expect(cache.getKeyForEviction(new Set([MEMBER_1, MEMBER_2]))).toBeUndefined();
            expect(cache.getKeyForEviction(new Set(['unrelated']))).toBe(MEMBER_1);
        });

        it('does not remove the returned candidate, so it is offered again until something else changes', () => {
            cache.addLastAccessedKey(MEMBER_1, false);
            cache.addLastAccessedKey(MEMBER_2, false);

            expect(cache.getKeyForEviction()).toBe(MEMBER_1);
            expect(cache.getKeyForEviction()).toBe(MEMBER_1);
        });

        it('is independent from cached values: drop and set do not touch the list', () => {
            cache.addLastAccessedKey(MEMBER_1, false);
            cache.set(MEMBER_2, {id: 2});
            cache.drop(MEMBER_1);

            expect(evictionOrder()).toEqual([MEMBER_1]);
        });
    });

    describe('addEvictableKeysToRecentlyAccessedList', () => {
        it('adds every stored key that matches the allowlist, grouped by allowlist order and then by key order', async () => {
            cache.setEvictionAllowList([EVICTABLE_PLAIN, COLLECTION.OTHER, COLLECTION.COLL]);
            const storedKeys = new Set([MEMBER_2, OTHER_MEMBER, PLAIN.KEY, MEMBER_1, EVICTABLE_PLAIN, COLLECTION.COLL]);

            await cache.addEvictableKeysToRecentlyAccessedList(OnyxKeys.isCollectionKey, () => Promise.resolve(storedKeys));

            expect(evictionOrder()).toEqual([EVICTABLE_PLAIN, OTHER_MEMBER, MEMBER_2, MEMBER_1]);
        });

        it('moves already accessed keys behind the ones it adds', async () => {
            cache.setEvictionAllowList([COLLECTION.COLL]);
            cache.addLastAccessedKey(MEMBER_3, false);

            await cache.addEvictableKeysToRecentlyAccessedList(OnyxKeys.isCollectionKey, () => Promise.resolve(new Set([MEMBER_3, MEMBER_1])));

            expect(evictionOrder()).toEqual([MEMBER_3, MEMBER_1]);
        });

        it('adds nothing with an empty allowlist', async () => {
            const getAllKeys = jest.fn(() => Promise.resolve(new Set([MEMBER_1])));

            await cache.addEvictableKeysToRecentlyAccessedList(OnyxKeys.isCollectionKey, getAllKeys);

            expect(getAllKeys).toHaveBeenCalledTimes(1);
            expect(cache.getKeyForEviction()).toBeUndefined();
        });

        it('rejects when reading the stored keys fails', async () => {
            cache.setEvictionAllowList([COLLECTION.COLL]);

            await expect(cache.addEvictableKeysToRecentlyAccessedList(OnyxKeys.isCollectionKey, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        });
    });

    describe('pending tasks', () => {
        it('reports no pending task for an unknown name', () => {
            expect(cache.hasPendingTask('getAllKeys')).toBe(false);
            expect(cache.getTaskPromise('getAllKeys')).toBeUndefined();
        });

        it('exposes the captured task by name while it is pending and hands every caller the same promise', async () => {
            const deferred = createDeferred<string>();

            const captured = cache.captureTask('get:plain', deferred.promise);

            expect(cache.hasPendingTask('get:plain')).toBe(true);
            expect(cache.getTaskPromise('get:plain')).toBe(captured);
            expect(cache.getTaskPromise('get:plain')).toBe(cache.getTaskPromise('get:plain'));

            deferred.resolve('value');
            await expect(captured).resolves.toBe('value');
        });

        it('forgets the task once it resolves', async () => {
            const deferred = createDeferred<number>();
            const captured = cache.captureTask('getAllKeys', deferred.promise);

            deferred.resolve(1);
            await captured;

            expect(cache.hasPendingTask('getAllKeys')).toBe(false);
            expect(cache.getTaskPromise('getAllKeys')).toBeUndefined();
        });

        it('forgets the task once it rejects and passes the rejection through', async () => {
            const deferred = createDeferred<number>();
            const captured = cache.captureTask('getAllKeys', deferred.promise);

            deferred.reject(new Error('failed'));

            await expect(captured).rejects.toThrow('failed');
            expect(cache.hasPendingTask('getAllKeys')).toBe(false);
        });

        it('keeps tasks with different names independent', async () => {
            const first = createDeferred<number>();
            const second = createDeferred<number>();
            const capturedFirst = cache.captureTask('get:a', first.promise);
            cache.captureTask('get:b', second.promise);

            first.resolve(1);
            await capturedFirst;

            expect(cache.hasPendingTask('get:a')).toBe(false);
            expect(cache.hasPendingTask('get:b')).toBe(true);
            second.resolve(2);
        });

        it('lets a new task be captured under a name after the previous one settled', async () => {
            await cache.captureTask('get:a', Promise.resolve(1));
            const deferred = createDeferred<number>();

            const captured = cache.captureTask('get:a', deferred.promise);

            expect(cache.getTaskPromise('get:a')).toBe(captured);
            deferred.resolve(2);
            await expect(captured).resolves.toBe(2);
            expect(cache.hasPendingTask('get:a')).toBe(false);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('lets the first of two tasks captured under one name remove the second while it is still pending', async () => {
            const first = createDeferred<number>();
            const second = createDeferred<number>();
            const capturedFirst = cache.captureTask('get:a', first.promise);
            const capturedSecond = cache.captureTask('get:a', second.promise);
            expect(cache.getTaskPromise('get:a')).toBe(capturedSecond);

            first.resolve(1);
            await capturedFirst;

            expect(cache.hasPendingTask('get:a')).toBe(false);
            second.resolve(2);
            await capturedSecond;
        });
    });
});
