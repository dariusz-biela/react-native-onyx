import Onyx from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import onyxSnapshotCache, {OnyxSnapshotCache} from '../../../../lib/OnyxSnapshotCache';
import type {UseOnyxResult, UseOnyxSelector} from '../../../../lib/useOnyx';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    PLAIN_WITH_UNDERSCORE: 'plain_key',
    ITEM_LIKE_PLAIN: 'item',
    COLLECTION: {
        ITEM: 'item_',
        ITEM_LEVEL: 'item_level_',
        ITEM_META: 'itemMeta_',
    },
} as const;

type TestResult = UseOnyxResult<{label: string}>;

function loaded(label: string): TestResult {
    return [{label}, {status: 'loaded'}];
}

function makeSelector(label: string): UseOnyxSelector<OnyxKey, string> {
    return () => label;
}

let cache: OnyxSnapshotCache;

beforeAll(async () => {
    Onyx.init({keys: KEYS});
    await waitForPromisesToResolve();
});

beforeEach(() => {
    cache = new OnyxSnapshotCache();
});

describe('OnyxSnapshotCache contract', () => {
    describe('cache keys', () => {
        it('gives the same cache key to every consumer of the same key and selector reference', () => {
            const selector = makeSelector('a');

            expect(cache.registerConsumer(KEYS.PLAIN, {selector})).toBe(cache.registerConsumer(KEYS.PLAIN, {selector}));
            expect(cache.registerConsumer(KEYS.PLAIN, {})).toBe(cache.registerConsumer(KEYS.PLAIN, {selector: undefined}));
        });

        it('gives different cache keys to different selector references on the same key, even when their logic is the same', () => {
            const first = makeSelector('a');
            const second = makeSelector('a');
            const cacheKeys = [cache.registerConsumer(KEYS.PLAIN, {selector: first}), cache.registerConsumer(KEYS.PLAIN, {selector: second}), cache.registerConsumer(KEYS.PLAIN, {})];

            expect(new Set(cacheKeys).size).toBe(3);
        });

        it('gives different cache keys to the same selector on different keys, including prefix-colliding member keys', () => {
            const selector = makeSelector('a');
            const onyxKeys = [KEYS.PLAIN, `${KEYS.COLLECTION.ITEM}1`, `${KEYS.COLLECTION.ITEM}11`, `${KEYS.COLLECTION.ITEM_LEVEL}1`, KEYS.COLLECTION.ITEM, KEYS.COLLECTION.ITEM_LEVEL];
            const withSelector = onyxKeys.map((key) => cache.registerConsumer(key, {selector}));
            const withoutSelector = onyxKeys.map((key) => cache.registerConsumer(key, {}));

            expect(new Set([...withSelector, ...withoutSelector]).size).toBe(onyxKeys.length * 2);
        });

        it('keeps a stable selector ID per selector reference and different IDs per reference', () => {
            const first = makeSelector('a');
            const second = makeSelector('b');

            const firstID = cache.getSelectorID(first);
            const secondID = cache.getSelectorID(second);

            expect(cache.getSelectorID(first)).toBe(firstID);
            expect(cache.getSelectorID(second)).toBe(secondID);
            expect(firstID).not.toBe(secondID);
        });

        it('does not share selector IDs or cache keys state between two instances', () => {
            const other = new OnyxSnapshotCache();
            const selector = makeSelector('a');
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {selector});
            const otherCacheKey = other.registerConsumer(KEYS.PLAIN, {selector});

            cache.setCachedResult(KEYS.PLAIN, cacheKey, loaded('mine'));

            expect(other.getCachedResult(KEYS.PLAIN, otherCacheKey)).toBeUndefined();
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toEqual(loaded('mine'));
        });
    });

    describe('hits and misses', () => {
        it('returns the exact result reference that was stored', () => {
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {});
            const result = loaded('a');

            cache.setCachedResult(KEYS.PLAIN, cacheKey, result);

            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(result);
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(result);
        });

        it('returns the latest stored result when a slot is written twice', () => {
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {});
            const latest = loaded('b');

            cache.setCachedResult(KEYS.PLAIN, cacheKey, loaded('a'));
            cache.setCachedResult(KEYS.PLAIN, cacheKey, latest);

            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(latest);
        });

        it('misses for a registered consumer that has not stored a result yet', () => {
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {});

            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBeUndefined();
        });

        it('misses for another cache key on a key that already holds a result', () => {
            const withoutSelector = cache.registerConsumer(KEYS.PLAIN, {});
            const withSelector = cache.registerConsumer(KEYS.PLAIN, {selector: makeSelector('a')});

            cache.setCachedResult(KEYS.PLAIN, withoutSelector, loaded('a'));

            expect(cache.getCachedResult(KEYS.PLAIN, withSelector)).toBeUndefined();
        });

        it('keeps results stored under the same cache key string on different Onyx keys apart', () => {
            const shared = 'same-cache-key';
            const plain = loaded('plain');
            const member = loaded('member');

            cache.setCachedResult(KEYS.PLAIN, shared, plain);
            cache.setCachedResult(`${KEYS.COLLECTION.ITEM}1`, shared, member);

            expect(cache.getCachedResult(KEYS.PLAIN, shared)).toBe(plain);
            expect(cache.getCachedResult(`${KEYS.COLLECTION.ITEM}1`, shared)).toBe(member);
            expect(cache.getCachedResult(KEYS.PLAIN_WITH_UNDERSCORE, shared)).toBeUndefined();
        });

        it('stores a result for a key after it was invalidated', () => {
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {});
            const next = loaded('b');

            cache.setCachedResult(KEYS.PLAIN, cacheKey, loaded('a'));
            cache.invalidateForKey(KEYS.PLAIN);
            cache.setCachedResult(KEYS.PLAIN, cacheKey, next);

            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(next);
        });
    });

    describe('invalidation', () => {
        const MEMBER = `${KEYS.COLLECTION.ITEM}1`;
        const SIBLING = `${KEYS.COLLECTION.ITEM}2`;
        const LONG_MEMBER = `${KEYS.COLLECTION.ITEM}11`;
        const LEVEL_MEMBER = `${KEYS.COLLECTION.ITEM_LEVEL}1`;
        const META_MEMBER = `${KEYS.COLLECTION.ITEM_META}1`;
        const ALL_KEYS = [
            KEYS.PLAIN,
            KEYS.PLAIN_WITH_UNDERSCORE,
            KEYS.ITEM_LIKE_PLAIN,
            KEYS.COLLECTION.ITEM,
            MEMBER,
            SIBLING,
            LONG_MEMBER,
            KEYS.COLLECTION.ITEM_LEVEL,
            LEVEL_MEMBER,
            KEYS.COLLECTION.ITEM_META,
            META_MEMBER,
        ];

        function fillEveryKey(): Map<string, string[]> {
            const cacheKeysByKey = new Map<string, string[]>();
            for (const key of ALL_KEYS) {
                const cacheKeys = [cache.registerConsumer(key, {}), cache.registerConsumer(key, {selector: makeSelector(key)})];
                for (const cacheKey of cacheKeys) {
                    cache.setCachedResult(key, cacheKey, loaded(`${key}|${cacheKey}`));
                }
                cacheKeysByKey.set(key, cacheKeys);
            }
            return cacheKeysByKey;
        }

        function keysWithResults(cacheKeysByKey: Map<string, string[]>): string[] {
            return ALL_KEYS.filter((key) => (cacheKeysByKey.get(key) ?? []).every((cacheKey) => cache.getCachedResult(key, cacheKey) !== undefined));
        }

        function keysWithoutResults(cacheKeysByKey: Map<string, string[]>): string[] {
            return ALL_KEYS.filter((key) => (cacheKeysByKey.get(key) ?? []).every((cacheKey) => cache.getCachedResult(key, cacheKey) === undefined));
        }

        it.each([
            ['a plain key', KEYS.PLAIN, [KEYS.PLAIN]],
            ['a plain key whose name contains an underscore', KEYS.PLAIN_WITH_UNDERSCORE, [KEYS.PLAIN_WITH_UNDERSCORE]],
            ['a plain key named like a collection without its underscore', KEYS.ITEM_LIKE_PLAIN, [KEYS.ITEM_LIKE_PLAIN]],
            ['a collection member, together with its collection root', MEMBER, [KEYS.COLLECTION.ITEM, MEMBER]],
            ['a member whose ID starts like a sibling ID', LONG_MEMBER, [KEYS.COLLECTION.ITEM, LONG_MEMBER]],
            ['a member of the longer-prefix collection, with its own root only', LEVEL_MEMBER, [KEYS.COLLECTION.ITEM_LEVEL, LEVEL_MEMBER]],
            ['a member of a collection whose name extends another without an underscore', META_MEMBER, [KEYS.COLLECTION.ITEM_META, META_MEMBER]],
            ['a collection root, without cascading to its members', KEYS.COLLECTION.ITEM, [KEYS.COLLECTION.ITEM]],
            ['the longer-prefix collection root, without touching the shorter one', KEYS.COLLECTION.ITEM_LEVEL, [KEYS.COLLECTION.ITEM_LEVEL]],
        ])('invalidates every consumer of %s and nothing else', (_description, keyToInvalidate: string, expectedInvalidated: string[]) => {
            const cacheKeysByKey = fillEveryKey();

            cache.invalidateForKey(keyToInvalidate);

            expect(keysWithoutResults(cacheKeysByKey)).toEqual(ALL_KEYS.filter((key) => expectedInvalidated.includes(key)));
            expect(keysWithResults(cacheKeysByKey)).toEqual(ALL_KEYS.filter((key) => !expectedInvalidated.includes(key)));
        });

        it('invalidates a member of a collection that has never been stored or subscribed to', () => {
            const unseen = `${KEYS.COLLECTION.ITEM_META}unseen_member`;
            const rootCacheKey = cache.registerConsumer(KEYS.COLLECTION.ITEM_META, {});
            const unseenCacheKey = cache.registerConsumer(unseen, {});
            cache.setCachedResult(KEYS.COLLECTION.ITEM_META, rootCacheKey, loaded('root'));
            cache.setCachedResult(unseen, unseenCacheKey, loaded('unseen'));

            cache.invalidateForKey(unseen);

            expect(cache.getCachedResult(KEYS.COLLECTION.ITEM_META, rootCacheKey)).toBeUndefined();
            expect(cache.getCachedResult(unseen, unseenCacheKey)).toBeUndefined();
        });

        it('drops nothing for an unknown key and only the collection root for a member without results', () => {
            const cacheKeysByKey = fillEveryKey();

            cache.invalidateForKey('unknownKey');
            cache.invalidateForKey(`${KEYS.COLLECTION.ITEM}999`);

            expect(keysWithResults(cacheKeysByKey)).toEqual(ALL_KEYS.filter((key) => key !== KEYS.COLLECTION.ITEM));
        });

        it('keeps consumer counts when results are invalidated, so a later deregistration still waits for the last consumer', () => {
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {});
            cache.registerConsumer(KEYS.PLAIN, {});
            cache.setCachedResult(KEYS.PLAIN, cacheKey, loaded('a'));

            cache.invalidateForKey(KEYS.PLAIN);
            const next = loaded('b');
            cache.setCachedResult(KEYS.PLAIN, cacheKey, next);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);

            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(next);
        });
    });

    describe('cleanup', () => {
        it('keeps the result while any consumer of the cache key is registered and drops it with the last one', () => {
            const selector = makeSelector('a');
            const cacheKeys = [cache.registerConsumer(KEYS.PLAIN, {selector}), cache.registerConsumer(KEYS.PLAIN, {selector}), cache.registerConsumer(KEYS.PLAIN, {selector})];
            const cacheKey = cacheKeys[0];
            const result = loaded('a');
            cache.setCachedResult(KEYS.PLAIN, cacheKey, result);

            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(result);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(result);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBeUndefined();
        });

        it('drops only the cache key whose last consumer left and keeps other cache keys on the same Onyx key', () => {
            const withoutSelector = cache.registerConsumer(KEYS.PLAIN, {});
            const withSelector = cache.registerConsumer(KEYS.PLAIN, {selector: makeSelector('a')});
            const kept = loaded('kept');
            cache.setCachedResult(KEYS.PLAIN, withoutSelector, loaded('dropped'));
            cache.setCachedResult(KEYS.PLAIN, withSelector, kept);

            cache.deregisterConsumer(KEYS.PLAIN, withoutSelector);

            expect(cache.getCachedResult(KEYS.PLAIN, withoutSelector)).toBeUndefined();
            expect(cache.getCachedResult(KEYS.PLAIN, withSelector)).toBe(kept);
        });

        it('keeps results of the same selector on other Onyx keys when the last consumer on one key leaves', () => {
            const selector = makeSelector('a');
            const onPlain = cache.registerConsumer(KEYS.PLAIN, {selector});
            const onMember = cache.registerConsumer(`${KEYS.COLLECTION.ITEM}1`, {selector});
            const kept = loaded('member');
            cache.setCachedResult(KEYS.PLAIN, onPlain, loaded('plain'));
            cache.setCachedResult(`${KEYS.COLLECTION.ITEM}1`, onMember, kept);

            cache.deregisterConsumer(KEYS.PLAIN, onPlain);

            expect(cache.getCachedResult(KEYS.PLAIN, onPlain)).toBeUndefined();
            expect(cache.getCachedResult(`${KEYS.COLLECTION.ITEM}1`, onMember)).toBe(kept);
        });

        it('does not count consumers of the same selector on another Onyx key when deciding to drop a result', () => {
            const selector = makeSelector('a');
            const onPlain = cache.registerConsumer(KEYS.PLAIN, {selector});
            cache.registerConsumer(KEYS.PLAIN_WITH_UNDERSCORE, {selector});
            cache.registerConsumer(KEYS.PLAIN_WITH_UNDERSCORE, {selector});
            cache.setCachedResult(KEYS.PLAIN, onPlain, loaded('plain'));

            cache.deregisterConsumer(KEYS.PLAIN, onPlain);

            expect(cache.getCachedResult(KEYS.PLAIN, onPlain)).toBeUndefined();
        });

        it('does not serve a result stored before every consumer left to a consumer that registers again', () => {
            const selector = makeSelector('a');
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {selector});
            cache.setCachedResult(KEYS.PLAIN, cacheKey, loaded('stale'));
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);

            const again = cache.registerConsumer(KEYS.PLAIN, {selector});

            expect(again).toBe(cacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, again)).toBeUndefined();
        });

        it('starts counting from zero again after the last consumer left', () => {
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {});
            cache.registerConsumer(KEYS.PLAIN, {});
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);

            cache.registerConsumer(KEYS.PLAIN, {});
            cache.setCachedResult(KEYS.PLAIN, cacheKey, loaded('a'));
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);

            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBeUndefined();
        });

        it('drops the result on an extra deregistration and keeps counting correctly afterwards', () => {
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {});
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);

            cache.registerConsumer(KEYS.PLAIN, {});
            cache.registerConsumer(KEYS.PLAIN, {});
            const result = loaded('a');
            cache.setCachedResult(KEYS.PLAIN, cacheKey, result);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(result);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBeUndefined();
        });

        it('drops a result stored under a cache key that no consumer registered when it is deregistered', () => {
            cache.setCachedResult(KEYS.PLAIN, 'unregistered', loaded('a'));

            cache.deregisterConsumer(KEYS.PLAIN, 'unregistered');

            expect(cache.getCachedResult(KEYS.PLAIN, 'unregistered')).toBeUndefined();
        });

        it('keeps results on other Onyx keys when the last cache key of one key is dropped', () => {
            const onPlain = cache.registerConsumer(KEYS.PLAIN, {});
            const onRoot = cache.registerConsumer(KEYS.COLLECTION.ITEM, {});
            const kept = loaded('root');
            cache.setCachedResult(KEYS.PLAIN, onPlain, loaded('plain'));
            cache.setCachedResult(KEYS.COLLECTION.ITEM, onRoot, kept);

            cache.deregisterConsumer(KEYS.PLAIN, onPlain);
            const next = loaded('plain again');
            cache.setCachedResult(KEYS.PLAIN, onPlain, next);

            expect(cache.getCachedResult(KEYS.COLLECTION.ITEM, onRoot)).toBe(kept);
            expect(cache.getCachedResult(KEYS.PLAIN, onPlain)).toBe(next);
        });
    });

    describe('clear', () => {
        it('drops every result on every key', () => {
            const onPlain = cache.registerConsumer(KEYS.PLAIN, {});
            const onMember = cache.registerConsumer(`${KEYS.COLLECTION.ITEM}1`, {selector: makeSelector('a')});
            cache.setCachedResult(KEYS.PLAIN, onPlain, loaded('plain'));
            cache.setCachedResult(`${KEYS.COLLECTION.ITEM}1`, onMember, loaded('member'));

            cache.clear();

            expect(cache.getCachedResult(KEYS.PLAIN, onPlain)).toBeUndefined();
            expect(cache.getCachedResult(`${KEYS.COLLECTION.ITEM}1`, onMember)).toBeUndefined();
        });

        it('keeps consumer counts and selector IDs, so cache keys and cleanup work the same after a clear', () => {
            const selector = makeSelector('a');
            const cacheKey = cache.registerConsumer(KEYS.PLAIN, {selector});
            cache.registerConsumer(KEYS.PLAIN, {selector});

            cache.clear();
            const result = loaded('a');
            cache.setCachedResult(KEYS.PLAIN, cacheKey, result);

            expect(cache.registerConsumer(KEYS.PLAIN, {selector})).toBe(cacheKey);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBe(result);
            cache.deregisterConsumer(KEYS.PLAIN, cacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, cacheKey)).toBeUndefined();
        });
    });

    describe('shared instance', () => {
        it('is an OnyxSnapshotCache', () => {
            expect(onyxSnapshotCache).toBeInstanceOf(OnyxSnapshotCache);
        });

        it('loses every stored result when Onyx.clear refreshes the session', async () => {
            const cacheKey = onyxSnapshotCache.registerConsumer(KEYS.PLAIN, {});
            onyxSnapshotCache.setCachedResult(KEYS.PLAIN, cacheKey, loaded('before clear'));

            await Onyx.clear();

            expect(onyxSnapshotCache.getCachedResult(KEYS.PLAIN, cacheKey)).toBeUndefined();
            onyxSnapshotCache.deregisterConsumer(KEYS.PLAIN, cacheKey);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('hands a new selector the ID of a selector seen before clearSelectorIds, so both share one cache key and one result', () => {
            const seenBefore = makeSelector('before');
            const beforeCacheKey = cache.registerConsumer(KEYS.PLAIN, {selector: seenBefore});
            const result = loaded('before');
            cache.setCachedResult(KEYS.PLAIN, beforeCacheKey, result);

            cache.clearSelectorIds();
            const seenAfter = makeSelector('after');
            const afterCacheKey = cache.registerConsumer(KEYS.PLAIN, {selector: seenAfter});

            expect(cache.getSelectorID(seenAfter)).toBe(cache.getSelectorID(seenBefore));
            expect(afterCacheKey).toBe(beforeCacheKey);
            expect(cache.getCachedResult(KEYS.PLAIN, afterCacheKey)).toBe(result);
        });
    });
});
