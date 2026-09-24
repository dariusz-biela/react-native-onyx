import {isEqual} from 'lodash';

import type {Random} from './batchGenerator';
import type {State, Update} from './harness';

import Onyx from '../../../../lib';
import {ALL_KEYS, COLLECTION_MEMBERS, createRandom, randomBatch, randomInitialState, withoutKeyRemovals} from './batchGenerator';
import {
    ONYX_KEYS,
    initOnyx,
    isPlainObject,
    readCache,
    readKeysThroughConnections,
    readStorage,
    recordCollectionAfterInitial,
    recordConnectionAfterInitial,
    resetOnyx,
    seedPartlyCold,
} from './harness';
import {applyUpdate, applyUpdates, defaultState} from './referenceModel';

const SEEDS_PER_SCENARIO = 150;
const ORDER_INDEPENDENT_METHODS: ReadonlyArray<Update['onyxMethod']> = ['set', 'merge', 'multiset', 'mergecollection'];
const {A, B} = ONYX_KEYS.COLLECTION;
const READ_KEYS: readonly string[] = [...ALL_KEYS, ONYX_KEYS.WITH_DEFAULT];

type Recorders = {
    members: Record<string, unknown[]>;
    collections: Record<string, unknown[]>;
};

function seeds(offset: number): number[] {
    return Array.from({length: SEEDS_PER_SCENARIO}, (_, index) => offset + index);
}

function withDefaults(state: State): State {
    return {...defaultState(), ...state};
}

function pickCollection(state: State, collectionKey: string): State {
    const collection: State = {};
    for (const key of COLLECTION_MEMBERS[collectionKey]) {
        if (state[key] !== undefined) {
            collection[key] = state[key];
        }
    }
    return collection;
}

/** Returns the state after every prefix of the batch, starting with the untouched state. */
function prefixStates(initial: State, batch: Update[]): State[] {
    const states = [initial];
    for (const update of batch) {
        states.push(applyUpdate(states.at(-1) ?? initial, update));
    }
    return states;
}

/** Tells whether every delivered value matches some prefix state, in the order the batch produced them. */
function isOrderedSubsequenceOfPrefixes(delivered: unknown[], prefixValues: unknown[]): boolean {
    let cursor = 0;
    for (const value of delivered) {
        const normalizedValue = value ?? undefined;
        while (cursor < prefixValues.length && !isEqual(prefixValues[cursor], normalizedValue)) {
            cursor++;
        }
        if (cursor === prefixValues.length) {
            return false;
        }
    }
    return true;
}

async function seedWarm(initial: State): Promise<void> {
    await Onyx.multiSet(initial);
}

async function recordEverything(): Promise<Recorders> {
    const recorders: Recorders = {members: {}, collections: {}};
    for (const key of ALL_KEYS) {
        recorders.members[key] = (await recordConnectionAfterInitial(key)).calls;
    }
    for (const collectionKey of [A, B]) {
        recorders.collections[collectionKey] = (await recordCollectionAfterInitial(collectionKey)).calls;
    }
    return recorders;
}

function expectSubscribersFollowTheBatch(recorders: Recorders, states: State[]): void {
    const initial = states[0];
    const final = states.at(-1) ?? initial;
    for (const key of ALL_KEYS) {
        const calls = recorders.members[key];
        const prefixValues = states.map((state) => state[key]);
        if (!isEqual(initial[key], final[key])) {
            expect({key, called: calls.length > 0}).toEqual({key, called: true});
        }
        if (calls.length > 0) {
            expect({key, last: calls.at(-1) ?? undefined}).toEqual({key, last: final[key]});
        }
        expect({key, ordered: isOrderedSubsequenceOfPrefixes(calls, prefixValues)}).toEqual({key, ordered: true});
    }
    for (const collectionKey of [A, B]) {
        const calls = recorders.collections[collectionKey];
        const expected = pickCollection(final, collectionKey);
        if (!isEqual(pickCollection(initial, collectionKey), expected)) {
            expect({collectionKey, called: calls.length > 0}).toEqual({collectionKey, called: true});
        }
        if (calls.length > 0) {
            expect({collectionKey, last: calls.at(-1) ?? {}}).toEqual({collectionKey, last: expected});
        }
        // Member groups of one batch may land in separate notifications, so ordering is checked per member.
        for (const key of COLLECTION_MEMBERS[collectionKey]) {
            const memberValues = calls.map((collection) => (isPlainObject(collection) ? collection[key] : undefined));
            const prefixValues = states.map((state) => state[key]);
            expect({key, orderedInCollection: isOrderedSubsequenceOfPrefixes(memberValues, prefixValues)}).toEqual({key, orderedInCollection: true});
        }
    }
}

