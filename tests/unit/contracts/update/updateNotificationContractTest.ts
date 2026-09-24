import Onyx from '../../../../lib';
import {
    DEFAULT_VALUE,
    ONYX_KEYS,
    StorageMock,
    initOnyx,
    readCache,
    readKeysThroughConnections,
    readStorage,
    recordCollectionAfterInitial,
    recordConnectionAfterInitial,
    resetOnyx,
    seedColdKey,
    track,
    waitForPromisesToResolve,
} from './harness';

const TEST = ONYX_KEYS.TEST_KEY;
const OTHER = ONYX_KEYS.OTHER_KEY;
const {A, B} = ONYX_KEYS.COLLECTION;
const WITH_DEFAULT = {[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE};
const STORAGE_WRITES = [StorageMock.setItem, StorageMock.multiSet, StorageMock.mergeItem, StorageMock.multiMerge, StorageMock.removeItem, StorageMock.removeItems];

function countStorageWrites(): number {
    return STORAGE_WRITES.reduce((total, write) => total + write.mock.calls.length, 0);
}

function member(index: number): string {
    return `${A}${index}`;
}

describe('Onyx.update grouping of collection members', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);

    it('delivers grouped member merges to a collection subscriber in one notification with the final values', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}, [member(3)]: {a: 1}});
        const collection = await recordCollectionAfterInitial(A);

        await Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: {a: 2}},
            {onyxMethod: 'merge', key: member(2), value: {a: 3}},
            {onyxMethod: 'mergecollection', key: A, value: {[member(1)]: {b: 1}, [member(4)]: {c: 1}}},
        ]);

        expect(collection.calls).toHaveLength(1);
        expect(collection.last()).toEqual({[member(1)]: {a: 2, b: 1}, [member(2)]: {a: 3}, [member(3)]: {a: 1}, [member(4)]: {c: 1}});
    });

    it('delivers grouped member sets to a collection subscriber in at most one notification', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}});
        const collection = await recordCollectionAfterInitial(A);

        await Onyx.update([
            {onyxMethod: 'set', key: member(1), value: {z: 1}},
            {onyxMethod: 'multiset', key: '', value: {[member(2)]: {y: 1}, [member(3)]: {x: 1}}},
            {onyxMethod: 'merge', key: member(1), value: {w: 1}},
        ]);

        expect(collection.calls.length).toBeLessThanOrEqual(1);
        expect(collection.last()).toEqual({[member(1)]: {z: 1, w: 1}, [member(2)]: {y: 1}, [member(3)]: {x: 1}});
    });

    it('delivers a group of sets and merges in at most two collection notifications ending with the final values', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}});
        const collection = await recordCollectionAfterInitial(A);

        await Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: {b: 1}},
            {onyxMethod: 'set', key: member(2), value: {c: 1}},
            {onyxMethod: 'merge', key: member(3), value: null},
            {onyxMethod: 'merge', key: member(4), value: {d: 1}},
        ]);

        expect(collection.calls.length).toBeGreaterThanOrEqual(1);
        expect(collection.calls.length).toBeLessThanOrEqual(2);
        expect(collection.last()).toEqual({[member(1)]: {a: 1, b: 1}, [member(2)]: {c: 1}, [member(4)]: {d: 1}});
    });

    it('persists many grouped member writes with fewer storage writes than members', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}, [member(3)]: {a: 1}});
        jest.clearAllMocks();

        await Onyx.update([1, 2, 3, 4, 5].map((index) => ({onyxMethod: 'merge' as const, key: member(index), value: {b: index}})));

        expect(countStorageWrites()).toBeLessThanOrEqual(2);
        expect(readStorage()).toEqual({
            ...WITH_DEFAULT,
            [member(1)]: {a: 1, b: 1},
            [member(2)]: {a: 1, b: 2},
            [member(3)]: {a: 1, b: 3},
            [member(4)]: {b: 4},
            [member(5)]: {b: 5},
        });
    });

    it('delivers each grouped member its final value once and leaves untouched members silent', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}, [member(3)]: {a: 1}});
        const first = await recordConnectionAfterInitial(member(1));
        const second = await recordConnectionAfterInitial(member(2));
        const untouched = await recordConnectionAfterInitial(member(3));
        const otherCollection = await recordCollectionAfterInitial(B);

        await Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: {a: 2}},
            {onyxMethod: 'merge', key: member(2), value: {a: 3}},
            {onyxMethod: 'merge', key: member(1), value: {b: 1}},
        ]);

        expect(first.calls).toEqual([{a: 2, b: 1}]);
        expect(second.calls).toEqual([{a: 3}]);
        expect(untouched.calls).toEqual([]);
        expect(otherCollection.calls).toEqual([]);
    });

    it('keeps the reference of untouched members stable in collection deliveries', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}, [member(3)]: {a: 1}});
        const deliveries: unknown[] = [];
        track(Onyx.connectWithoutView({key: A, callback: (value) => deliveries.push(value)}));
        await waitForPromisesToResolve();
        const before = deliveries.at(-1);

        await Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: {a: 2}},
            {onyxMethod: 'merge', key: member(2), value: {a: 3}},
        ]);

        const after = deliveries.at(-1);
        expect(after).not.toBe(before);
        expect(Reflect.get(Object(after), member(3))).toBe(Reflect.get(Object(before), member(3)));
    });

    it('sends nothing to member subscribers when grouped merges change nothing', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}});
        const first = await recordConnectionAfterInitial(member(1));
        const second = await recordConnectionAfterInitial(member(2));
        const collection = await recordCollectionAfterInitial(A);

        await Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: {a: 1}},
            {onyxMethod: 'merge', key: member(2), value: {a: 1}},
        ]);

        expect(first.calls).toEqual([]);
        expect(second.calls).toEqual([]);
        expect(collection.calls.length).toBeLessThanOrEqual(1);
        for (const value of collection.calls) {
            expect(value).toEqual({[member(1)]: {a: 1}, [member(2)]: {a: 1}});
        }
    });

    it('sends member subscribers at most one unchanged value when grouped sets repeat the stored values', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}});
        const first = await recordConnectionAfterInitial(member(1));

        await Onyx.update([
            {onyxMethod: 'set', key: member(1), value: {a: 1}},
            {onyxMethod: 'set', key: member(2), value: {a: 1}},
        ]);

        expect(first.calls.length).toBeLessThanOrEqual(1);
        for (const value of first.calls) {
            expect(value).toEqual({a: 1});
        }
    });

    it('removes grouped members merged with null and tells their subscribers', async () => {
        await Onyx.multiSet({[member(1)]: {a: 1}, [member(2)]: {a: 1}, [member(3)]: {a: 1}});
        const first = await recordConnectionAfterInitial(member(1));
        const collection = await recordCollectionAfterInitial(A);

        await Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: null},
            {onyxMethod: 'set', key: member(2), value: null},
        ]);

        expect(first.calls.length).toBeGreaterThanOrEqual(1);
        expect(first.calls.at(-1) ?? undefined).toBeUndefined();
        expect(collection.last()).toEqual({[member(3)]: {a: 1}});
        expect(readCache()).toEqual({...WITH_DEFAULT, [member(3)]: {a: 1}});
        expect(readStorage()).toEqual({...WITH_DEFAULT, [member(3)]: {a: 1}});
    });

    it('merges grouped changes onto evicted members read back from storage', async () => {
        seedColdKey(member(1), {a: 1, keep: 1});
        seedColdKey(member(2), {a: 1, keep: 2});

        await Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: {a: 2}},
            {onyxMethod: 'merge', key: member(2), value: {a: 3}},
            {onyxMethod: 'merge', key: member(1), value: {b: 1}},
        ]);

        const expected = {[member(1)]: {a: 2, keep: 1, b: 1}, [member(2)]: {a: 3, keep: 2}};
        expect(await readKeysThroughConnections([member(1), member(2)])).toEqual(expected);
        expect(readStorage()).toEqual({...WITH_DEFAULT, ...expected});
    });

    it('replaces evicted members that a grouped set writes', async () => {
        seedColdKey(member(1), {a: 1, stale: 1});
        seedColdKey(member(2), {a: 1, stale: 2});

        await Onyx.update([
            {onyxMethod: 'set', key: member(1), value: {fresh: 1}},
            {onyxMethod: 'set', key: member(2), value: {fresh: 2}},
            {onyxMethod: 'merge', key: member(2), value: {more: 2}},
        ]);

        const expected = {[member(1)]: {fresh: 1}, [member(2)]: {fresh: 2, more: 2}};
        expect(await readKeysThroughConnections([member(1), member(2)])).toEqual(expected);
        expect(readStorage()).toEqual({...WITH_DEFAULT, ...expected});
    });
});

