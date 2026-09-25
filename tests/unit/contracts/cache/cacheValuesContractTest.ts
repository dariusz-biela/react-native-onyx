import type {Cache} from './cacheHelpers';
import {COLLECTION, PLAIN, expectSnapshotConsistent, isRecord, loadFreshCache, readSnapshot} from './cacheHelpers';
import type OnyxKeysDefault from '../../../../lib/OnyxKeys';

const REPLACE_MARK = 'ONYX_INTERNALS__REPLACE_OBJECT_MARK';

const MEMBER_1 = `${COLLECTION.COLL}1`;
const MEMBER_2 = `${COLLECTION.COLL}2`;

let cache: Cache;

function readRecord(source: Cache, key: string): Record<string, unknown> {
    const value = source.get(key);
    if (!isRecord(value)) {
        throw new Error(`Expected an object at '${key}'`);
    }
    return value;
}

let OnyxKeys: typeof OnyxKeysDefault;

beforeEach(() => {
    ({cache, OnyxKeys} = loadFreshCache());
});

describe('OnyxCache values contract', () => {
    describe('get and set', () => {
        it('returns the stored reference from both set and get, without copying', () => {
            const value = {id: 1, nested: {a: 1}};

            expect(cache.set(PLAIN.KEY, value)).toBe(value);
            expect(cache.get(PLAIN.KEY)).toBe(value);
        });

        it('stores values with nested nulls verbatim, because set does not normalise', () => {
            const value = {keep: 1, drop: null};

            cache.set(PLAIN.KEY, value);

            expect(cache.get(PLAIN.KEY)).toBe(value);
            expect(cache.get(PLAIN.KEY)).toEqual({keep: 1, drop: null});
        });

        it.each([
            ['zero', 0],
            ['empty string', ''],
            ['false', false],
            ['empty object', {}],
            ['empty array', []],
        ])('keeps the falsy value %s as a cache hit', (_label, value) => {
            expect(cache.set(PLAIN.KEY, value)).toBe(value);

            expect(cache.get(PLAIN.KEY)).toBe(value);
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(true);
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
        ])('removes the value, returns undefined and keeps the key registered when set to %s', (_label, value) => {
            cache.set(PLAIN.KEY, {id: 1});

            expect(cache.set(PLAIN.KEY, value)).toBeUndefined();

            expect(cache.get(PLAIN.KEY)).toBeUndefined();
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(false);
            expect(cache.getAllKeys().has(PLAIN.KEY)).toBe(true);
        });

        it('registers a key even when its first write is null', () => {
            cache.set(PLAIN.KEY, null);

            expect(cache.getAllKeys().has(PLAIN.KEY)).toBe(true);
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(false);
        });

        it('replaces an object with a primitive and a primitive with an object', () => {
            cache.set(PLAIN.KEY, {id: 1});
            cache.set(PLAIN.KEY, 'text');
            expect(cache.get(PLAIN.KEY)).toBe('text');

            const next = {id: 2};
            cache.set(PLAIN.KEY, next);
            expect(cache.get(PLAIN.KEY)).toBe(next);
        });

        it('replaces instead of merging when an object is set over an object', () => {
            cache.set(PLAIN.KEY, {a: 1, b: 2});
            cache.set(PLAIN.KEY, {b: 3});

            expect(cache.get(PLAIN.KEY)).toEqual({b: 3});
        });

        it('keeps prefix-colliding keys independent', () => {
            cache.set(PLAIN.KEY, 'short');
            cache.set(`${PLAIN.KEY}Longer`, 'long');
            cache.set(PLAIN.COLL_LOOKALIKE, 'lookalike');
            cache.set(MEMBER_1, {id: 1});

            expect(cache.get(PLAIN.KEY)).toBe('short');
            expect(cache.get(`${PLAIN.KEY}Longer`)).toBe('long');
            expect(cache.get(PLAIN.COLL_LOOKALIKE)).toBe('lookalike');
            expect(cache.get(MEMBER_1)).toEqual({id: 1});
        });

        it('returns undefined for a key that was never written', () => {
            expect(cache.get('neverWritten')).toBeUndefined();
            expect(cache.hasCacheForKey('neverWritten')).toBe(false);
        });
    });

    describe('hasCacheForKey and nullish storage keys', () => {
        it('treats a key known to be nullish in storage as a cache hit with an undefined value', () => {
            cache.addNullishStorageKey(PLAIN.KEY);

            expect(cache.hasNullishStorageKey(PLAIN.KEY)).toBe(true);
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(true);
            expect(cache.get(PLAIN.KEY)).toBeUndefined();
            expect(cache.getAllKeys().has(PLAIN.KEY)).toBe(false);
        });

        it('clears the nullish marker when the key is set to a value', () => {
            cache.addNullishStorageKey(PLAIN.KEY);
            cache.set(PLAIN.KEY, {id: 1});

            expect(cache.hasNullishStorageKey(PLAIN.KEY)).toBe(false);
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(true);
        });

        it('clears the nullish marker when the key is set to null, so the key becomes a cache miss', () => {
            cache.addNullishStorageKey(PLAIN.KEY);
            cache.set(PLAIN.KEY, null);

            expect(cache.hasNullishStorageKey(PLAIN.KEY)).toBe(false);
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(false);
        });

        it('forgets every nullish marker on clearNullishStorageKeys but keeps cached values', () => {
            cache.addNullishStorageKey('a');
            cache.addNullishStorageKey('b');
            cache.set(PLAIN.KEY, 1);

            cache.clearNullishStorageKeys();

            expect(cache.hasNullishStorageKey('a')).toBe(false);
            expect(cache.hasNullishStorageKey('b')).toBe(false);
            expect(cache.hasCacheForKey('a')).toBe(false);
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(true);
        });

        it('keeps markers per key, so a marker on one key does not affect a prefix-colliding key', () => {
            cache.addNullishStorageKey(PLAIN.KEY);

            expect(cache.hasCacheForKey(`${PLAIN.KEY}Longer`)).toBe(false);
            expect(cache.hasCacheForKey(PLAIN.KEY.slice(0, -1))).toBe(false);
        });
    });

    describe('drop', () => {
        it('forgets the value and the key', () => {
            cache.set(PLAIN.KEY, {id: 1});

            cache.drop(PLAIN.KEY);

            expect(cache.get(PLAIN.KEY)).toBeUndefined();
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(false);
            expect(cache.getAllKeys().has(PLAIN.KEY)).toBe(false);
        });

        it('does not touch other keys', () => {
            const other = {id: 2};
            cache.set(PLAIN.KEY, {id: 1});
            cache.set(`${PLAIN.KEY}Longer`, other);

            cache.drop(PLAIN.KEY);

            expect(cache.get(`${PLAIN.KEY}Longer`)).toBe(other);
            expect(cache.getAllKeys().has(`${PLAIN.KEY}Longer`)).toBe(true);
        });

        it('is safe for a key that was never written', () => {
            expect(() => cache.drop('neverWritten')).not.toThrow();
            expect(cache.getAllKeys().size).toBe(0);
        });

        it('lets a dropped collection member come back with a later set', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.drop(MEMBER_1);
            const revived = {id: 2};
            cache.set(MEMBER_1, revived);

            expect(cache.get(MEMBER_1)).toBe(revived);
            expect(readSnapshot(cache, COLLECTION.COLL)[MEMBER_1]).toBe(revived);
            expectSnapshotConsistent(cache, OnyxKeys, COLLECTION.COLL);
        });

        it('keeps a nullish marker, so a dropped key known to be empty in storage stays a cache hit', () => {
            cache.addNullishStorageKey(PLAIN.KEY);

            cache.drop(PLAIN.KEY);

            expect(cache.hasNullishStorageKey(PLAIN.KEY)).toBe(true);
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(true);
        });
    });

    describe('merge', () => {
        it('throws for arrays and non-objects', () => {
            expect(() => Reflect.apply(cache.merge, cache, [[]])).toThrow();
            expect(() => Reflect.apply(cache.merge, cache, ['text'])).toThrow();
            expect(() => Reflect.apply(cache.merge, cache, [1])).toThrow();
        });

        it('creates new keys and registers them', () => {
            cache.merge({[PLAIN.KEY]: {id: 1}, [MEMBER_1]: 'member'});

            expect(cache.get(PLAIN.KEY)).toEqual({id: 1});
            expect(cache.get(MEMBER_1)).toBe('member');
            expect([...cache.getAllKeys()].sort()).toEqual([MEMBER_1, PLAIN.KEY].sort());
        });

        it('deep merges objects and keeps target keys the source does not mention', () => {
            cache.set(PLAIN.KEY, {a: 1, nested: {x: 1, y: 2}});

            cache.merge({[PLAIN.KEY]: {b: 2, nested: {y: 3, z: 4}}});

            expect(cache.get(PLAIN.KEY)).toEqual({a: 1, b: 2, nested: {x: 1, y: 3, z: 4}});
        });

        it('never mutates the previously cached object or the merged-in value', () => {
            const previous = {a: 1, nested: {x: 1}};
            const change = {nested: {x: 2}, b: 2};
            cache.set(PLAIN.KEY, previous);

            cache.merge({[PLAIN.KEY]: change});

            expect(previous).toEqual({a: 1, nested: {x: 1}});
            expect(change).toEqual({nested: {x: 2}, b: 2});
            expect(cache.get(PLAIN.KEY)).not.toBe(previous);
            expect(cache.get(PLAIN.KEY)).toEqual({a: 1, b: 2, nested: {x: 2}});
        });

        it('shares untouched nested branches with the previous value', () => {
            const untouched = {deep: {value: 1}};
            cache.set(PLAIN.KEY, {untouched, touched: {v: 1}});

            cache.merge({[PLAIN.KEY]: {touched: {v: 2}}});

            expect(cache.get(PLAIN.KEY)).toEqual({untouched: {deep: {value: 1}}, touched: {v: 2}});
            expect(readRecord(cache, PLAIN.KEY).untouched).toBe(untouched);
        });

        it('keeps the cached reference when the merge changes nothing', () => {
            const previous = {a: 1, nested: {x: 1}};
            cache.set(PLAIN.KEY, previous);

            cache.merge({[PLAIN.KEY]: {a: 1, nested: {x: 1}}});
            cache.merge({[PLAIN.KEY]: {}});

            expect(cache.get(PLAIN.KEY)).toBe(previous);
        });

        it('replaces arrays instead of merging them index by index', () => {
            cache.set(PLAIN.KEY, {list: [1, 2, 3]});

            cache.merge({[PLAIN.KEY]: {list: [9]}});

            expect(cache.get(PLAIN.KEY)).toEqual({list: [9]});
        });

        it('replaces a top-level array with the new array', () => {
            const next = [3];
            cache.set(PLAIN.KEY, [1, 2]);

            cache.merge({[PLAIN.KEY]: next});

            expect(cache.get(PLAIN.KEY)).toEqual([3]);
        });

        it('replaces primitives and lets an object replace a primitive', () => {
            cache.set(PLAIN.KEY, 'text');
            cache.merge({[PLAIN.KEY]: {id: 1}});
            expect(cache.get(PLAIN.KEY)).toEqual({id: 1});

            cache.merge({[PLAIN.KEY]: 5});
            expect(cache.get(PLAIN.KEY)).toBe(5);
        });

        it('stores falsy primitives as cache hits', () => {
            cache.merge({a: 0, b: '', c: false});

            expect(cache.get('a')).toBe(0);
            expect(cache.get('b')).toBe('');
            expect(cache.get('c')).toBe(false);
            expect(cache.hasCacheForKey('a')).toBe(true);
            expect(cache.hasCacheForKey('b')).toBe(true);
            expect(cache.hasCacheForKey('c')).toBe(true);
        });

        it('removes nested nulls from the merged result at every depth', () => {
            cache.set(PLAIN.KEY, {keep: 1, drop: 2, nested: {keep: 1, drop: 2, deeper: {drop: 3, keep: 4}}});

            cache.merge({[PLAIN.KEY]: {drop: null, nested: {drop: null, deeper: {drop: null}}}});

            expect(cache.get(PLAIN.KEY)).toEqual({keep: 1, nested: {keep: 1, deeper: {keep: 4}}});
        });

        it('removes nested nulls from a value merged into a key that had no value', () => {
            cache.merge({[PLAIN.KEY]: {keep: 1, drop: null, nested: {drop: null, keep: 2}}});

            expect(cache.get(PLAIN.KEY)).toEqual({keep: 1, nested: {keep: 2}});
        });

        it('replaces a nested object whose source carries the replace mark, and strips the mark', () => {
            cache.set(PLAIN.KEY, {nested: {old: 1, shared: 1}, other: 1});

            cache.merge({[PLAIN.KEY]: {nested: {[REPLACE_MARK]: true, shared: 2}}});

            expect(cache.get(PLAIN.KEY)).toEqual({nested: {shared: 2}, other: 1});
        });

        it('deletes the value and marks the key nullish for a top-level null', () => {
            cache.set(PLAIN.KEY, {id: 1});

            cache.merge({[PLAIN.KEY]: null});

            expect(cache.get(PLAIN.KEY)).toBeUndefined();
            expect(cache.hasNullishStorageKey(PLAIN.KEY)).toBe(true);
            expect(cache.hasCacheForKey(PLAIN.KEY)).toBe(true);
            expect(cache.getAllKeys().has(PLAIN.KEY)).toBe(true);
        });

        it('leaves the value untouched for a top-level undefined but still registers the key', () => {
            const previous = {id: 1};
            cache.set(PLAIN.KEY, previous);

            cache.merge({[PLAIN.KEY]: undefined, fresh: undefined});

            expect(cache.get(PLAIN.KEY)).toBe(previous);
            expect(cache.get('fresh')).toBeUndefined();
            expect(cache.getAllKeys().has('fresh')).toBe(true);
            expect(cache.hasCacheForKey('fresh')).toBe(true);
        });

        it('clears the nullish marker when a non-null value is merged later', () => {
            cache.merge({[PLAIN.KEY]: null});
            cache.merge({[PLAIN.KEY]: {id: 1}});

            expect(cache.hasNullishStorageKey(PLAIN.KEY)).toBe(false);
            expect(cache.get(PLAIN.KEY)).toEqual({id: 1});
        });

        it('applies every key of one call, including null next to values', () => {
            cache.set('a', {v: 1});
            cache.set('b', {v: 1});

            cache.merge({a: null, b: {w: 2}, c: {v: 3}});

            expect(cache.get('a')).toBeUndefined();
            expect(cache.get('b')).toEqual({v: 1, w: 2});
            expect(cache.get('c')).toEqual({v: 3});
        });

        it('does nothing for an empty object', () => {
            cache.set(PLAIN.KEY, 1);

            cache.merge({});

            expect([...cache.getAllKeys()]).toEqual([PLAIN.KEY]);
            expect(cache.get(PLAIN.KEY)).toBe(1);
        });
    });

    describe('hydrate', () => {
        it('throws for null, arrays and non-objects', () => {
            expect(() => Reflect.apply(cache.hydrate, cache, [null])).toThrow();
            expect(() => Reflect.apply(cache.hydrate, cache, [[]])).toThrow();
            expect(() => Reflect.apply(cache.hydrate, cache, ['text'])).toThrow();
        });

        it('stores clean values by reference and registers every key', () => {
            const value = {a: {b: [1, null]}};
            const list = [{id: 1}];

            cache.hydrate({[PLAIN.KEY]: value, list, flag: false, count: 0});

            expect(cache.get(PLAIN.KEY)).toBe(value);
            expect(cache.get('list')).toBe(list);
            expect(cache.get('flag')).toBe(false);
            expect(cache.get('count')).toBe(0);
            expect([...cache.getAllKeys()].sort()).toEqual(['count', 'flag', 'list', PLAIN.KEY].sort());
        });

        it('keeps nulls inside arrays because arrays are stored as they are', () => {
            cache.hydrate({[PLAIN.KEY]: {list: [null, 1]}});

            expect(cache.get(PLAIN.KEY)).toEqual({list: [null, 1]});
        });

        it('normalises nested nulls and undefined at every depth without mutating the input', () => {
            const value = {keep: 1, a: {b: {c: null, d: 1}, e: undefined}};

            cache.hydrate({[PLAIN.KEY]: value});

            expect(cache.get(PLAIN.KEY)).toEqual({keep: 1, a: {b: {d: 1}}});
            expect(cache.get(PLAIN.KEY)).not.toHaveProperty(['a', 'e']);
            expect(value).toEqual({keep: 1, a: {b: {c: null, d: 1}, e: undefined}});
        });

        it('strips the replace mark from nested objects', () => {
            cache.hydrate({nested: {inner: {deeper: {[REPLACE_MARK]: true, v: 2}}, keep: 1}});

            expect(cache.get('nested')).toEqual({inner: {deeper: {v: 2}}, keep: 1});
        });

        it('marks null and undefined values as nullish; null deletes an existing value, undefined keeps it', () => {
            const kept = {id: 2};
            cache.set('cleared', {id: 1});
            cache.set('kept', kept);

            cache.hydrate({cleared: null, kept: undefined, fresh: undefined});

            expect(cache.get('cleared')).toBeUndefined();
            expect(cache.hasNullishStorageKey('cleared')).toBe(true);
            expect(cache.get('kept')).toBe(kept);
            expect(cache.hasNullishStorageKey('fresh')).toBe(true);
            expect(cache.hasCacheForKey('fresh')).toBe(true);
        });

        it('merges into a key that already has a value and lets the hydrated value win on overlapping leaves', () => {
            const untouched = {deep: 1};
            cache.set(PLAIN.KEY, {fromWrite: 1, shared: 'write', untouched, nested: {a: 1}});

            cache.hydrate({[PLAIN.KEY]: {shared: 'disk', fromDisk: 2, nested: {b: 2, drop: null}}});

            const value = readRecord(cache, PLAIN.KEY);
            expect(value).toEqual({fromWrite: 1, shared: 'disk', untouched: {deep: 1}, fromDisk: 2, nested: {a: 1, b: 2}});
            expect(value.untouched).toBe(untouched);
        });

        it('keeps the existing reference when the hydrated value changes nothing', () => {
            const existing = {a: 1};
            cache.set(PLAIN.KEY, existing);

            cache.hydrate({[PLAIN.KEY]: {a: 1}});

            expect(cache.get(PLAIN.KEY)).toBe(existing);
        });

        it('clears a nullish marker when a value is hydrated', () => {
            cache.addNullishStorageKey(PLAIN.KEY);

            cache.hydrate({[PLAIN.KEY]: {id: 1}});

            expect(cache.hasNullishStorageKey(PLAIN.KEY)).toBe(false);
        });

        it('exposes hydrated collection members through the snapshot with the stored references', () => {
            const member = {id: 1};
            cache.hydrate({[MEMBER_1]: member, [MEMBER_2]: null, [`${COLLECTION.COLL_SUB}1`]: {id: 3}});

            const snapshot = readSnapshot(cache, COLLECTION.COLL);
            expect(snapshot).toEqual({[MEMBER_1]: {id: 1}});
            expect(snapshot[MEMBER_1]).toBe(member);
            expect(readSnapshot(cache, COLLECTION.COLL_SUB)).toEqual({[`${COLLECTION.COLL_SUB}1`]: {id: 3}});
            expectSnapshotConsistent(cache, OnyxKeys, COLLECTION.COLL);
        });

        it('produces the same values as merge into an empty cache for every shape', () => {
            const build = (): Record<string, unknown> => ({
                s: 'x',
                n: 0,
                b: false,
                o: {a: 1, nested: {n: null, keep: 1}},
                r: {[REPLACE_MARK]: true, v: 1},
                arr: [1, {a: null}],
                nul: null,
                und: undefined,
                [MEMBER_1]: {id: 1, drop: null},
            });
            const {cache: mergeCache} = loadFreshCache();
            mergeCache.merge(build());
            ({cache, OnyxKeys} = loadFreshCache());

            cache.hydrate(build());

            for (const key of Object.keys(build())) {
                expect(cache.get(key)).toEqual(mergeCache.get(key));
                expect(cache.hasCacheForKey(key)).toBe(mergeCache.hasCacheForKey(key));
                expect(cache.hasNullishStorageKey(key)).toBe(mergeCache.hasNullishStorageKey(key));
            }
            expect([...cache.getAllKeys()].sort()).toEqual([...mergeCache.getAllKeys()].sort());
        });
    });

    describe('hasValueChanged', () => {
        it('reports no change for the cached reference itself', () => {
            const value = {a: 1};
            cache.set(PLAIN.KEY, value);

            expect(cache.hasValueChanged(PLAIN.KEY, value)).toBe(false);
        });

        it('reports no change for a deep-equal copy', () => {
            cache.set(PLAIN.KEY, {a: 1, nested: {list: [1, {b: 2}]}});

            expect(cache.hasValueChanged(PLAIN.KEY, {a: 1, nested: {list: [1, {b: 2}]}})).toBe(false);
        });

        it('reports a change deep inside nested objects and arrays', () => {
            cache.set(PLAIN.KEY, {a: 1, nested: {list: [1, {b: 2}]}});

            expect(cache.hasValueChanged(PLAIN.KEY, {a: 1, nested: {list: [1, {b: 3}]}})).toBe(true);
            expect(cache.hasValueChanged(PLAIN.KEY, {a: 1, nested: {list: [{b: 2}, 1]}})).toBe(true);
            expect(cache.hasValueChanged(PLAIN.KEY, {a: 1, nested: {list: [1, {b: 2}]}, extra: true})).toBe(true);
            expect(cache.hasValueChanged(PLAIN.KEY, {a: 1})).toBe(true);
        });

        it('compares primitives by value', () => {
            cache.set(PLAIN.KEY, 1);

            expect(cache.hasValueChanged(PLAIN.KEY, 1)).toBe(false);
            expect(cache.hasValueChanged(PLAIN.KEY, 2)).toBe(true);
            expect(cache.hasValueChanged(PLAIN.KEY, '1')).toBe(true);
        });

        it('treats a missing value as equal to undefined but different from null and from an empty object', () => {
            expect(cache.hasValueChanged(PLAIN.KEY, undefined)).toBe(false);
            expect(cache.hasValueChanged(PLAIN.KEY, null)).toBe(true);
            expect(cache.hasValueChanged(PLAIN.KEY, {})).toBe(true);
        });

        it('reports a change for undefined when a value is cached', () => {
            cache.set(PLAIN.KEY, {a: 1});

            expect(cache.hasValueChanged(PLAIN.KEY, undefined)).toBe(true);
            expect(cache.hasValueChanged(PLAIN.KEY, null)).toBe(true);
        });

        it('reads the latest value after writes', () => {
            cache.set(PLAIN.KEY, {a: 1});
            cache.merge({[PLAIN.KEY]: {a: 2}});

            expect(cache.hasValueChanged(PLAIN.KEY, {a: 1})).toBe(true);
            expect(cache.hasValueChanged(PLAIN.KEY, {a: 2})).toBe(false);

            cache.drop(PLAIN.KEY);
            expect(cache.hasValueChanged(PLAIN.KEY, {a: 2})).toBe(true);
            expect(cache.hasValueChanged(PLAIN.KEY, undefined)).toBe(false);
        });

        it('compares against this key only, never a prefix-colliding one', () => {
            cache.set(PLAIN.KEY, {a: 1});
            cache.set(`${PLAIN.KEY}Longer`, {a: 2});

            expect(cache.hasValueChanged(`${PLAIN.KEY}Longer`, {a: 1})).toBe(true);
            expect(cache.hasValueChanged(`${PLAIN.KEY}Longer`, {a: 2})).toBe(false);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('marks a key nullish when merge receives undefined for it, even though its cached value is kept', () => {
            const previous = {id: 1};
            cache.set(PLAIN.KEY, previous);

            cache.merge({[PLAIN.KEY]: undefined});

            expect(cache.get(PLAIN.KEY)).toBe(previous);
            expect(cache.hasNullishStorageKey(PLAIN.KEY)).toBe(true);
        });

        it('keeps a replace mark that sits on the top-level value, in hydrate and in merge alike', () => {
            const {cache: mergeCache} = loadFreshCache();
            mergeCache.merge({top: {[REPLACE_MARK]: true, v: 1}});
            ({cache} = loadFreshCache());

            cache.hydrate({top: {[REPLACE_MARK]: true, v: 1}});

            expect(cache.get('top')).toEqual({[REPLACE_MARK]: true, v: 1});
            expect(mergeCache.get('top')).toEqual({[REPLACE_MARK]: true, v: 1});
        });

        it('accepts null as the data of merge and does nothing, while hydrate throws for it', () => {
            expect(() => Reflect.apply(cache.merge, cache, [null])).not.toThrow();
            expect(cache.getAllKeys().size).toBe(0);
        });
    });
});
