import type {Random} from '../update/batchGenerator';
import type {State, Update} from '../update/harness';

import {createRandom} from '../update/batchGenerator';
import {ONYX_KEYS, deepClone, isPlainObject, isRunningAsSuite, toUpdate} from '../update/harness';
import {COLLECTIONS, COLLECTION_MEMBERS, MEMBER_KEYS, PLAIN_KEYS, SKIPPABLE_MEMBER, applyOp, isCompatible} from './model';
import type {Op, OpKind} from './model';

const {NEST} = ONYX_KEYS.COLLECTION;
const WRITE_KEYS: readonly string[] = [...PLAIN_KEYS, ...MEMBER_KEYS];

const SEQUENTIAL_KINDS: readonly OpKind[] = [
    'set',
    'set',
    'set',
    'merge',
    'merge',
    'merge',
    'multiSet',
    'multiSet',
    'mergeCollection',
    'mergeCollection',
    'mergeCollection',
    'setCollection',
    'setCollection',
    'update',
    'update',
    'clear',
];

function randomLeaf(random: Random): unknown {
    return random.pick<unknown>(['x', 'y', 1, 2, true, [1, 2]]);
}

function randomObject(random: Random, allowNestedNulls: boolean): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    if (random.chance(0.6)) {
        value.name = allowNestedNulls && random.chance(0.2) ? null : randomLeaf(random);
    }
    if (random.chance(0.5)) {
        value.count = allowNestedNulls && random.chance(0.2) ? null : random.int(3);
    }
    if (random.chance(0.5)) {
        const nested: Record<string, unknown> = {};
        if (random.chance(0.7)) {
            nested.left = allowNestedNulls && random.chance(0.25) ? null : randomLeaf(random);
        }
        if (random.chance(0.6)) {
            nested.right = {deep: random.int(3)};
        }
        value.nested = nested;
    }
    return value;
}

/** A value that repeats the current one, so the sequence also exercises writes that change nothing. */
function sameAsCurrent(state: State, key: string): unknown {
    return state[key] === undefined ? null : deepClone(state[key]);
}

function randomReplacement(random: Random, state: State, key: string): unknown {
    const roll = random.next();
    if (roll < 0.12) {
        return sameAsCurrent(state, key);
    }
    if (roll < 0.22) {
        return null;
    }
    if (roll < 0.3) {
        return random.pick<unknown>([[], [1, 2], ['z']]);
    }
    if (roll < 0.35 && PLAIN_KEYS.includes(key)) {
        return random.pick<unknown>(['text', 7, false]);
    }
    return randomObject(random, true);
}

