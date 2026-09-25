import {isEqual} from 'lodash';

import type {State, Update} from '../update/harness';

import {DEFAULT_VALUE, ONYX_KEYS, SKIPPABLE_ID, isPlainObject, isRunningAsSuite} from '../update/harness';
import {applyUpdates, defaultState, getCollectionKey, mergeValue, withoutNestedNulls} from '../update/referenceModel';

const {NEST, NEST_LEVEL} = ONYX_KEYS.COLLECTION;

const PLAIN_KEYS: readonly string[] = [ONYX_KEYS.TEST_KEY, ONYX_KEYS.OTHER_KEY, ONYX_KEYS.WITH_DEFAULT];
const SKIPPABLE_MEMBER = `${NEST}${SKIPPABLE_ID}`;

// `nest_level_` members also start with `nest_`, so the two collections collide on their prefix.
const COLLECTION_MEMBERS: Record<string, readonly string[]> = {
    [NEST]: [`${NEST}1`, `${NEST}2`],
    [NEST_LEVEL]: [`${NEST_LEVEL}1`, `${NEST_LEVEL}2`],
};
const COLLECTIONS: readonly string[] = [NEST, NEST_LEVEL];
const MEMBER_KEYS: readonly string[] = COLLECTIONS.flatMap((collectionKey) => COLLECTION_MEMBERS[collectionKey]);
const OBSERVED_KEYS: readonly string[] = [...PLAIN_KEYS, ...MEMBER_KEYS, SKIPPABLE_MEMBER];

type Op =
    | {kind: 'set'; key: string; value: unknown}
    | {kind: 'merge'; key: string; value: unknown}
    | {kind: 'multiSet'; data: Record<string, unknown>}
    | {kind: 'mergeCollection'; collectionKey: string; data: Record<string, unknown>}
    | {kind: 'setCollection'; collectionKey: string; data: Record<string, unknown>}
    | {kind: 'update'; updates: Update[]}
    | {kind: 'clear'};

type OpKind = Op['kind'];

function isSkippable(key: string): boolean {
    const collectionKey = getCollectionKey(key);
    return !!collectionKey && key.slice(collectionKey.length) === SKIPPABLE_ID;
}

/** The array/non-array rule of set, merge and mergeCollection: a change of the other kind is dropped, except an object over an empty array. */
function isCompatible(change: unknown, existing: unknown): boolean {
    if (!existing || !change) {
        return true;
    }
    if (Array.isArray(existing) && existing.length === 0 && isPlainObject(change)) {
        return true;
    }
    return Array.isArray(existing) === Array.isArray(change);
}

function withoutKey(state: State, key: string): State {
    const next: State = {...state};
    delete next[key];
    return next;
}

/** multiSet and setCollection replace without checking the array/non-array rule. */
function replaceValue(state: State, key: string, value: unknown): State {
    const effectiveValue = isSkippable(key) ? null : value;
    if (effectiveValue === undefined) {
        return state;
    }
    if (effectiveValue === null) {
        return withoutKey(state, key);
    }
    return {...state, [key]: withoutNestedNulls(effectiveValue)};
}

function setValue(state: State, key: string, value: unknown): State {
    if (!isCompatible(value, state[key])) {
        return state;
    }
    return replaceValue(state, key, value);
}

function mergeInto(state: State, key: string, change: unknown): State {
    if (change === undefined || isSkippable(key) || !isCompatible(change, state[key])) {
        return state;
    }
    if (change === null) {
        return withoutKey(state, key);
    }
    return {...state, [key]: mergeValue(state[key], change)};
}

function belongsTo(collectionKey: string, data: Record<string, unknown>): boolean {
    return Object.keys(data).every((key) => key.startsWith(collectionKey));
}

function applyOp(state: State, op: Op): State {
    switch (op.kind) {
        case 'set':
            return setValue(state, op.key, op.value);
        case 'merge':
            return mergeInto(state, op.key, op.value);
        case 'multiSet':
            return Object.entries(op.data).reduce((next, [key, value]) => replaceValue(next, key, value), state);
        case 'mergeCollection':
            if (Object.keys(op.data).length === 0 || !belongsTo(op.collectionKey, op.data)) {
                return state;
            }
            return Object.entries(op.data).reduce((next, [key, value]) => mergeInto(next, key, value), state);
        case 'setCollection': {
            if (!belongsTo(op.collectionKey, op.data)) {
                return state;
            }
            // Every stored key starting with the collection key is dropped, which includes prefix-colliding child members.
            const dropped = Object.keys(state)
                .filter((key) => key.startsWith(op.collectionKey) && !(key in op.data))
                .reduce(withoutKey, state);
            return Object.entries(op.data).reduce((next, [key, value]) => replaceValue(next, key, value), dropped);
        }
        case 'update':
            return applyUpdates(state, op.updates);
        case 'clear':
            return defaultState();
        default:
            return state;
    }
}

