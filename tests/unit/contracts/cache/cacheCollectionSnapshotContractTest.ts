import type {Cache} from './cacheHelpers';
import {COLLECTION, PLAIN, expectSnapshotConsistent, loadFreshCache, readSnapshot} from './cacheHelpers';
import type OnyxKeysDefault from '../../../../lib/OnyxKeys';

const MEMBER_1 = `${COLLECTION.COLL}1`;
const MEMBER_2 = `${COLLECTION.COLL}2`;
const MEMBER_3 = `${COLLECTION.COLL}3`;
const SUB_MEMBER = `${COLLECTION.COLL_SUB}1`;
// Starts with 'coll_sub' but not with 'coll_sub_', so it belongs to 'coll_'.
const SUB_LOOKALIKE = `${COLLECTION.COLL}subX`;
const OTHER_MEMBER = `${COLLECTION.OTHER}1`;

let cache: Cache;
let OnyxKeys: typeof OnyxKeysDefault;

beforeEach(() => {
    ({cache, OnyxKeys} = loadFreshCache());
});

describe('OnyxCache collection snapshot contract', () => {
    describe('before any key is known', () => {
        it('returns undefined for a registered collection while the cache holds no keys', () => {
            expect(cache.getCollectionData(COLLECTION.COLL)).toBeUndefined();
            expect(cache.getCollectionData(COLLECTION.EMPTY)).toBeUndefined();
        });

        it('returns undefined for a key that is not a registered collection', () => {
            cache.set(PLAIN.KEY, 1);

            expect(cache.getCollectionData('unknown_')).toBeUndefined();
            expect(cache.getCollectionData(PLAIN.KEY)).toBeUndefined();
        });
    });

    describe('empty collections', () => {
        it('returns a frozen empty object once any key is known, and the same reference on every read', () => {
            cache.set(PLAIN.KEY, 1);

            const first = cache.getCollectionData(COLLECTION.EMPTY);
            const second = cache.getCollectionData(COLLECTION.EMPTY);

            expect(first).toEqual({});
            expect(Object.isFrozen(first)).toBe(true);
            expect(second).toBe(first);
        });

        it('treats a key registered through setAllKeys as known', () => {
            cache.setAllKeys([PLAIN.KEY]);

            expect(cache.getCollectionData(COLLECTION.EMPTY)).toEqual({});
        });

        it('returns an empty snapshot after the last member is removed while other keys exist', () => {
            cache.set(PLAIN.KEY, 1);
            cache.set(MEMBER_1, {id: 1});
            expect(readSnapshot(cache, COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 1}});

            cache.set(MEMBER_1, null);

            const empty = cache.getCollectionData(COLLECTION.COLL);
            expect(empty).toEqual({});
            expect(Object.isFrozen(empty)).toBe(true);
            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(empty);
        });

        it('returns undefined again once every key has been dropped from the cache', () => {
            cache.set(MEMBER_1, {id: 1});
            expect(readSnapshot(cache, COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 1}});

            cache.drop(MEMBER_1);

            expect(cache.getAllKeys().size).toBe(0);
            expect(cache.getCollectionData(COLLECTION.COLL)).toBeUndefined();
        });

        it('keeps the empty snapshot when a member is set to null without ever having a value', () => {
            cache.set(PLAIN.KEY, 1);
            const empty = cache.getCollectionData(COLLECTION.COLL);

            cache.set(MEMBER_1, null);
            cache.merge({[MEMBER_2]: null});

            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(empty);
        });
    });

    describe('structural sharing', () => {
        it('returns a frozen snapshot whose members are the cached references', () => {
            const one = {id: 1};
            const two = {id: 2};
            cache.set(MEMBER_1, one);
            cache.set(MEMBER_2, two);

            const snapshot = readSnapshot(cache, COLLECTION.COLL);

            expect(snapshot).toEqual({[MEMBER_1]: one, [MEMBER_2]: two});
            expect(snapshot[MEMBER_1]).toBe(one);
            expect(snapshot[MEMBER_2]).toBe(two);
            expect(Object.isFrozen(snapshot)).toBe(true);
        });

        it('returns the same reference while nothing changed', () => {
            cache.set(MEMBER_1, {id: 1});

            const first = cache.getCollectionData(COLLECTION.COLL);

            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(first);
            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(first);
        });

        it('returns a new reference after a member changes and keeps unchanged siblings by reference', () => {
            const one = {id: 1};
            cache.set(MEMBER_1, one);
            cache.set(MEMBER_2, {id: 2});
            const before = readSnapshot(cache, COLLECTION.COLL);

            const nextTwo = {id: 22};
            cache.set(MEMBER_2, nextTwo);
            const after = readSnapshot(cache, COLLECTION.COLL);

            expect(after).not.toBe(before);
            expect(after[MEMBER_1]).toBe(one);
            expect(after[MEMBER_2]).toBe(nextTwo);
            expect(before[MEMBER_2]).toEqual({id: 2});
        });

        it('returns a new reference after a member is added', () => {
            cache.set(MEMBER_1, {id: 1});
            const before = cache.getCollectionData(COLLECTION.COLL);

            cache.set(MEMBER_2, {id: 2});

            const after = readSnapshot(cache, COLLECTION.COLL);
            expect(after).not.toBe(before);
            expect(Object.keys(after).sort()).toEqual([MEMBER_1, MEMBER_2]);
        });

        it('returns a new reference without the member after it is set to null, dropped or merged to null', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(MEMBER_2, {id: 2});
            cache.set(MEMBER_3, {id: 3});
            const initial = cache.getCollectionData(COLLECTION.COLL);

            cache.set(MEMBER_1, null);
            const afterSet = readSnapshot(cache, COLLECTION.COLL);
            expect(afterSet).not.toBe(initial);
            expect(afterSet).not.toHaveProperty([MEMBER_1]);

            cache.drop(MEMBER_2);
            const afterDrop = readSnapshot(cache, COLLECTION.COLL);
            expect(afterDrop).not.toBe(afterSet);
            expect(afterDrop).not.toHaveProperty([MEMBER_2]);

            cache.merge({[MEMBER_3]: null});
            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({});
        });

        it('returns a new reference when one member is removed and another added between two reads', () => {
            cache.set(MEMBER_1, {id: 1});
            const before = cache.getCollectionData(COLLECTION.COLL);

            cache.set(MEMBER_1, null);
            cache.set(MEMBER_2, {id: 2});

            const after = cache.getCollectionData(COLLECTION.COLL);
            expect(after).not.toBe(before);
            expect(after).toEqual({[MEMBER_2]: {id: 2}});
        });

        it('keeps the reference when a member is set to its own current reference', () => {
            const one = {id: 1};
            cache.set(MEMBER_1, one);
            const before = cache.getCollectionData(COLLECTION.COLL);

            cache.set(MEMBER_1, one);

            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(before);
        });

        it('keeps the reference when a member changes and changes back before the next read', () => {
            const one = {id: 1};
            cache.set(MEMBER_1, one);
            const before = cache.getCollectionData(COLLECTION.COLL);

            cache.set(MEMBER_1, {id: 99});
            cache.set(MEMBER_1, one);

            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(before);
        });

        it('returns a new reference for a deep-equal replacement, so the snapshot always holds the cached reference', () => {
            cache.set(MEMBER_1, {id: 1});
            const before = cache.getCollectionData(COLLECTION.COLL);

            const copy = {id: 1};
            cache.set(MEMBER_1, copy);

            const after = readSnapshot(cache, COLLECTION.COLL);
            expect(after).not.toBe(before);
            expect(after[MEMBER_1]).toBe(copy);
        });

        it('keeps the reference when a merge into a member changes nothing', () => {
            cache.set(MEMBER_1, {id: 1, nested: {a: 1}});
            const before = cache.getCollectionData(COLLECTION.COLL);

            cache.merge({[MEMBER_1]: {id: 1, nested: {a: 1}}});
            cache.merge({[MEMBER_1]: undefined});

            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(before);
        });

        it('returns a new reference after a merge changes a member, sharing the other members', () => {
            const two = {id: 2};
            cache.set(MEMBER_1, {id: 1});
            cache.set(MEMBER_2, two);
            const before = cache.getCollectionData(COLLECTION.COLL);

            cache.merge({[MEMBER_1]: {name: 'one'}});

            const after = readSnapshot(cache, COLLECTION.COLL);
            expect(after).not.toBe(before);
            expect(after[MEMBER_1]).toEqual({id: 1, name: 'one'});
            expect(after[MEMBER_2]).toBe(two);
            expectSnapshotConsistent(cache, OnyxKeys, COLLECTION.COLL);
        });

        it('never changes a snapshot that was already handed out', () => {
            cache.set(MEMBER_1, {id: 1});
            const handedOut = readSnapshot(cache, COLLECTION.COLL);

            cache.merge({[MEMBER_1]: {id: 2}, [MEMBER_2]: {id: 3}});
            cache.drop(MEMBER_1);
            cache.getCollectionData(COLLECTION.COLL);

            expect(handedOut).toEqual({[MEMBER_1]: {id: 1}});
        });
    });

    describe('dirty tracking', () => {
        it('reflects every write since the last read in one rebuild', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.getCollectionData(COLLECTION.COLL);

            cache.set(MEMBER_2, {id: 2});
            cache.merge({[MEMBER_1]: {name: 'one'}, [MEMBER_3]: {id: 3}});
            cache.set(MEMBER_2, null);

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 1, name: 'one'}, [MEMBER_3]: {id: 3}});
            expectSnapshotConsistent(cache, OnyxKeys, COLLECTION.COLL);
        });

        it('reflects writes made between reads, one after another', () => {
            cache.set(MEMBER_1, {v: 1});
            expect(readSnapshot(cache, COLLECTION.COLL)[MEMBER_1]).toEqual({v: 1});

            cache.set(MEMBER_1, {v: 2});
            expect(readSnapshot(cache, COLLECTION.COLL)[MEMBER_1]).toEqual({v: 2});

            cache.merge({[MEMBER_1]: {w: 3}});
            expect(readSnapshot(cache, COLLECTION.COLL)[MEMBER_1]).toEqual({v: 2, w: 3});

            cache.hydrate({[MEMBER_1]: {v: 4}});
            expect(readSnapshot(cache, COLLECTION.COLL)[MEMBER_1]).toEqual({v: 4, w: 3});
        });

        it('leaves other collections untouched, including a clean snapshot read before the write', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(OTHER_MEMBER, {id: 2});
            const other = cache.getCollectionData(COLLECTION.OTHER);
            const coll = cache.getCollectionData(COLLECTION.COLL);

            cache.set(MEMBER_1, {id: 11});
            cache.set(PLAIN.KEY, 'plain');
            cache.merge({[PLAIN.COLL_LOOKALIKE]: {x: 1}});

            expect(cache.getCollectionData(COLLECTION.OTHER)).toBe(other);
            expect(cache.getCollectionData(COLLECTION.COLL)).not.toBe(coll);
        });

        it('marks every collection touched by one merge call', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(OTHER_MEMBER, {id: 2});
            const coll = cache.getCollectionData(COLLECTION.COLL);
            const other = cache.getCollectionData(COLLECTION.OTHER);

            cache.merge({[MEMBER_1]: {id: 10}, [OTHER_MEMBER]: {id: 20}, [SUB_MEMBER]: {id: 30}});

            expect(cache.getCollectionData(COLLECTION.COLL)).not.toBe(coll);
            expect(cache.getCollectionData(COLLECTION.OTHER)).not.toBe(other);
            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 10}});
            expect(cache.getCollectionData(COLLECTION.OTHER)).toEqual({[OTHER_MEMBER]: {id: 20}});
            expect(cache.getCollectionData(COLLECTION.COLL_SUB)).toEqual({[SUB_MEMBER]: {id: 30}});
        });

        it('marks every collection touched by one hydrate call', () => {
            cache.set(PLAIN.KEY, 1);
            const coll = cache.getCollectionData(COLLECTION.COLL);
            const other = cache.getCollectionData(COLLECTION.OTHER);

            cache.hydrate({[MEMBER_1]: {id: 1}, [OTHER_MEMBER]: {id: 2}});

            expect(cache.getCollectionData(COLLECTION.COLL)).not.toBe(coll);
            expect(cache.getCollectionData(COLLECTION.OTHER)).not.toBe(other);
            expect(cache.getCollectionData(COLLECTION.OTHER)).toEqual({[OTHER_MEMBER]: {id: 2}});
        });

        it('removes a member hydrated as null from the snapshot', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(MEMBER_2, {id: 2});
            cache.getCollectionData(COLLECTION.COLL);

            cache.hydrate({[MEMBER_1]: null});

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_2]: {id: 2}});
        });

        it('keeps a snapshot consistent across a long interleaved sequence of writes and reads', () => {
            const collections = [COLLECTION.COLL, COLLECTION.COLL_SUB, COLLECTION.OTHER];
            const keys = [MEMBER_1, MEMBER_2, SUB_MEMBER, SUB_LOOKALIKE, OTHER_MEMBER, `${COLLECTION.OTHER}2`];
            let seed = 7;
            const next = () => {
                seed = (seed * 48271) % 2147483647;
                return seed;
            };

            for (let step = 0; step < 300; step++) {
                const key = keys[next() % keys.length];
                const action = next() % 6;
                if (action === 0) {
                    cache.set(key, {v: step});
                } else if (action === 1) {
                    cache.set(key, null);
                } else if (action === 2) {
                    cache.merge({[key]: {w: step % 3}});
                } else if (action === 3) {
                    cache.merge({[key]: null});
                } else if (action === 4) {
                    cache.drop(key);
                } else {
                    cache.hydrate({[key]: {h: step % 2}});
                }

                if (next() % 3 === 0) {
                    for (const collectionKey of collections) {
                        if (cache.getAllKeys().size > 0) {
                            expectSnapshotConsistent(cache, OnyxKeys, collectionKey);
                        }
                    }
                }
            }
        });
    });

    describe('prefix-colliding collections', () => {
        it('puts a member into the most specific matching collection only', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(SUB_MEMBER, {id: 2});
            cache.set(SUB_LOOKALIKE, {id: 3});

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 1}, [SUB_LOOKALIKE]: {id: 3}});
            expect(cache.getCollectionData(COLLECTION.COLL_SUB)).toEqual({[SUB_MEMBER]: {id: 2}});
            expectSnapshotConsistent(cache, OnyxKeys, COLLECTION.COLL);
            expectSnapshotConsistent(cache, OnyxKeys, COLLECTION.COLL_SUB);
        });

        it('rebuilds only the owning collection when a nested member changes', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(SUB_MEMBER, {id: 2});
            const coll = cache.getCollectionData(COLLECTION.COLL);
            const sub = cache.getCollectionData(COLLECTION.COLL_SUB);

            cache.set(SUB_MEMBER, {id: 22});

            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(coll);
            expect(cache.getCollectionData(COLLECTION.COLL_SUB)).not.toBe(sub);
        });

        it('never includes plain keys that only share a prefix with the collection', () => {
            cache.set(PLAIN.COLL_LOOKALIKE, {x: 1});
            cache.set('collX_1', {x: 2});
            cache.set(PLAIN.UNDERSCORED, {x: 3});
            cache.set(MEMBER_1, {id: 1});

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 1}});
        });

        it('does not treat a value stored at the collection key itself as a member once members exist', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(COLLECTION.COLL, {whole: true});

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 1}});
        });

        it('finds the members of a collection registered later through setCollectionKeys when they are written afterwards', () => {
            ({cache, OnyxKeys} = loadFreshCache([COLLECTION.COLL]));
            cache.setCollectionKeys(new Set([COLLECTION.COLL, COLLECTION.COLL_SUB]));

            cache.set(SUB_MEMBER, {id: 1});
            cache.set(MEMBER_1, {id: 2});

            expect(cache.getCollectionData(COLLECTION.COLL_SUB)).toEqual({[SUB_MEMBER]: {id: 1}});
            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 2}});
        });

        it('keeps an existing snapshot when setCollectionKeys runs again with the same keys', () => {
            cache.set(MEMBER_1, {id: 1});
            const before = cache.getCollectionData(COLLECTION.COLL);

            cache.setCollectionKeys(new Set([COLLECTION.COLL, COLLECTION.COLL_SUB, COLLECTION.OTHER, COLLECTION.EMPTY]));

            expect(cache.getCollectionData(COLLECTION.COLL)).toBe(before);
        });
    });

    describe('dropping the collection key itself', () => {
        it('rebuilds the snapshot from the members that are still cached', () => {
            const one = {id: 1};
            cache.set(MEMBER_1, one);
            cache.getCollectionData(COLLECTION.COLL);

            cache.drop(COLLECTION.COLL);

            const snapshot = readSnapshot(cache, COLLECTION.COLL);
            expect(snapshot).toEqual({[MEMBER_1]: one});
            expect(snapshot[MEMBER_1]).toBe(one);
            expect(Object.isFrozen(snapshot)).toBe(true);
            expect(cache.get(MEMBER_1)).toBe(one);
        });

        it('returns an empty snapshot when no member is cached but other keys exist', () => {
            cache.set(PLAIN.KEY, 1);

            cache.drop(COLLECTION.COLL);

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({});
        });
    });

    describe('storage key set', () => {
        it('lets members registered through setAllKeys show up once their values are hydrated', () => {
            cache.setAllKeys([MEMBER_1, SUB_MEMBER, PLAIN.KEY]);
            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({});

            cache.hydrate({[MEMBER_1]: {id: 1}, [SUB_MEMBER]: {id: 2}, [PLAIN.KEY]: 1});

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 1}});
            expect(cache.getCollectionData(COLLECTION.COLL_SUB)).toEqual({[SUB_MEMBER]: {id: 2}});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('includes a value stored at the collection key itself as a member while the collection has no members', () => {
            cache.set(COLLECTION.COLL, {whole: true});

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[COLLECTION.COLL]: {whole: true}});
        });

        it('includes the collection key value again once the last member is dropped', () => {
            cache.set(MEMBER_1, {id: 1});
            cache.set(COLLECTION.COLL, {whole: true});
            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_1]: {id: 1}});

            cache.drop(MEMBER_1);

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[COLLECTION.COLL]: {whole: true}});
        });

        it('hides members cached before their collection key was registered, even after a sibling write', () => {
            ({cache, OnyxKeys} = loadFreshCache([]));
            cache.set(MEMBER_1, {id: 1});
            cache.setCollectionKeys(new Set([COLLECTION.COLL]));

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({});

            cache.set(MEMBER_2, {id: 2});

            expect(cache.getCollectionData(COLLECTION.COLL)).toEqual({[MEMBER_2]: {id: 2}});
            expect(cache.get(MEMBER_1)).toEqual({id: 1});
        });
    });
});