describe('Onyx.update notifications', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);

    it('notifies a plain key subscriber at least once when its value changes and ends on the final value', async () => {
        await Onyx.set(TEST, {a: 1});
        const subscriber = await recordConnectionAfterInitial(TEST);

        await Onyx.update([
            {onyxMethod: 'merge', key: TEST, value: {b: 1}},
            {onyxMethod: 'merge', key: TEST, value: {c: 1}},
        ]);

        expect(subscriber.calls.length).toBeGreaterThanOrEqual(1);
        expect(subscriber.calls.length).toBeLessThanOrEqual(2);
        expect(subscriber.last()).toEqual({a: 1, b: 1, c: 1});
    });

    it('does not notify a plain key subscriber when the batch leaves the value unchanged', async () => {
        await Onyx.set(TEST, {a: 1});
        await Onyx.set(OTHER, {b: 1});
        const test = await recordConnectionAfterInitial(TEST);
        const other = await recordConnectionAfterInitial(OTHER);

        await Onyx.update([
            {onyxMethod: 'merge', key: TEST, value: {a: 1}},
            {onyxMethod: 'set', key: OTHER, value: {b: 1}},
        ]);

        expect(test.calls).toEqual([]);
        expect(other.calls).toEqual([]);
    });

    it('does not notify subscribers of keys the batch does not touch', async () => {
        await Onyx.multiSet({[TEST]: {a: 1}, [OTHER]: {b: 1}, [`${B}1`]: {c: 1}});
        const other = await recordConnectionAfterInitial(OTHER);
        const bMember = await recordConnectionAfterInitial(`${B}1`);

        await Onyx.update([
            {onyxMethod: 'merge', key: TEST, value: {a: 2}},
            {onyxMethod: 'merge', key: member(1), value: {x: 1}},
            {onyxMethod: 'merge', key: member(2), value: {x: 2}},
        ]);

        expect(other.calls).toEqual([]);
        expect(bMember.calls).toEqual([]);
    });

    it('has delivered the final values to subscribers by the time the returned promise resolves', async () => {
        const test = await recordConnectionAfterInitial(TEST);
        const first = await recordConnectionAfterInitial(member(1));
        const collection = await recordCollectionAfterInitial(A);

        await Onyx.update([
            {onyxMethod: 'set', key: TEST, value: {a: 1}},
            {onyxMethod: 'merge', key: member(1), value: {b: 1}},
            {onyxMethod: 'merge', key: member(2), value: {b: 2}},
        ]);

        expect(test.last()).toEqual({a: 1});
        expect(first.last()).toEqual({b: 1});
        expect(collection.last()).toEqual({[member(1)]: {b: 1}, [member(2)]: {b: 2}});
    });

    it('applies update calls issued in the same tick in call order', async () => {
        await Onyx.set(TEST, {a: 0});
        const subscriber = await recordConnectionAfterInitial(TEST);

        const first = Onyx.update([{onyxMethod: 'merge', key: TEST, value: {a: 1, b: 1}}]);
        const second = Onyx.update([{onyxMethod: 'merge', key: TEST, value: {a: 2}}]);
        const third = Onyx.update([{onyxMethod: 'merge', key: TEST, value: {c: 1}}]);
        await Promise.all([first, second, third]);

        expect(readCache()[TEST]).toEqual({a: 2, b: 1, c: 1});
        expect(readStorage()[TEST]).toEqual({a: 2, b: 1, c: 1});
        const allowed = [
            {a: 1, b: 1},
            {a: 2, b: 1},
            {a: 2, b: 1, c: 1},
        ];
        let cursor = 0;
        for (const value of subscriber.calls) {
            const index = allowed.findIndex((candidate, candidateIndex) => candidateIndex >= cursor && JSON.stringify(candidate) === JSON.stringify(value));
            expect(index).toBeGreaterThanOrEqual(cursor);
            cursor = index;
        }
        expect(subscriber.last()).toEqual({a: 2, b: 1, c: 1});
    });

    it('applies interleaved grouped updates of the same members in call order', async () => {
        await Onyx.multiSet({[member(1)]: {a: 0}, [member(2)]: {a: 0}});
        const collection = await recordCollectionAfterInitial(A);

        const first = Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: {a: 1}},
            {onyxMethod: 'merge', key: member(2), value: {a: 1}},
        ]);
        const second = Onyx.update([
            {onyxMethod: 'merge', key: member(1), value: {a: 2, b: 2}},
            {onyxMethod: 'merge', key: member(2), value: {c: 2}},
        ]);
        await Promise.all([first, second]);

        const expected = {[member(1)]: {a: 2, b: 2}, [member(2)]: {a: 1, c: 2}};
        expect(collection.last()).toEqual(expected);
        expect(readStorage()).toEqual({...WITH_DEFAULT, ...expected});
    });

    it('applies an update and single-key writes issued in the same tick in call order', async () => {
        await Onyx.set(TEST, {a: 0});

        const writes = [
            Onyx.merge(TEST, {a: 1}),
            Onyx.update([
                {onyxMethod: 'merge', key: TEST, value: {b: 1}},
                {onyxMethod: 'merge', key: member(1), value: {x: 1}},
                {onyxMethod: 'merge', key: member(2), value: {x: 2}},
            ]),
            Onyx.merge(TEST, {c: 1}),
            Onyx.merge(member(1), {y: 1}),
        ];
        await Promise.all(writes);

        const expected = {[TEST]: {a: 1, b: 1, c: 1}, [member(1)]: {x: 1, y: 1}, [member(2)]: {x: 2}};
        expect(readCache()).toEqual({...WITH_DEFAULT, ...expected});
        expect(readStorage()).toEqual({...WITH_DEFAULT, ...expected});
    });

    it('applies writes issued by a subscriber while the batch is being delivered', async () => {
        await Onyx.multiSet({[TEST]: {a: 0}, [member(1)]: {a: 0}});
        let reacted = false;
        track(
            Onyx.connectWithoutView({
                key: TEST,
                callback: (value) => {
                    if (reacted || JSON.stringify(value) !== JSON.stringify({a: 1})) {
                        return;
                    }
                    reacted = true;
                    Onyx.update([
                        {onyxMethod: 'merge', key: TEST, value: {fromSubscriber: true}},
                        {onyxMethod: 'merge', key: OTHER, value: {fromSubscriber: true}},
                    ]);
                },
            }),
        );
        const collectionSubscriberWrites: Array<Promise<void>> = [];
        track(
            Onyx.connectWithoutView({
                key: A,
                callback: (value) => {
                    const collection = Object(value);
                    if (Reflect.get(collection, member(1))?.a === 1 && !Reflect.has(collection, member(3))) {
                        collectionSubscriberWrites.push(Onyx.merge(member(3), {fromSubscriber: true}));
                    }
                },
            }),
        );
        await waitForPromisesToResolve();

        await Onyx.update([
            {onyxMethod: 'merge', key: TEST, value: {a: 1}},
            {onyxMethod: 'merge', key: member(1), value: {a: 1}},
            {onyxMethod: 'merge', key: member(2), value: {a: 1}},
        ]);
        await Promise.all(collectionSubscriberWrites);
        await waitForPromisesToResolve();

        const expected = {
            [TEST]: {a: 1, fromSubscriber: true},
            [OTHER]: {fromSubscriber: true},
            [member(1)]: {a: 1},
            [member(2)]: {a: 1},
            [member(3)]: {fromSubscriber: true},
        };
        expect(readCache()).toEqual({...WITH_DEFAULT, ...expected});
        expect(readStorage()).toEqual({...WITH_DEFAULT, ...expected});
    });
});
