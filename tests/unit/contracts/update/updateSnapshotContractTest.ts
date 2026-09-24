import type {State, Update} from './harness';

import Onyx from '../../../../lib';
import {ONYX_KEYS, initOnyx, readCache, readStorage, recordConnectionAfterInitial, resetOnyx} from './harness';

const TEST = ONYX_KEYS.TEST_KEY;
const OTHER = ONYX_KEYS.OTHER_KEY;
const {A, SNAPSHOT} = ONYX_KEYS.COLLECTION;
const SNAPSHOT_1 = `${SNAPSHOT}1`;
const SNAPSHOT_2 = `${SNAPSHOT}2`;

type SnapshotCase = {
    name: string;
    data: State;
    snapshot: State;
    batch: Update[];
    expectedSnapshot: State;
};

const SNAPSHOT_CASES: SnapshotCase[] = [
    {
        name: 'a merge updates the fields the snapshot already holds',
        data: {[TEST]: {a: 1, b: 1}},
        snapshot: {[TEST]: {a: 1}},
        batch: [{onyxMethod: 'merge', key: TEST, value: {a: 2, b: 2, c: 2}}],
        expectedSnapshot: {[TEST]: {a: 2}},
    },
    {
        name: 'a set updates the held fields and keeps the others',
        data: {[TEST]: {a: 1, b: 1}},
        snapshot: {[TEST]: {a: 1, b: 1}},
        batch: [{onyxMethod: 'set', key: TEST, value: {a: 2}}],
        expectedSnapshot: {[TEST]: {a: 2, b: 1}},
    },
    {
        name: 'merges on the same key accumulate',
        data: {[TEST]: {a: 1, b: 1}},
        snapshot: {[TEST]: {a: 1, b: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {a: 2}},
            {onyxMethod: 'merge', key: TEST, value: {b: 2, c: 3}},
        ],
        expectedSnapshot: {[TEST]: {a: 2, b: 2}},
    },
    {
        name: 'a nested merge is deep merged into the held value',
        data: {[TEST]: {a: {x: 1, y: 1}}},
        snapshot: {[TEST]: {a: {x: 1, y: 1}}},
        batch: [{onyxMethod: 'merge', key: TEST, value: {a: {x: 2}}}],
        expectedSnapshot: {[TEST]: {a: {x: 2, y: 1}}},
    },
    {
        name: 'the configured snapshot merge keys are always copied',
        data: {[TEST]: {a: 1}},
        snapshot: {[TEST]: {a: 1}},
        batch: [{onyxMethod: 'merge', key: TEST, value: {pendingAction: 'add', z: 1}}],
        expectedSnapshot: {[TEST]: {a: 1, pendingAction: 'add'}},
    },
    {
        name: 'a null write removes the entry',
        data: {[TEST]: {a: 1}, [OTHER]: {a: 1}},
        snapshot: {[TEST]: {a: 1}, [OTHER]: {a: 1}},
        batch: [{onyxMethod: 'merge', key: TEST, value: null}],
        expectedSnapshot: {[OTHER]: {a: 1}},
    },
    {
        name: 'a null write followed by a merge keeps only the merge',
        data: {[TEST]: {a: 1}},
        snapshot: {[TEST]: {a: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: null},
            {onyxMethod: 'merge', key: TEST, value: {a: 3}},
        ],
        expectedSnapshot: {[TEST]: {a: 3}},
    },
    {
        name: 'arrays are replaced',
        data: {[TEST]: [1]},
        snapshot: {[TEST]: [1]},
        batch: [{onyxMethod: 'set', key: TEST, value: [2, 3]}],
        expectedSnapshot: {[TEST]: [2, 3]},
    },
    {
        name: 'keys the snapshot does not hold are left out',
        data: {[TEST]: {a: 1}},
        snapshot: {[OTHER]: {a: 1}},
        batch: [{onyxMethod: 'merge', key: TEST, value: {a: 2}}],
        expectedSnapshot: {[OTHER]: {a: 1}},
    },
    {
        name: 'writes to another snapshot key are not copied into this snapshot',
        data: {[SNAPSHOT_2]: {data: {[TEST]: {a: 1}}}},
        snapshot: {[SNAPSHOT_2]: {data: {[TEST]: {a: 1}}}},
        batch: [{onyxMethod: 'merge', key: SNAPSHOT_2, value: {data: {[TEST]: {a: 2}}}}],
        expectedSnapshot: {[SNAPSHOT_2]: {data: {[TEST]: {a: 1}}}},
    },
    {
        name: 'keyless multiset entries update every held key',
        data: {[TEST]: {a: 1}, [OTHER]: {b: 1}},
        snapshot: {[TEST]: {a: 1}, [OTHER]: {b: 1}},
        // @ts-expect-error untyped callers send multiset entries without a key
        batch: [{onyxMethod: 'multiset', value: {[TEST]: {a: 2}, [OTHER]: {b: 2}}}],
        expectedSnapshot: {[TEST]: {a: 2}, [OTHER]: {b: 2}},
    },
    {
        name: 'grouped member merges update every held member',
        data: {[`${A}1`]: {a: 1}, [`${A}2`]: {a: 1}},
        snapshot: {[`${A}1`]: {a: 1}, [`${A}2`]: {a: 1}},
        batch: [
            {onyxMethod: 'merge', key: `${A}1`, value: {a: 2}},
            {onyxMethod: 'merge', key: `${A}2`, value: {a: 3}},
        ],
        expectedSnapshot: {[`${A}1`]: {a: 2}, [`${A}2`]: {a: 3}},
    },
    {
        name: 'invalid entries are skipped without dropping the valid ones',
        data: {[TEST]: {a: 1}},
        snapshot: {[TEST]: {a: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {a: 2}},
            // @ts-expect-error a non-string key is invalid input
            {onyxMethod: 'merge', key: 5, value: {a: 3}},
        ],
        expectedSnapshot: {[TEST]: {a: 2}},
    },
];

