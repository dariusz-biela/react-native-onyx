import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {expectOrderedSubsequenceOfStates} from '../connect/utils/deliveries';
import {KEYS} from '../connect/utils/freshOnyx';
import {NESTED_1, R1, R2, R3, REPORT, countFor, instanceSyncHandler, namesOf, startHarness, valuesFor} from './utils/harness';

describe('writes interleaved in one tick', () => {
    it('delivers each subscriber an in-order subsequence of the states synchronous writes went through, ending on the final one', async () => {
        const {Onyx, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {v: 0}}});
        connect('R1', R1);
        connect('R2', R2);
        connect('root', REPORT);
        connect('plain', KEYS.PLAIN);
        await settle();

        const writes = [
            Onyx.set(R1, {v: 1}),
            Onyx.set(KEYS.PLAIN, 'a'),
            Onyx.set(R2, {v: 2}),
            Onyx.multiSet({[R1]: {v: 1, w: 1}}),
            Onyx.multiSet({[R2]: {v: 3}, [KEYS.PLAIN]: 'b'}),
            Onyx.set(R1, null),
        ];
        await Promise.all(writes);
        await waitForPromisesToResolve();

        expectOrderedSubsequenceOfStates(valuesFor(log, 'R1'), [{v: 1}, {v: 1, w: 1}, undefined]);
        expectOrderedSubsequenceOfStates(valuesFor(log, 'R2'), [{v: 2}, {v: 3}]);
        expectOrderedSubsequenceOfStates(valuesFor(log, 'plain'), ['a', 'b']);
        expectOrderedSubsequenceOfStates(valuesFor(log, 'root'), [
            {[R1]: {v: 1}},
            {[R1]: {v: 1}, [R2]: {v: 2}},
            {[R1]: {v: 1, w: 1}, [R2]: {v: 2}},
            {[R1]: {v: 1, w: 1}, [R2]: {v: 3}},
            {[R2]: {v: 3}},
        ]);
        expect(countFor(log, 'root')).toBeLessThanOrEqual(5);
        expect(cache.getCollectionData(REPORT)).toEqual({[R2]: {v: 3}});
    });

    it('delivers each member of an Onyx.update once and the root at most twice, ending on the final state', async () => {
        const {Onyx, log, connect, settle} = await startHarness({storedValues: {[R1]: {v: 0}}});
        connect('R1', R1);
        connect('R2', R2);
        connect('R3', R3);
        connect('root', REPORT);
        connect('plain', KEYS.PLAIN);
        await settle();

        await Onyx.update([
            {onyxMethod: Onyx.METHOD.SET, key: KEYS.PLAIN, value: 'p'},
            {onyxMethod: Onyx.METHOD.MERGE, key: R1, value: {w: 1}},
            {onyxMethod: Onyx.METHOD.MERGE_COLLECTION, key: REPORT, value: {[R2]: {v: 2}}},
            {onyxMethod: Onyx.METHOD.SET, key: R3, value: {v: 3}},
        ]);
        await waitForPromisesToResolve();

        expect(valuesFor(log, 'plain')).toEqual(['p']);
        expect(valuesFor(log, 'R1')).toEqual([{v: 0, w: 1}]);
        expect(valuesFor(log, 'R2')).toEqual([{v: 2}]);
        expect(valuesFor(log, 'R3')).toEqual([{v: 3}]);
        expect(countFor(log, 'root')).toBeGreaterThanOrEqual(1);
        expect(countFor(log, 'root')).toBeLessThanOrEqual(2);
        expect(valuesFor(log, 'root').at(-1)).toEqual({[R1]: {v: 0, w: 1}, [R2]: {v: 2}, [R3]: {v: 3}});
    });
});