/** A batch that ends with a setCollection of A, where no other entry touches collection A. */
function batchWithIsolatedSetCollection(random: Random): Update[] {
    const outsideA = randomBatch(random, {length: 1 + random.int(5), methods: ORDER_INDEPENDENT_METHODS}).filter((update) => {
        if (update.key.startsWith(A)) {
            return false;
        }
        return !(update.onyxMethod === 'multiset' && Object.keys(update.value ?? {}).some((key) => key.startsWith(A)));
    });
    const setCollection = randomBatch(random, {length: 20, methods: ['setcollection']}).find((update) => update.key === A);
    const position = random.int(outsideA.length + 1);
    return setCollection ? [...outsideA.slice(0, position), setCollection, ...outsideA.slice(position)] : outsideA;
}

describe('Onyx.update matches applying its entries one by one', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);

    it.each(seeds(1))('warm cache, seed %i: cache, storage and subscribers end in the sequential state', async (seed) => {
        const random = createRandom(seed);
        const initial = randomInitialState(random);
        const batch = randomBatch(random, {length: 1 + random.int(8), methods: ORDER_INDEPENDENT_METHODS});
        await seedWarm(initial);
        const recorders = await recordEverything();

        await Onyx.update(batch);

        const states = prefixStates(initial, batch);
        const expected = withDefaults(states.at(-1) ?? initial);
        expect(readCache()).toEqual(expected);
        expect(readStorage()).toEqual(expected);
        expectSubscribersFollowTheBatch(recorders, states);
    });

    it.each(seeds(4001))('long warm batch, seed %i: repeated writes to the same keys end in the sequential state', async (seed) => {
        const random = createRandom(seed);
        const initial = randomInitialState(random);
        const batch = randomBatch(random, {length: 10 + random.int(15), methods: ORDER_INDEPENDENT_METHODS});
        await seedWarm(initial);
        const recorders = await recordEverything();

        await Onyx.update(batch);

        const states = prefixStates(initial, batch);
        const expected = withDefaults(states.at(-1) ?? initial);
        expect(readCache()).toEqual(expected);
        expect(readStorage()).toEqual(expected);
        expectSubscribersFollowTheBatch(recorders, states);
    });

    it.each(seeds(1001))('partly evicted cache, seed %i: reads and storage end in the sequential state', async (seed) => {
        const random = createRandom(seed);
        const initial = randomInitialState(random);
        const batch = withoutKeyRemovals(randomBatch(random, {length: 1 + random.int(8), methods: ORDER_INDEPENDENT_METHODS}));
        await seedPartlyCold(initial, () => random.chance(0.5));

        await Onyx.update(batch);

        const expected = withDefaults(applyUpdates(initial, batch));
        expect(await readKeysThroughConnections(READ_KEYS)).toEqual(expected);
        expect(readStorage()).toEqual(expected);
    });

    it.each(seeds(2001))('setCollection with unrelated entries, seed %i: ends in the sequential state', async (seed) => {
        const random = createRandom(seed);
        const initial = randomInitialState(random);
        const batch = batchWithIsolatedSetCollection(random);
        await seedWarm(initial);
        const recorders = await recordEverything();

        await Onyx.update(batch);

        const states = prefixStates(initial, batch);
        const expected = withDefaults(states.at(-1) ?? initial);
        expect(readCache()).toEqual(expected);
        expect(readStorage()).toEqual(expected);
        expectSubscribersFollowTheBatch(recorders, states);
    });

    it.each(seeds(3001))('leading clear, seed %i: ends in the sequential state', async (seed) => {
        const random = createRandom(seed);
        const initial = randomInitialState(random);
        const batch: Update[] = [{onyxMethod: 'clear', key: ''}, ...randomBatch(random, {length: 1 + random.int(6), methods: ORDER_INDEPENDENT_METHODS})];
        await seedWarm(initial);

        await Onyx.update(batch);

        const expected = withDefaults(applyUpdates(initial, batch));
        expect(readCache()).toEqual(expected);
        expect(readStorage()).toEqual(expected);
    });
});