async function seed(data: State, snapshots: State): Promise<void> {
    await Onyx.multiSet({...data, ...snapshots});
}

describe('Onyx.update keeps cached snapshots in sync', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);

    it.each(SNAPSHOT_CASES)('$name', async ({data, snapshot, batch, expectedSnapshot}) => {
        await seed(data, {[SNAPSHOT_1]: {data: snapshot}});

        await Onyx.update(batch);

        expect(readCache()[SNAPSHOT_1]).toEqual({data: expectedSnapshot});
        expect(readStorage()[SNAPSHOT_1]).toEqual({data: expectedSnapshot});
    });

    it('updates each snapshot with its own shape', async () => {
        await seed({[TEST]: {a: 1}}, {[SNAPSHOT_1]: {data: {[TEST]: {a: 1}}}, [SNAPSHOT_2]: {data: {[TEST]: {a: 1, b: 1}}}});

        await Onyx.update([{onyxMethod: 'merge', key: TEST, value: {a: 2, b: 2}}]);

        expect(readCache()[SNAPSHOT_1]).toEqual({data: {[TEST]: {a: 2}}});
        expect(readCache()[SNAPSHOT_2]).toEqual({data: {[TEST]: {a: 2, b: 2}}});
    });

    it('does not write a snapshot when no held key changes', async () => {
        await seed({[TEST]: {a: 1}}, {[SNAPSHOT_1]: {data: {[OTHER]: {a: 1}}}});
        const snapshotSubscriber = await recordConnectionAfterInitial(SNAPSHOT_1);

        await Onyx.update([{onyxMethod: 'merge', key: TEST, value: {a: 2}}]);

        expect(snapshotSubscriber.calls).toEqual([]);
    });

    it('delivers the synced snapshot and the data before the returned promise resolves', async () => {
        await seed({[TEST]: {a: 1}}, {[SNAPSHOT_1]: {data: {[TEST]: {a: 1}}}});
        const snapshotSubscriber = await recordConnectionAfterInitial(SNAPSHOT_1);
        const dataSubscriber = await recordConnectionAfterInitial(TEST);

        await Onyx.update([{onyxMethod: 'merge', key: TEST, value: {a: 2}}]);

        expect(snapshotSubscriber.last()).toEqual({data: {[TEST]: {a: 2}}});
        expect(dataSubscriber.last()).toEqual({a: 2});
    });

    it('keeps a direct write to a snapshot key in the same batch', async () => {
        await seed({}, {[SNAPSHOT_1]: {data: {[TEST]: {a: 1}}}});

        await Onyx.update([
            {onyxMethod: 'merge', key: SNAPSHOT_1, value: {data: {[TEST]: {a: 5}}}},
            {onyxMethod: 'merge', key: TEST, value: {a: 2}},
        ]);

        expect(readCache()[SNAPSHOT_1]).toEqual({data: {[TEST]: {a: 5}}});
        expect(readCache()[TEST]).toEqual({a: 2});
    });
});