function randomChange(random: Random, state: State, key: string): unknown {
    const roll = random.next();
    if (roll < 0.1) {
        return sameAsCurrent(state, key);
    }
    if (roll < 0.18) {
        return null;
    }
    if (roll < 0.24) {
        return random.pick<unknown>([[], [3], {}]);
    }
    if (roll < 0.28 && PLAIN_KEYS.includes(key)) {
        return random.pick<unknown>(['text', 7]);
    }
    return randomObject(random, true);
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

function randomWriteKey(random: Random): string {
    return random.chance(0.05) ? SKIPPABLE_MEMBER : random.pick(WRITE_KEYS);
}

function membersOf(random: Random, collectionKey: string): string[] {
    const members = pickSubset(random, COLLECTION_MEMBERS[collectionKey], 1);
    if (collectionKey === NEST && random.chance(0.1)) {
        members.push(SKIPPABLE_MEMBER);
    }
    return members;
}

/**
 * Update batches stay inside the region the update differential test already proves equal to sequential application:
 * object values without nested nulls, keys outside the child collection, and keys that hold an object or nothing.
 */
function randomUpdates(random: Random, state: State): Update[] {
    const eligible = [...PLAIN_KEYS, ...COLLECTION_MEMBERS[NEST]].filter((key) => state[key] === undefined || isPlainObject(state[key]));
    if (eligible.length === 0) {
        return [];
    }
    const updates: Update[] = [];
    const length = 1 + random.int(4);
    for (let index = 0; index < length; index++) {
        const method = random.pick<Update['onyxMethod']>(['set', 'merge', 'merge', 'multiset', 'mergecollection']);
        if (method === 'multiset') {
            const value: Record<string, unknown> = {};
            for (const key of pickSubset(random, eligible, 1)) {
                value[key] = randomObject(random, false);
            }
            updates.push(toUpdate({onyxMethod: 'multiset', key: '', value}));
            continue;
        }
        if (method === 'mergecollection') {
            const value: Record<string, unknown> = {};
            for (const key of pickSubset(
                random,
                COLLECTION_MEMBERS[NEST].filter((member) => eligible.includes(member)),
                0,
            )) {
                value[key] = randomObject(random, false);
            }
            if (Object.keys(value).length > 0) {
                updates.push(toUpdate({onyxMethod: 'mergecollection', key: NEST, value}));
            }
            continue;
        }
        const key = random.pick(eligible);
        const value = random.chance(0.15) ? null : randomObject(random, false);
        updates.push(toUpdate({onyxMethod: method, key, value}));
    }
    return updates;
}

function randomOp(random: Random, state: State, kinds: readonly OpKind[] = SEQUENTIAL_KINDS): Op {
    const kind = random.pick(kinds);
    switch (kind) {
        case 'set': {
            const key = randomWriteKey(random);
            return {kind, key, value: random.chance(0.04) ? undefined : randomReplacement(random, state, key)};
        }
        case 'merge': {
            const key = randomWriteKey(random);
            return {kind, key, value: random.chance(0.04) ? undefined : randomChange(random, state, key)};
        }
        case 'multiSet': {
            const data: Record<string, unknown> = {};
            for (const key of pickSubset(random, WRITE_KEYS, 1)) {
                data[key] = randomReplacement(random, state, key);
            }
            return {kind, data};
        }
        case 'mergeCollection': {
            const collectionKey = random.pick(COLLECTIONS);
            const data: Record<string, unknown> = {};
            for (const key of membersOf(random, collectionKey)) {
                data[key] = randomChange(random, state, key);
            }
            return {kind, collectionKey, data};
        }
        case 'setCollection': {
            const collectionKey = random.pick(COLLECTIONS);
            const data: Record<string, unknown> = {};
            for (const key of random.chance(0.1) ? [] : membersOf(random, collectionKey)) {
                data[key] = random.chance(0.15) ? sameAsCurrent(state, key) ?? {} : randomObject(random, true);
            }
            return {kind, collectionKey, data};
        }
        case 'update':
            return {kind, updates: randomUpdates(random, state)};
        default:
            return {kind: 'clear'};
    }
}

/** A top-level object or null, so a same-key burst never mixes arrays with objects. */
function randomObjectOrNull(random: Random, state: State, key: string): unknown {
    const roll = random.next();
    if (roll < 0.12 && isPlainObject(state[key])) {
        return deepClone(state[key]);
    }
    if (roll < 0.25) {
        return null;
    }
    return randomObject(random, true);
}

function randomPrefixOp(random: Random, state: State, allowMerge: boolean, mergeKeys: readonly string[]): Op {
    const kind = random.pick<OpKind>(allowMerge ? ['set', 'set', 'merge', 'merge', 'merge', 'multiSet'] : ['set', 'set', 'multiSet']);
    if (kind === 'multiSet') {
        const data: Record<string, unknown> = {};
        for (const key of pickSubset(random, WRITE_KEYS, 1)) {
            data[key] = randomObject(random, true);
        }
        return {kind, data};
    }
    if (kind === 'merge') {
        const key = random.pick(mergeKeys);
        return {kind, key, value: randomObjectOrNull(random, state, key)};
    }
    const key = randomWriteKey(random);
    return {kind: 'set', key, value: randomObjectOrNull(random, state, key)};
}

/**
 * A batch of writes issued in one tick: key writes, then at most one collection write, clear or update last. The
 * same-tick reorderings the set, multiSet, setCollection, mergeCollection and clear contracts pin as suspected bugs are
 * kept out: a null multiSet after a merge, a merge before a setCollection or a clear, a key write after a collection
 * write, a merge of a member that a later update groups, and a closing mergeCollection that removes a member created
 * earlier in the batch or merges an array.
 */
function randomBatch(random: Random, state: State): Op[] {
    const closing = random.pick<OpKind | 'none'>(['none', 'none', 'mergeCollection', 'setCollection', 'clear', 'update']);
    const allowMerge = closing !== 'setCollection' && closing !== 'clear';
    const mergeKeys = closing === 'update' ? WRITE_KEYS.filter((key) => !COLLECTION_MEMBERS[NEST].includes(key)) : WRITE_KEYS;
    const ops: Op[] = [];
    let current = state;
    const prefixLength = 1 + random.int(3);
    for (let index = 0; index < prefixLength; index++) {
        const op = randomPrefixOp(random, current, allowMerge, mergeKeys);
        ops.push(op);
        current = applyOp(current, op);
    }
    if (closing === 'none') {
        return ops;
    }
    const last = randomOp(random, current, [closing]);
    if (last.kind === 'mergeCollection') {
        // mergeCollection checks removals and arrays against the value before the batch (pinned in this folder).
        const data = Object.fromEntries(Object.entries(last.data).filter(([key, value]) => !Array.isArray(value) && (value !== null || key in state)));
        return [...ops, {...last, data}];
    }
    return [...ops, last];
}

/** A stored state of object values that Onyx.init hydrates before the sequence starts. */
function randomStoredState(random: Random): State {
    const state: State = {};
    for (const key of [ONYX_KEYS.TEST_KEY, ONYX_KEYS.OTHER_KEY, ...MEMBER_KEYS]) {
        if (random.chance(0.5)) {
            state[key] = randomObject(random, false);
        }
    }
    return state;
}

function randomSequence(random: Random, initial: State, length: number, kinds?: readonly OpKind[]): Op[] {
    const ops: Op[] = [];
    let state = initial;
    for (let index = 0; index < length; index++) {
        const op = randomOp(random, state, kinds);
        ops.push(op);
        state = applyOp(state, op);
    }
    return ops;
}

export {createRandom, randomOp, randomBatch, randomSequence, randomStoredState, SEQUENTIAL_KINDS};

if (isRunningAsSuite(__filename)) {
    describe('model-based sequence generator', () => {
        it('replays the same sequence for the same seed', () => {
            const first = createRandom(11);
            const second = createRandom(11);
            expect(randomSequence(first, randomStoredState(first), 20)).toEqual(randomSequence(second, randomStoredState(second), 20));
        });

        it('keeps update batches on keys that hold objects', () => {
            const random = createRandom(5);
            const state: State = {test: [1], other: {a: 1}};
            for (let index = 0; index < 30; index++) {
                for (const entry of randomUpdates(random, state)) {
                    expect(entry.key === '' || isCompatible({}, state[entry.key])).toBe(true);
                    expect(entry.key).not.toBe('test');
                }
            }
        });
    });
}
