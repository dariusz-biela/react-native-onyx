import type GenericCollection from '../../../utils/GenericCollection';

import Onyx from '../../../../lib';
import OnyxCache from '../../../../lib/OnyxCache';
import OnyxUtils from '../../../../lib/OnyxUtils';
import {
    KEYS,
    SKIPPABLE_ID,
    StorageMock,
    isRecord,
    toRecord,
    cachedMembers,
    createDeferred,
    evictionOrder,
    initOnyx,
    readCollection,
    record,
    resetOnyx,
    settle,
    storedWithPrefix,
} from './helpers';

const ROUTES = KEYS.COLLECTION.ROUTES;
const A = `${ROUTES}A`;
const B = `${ROUTES}B`;
const C = `${ROUTES}C`;
const D = `${ROUTES}D`;

async function seedRoutes(): Promise<void> {
    await Onyx.multiSet({
        [A]: {name: 'A', tags: ['a']},
        [B]: {name: 'B'},
        [C]: {name: 'C'},
    });
}

describe('Onyx.setCollection contract', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);
    afterAll(resetOnyx);

    describe('replacement semantics', () => {
        it('replaces the whole collection in cache, storage and the key index', async () => {
            await seedRoutes();

            await Onyx.setCollection(ROUTES, {
                [A]: {name: 'A2'},
                [D]: {name: 'D'},
            });

            const expected = {[A]: {name: 'A2'}, [D]: {name: 'D'}};
            expect(cachedMembers(ROUTES)).toEqual(expected);
            expect(readCollection(ROUTES)).toEqual(expected);
            expect(storedWithPrefix(ROUTES)).toEqual(expected);

            const keys = await OnyxUtils.getAllKeys();
            expect(keys.has(A)).toBe(true);
            expect(keys.has(D)).toBe(true);
            expect(keys.has(B)).toBe(false);
            expect(keys.has(C)).toBe(false);
            expect(OnyxCache.hasCacheForKey(B)).toBe(false);
            expect(OnyxCache.hasCacheForKey(C)).toBe(false);
        });

        it('sets each member to exactly the new value instead of merging it into the old one', async () => {
            await seedRoutes();

            await Onyx.setCollection(ROUTES, {[A]: {other: true}});

            expect(OnyxCache.get(A)).toEqual({other: true});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {other: true}});
        });

        it('replaces a member even when the new value has a different type', async () => {
            await seedRoutes();

            await Onyx.setCollection(ROUTES, {[A]: ['list'], [B]: 'text', [C]: 7});

            expect(readCollection(ROUTES)).toEqual({[A]: ['list'], [B]: 'text', [C]: 7});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: ['list'], [B]: 'text', [C]: 7});
        });

        it('removes members that exist only in storage and were never loaded into the cache', async () => {
            StorageMock.setMockStore({[A]: {name: 'stale A'}, [B]: {name: 'stale B'}, [`${KEYS.COLLECTION.OTHER}1`]: {name: 'other'}});

            await Onyx.setCollection(ROUTES, {[C]: {name: 'C'}});

            expect(storedWithPrefix(ROUTES)).toEqual({[C]: {name: 'C'}});
            expect(storedWithPrefix(KEYS.COLLECTION.OTHER)).toEqual({[`${KEYS.COLLECTION.OTHER}1`]: {name: 'other'}});
            expect(readCollection(ROUTES)).toEqual({[C]: {name: 'C'}});
        });

        it('leaves other collections, lookalike collections and plain keys untouched', async () => {
            await seedRoutes();
            const archive = `${KEYS.COLLECTION.ROUTES_ARCHIVE}A`;
            const other = `${KEYS.COLLECTION.OTHER}A`;
            await Onyx.multiSet({[archive]: {name: 'archived'}, [other]: {name: 'other'}, [KEYS.PLAIN]: 'plain', routes: 'no underscore'});

            await Onyx.setCollection(ROUTES, {});

            expect(OnyxCache.get(archive)).toEqual({name: 'archived'});
            expect(OnyxCache.get(other)).toEqual({name: 'other'});
            expect(OnyxCache.get(KEYS.PLAIN)).toBe('plain');
            expect(OnyxCache.get('routes')).toBe('no underscore');
            expect(StorageMock.getMockStore()).toEqual({[archive]: {name: 'archived'}, [other]: {name: 'other'}, [KEYS.PLAIN]: 'plain', routes: 'no underscore'});
        });

        it('replaces a large collection with a disjoint one', async () => {
            const before: GenericCollection = {};
            const after: GenericCollection = {};
            for (let i = 0; i < 300; i++) {
                before[`${ROUTES}${i}`] = {id: i};
                after[`${ROUTES}${i + 300}`] = {id: i + 300};
            }
            await Onyx.setCollection(ROUTES, before);

            await Onyx.setCollection(ROUTES, after);

            expect(readCollection(ROUTES)).toEqual(after);
            expect(storedWithPrefix(ROUTES)).toEqual(after);
        });

        it('resolves with undefined only after storage reflects the new collection', async () => {
            await seedRoutes();

            const result = await Onyx.setCollection(ROUTES, {[D]: {name: 'D'}});

            expect(result).toBeUndefined();
            expect(storedWithPrefix(ROUTES)).toEqual({[D]: {name: 'D'}});
        });

        it('does not mutate the collection object or the member objects it was given', async () => {
            await seedRoutes();
            const member = {name: 'A2', nested: {keep: 1, drop: null}};
            const input: GenericCollection = {[A]: member};

            await Onyx.setCollection(ROUTES, input);

            expect(Object.keys(input)).toEqual([A]);
            expect(member).toEqual({name: 'A2', nested: {keep: 1, drop: null}});
        });
    });

    describe('empty collection', () => {
        it('removes every member when given an empty object', async () => {
            await seedRoutes();
            await Onyx.set(KEYS.PLAIN, 'plain');
            const collection = record(ROUTES);
            const memberA = record(A);
            await settle();
            collection.reset();
            memberA.reset();

            await Onyx.setCollection(ROUTES, {});

            expect(cachedMembers(ROUTES)).toEqual({});
            expect(readCollection(ROUTES)).toEqual({});
            expect(storedWithPrefix(ROUTES)).toEqual({});
            expect(collection.last()).toEqual({});
            expect(memberA.values()).toEqual([undefined]);
        });

        it('changes nothing when the collection is already empty', async () => {
            await Onyx.set(KEYS.PLAIN, 'plain');
            const memberA = record(A);
            await settle();
            memberA.reset();

            await Onyx.setCollection(ROUTES, {});

            expect(memberA.calls).toHaveLength(0);
            expect(StorageMock.getMockStore()).toEqual({[KEYS.PLAIN]: 'plain'});
            expect(readCollection(ROUTES)).toEqual({});
        });
    });

    describe('null, undefined and nested nulls', () => {
        it('removes a member whose new value is null and ignores null for a member that does not exist', async () => {
            await seedRoutes();
            const memberA = record(A);
            const memberD = record(D);
            await settle();
            memberA.reset();
            memberD.reset();

            await Onyx.setCollection(ROUTES, {[A]: null, [B]: {name: 'B2'}, [D]: null});

            expect(readCollection(ROUTES)).toEqual({[B]: {name: 'B2'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[B]: {name: 'B2'}});
            expect(memberA.values()).toEqual([undefined]);
            expect(memberD.calls).toHaveLength(0);
            expect((await OnyxUtils.getAllKeys()).has(D)).toBe(false);
        });

        it('strips nested null and undefined properties before caching, storing and delivering', async () => {
            const memberA = record(A);
            const collection = record(ROUTES);
            await settle();

            await Onyx.setCollection(ROUTES, {
                [A]: {keep: 1, gone: null, alsoGone: undefined, nested: {keep: 2, gone: null, deeper: {gone: null}}},
            });

            const expected = {keep: 1, nested: {keep: 2, deeper: {}}};
            expect(OnyxCache.get(A)).toEqual(expected);
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: expected});
            expect(memberA.last()).toEqual(expected);
            expect(collection.last()).toEqual({[A]: expected});
            expect(Object.keys(toRecord(OnyxCache.get(A)))).toEqual(['keep', 'nested']);
        });
    });

    describe('subscriber notifications', () => {
        it('notifies a changed member once with its new value and a removed member once with undefined', async () => {
            await seedRoutes();
            const memberA = record(A);
            const memberB = record(B);
            const memberD = record(D);
            await settle();
            memberA.reset();
            memberB.reset();
            memberD.reset();

            await Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [D]: {name: 'D'}});

            expect(memberA.calls).toEqual([{value: {name: 'A2'}, key: A}]);
            expect(memberB.calls).toEqual([{value: undefined, key: B}]);
            expect(memberD.calls).toEqual([{value: {name: 'D'}, key: D}]);
        });

        it('does not notify a member whose value is passed back by the same reference', async () => {
            const valueA = {name: 'A'};
            await Onyx.setCollection(ROUTES, {[A]: valueA, [B]: {name: 'B'}});
            const memberA = record(A);
            await settle();
            memberA.reset();

            await Onyx.setCollection(ROUTES, {[A]: valueA, [B]: {name: 'B2'}});

            expect(memberA.calls).toHaveLength(0);
            expect(OnyxCache.get(A)).toBe(valueA);
        });

        it('delivers the full new collection to collection subscribers at most once per call', async () => {
            await seedRoutes();
            const collection = record(ROUTES);
            await settle();
            collection.reset();

            await Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [D]: {name: 'D'}});

            expect(collection.calls.length).toBeGreaterThanOrEqual(1);
            expect(collection.calls.length).toBeLessThanOrEqual(1);
            expect(collection.calls[0]).toEqual({value: {[A]: {name: 'A2'}, [D]: {name: 'D'}}, key: ROUTES});
        });

        it('gives collection subscribers a new reference on change and keeps unchanged member references', async () => {
            const valueB = {name: 'B'};
            await Onyx.setCollection(ROUTES, {[A]: {name: 'A'}, [B]: valueB});
            const collection = record(ROUTES);
            await settle();
            const before = toRecord(collection.last());

            await Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [B]: valueB});

            const after = toRecord(collection.last());
            expect(after).not.toBe(before);
            expect(after[B]).toBe(before[B]);
            expect(after[A]).toEqual({name: 'A2'});
        });

        it('keeps the collection reference when every member is passed back by the same reference', async () => {
            const input: GenericCollection = {[A]: {name: 'A'}, [B]: {name: 'B'}};
            await Onyx.setCollection(ROUTES, input);
            const collection = record(ROUTES);
            const memberA = record(A);
            await settle();
            const before = collection.last();
            collection.reset();
            memberA.reset();

            await Onyx.setCollection(ROUTES, {...input});

            expect(memberA.calls).toHaveLength(0);
            for (const value of collection.values()) {
                expect(value).toBe(before);
            }
            expect(readCollection(ROUTES)).toBe(before);
        });

        it('delivers the same value a member subscriber reads from the cache', async () => {
            await seedRoutes();
            const memberA = record(A);
            await settle();
            memberA.reset();

            await Onyx.setCollection(ROUTES, {[A]: {name: 'A2', nested: {x: 1}}});

            expect(memberA.last()).toBe(OnyxCache.get(A));
            expect(toRecord(readCollection(ROUTES))[A]).toBe(OnyxCache.get(A));
        });

        it('shows the whole new collection in the cache to every subscriber while it is notified', async () => {
            await seedRoutes();
            const seen: unknown[] = [];
            const snapshot = () => ({a: OnyxCache.get(A), b: OnyxCache.get(B), c: OnyxCache.get(C), d: OnyxCache.get(D), collection: readCollection(ROUTES)});
            record(A, () => seen.push(snapshot()));
            record(B, () => seen.push(snapshot()));
            record(ROUTES, () => seen.push(snapshot()));
            await settle();
            seen.length = 0;

            await Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [D]: {name: 'D'}});

            expect(seen.length).toBeGreaterThanOrEqual(2);
            for (const view of seen) {
                expect(view).toEqual({
                    a: {name: 'A2'},
                    b: undefined,
                    c: undefined,
                    d: {name: 'D'},
                    collection: {[A]: {name: 'A2'}, [D]: {name: 'D'}},
                });
            }
        });

        it('does not notify subscribers of other or lookalike collections', async () => {
            await seedRoutes();
            await Onyx.multiSet({[`${KEYS.COLLECTION.ROUTES_ARCHIVE}A`]: 1, [`${KEYS.COLLECTION.OTHER}A`]: 1});
            const archive = record(KEYS.COLLECTION.ROUTES_ARCHIVE);
            const archiveMember = record(`${KEYS.COLLECTION.ROUTES_ARCHIVE}A`);
            const other = record(KEYS.COLLECTION.OTHER);
            await settle();
            archive.reset();
            archiveMember.reset();
            other.reset();

            await Onyx.setCollection(ROUTES, {[D]: {name: 'D'}});

            expect(archive.calls).toHaveLength(0);
            expect(archiveMember.calls).toHaveLength(0);
            expect(other.calls).toHaveLength(0);
        });

        it('gives a subscriber that connects afterwards the new state', async () => {
            await seedRoutes();
            await Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [D]: {name: 'D'}});

            const collection = record(ROUTES);
            const memberB = record(B);
            const memberD = record(D);
            await settle();

            expect(collection.last()).toEqual({[A]: {name: 'A2'}, [D]: {name: 'D'}});
            expect(memberB.last()).toBeUndefined();
            expect(memberD.last()).toEqual({name: 'D'});
        });
    });

    describe('invalid keys', () => {
        it('rejects the whole call when any key does not belong to the collection', async () => {
            await seedRoutes();
            const collection = record(ROUTES);
            const memberA = record(A);
            await settle();
            collection.reset();
            memberA.reset();
            const mixed: GenericCollection = {[A]: {name: 'A2'}, [`${KEYS.COLLECTION.ROUTES_ARCHIVE}A`]: {name: 'wrong'}, invalid_key: {name: 'wrong'}};

            await expect(Onyx.setCollection(ROUTES, mixed)).resolves.toBeUndefined();

            expect(collection.calls).toHaveLength(0);
            expect(memberA.calls).toHaveLength(0);
            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A', tags: ['a']}, [B]: {name: 'B'}, [C]: {name: 'C'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A', tags: ['a']}, [B]: {name: 'B'}, [C]: {name: 'C'}});
            expect(OnyxCache.get(`${KEYS.COLLECTION.ROUTES_ARCHIVE}A`)).toBeUndefined();
            expect(StorageMock.getMockStore()).not.toHaveProperty('invalid_key');
        });

        it('rejects a key that only shares the collection prefix without its trailing separator', async () => {
            await seedRoutes();

            const lookalike: GenericCollection = {routesA: {name: 'wrong'}};
            await Onyx.setCollection(ROUTES, lookalike);

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A', tags: ['a']}, [B]: {name: 'B'}, [C]: {name: 'C'}});
            expect(OnyxCache.get('routesA')).toBeUndefined();
        });
    });

    describe('skippable member IDs', () => {
        it('drops a skippable member from the new collection and removes an existing one', async () => {
            const skippable = `${ROUTES}${SKIPPABLE_ID}`;
            StorageMock.setMockStore({[skippable]: {name: 'persisted skippable'}});
            const member = record(skippable);
            await settle();
            member.reset();

            await Onyx.setCollection(ROUTES, {[A]: {name: 'A'}, [skippable]: {name: 'skip me'}});

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A'}});
            expect(member.last()).toBeUndefined();
        });
    });

    describe('RAM-only collection', () => {
        it('replaces the collection in the cache and for subscribers without touching storage', async () => {
            const ram1 = `${KEYS.COLLECTION.RAM_ONLY}1`;
            const ram2 = `${KEYS.COLLECTION.RAM_ONLY}2`;
            const ram3 = `${KEYS.COLLECTION.RAM_ONLY}3`;
            await Onyx.setCollection(KEYS.COLLECTION.RAM_ONLY, {[ram1]: 'one', [ram2]: 'two'});
            const member1 = record(ram1);
            const collection = record(KEYS.COLLECTION.RAM_ONLY);
            await settle();
            member1.reset();

            await Onyx.setCollection(KEYS.COLLECTION.RAM_ONLY, {[ram2]: 'two!', [ram3]: 'three'});

            expect(readCollection(KEYS.COLLECTION.RAM_ONLY)).toEqual({[ram2]: 'two!', [ram3]: 'three'});
            expect(member1.values()).toEqual([undefined]);
            expect(collection.last()).toEqual({[ram2]: 'two!', [ram3]: 'three'});
            expect(storedWithPrefix(KEYS.COLLECTION.RAM_ONLY)).toEqual({});
            expect(StorageMock.multiSet).not.toHaveBeenCalledWith(expect.arrayContaining([expect.arrayContaining([ram2])]));
        });
    });

    describe('Onyx.update with SET_COLLECTION', () => {
        it('replaces the collection the same way as Onyx.setCollection', async () => {
            await seedRoutes();
            const memberB = record(B);
            await settle();
            memberB.reset();

            await Onyx.update([{onyxMethod: Onyx.METHOD.SET_COLLECTION, key: ROUTES, value: {[A]: {name: 'A2'}, [D]: {name: 'D'}}}]);

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}, [D]: {name: 'D'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}, [D]: {name: 'D'}});
            expect(memberB.values()).toEqual([undefined]);
        });
    });

    describe('ordering and interleaving', () => {
        it('applies two calls issued in the same tick in call order', async () => {
            await seedRoutes();
            const collection = record(ROUTES);
            const memberA = record(A);
            await settle();
            collection.reset();
            memberA.reset();
            const first = {[A]: {v: 1}, [B]: {v: 1}};
            const second = {[A]: {v: 2}, [D]: {v: 2}};

            await Promise.all([Onyx.setCollection(ROUTES, first), Onyx.setCollection(ROUTES, second)]);

            expect(readCollection(ROUTES)).toEqual(second);
            expect(storedWithPrefix(ROUTES)).toEqual(second);
            expect(collection.last()).toEqual(second);
            expect(memberA.last()).toEqual({v: 2});
            const firstIndex = collection.values().findIndex((value) => JSON.stringify(value) === JSON.stringify(first));
            const secondIndex = collection.values().findIndex((value) => JSON.stringify(value) === JSON.stringify(second));
            expect(secondIndex).toBeGreaterThan(firstIndex);
            for (const value of collection.values()) {
                expect([first, second]).toContainEqual(value);
            }
        });

        it('lets a setCollection issued after a member set in the same tick win', async () => {
            await seedRoutes();

            await Promise.all([Onyx.set(D, {name: 'D'}), Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}})]);

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}});
        });

        it('merges into the new value of a member merged right after setCollection in the same tick', async () => {
            await seedRoutes();

            await Promise.all([Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}}), Onyx.merge(A, {extra: 1})]);

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2', extra: 1}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2', extra: 1}});
        });

        it('lets a setCollection issued after a member merge in the same tick win', async () => {
            await seedRoutes();

            await Promise.all([Onyx.merge(A, {extra: 1}), Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}})]);
            await settle();

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}});
        });

        it('settles on the second collection when a collection subscriber replaces it again while notified', async () => {
            await seedRoutes();
            let replaced = false;
            const collection = record(ROUTES, (value) => {
                if (replaced || !(isRecord(value) && value[D])) {
                    return;
                }
                replaced = true;
                Onyx.setCollection(ROUTES, {[C]: {name: 'C3'}});
            });
            await settle();
            collection.reset();

            await Onyx.setCollection(ROUTES, {[D]: {name: 'D'}});
            await settle();

            expect(replaced).toBe(true);
            expect(readCollection(ROUTES)).toEqual({[C]: {name: 'C3'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[C]: {name: 'C3'}});
            expect(collection.last()).toEqual({[C]: {name: 'C3'}});
        });
    });

    describe('storage writes and failures', () => {
        it('retries a failed write until storage holds the new collection without notifying subscribers again', async () => {
            await seedRoutes();
            const memberA = record(A);
            const memberB = record(B);
            const collection = record(ROUTES);
            await settle();
            memberA.reset();
            memberB.reset();
            collection.reset();
            jest.mocked(StorageMock.multiSet).mockImplementationOnce(() => Promise.reject(new Error('unclassified failure')));

            await Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [D]: {name: 'D'}});

            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}, [D]: {name: 'D'}});
            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}, [D]: {name: 'D'}});
            expect(memberA.values()).toEqual([{name: 'A2'}]);
            expect(memberB.values()).toEqual([undefined]);
            expect(collection.calls.length).toBeLessThanOrEqual(1);
        });

        it('resolves only after old members are removed from storage', async () => {
            await seedRoutes();
            const pendingRemoval = createDeferred();
            jest.mocked(StorageMock.removeItems).mockImplementationOnce(() => pendingRemoval.promise);
            let resolved = false;

            const write = Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}}).then(() => {
                resolved = true;
            });
            await settle();

            expect(resolved).toBe(false);
            pendingRemoval.resolve();
            await write;
            expect(resolved).toBe(true);
        });

        it('keeps the cache and subscribers on the new collection when removing old members from storage fails', async () => {
            await seedRoutes();
            const memberB = record(B);
            await settle();
            memberB.reset();
            jest.mocked(StorageMock.removeItems).mockImplementationOnce(() => Promise.reject(new Error('removal failed')));

            await expect(Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}})).resolves.toBeUndefined();

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}});
            expect(memberB.values()).toEqual([undefined]);
            expect(OnyxCache.get(B)).toBeUndefined();
        });
    });

    describe('eviction bookkeeping', () => {
        it('forgets removed members and tracks new ones as recently used', async () => {
            const e1 = `${KEYS.COLLECTION.EVICTABLE}1`;
            const e2 = `${KEYS.COLLECTION.EVICTABLE}2`;
            const e3 = `${KEYS.COLLECTION.EVICTABLE}3`;
            await Onyx.setCollection(KEYS.COLLECTION.EVICTABLE, {[e1]: 1, [e2]: 2});

            await Onyx.setCollection(KEYS.COLLECTION.EVICTABLE, {[e2]: 2, [e3]: 3});

            const order = evictionOrder();
            expect(order).not.toContain(e1);
            expect([...order].sort()).toEqual([e2, e3]);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('removes members of a nested collection that shares the prefix, without notifying their subscribers', async () => {
            const nested = `${KEYS.COLLECTION.TEST_LEVEL}1`;
            await Onyx.multiSet({[nested]: {name: 'nested'}, [`${KEYS.COLLECTION.TEST}1`]: {name: 'parent'}});
            const nestedCollection = record(KEYS.COLLECTION.TEST_LEVEL);
            const nestedMember = record(nested);
            await settle();
            nestedCollection.reset();
            nestedMember.reset();

            await Onyx.setCollection(KEYS.COLLECTION.TEST, {[`${KEYS.COLLECTION.TEST}2`]: {name: 'parent 2'}});

            expect(OnyxCache.get(nested)).toBeUndefined();
            expect(storedWithPrefix(KEYS.COLLECTION.TEST_LEVEL)).toEqual({});
            expect(readCollection(KEYS.COLLECTION.TEST)).toEqual({[`${KEYS.COLLECTION.TEST}2`]: {name: 'parent 2'}});
            expect(nestedCollection.calls).toHaveLength(0);
            expect(nestedMember.calls).toHaveLength(0);
        });

        it('accepts a nested collection member in a parent collection call without notifying its subscribers', async () => {
            const nested = `${KEYS.COLLECTION.TEST_LEVEL}1`;
            const nestedMember = record(nested);
            const nestedCollection = record(KEYS.COLLECTION.TEST_LEVEL);
            await settle();
            nestedMember.reset();
            nestedCollection.reset();

            await Onyx.setCollection(KEYS.COLLECTION.TEST, {[nested]: {name: 'nested'}});

            expect(OnyxCache.get(nested)).toEqual({name: 'nested'});
            expect(storedWithPrefix(KEYS.COLLECTION.TEST_LEVEL)).toEqual({[nested]: {name: 'nested'}});
            expect(readCollection(KEYS.COLLECTION.TEST)).toEqual({});
            expect(nestedMember.calls).toHaveLength(0);
            expect(nestedCollection.calls).toHaveLength(0);
        });

        it('keeps the old value of a member whose new value is undefined instead of removing it', async () => {
            await seedRoutes();

            await Onyx.setCollection(ROUTES, {[A]: undefined, [D]: {name: 'D'}});

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A', tags: ['a']}, [D]: {name: 'D'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A', tags: ['a']}, [D]: {name: 'D'}});
        });

        it('drops a member set issued right after setCollection in the same tick', async () => {
            await seedRoutes();
            const memberD = record(D);
            await settle();
            memberD.reset();

            await Promise.all([Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}}), Onyx.set(D, {name: 'D'})]);

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}});
            expect(memberD.values()).toEqual([{name: 'D'}, undefined]);
        });

        it('merges onto the old stored value of a member removed by setCollection in the same tick', async () => {
            await seedRoutes();
            const memberB = record(B);
            await settle();
            memberB.reset();

            await Promise.all([Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}}), Onyx.merge(B, {extra: 1})]);
            await settle();

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}, [B]: {name: 'B', extra: 1}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}, [B]: {name: 'B', extra: 1}});
            expect(memberB.values()).toEqual([undefined, {name: 'B', extra: 1}]);
        });

        it('keeps a new member merged just before setCollection in the same tick', async () => {
            await seedRoutes();

            await Promise.all([Onyx.merge(D, {name: 'D'}), Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}})]);
            await settle();

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}, [D]: {name: 'D'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}, [D]: {name: 'D'}});
        });

        it('keeps a member re-written by a subscriber during its removal notification in the cache but deletes it from storage', async () => {
            await seedRoutes();
            let rewritten = false;
            const memberB = record(B, (value) => {
                if (value !== undefined || rewritten) {
                    return;
                }
                rewritten = true;
                Onyx.set(B, {name: 'B again'});
            });
            await settle();
            memberB.reset();

            await Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}});
            await settle();

            expect(rewritten).toBe(true);
            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}, [B]: {name: 'B again'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}});
            expect(memberB.values()).toEqual([undefined, {name: 'B again'}]);
        });

        it('silently overwrites a newer member write when a failed storage write is retried', async () => {
            await Onyx.setCollection(ROUTES, {[A]: {v: 0}});
            const memberA = record(A);
            await settle();
            memberA.reset();
            const pendingWrite = createDeferred();
            jest.mocked(StorageMock.multiSet).mockImplementationOnce(() => pendingWrite.promise);

            const write = Onyx.setCollection(ROUTES, {[A]: {v: 1}});
            await settle();
            await Onyx.set(A, {v: 2});
            pendingWrite.reject(new Error('unclassified failure'));
            await write;

            expect(memberA.values()).toEqual([{v: 1}, {v: 2}]);
            expect(OnyxCache.get(A)).toEqual({v: 1});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {v: 1}});
        });
    });
});
