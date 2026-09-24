import type {State, Update} from './harness';

import Onyx from '../../../../lib';
import {createRandom, randomBatch, randomInitialState, withoutKeyRemovals} from './batchGenerator';
import {DEFAULT_VALUE, ONYX_KEYS, initOnyx, resetOnyx, seedPartlyCold} from './harness';
import {applyUpdates} from './referenceModel';
import {recordStorageForSQLite} from './sqliteReplay';

const SEEDS = 100;
const ORDER_INDEPENDENT_METHODS: ReadonlyArray<Update['onyxMethod']> = ['set', 'merge', 'multiset', 'mergecollection'];
const TEST = ONYX_KEYS.TEST_KEY;
const {A, B} = ONYX_KEYS.COLLECTION;
const WITH_DEFAULT = {[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE};

type StorageCase = {
    name: string;
    initial: State;
    batch: Update[];
};

const STORAGE_CASES: StorageCase[] = [
    {
        name: 'a plain key whose nested object is removed and written again',
        initial: {[TEST]: {nested: {left: 1}, keep: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {nested: null}},
            {onyxMethod: 'merge', key: TEST, value: {nested: {right: 1}}},
        ],
    },
    {
        name: 'grouped members whose nested object is removed and written again',
        initial: {[`${A}1`]: {nested: {left: 1}, keep: 1}, [`${A}2`]: {nested: {left: 2}}},
        batch: [
            {onyxMethod: 'merge', key: `${A}1`, value: {nested: null}},
            {onyxMethod: 'merge', key: `${A}1`, value: {nested: {right: 1}}},
            {onyxMethod: 'merge', key: `${A}2`, value: {nested: null}},
            {onyxMethod: 'merge', key: `${A}2`, value: {nested: {right: 2}}},
        ],
    },
    {
        name: 'a mergecollection removing nested fields and whole members',
        initial: {[`${B}1`]: {nested: {left: 1, right: 1}}, [`${B}2`]: {a: 1}},
        batch: [
            {onyxMethod: 'mergecollection', key: B, value: {[`${B}1`]: {nested: {left: null}}, [`${B}3`]: {c: {d: 1}}}},
            {onyxMethod: 'merge', key: `${B}2`, value: null},
        ],
    },
    {
        name: 'sets and multisets that carry nested nulls',
        initial: {[TEST]: {a: 1}, [`${A}1`]: {a: 1}},
        batch: [
            {onyxMethod: 'set', key: TEST, value: {b: null, c: {d: null, e: 1}}},
            {onyxMethod: 'multiset', key: '', value: {[`${A}1`]: {b: null, c: 1}, [`${A}2`]: {d: null}}},
        ],
    },
    {
        name: 'a new key merged with nested nulls',
        initial: {},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {a: null, b: {c: null, d: 1}}},
            {onyxMethod: 'merge', key: `${A}1`, value: {a: null, b: 1}},
            {onyxMethod: 'merge', key: `${A}2`, value: {c: {d: null}}},
        ],
    },
];

function withDefaults(state: State): State {
    return {...WITH_DEFAULT, ...state};
}

describe('Onyx.update storage writes replayed with SQLite semantics', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);

    it.each(STORAGE_CASES)('$name', async ({initial, batch}) => {
        await Onyx.multiSet(initial);
        const replay = recordStorageForSQLite();

        await Onyx.update(batch);

        expect(replay()).toEqual(withDefaults(applyUpdates(initial, batch)));
    });

    it.each(Array.from({length: SEEDS}, (_, index) => 5001 + index))('warm cache, seed %i', async (seed) => {
        const random = createRandom(seed);
        const initial = randomInitialState(random);
        const batch = randomBatch(random, {length: 1 + random.int(12), methods: ORDER_INDEPENDENT_METHODS});
        await Onyx.multiSet(initial);
        const replay = recordStorageForSQLite();

        await Onyx.update(batch);

        expect(replay()).toEqual(withDefaults(applyUpdates(initial, batch)));
    });

    it.each(Array.from({length: SEEDS}, (_, index) => 6001 + index))('partly evicted cache, seed %i', async (seed) => {
        const random = createRandom(seed);
        const initial = randomInitialState(random);
        const batch = withoutKeyRemovals(randomBatch(random, {length: 1 + random.int(12), methods: ORDER_INDEPENDENT_METHODS}));
        await seedPartlyCold(initial, () => random.chance(0.5));
        const replay = recordStorageForSQLite();

        await Onyx.update(batch);

        expect(replay()).toEqual(withDefaults(applyUpdates(initial, batch)));
    });
});