function applyOps(state: State, ops: readonly Op[]): State {
    return ops.reduce(applyOp, state);
}

/** Returns the members the model holds for a collection, resolving prefix collisions to the longest collection key. */
function projectCollection(state: State, collectionKey: string): State {
    const collection: State = {};
    for (const [key, value] of Object.entries(state)) {
        if (getCollectionKey(key) === collectionKey) {
            collection[key] = value;
        }
    }
    return collection;
}

/** What a subscriber to the target should see: a value for a key, a member map for a collection. */
function project(state: State, target: string): unknown {
    return COLLECTIONS.includes(target) ? projectCollection(state, target) : state[target];
}

/** Returns the keys an operation names, before any filtering. */
function namedKeys(op: Op): string[] {
    switch (op.kind) {
        case 'set':
        case 'merge':
            return [op.key];
        case 'multiSet':
        case 'mergeCollection':
        case 'setCollection':
            return Object.keys(op.data);
        case 'update':
            return op.updates.flatMap((entry) =>
                entry.onyxMethod === 'multiset' || entry.onyxMethod === 'mergecollection' || entry.onyxMethod === 'setcollection' ? Object.keys(entry.value ?? {}) : [entry.key],
            );
        default:
            return [];
    }
}

/** Tells whether an operation may notify a target at all; untouched targets must stay silent. */
function touches(op: Op, target: string): boolean {
    if (op.kind === 'clear') {
        return true;
    }
    const keys = namedKeys(op);
    if (COLLECTIONS.includes(target)) {
        return (op.kind === 'setCollection' && op.collectionKey === target) || keys.some((key) => getCollectionKey(key) === target);
    }
    return keys.includes(target) || (op.kind === 'setCollection' && target.startsWith(op.collectionKey));
}

/** A parent setCollection removes prefix-colliding child members without notifying their subscribers (pinned as a suspected bug). */
function isSilentChildRemoval(op: Op, target: string, before: State, after: State): boolean {
    if (op.kind !== 'setCollection') {
        return false;
    }
    const childKeys = COLLECTIONS.includes(target) ? Object.keys(projectCollection(before, target)) : [target];
    return childKeys.some((key) => getCollectionKey(key) !== op.collectionKey && key.startsWith(op.collectionKey) && key in before && !(key in after));
}

/** Onyx.init merges the stored state with the defaults, the default winning over any stored primitive. */
function hydratedState(state: State): State {
    return {...state, [ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE};
}

function initialModel(stored: State): State {
    return {...stored, ...defaultState()};
}

function describeOp(op: Op): string {
    return JSON.stringify(op);
}

export {
    PLAIN_KEYS,
    SKIPPABLE_MEMBER,
    COLLECTION_MEMBERS,
    COLLECTIONS,
    MEMBER_KEYS,
    OBSERVED_KEYS,
    applyOp,
    applyOps,
    project,
    projectCollection,
    touches,
    isSilentChildRemoval,
    hydratedState,
    initialModel,
    describeOp,
    isCompatible,
};
export type {Op, OpKind};

if (isRunningAsSuite(__filename)) {
    describe('model-based reference model', () => {
        it('removes prefix-colliding child members on a parent setCollection', () => {
            const before = {nest_1: {a: 1}, nest_level_1: {b: 1}};
            const after = applyOp(before, {kind: 'setCollection', collectionKey: NEST, data: {nest_2: {c: 1}}});
            expect(after).toEqual({nest_2: {c: 1}});
            expect(isSilentChildRemoval({kind: 'setCollection', collectionKey: NEST, data: {}}, NEST_LEVEL, before, after)).toBe(true);
            expect(isSilentChildRemoval({kind: 'setCollection', collectionKey: NEST, data: {}}, `${NEST}1`, before, after)).toBe(false);
        });

        it('keeps prefix-colliding collections apart in projections', () => {
            const state = {nest_1: 1, nest_level_1: 2, test: 3};
            expect(project(state, NEST)).toEqual({nest_1: 1});
            expect(project(state, NEST_LEVEL)).toEqual({nest_level_1: 2});
            expect(isEqual(project(state, 'test'), 3)).toBe(true);
        });

        it('lets multiSet replace across the array/object boundary while set drops it', () => {
            expect(applyOp({test: {a: 1}}, {kind: 'set', key: 'test', value: [1]})).toEqual({test: {a: 1}});
            expect(applyOp({test: {a: 1}}, {kind: 'multiSet', data: {test: [1]}})).toEqual({test: [1]});
        });
    });
}
