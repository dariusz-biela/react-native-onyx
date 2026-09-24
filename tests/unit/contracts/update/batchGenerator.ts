import type {State, Update} from './harness';

import {ONYX_KEYS, isPlainObject, isRunningAsSuite, toUpdate} from './harness';

type Random = {
    next: () => number;
    int: (maxExclusive: number) => number;
    pick: <T>(items: readonly T[]) => T;
    chance: (probability: number) => boolean;
};

/** Park-Miller generator, so every seed replays the same batch. */
function createRandom(seed: number): Random {
    const modulus = 2147483647;
    let current = (Math.abs(Math.trunc(seed)) % (modulus - 1)) + 1;
    const next = () => {
        current = (current * 16807) % modulus;
        return (current - 1) / (modulus - 1);
    };
    // Neighbouring seeds start almost equal, so a few draws are discarded to decorrelate them.
    for (let warmUp = 0; warmUp < 8; warmUp++) {
        next();
    }
    return {
        next,
        int: (maxExclusive) => Math.floor(next() * maxExclusive),
        pick: (items) => items[Math.floor(next() * items.length)],
        chance: (probability) => next() < probability,
    };
}

const {A, B} = ONYX_KEYS.COLLECTION;

const COLLECTION_MEMBERS: Record<string, readonly string[]> = {
    [A]: [`${A}1`, `${A}2`, `${A}3`],
    [B]: [`${B}1`, `${B}2`],
};

const PLAIN_KEYS: readonly string[] = [ONYX_KEYS.TEST_KEY, ONYX_KEYS.OTHER_KEY];
const ALL_KEYS: readonly string[] = [...PLAIN_KEYS, ...Object.values(COLLECTION_MEMBERS).flat()];
const FIELDS = ['name', 'count', 'nested'] as const;

function randomLeaf(random: Random): unknown {
    return random.pick<unknown>(['x', 'y', 1, 2, true, [1, 2]]);
}

/**
 * Builds an object value. Only non-object leaves may be null, so a property never goes from null to an object
 * inside one batch; that pattern leaks the replace marker and is pinned separately as a suspected bug.
 */
function randomObject(random: Random, allowNulls: boolean): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    for (const field of FIELDS) {
        if (!random.chance(0.6)) {
            continue;
        }
        if (field === 'nested') {
            const nested: Record<string, unknown> = {};
            if (random.chance(0.7)) {
                nested.left = allowNulls && random.chance(0.2) ? null : randomLeaf(random);
            }
            if (random.chance(0.7)) {
                nested.right = {deep: random.int(3)};
            }
            value[field] = nested;
            continue;
        }
        value[field] = allowNulls && random.chance(0.2) ? null : randomLeaf(random);
    }
    return value;
}

function randomMergeValue(random: Random): unknown {
    return random.chance(0.12) ? null : randomObject(random, true);
}

function randomSetValue(random: Random): unknown {
    return random.chance(0.12) ? null : randomObject(random, true);
}

function pickSubset(random: Random, items: readonly string[], minimum: number): string[] {
    const subset = items.filter(() => random.chance(0.5));
    for (const item of items) {
        if (subset.length >= minimum) {
            break;
        }
        if (!subset.includes(item)) {
            subset.push(item);
        }
    }
    return subset;
}

type BatchOptions = {
    length: number;
    methods: ReadonlyArray<Update['onyxMethod']>;
};

function randomUpdate(random: Random, method: Update['onyxMethod']): Update {
    switch (method) {
        case 'set':
            return {onyxMethod: 'set', key: random.pick(ALL_KEYS), value: randomSetValue(random)};
        case 'merge':
            return {onyxMethod: 'merge', key: random.pick(ALL_KEYS), value: randomMergeValue(random)};
        case 'multiset': {
            const value: Record<string, unknown> = {};
            for (const key of pickSubset(random, ALL_KEYS, 1)) {
                value[key] = randomSetValue(random);
            }
            return {onyxMethod: 'multiset', key: '', value};
        }
        case 'mergecollection': {
            const collectionKey = random.pick([A, B]);
            const value: Record<string, unknown> = {};
            for (const key of pickSubset(random, COLLECTION_MEMBERS[collectionKey], 1)) {
                value[key] = randomMergeValue(random);
            }
            return toUpdate({onyxMethod: 'mergecollection', key: collectionKey, value});
        }
        case 'setcollection': {
            const collectionKey = random.pick([A, B]);
            const value: Record<string, unknown> = {};
            for (const key of pickSubset(random, COLLECTION_MEMBERS[collectionKey], 1)) {
                value[key] = randomObject(random, false);
            }
            return toUpdate({onyxMethod: 'setcollection', key: collectionKey, value});
        }
        default:
            return {onyxMethod: 'clear', key: ''};
    }
}

function randomBatch(random: Random, {length, methods}: BatchOptions): Update[] {
    const batch: Update[] = [];
    for (let index = 0; index < length; index++) {
        batch.push(randomUpdate(random, random.pick(methods)));
    }
    return batch;
}

/** Builds a starting state with object values only, so every generated change is type compatible. */
function randomInitialState(random: Random): State {
    const state: State = {};
    for (const key of ALL_KEYS) {
        if (random.chance(0.6)) {
            state[key] = randomObject(random, false);
        }
    }
    return state;
}

function withoutNullEntries(value: unknown): unknown {
    if (!isPlainObject(value)) {
        return value;
    }
    return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== null));
}

/** Drops whole-key removals, which do not reach evicted keys (pinned as a suspected bug). */
function withoutKeyRemovals(batch: Update[]): Update[] {
    return batch.flatMap((update): Update[] => {
        if (update.onyxMethod === 'set' || update.onyxMethod === 'merge') {
            return update.value === null ? [] : [update];
        }
        if (update.onyxMethod === 'multiset' || update.onyxMethod === 'mergecollection') {
            return [toUpdate({...update, value: withoutNullEntries(update.value)})];
        }
        return [update];
    });
}

export {createRandom, randomBatch, randomInitialState, withoutKeyRemovals, ALL_KEYS, COLLECTION_MEMBERS};
export type {Random, BatchOptions};

if (isRunningAsSuite(__filename)) {
    describe('update batch generator', () => {
        it('replays the same batch for the same seed', () => {
            const options: BatchOptions = {length: 6, methods: ['set', 'merge', 'multiset', 'mergecollection', 'setcollection']};
            expect(randomBatch(createRandom(7), options)).toEqual(randomBatch(createRandom(7), options));
            expect(randomInitialState(createRandom(7))).toEqual(randomInitialState(createRandom(7)));
        });

        it('only emits collection members that belong to the named collection', () => {
            const batch = randomBatch(createRandom(3), {length: 50, methods: ['mergecollection', 'setcollection']});
            for (const update of batch) {
                expect(Object.keys(update.value ?? {}).every((key) => key.startsWith(update.key))).toBe(true);
            }
        });
    });
}
