import type GenericCollection from '../../../utils/GenericCollection';

import Onyx from '../../../../lib';
import OnyxCache from '../../../../lib/OnyxCache';
import OnyxUtils from '../../../../lib/OnyxUtils';
import {KEYS, SKIPPABLE_ID, StorageMock, toRecord, createDeferred, initOnyx, readCollection, record, resetOnyx, settle, storedWithPrefix} from './helpers';

const ROUTES = KEYS.COLLECTION.ROUTES;
const A = `${ROUTES}A`;
const B = `${ROUTES}B`;
const C = `${ROUTES}C`;
const D = `${ROUTES}D`;

const SEED = {[A]: {name: 'A', tags: ['a']}, [B]: {name: 'B'}, [C]: {name: 'C'}};

function partialSet(collection: GenericCollection, collectionKey: string = ROUTES): Promise<void> {
    return OnyxUtils.partialSetCollection({collectionKey, collection});
}

describe('OnyxUtils.partialSetCollection contract', () => {
    beforeAll(initOnyx);
    beforeEach(async () => {
        await resetOnyx();
        await Onyx.multiSet(SEED);
    });
    afterAll(resetOnyx);

    describe('replacement semantics', () => {
        it('replaces the targeted members, adds new ones and keeps every untargeted member', async () => {
            await partialSet({[A]: {other: true}, [D]: {name: 'D'}});

            const expected = {[A]: {other: true}, [B]: {name: 'B'}, [C]: {name: 'C'}, [D]: {name: 'D'}};
            expect(readCollection(ROUTES)).toEqual(expected);
            expect(storedWithPrefix(ROUTES)).toEqual(expected);
            expect((await OnyxUtils.getAllKeys()).has(D)).toBe(true);
        });

        it('keeps untargeted members that exist only in storage', async () => {
            await resetOnyx();
            StorageMock.setMockStore({[B]: {name: 'stored B'}});

            await partialSet({[A]: {name: 'A'}});

            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A'}, [B]: {name: 'stored B'}});
        });

        it('removes a member set to null and ignores null for a member that does not exist', async () => {
            const memberD = record(D);
            await settle();
            memberD.reset();

            await partialSet({[A]: null, [D]: null});

            expect(readCollection(ROUTES)).toEqual({[B]: {name: 'B'}, [C]: {name: 'C'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[B]: {name: 'B'}, [C]: {name: 'C'}});
            expect(OnyxCache.hasCacheForKey(A)).toBe(false);
            expect(memberD.calls).toHaveLength(0);
        });

        it('changes nothing for an empty collection', async () => {
            const memberA = record(A);
            await settle();
            memberA.reset();

            await partialSet({});

            expect(readCollection(ROUTES)).toEqual(SEED);
            expect(storedWithPrefix(ROUTES)).toEqual(SEED);
            expect(memberA.calls).toHaveLength(0);
        });

        it('strips nested nulls and does not mutate its input', async () => {
            const member = {keep: 1, gone: null, nested: {gone: null, keep: 2}};
            const input = {[A]: member};

            await partialSet(input);

            expect(OnyxCache.get(A)).toEqual({keep: 1, nested: {keep: 2}});
            expect(storedWithPrefix(ROUTES)[A]).toEqual({keep: 1, nested: {keep: 2}});
            expect(input).toEqual({[A]: {keep: 1, gone: null, nested: {gone: null, keep: 2}}});
        });

        it('leaves lookalike and other collections untouched', async () => {
            const archive = `${KEYS.COLLECTION.ROUTES_ARCHIVE}A`;
            await Onyx.set(archive, {name: 'archived'});

            await partialSet({[A]: null, [B]: null, [C]: null});

            expect(OnyxCache.get(archive)).toEqual({name: 'archived'});
            expect(storedWithPrefix(KEYS.COLLECTION.ROUTES_ARCHIVE)).toEqual({[archive]: {name: 'archived'}});
        });

        it('rejects the whole call when any key does not belong to the collection', async () => {
            const collection = record(ROUTES);
            await settle();
            collection.reset();

            await expect(partialSet({[A]: {name: 'A2'}, [`${KEYS.COLLECTION.OTHER}A`]: {name: 'wrong'}})).resolves.toBeUndefined();

            expect(collection.calls).toHaveLength(0);
            expect(readCollection(ROUTES)).toEqual(SEED);
            expect(storedWithPrefix(KEYS.COLLECTION.OTHER)).toEqual({});
        });

        it('turns a skippable member into a removal', async () => {
            const skippable = `${ROUTES}${SKIPPABLE_ID}`;
            await resetOnyx();
            StorageMock.setMockStore({...SEED, [skippable]: {name: 'persisted'}});

            await partialSet({[skippable]: {name: 'skip me'}, [A]: {name: 'A2'}});

            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}, [B]: {name: 'B'}, [C]: {name: 'C'}});
            expect(OnyxCache.get(skippable)).toBeUndefined();
        });

        it('updates a RAM-only collection without touching storage', async () => {
            const ram1 = `${KEYS.COLLECTION.RAM_ONLY}1`;
            const ram2 = `${KEYS.COLLECTION.RAM_ONLY}2`;
            await Onyx.setCollection(KEYS.COLLECTION.RAM_ONLY, {[ram1]: 'one'});

            await partialSet({[ram2]: 'two'}, KEYS.COLLECTION.RAM_ONLY);

            expect(readCollection(KEYS.COLLECTION.RAM_ONLY)).toEqual({[ram1]: 'one', [ram2]: 'two'});
            expect(storedWithPrefix(KEYS.COLLECTION.RAM_ONLY)).toEqual({});
        });
    });

    describe('subscriber notifications', () => {
        it('notifies only targeted members, each once with its new value or undefined', async () => {
            const memberA = record(A);
            const memberB = record(B);
            const memberC = record(C);
            const memberD = record(D);
            await settle();
            for (const recorder of [memberA, memberB, memberC, memberD]) {
                recorder.reset();
            }

            await partialSet({[A]: {name: 'A2'}, [B]: null, [D]: {name: 'D'}});

            expect(memberA.calls).toEqual([{value: {name: 'A2'}, key: A}]);
            expect(memberB.calls).toEqual([{value: undefined, key: B}]);
            expect(memberD.calls).toEqual([{value: {name: 'D'}, key: D}]);
            expect(memberC.calls).toHaveLength(0);
        });

        it('does not notify a member passed back by the same reference', async () => {
            const valueA = OnyxCache.get(A);
            const memberA = record(A);
            await settle();
            memberA.reset();

            await partialSet({[A]: valueA, [B]: {name: 'B2'}});

            expect(memberA.calls).toHaveLength(0);
        });

        it('delivers the full collection to collection subscribers at most once and keeps untouched member references', async () => {
            const collection = record(ROUTES);
            await settle();
            const before = toRecord(collection.last());
            collection.reset();

            await partialSet({[A]: {name: 'A2'}, [D]: {name: 'D'}});

            expect(collection.calls.length).toBeGreaterThanOrEqual(1);
            expect(collection.calls.length).toBeLessThanOrEqual(1);
            const after = toRecord(collection.last());
            expect(after).toEqual({[A]: {name: 'A2'}, [B]: {name: 'B'}, [C]: {name: 'C'}, [D]: {name: 'D'}});
            expect(after[B]).toBe(before[B]);
            expect(after[C]).toBe(before[C]);
        });

        it('shows the whole update in the cache to every subscriber while it is notified', async () => {
            const seen: unknown[] = [];
            const snapshot = () => ({a: OnyxCache.get(A), b: OnyxCache.get(B), d: OnyxCache.get(D)});
            record(A, () => seen.push(snapshot()));
            record(B, () => seen.push(snapshot()));
            record(ROUTES, () => seen.push(snapshot()));
            await settle();
            seen.length = 0;

            await partialSet({[A]: {name: 'A2'}, [B]: null, [D]: {name: 'D'}});

            expect(seen.length).toBeGreaterThanOrEqual(2);
            for (const view of seen) {
                expect(view).toEqual({a: {name: 'A2'}, b: undefined, d: {name: 'D'}});
            }
        });
    });

    describe('Onyx.update grouping', () => {
        it('applies several member sets of one collection as replacements and keeps the rest', async () => {
            const memberC = record(C);
            await settle();
            memberC.reset();

            await Onyx.update([
                {onyxMethod: Onyx.METHOD.SET, key: A, value: {other: true}},
                {onyxMethod: Onyx.METHOD.SET, key: B, value: null},
                {onyxMethod: Onyx.METHOD.SET, key: D, value: {name: 'D'}},
            ]);

            const expected = {[A]: {other: true}, [C]: {name: 'C'}, [D]: {name: 'D'}};
            expect(readCollection(ROUTES)).toEqual(expected);
            expect(storedWithPrefix(ROUTES)).toEqual(expected);
            expect(memberC.calls).toHaveLength(0);
        });

        it('notifies collection subscribers at most once for a grouped update', async () => {
            const collection = record(ROUTES);
            await settle();
            collection.reset();

            await Onyx.update([
                {onyxMethod: Onyx.METHOD.SET, key: A, value: {name: 'A2'}},
                {onyxMethod: Onyx.METHOD.SET, key: B, value: null},
                {onyxMethod: Onyx.METHOD.SET, key: D, value: {name: 'D'}},
            ]);

            expect(collection.calls.length).toBeGreaterThanOrEqual(1);
            expect(collection.calls.length).toBeLessThanOrEqual(1);
            expect(collection.last()).toEqual({[A]: {name: 'A2'}, [C]: {name: 'C'}, [D]: {name: 'D'}});
        });

        it('applies a merge queued after a set of the same member on top of the new value only', async () => {
            await Onyx.update([
                {onyxMethod: Onyx.METHOD.SET, key: A, value: {name: 'A2'}},
                {onyxMethod: Onyx.METHOD.MERGE, key: A, value: {extra: 1}},
                {onyxMethod: Onyx.METHOD.SET, key: B, value: {name: 'B2'}},
            ]);

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2', extra: 1}, [B]: {name: 'B2'}, [C]: {name: 'C'}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2', extra: 1}, [B]: {name: 'B2'}, [C]: {name: 'C'}});
        });

        it('handles sets and merges of different members in one update', async () => {
            await Onyx.update([
                {onyxMethod: Onyx.METHOD.SET, key: A, value: {name: 'A2'}},
                {onyxMethod: Onyx.METHOD.MERGE, key: B, value: {extra: 1}},
                {onyxMethod: Onyx.METHOD.MERGE, key: C, value: null},
            ]);

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}, [B]: {name: 'B', extra: 1}});
            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}, [B]: {name: 'B', extra: 1}});
        });

        it('replaces members through MULTI_SET in an update', async () => {
            await Onyx.update([{onyxMethod: Onyx.METHOD.MULTI_SET, key: '', value: {[A]: {other: true}, [B]: {name: 'B2'}}}]);

            expect(readCollection(ROUTES)).toEqual({[A]: {other: true}, [B]: {name: 'B2'}, [C]: {name: 'C'}});
        });
    });

    describe('storage failures', () => {
        it('retries a failed write until storage holds the update without notifying members again', async () => {
            const memberA = record(A);
            const collection = record(ROUTES);
            await settle();
            memberA.reset();
            collection.reset();
            jest.mocked(StorageMock.multiSet).mockImplementationOnce(() => Promise.reject(new Error('unclassified failure')));

            await partialSet({[A]: {name: 'A2'}, [B]: null});

            expect(storedWithPrefix(ROUTES)).toEqual({[A]: {name: 'A2'}, [C]: {name: 'C'}});
            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A2'}, [C]: {name: 'C'}});
            expect(memberA.values()).toEqual([{name: 'A2'}]);
            expect(collection.calls.length).toBeLessThanOrEqual(1);
        });

        it('keeps the cache on the update when removing members from storage fails', async () => {
            jest.mocked(StorageMock.removeItems).mockImplementationOnce(() => Promise.reject(new Error('removal failed')));

            await expect(partialSet({[B]: null})).resolves.toBeUndefined();

            expect(readCollection(ROUTES)).toEqual({[A]: {name: 'A', tags: ['a']}, [C]: {name: 'C'}});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('silently overwrites a newer member write when a failed storage write is retried', async () => {
            const memberA = record(A);
            await settle();
            memberA.reset();
            const pendingWrite = createDeferred();
            jest.mocked(StorageMock.multiSet).mockImplementationOnce(() => pendingWrite.promise);

            const write = partialSet({[A]: {v: 1}});
            await settle();
            await Onyx.set(A, {v: 2});
            pendingWrite.reject(new Error('unclassified failure'));
            await write;

            expect(memberA.values()).toEqual([{v: 1}, {v: 2}]);
            expect(OnyxCache.get(A)).toEqual({v: 1});
            expect(storedWithPrefix(ROUTES)[A]).toEqual({v: 1});
        });
    });
});