describe('batched collection writes', () => {
    it('notifies the root once and each written member once for a mergeCollection', async () => {
        const {Onyx, log, connect, settle} = await startHarness({storedValues: {[R1]: {v: 0}}});
        connect('R1', R1);
        connect('R2', R2);
        connect('R3', R3);
        connect('root', REPORT);
        await settle();

        await Onyx.mergeCollection(REPORT, {[R1]: {w: 1}, [R2]: {v: 2}, [R3]: {v: 3}});

        expect([...namesOf(log)].sort()).toEqual(['R1', 'R2', 'R3', 'root']);
        expect(valuesFor(log, 'root')).toEqual([{[R1]: {v: 0, w: 1}, [R2]: {v: 2}, [R3]: {v: 3}}]);
    });

    it('notifies each collection root once for a multiSet spanning two collections', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        connect('root', REPORT);
        connect('nested root', KEYS.COLLECTION.REPORT_NESTED);
        await settle();

        await Onyx.multiSet({[R1]: {v: 1}, [NESTED_1]: {v: 'n'}, [R2]: {v: 2}});

        expect(valuesFor(log, 'root')).toEqual([{[R1]: {v: 1}, [R2]: {v: 2}}]);
        expect(valuesFor(log, 'nested root')).toEqual([{[NESTED_1]: {v: 'n'}}]);
    });

    it('notifies the root once and the removed members with undefined when multiSet removes members', async () => {
        const {Onyx, log, connect, settle} = await startHarness({storedValues: {[R1]: {v: 1}, [R2]: {v: 2}}});
        connect('R1', R1);
        connect('R2', R2);
        connect('root', REPORT);
        await settle();

        await Onyx.multiSet({[R1]: null, [R2]: {v: 22}});

        expect(valuesFor(log, 'R1')).toEqual([undefined]);
        expect(valuesFor(log, 'R2')).toEqual([{v: 22}]);
        expect(valuesFor(log, 'root')).toEqual([{[R2]: {v: 22}}]);
    });
});

describe('instance sync batches', () => {
    it('notifies the root once for several synced members and each changed member with its synced value', async () => {
        const {cache, log, connect, settle} = await startHarness({shouldSyncMultipleInstances: true, storedValues: {[R1]: {v: 0}}});
        connect('R1', R1);
        connect('R2', R2);
        connect('root', REPORT);
        await settle();
        const onSync = instanceSyncHandler();

        onSync([
            [R1, {v: 1}],
            [R2, {v: 2}],
        ]);

        expect(valuesFor(log, 'R1')).toEqual([{v: 1}]);
        expect(valuesFor(log, 'R2')).toEqual([{v: 2}]);
        expect(valuesFor(log, 'root')).toEqual([{[R1]: {v: 1}, [R2]: {v: 2}}]);
        expect(cache.get(R1)).toEqual({v: 1});
    });

    it('does not notify a member whose synced value is the reference already cached', async () => {
        const {cache, log, connect, settle} = await startHarness({shouldSyncMultipleInstances: true, storedValues: {[R1]: {v: 1}}});
        connect('R1', R1);
        connect('R2', R2);
        await settle();
        const onSync = instanceSyncHandler();

        onSync([
            [R1, cache.get(R1)],
            [R2, {v: 2}],
        ]);

        expect(namesOf(log)).toEqual(['R2']);
    });

    it('compares a member synced twice in one batch against its value from before the batch', async () => {
        const {cache, log, connect, settle} = await startHarness({shouldSyncMultipleInstances: true, storedValues: {[R1]: {v: 1}, [R2]: {v: 2}}});
        connect('R1', R1);
        connect('R2', R2);
        await settle();
        const onSync = instanceSyncHandler();
        const originalR1 = cache.get(R1);

        onSync([
            [R1, {v: 'intermediate'}],
            [R2, {v: 'intermediate'}],
            [R1, originalR1],
            [R2, {v: 22}],
        ]);

        expect(valuesFor(log, 'R1')).toEqual([]);
        expect(valuesFor(log, 'R2')).toEqual([{v: 22}]);
    });
});
