import type {State, Update} from './harness';

import {DEFAULT_VALUE, ONYX_KEYS, SKIPPABLE_ID, isPlainObject, isRunningAsSuite} from './harness';

const COLLECTION_KEYS: readonly string[] = Object.values(ONYX_KEYS.COLLECTION);

function defaultState(): State {
    return {[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE};
}

function isArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function getCollectionKey(key: string): string | undefined {
    let match: string | undefined;
    for (const collectionKey of COLLECTION_KEYS) {
        if (key.startsWith(collectionKey) && key.length > collectionKey.length && (!match || collectionKey.length > match.length)) {
            match = collectionKey;
        }
    }
    return match;
}

function isSkippable(key: string): boolean {
    const collectionKey = getCollectionKey(key);
    return !!collectionKey && key.slice(collectionKey.length) === SKIPPABLE_ID;
}

function withoutNestedNulls(value: unknown): unknown {
    if (!isPlainObject(value)) {
        return value;
    }
    const result: Record<string, unknown> = {};
    for (const [property, propertyValue] of Object.entries(value)) {
        if (propertyValue === null || propertyValue === undefined) {
            continue;
        }
        result[property] = withoutNestedNulls(propertyValue);
    }
    return result;
}

function mergeValue(existing: unknown, change: unknown): unknown {
    if (!isPlainObject(change)) {
        return change;
    }
    const result: Record<string, unknown> = isPlainObject(existing) ? {...existing} : {};
    for (const [property, propertyChange] of Object.entries(change)) {
        if (propertyChange === undefined) {
            continue;
        }
        if (propertyChange === null) {
            delete result[property];
            continue;
        }
        result[property] = mergeValue(result[property], propertyChange);
    }
    return withoutNestedNulls(result);
}

/** Mirrors the array/non-array compatibility rule: a change of the other kind is dropped, except an object over an empty array. */
function isCompatible(change: unknown, existing: unknown): boolean {
    if (!existing || !change) {
        return true;
    }
    if (isArray(existing) && existing.length === 0 && isPlainObject(change)) {
        return true;
    }
    return isArray(existing) === isArray(change);
}

function withoutKey(state: State, key: string): State {
    const next: State = {...state};
    delete next[key];
    return next;
}

function applySet(state: State, key: string, value: unknown): State {
    const effectiveValue = isSkippable(key) ? null : value;
    if (effectiveValue === undefined || !isCompatible(effectiveValue, state[key])) {
        return state;
    }
    if (effectiveValue === null) {
        return withoutKey(state, key);
    }
    return {...state, [key]: withoutNestedNulls(effectiveValue)};
}

function applyMerge(state: State, key: string, change: unknown): State {
    if (change === undefined || isSkippable(key) || !isCompatible(change, state[key])) {
        return state;
    }
    if (change === null) {
        return withoutKey(state, key);
    }
    return {...state, [key]: mergeValue(state[key], change)};
}

function belongsTo(collectionKey: string, memberKeys: string[]): boolean {
    return memberKeys.every((memberKey) => memberKey.startsWith(collectionKey));
}

/**
 * Applies one update the way the public single-operation API documents it, one after the other.
 * `Onyx.update` must end in the same state for every batch this model covers.
 */
function applyUpdate(state: State, update: Update): State {
    const {key, value} = update;
    switch (update.onyxMethod) {
        case 'set':
            return applySet(state, key, value);
        case 'merge':
            return applyMerge(state, key, value);
        case 'multiset':
            if (!isPlainObject(value)) {
                return state;
            }
            return Object.entries(value).reduce((next, [memberKey, memberValue]) => applySet(next, memberKey, memberValue), state);
        case 'mergecollection': {
            if (!isPlainObject(value) || Object.keys(value).length === 0 || !belongsTo(key, Object.keys(value))) {
                return state;
            }
            return Object.entries(value).reduce((next, [memberKey, memberValue]) => applyMerge(next, memberKey, memberValue), state);
        }
        case 'setcollection': {
            if (!isPlainObject(value) || !belongsTo(key, Object.keys(value))) {
                return state;
            }
            const withoutDropped = Object.keys(state)
                .filter((existingKey) => existingKey.startsWith(key) && !(existingKey in value))
                .reduce(withoutKey, state);
            return Object.entries(value).reduce((next, [memberKey, memberValue]) => applySet(next, memberKey, memberValue), withoutDropped);
        }
        case 'clear':
            return defaultState();
        default:
            return state;
    }
}

function applyUpdates(state: State, updates: Update[]): State {
    return updates.reduce(applyUpdate, state);
}

export {defaultState, applyUpdate, applyUpdates, mergeValue, withoutNestedNulls, getCollectionKey};

if (isRunningAsSuite(__filename)) {
    describe('update reference model', () => {
        it('deep merges objects and removes keys merged with null', () => {
            expect(mergeValue({a: 1, b: {c: 1, d: 2}}, {b: {c: null, e: 3}, f: null})).toEqual({a: 1, b: {d: 2, e: 3}});
        });

        it('replaces arrays and primitives instead of merging them', () => {
            expect(mergeValue({a: [1, 2]}, {a: [3]})).toEqual({a: [3]});
            expect(mergeValue({a: 1}, 'text')).toBe('text');
        });

        it('treats a set as a replacement without nested nulls', () => {
            expect(applyUpdates({test: {a: 1}}, [{onyxMethod: 'set', key: 'test', value: {b: {c: null}}}])).toEqual({test: {b: {}}});
        });

        it('removes collection members missing from a setCollection', () => {
            const state = {colA_1: {a: 1}, colA_2: {a: 2}, colB_1: {b: 1}};
            expect(applyUpdates(state, [{onyxMethod: 'setcollection', key: 'colA_', value: {colA_2: {a: 3}}}])).toEqual({colA_2: {a: 3}, colB_1: {b: 1}});
        });

        it('resolves the most specific collection of a prefix-colliding key', () => {
            expect(getCollectionKey('nest_level_1')).toBe('nest_level_');
            expect(getCollectionKey('nest_1')).toBe('nest_');
            expect(getCollectionKey('nvp_test')).toBeUndefined();
        });
    });
}
