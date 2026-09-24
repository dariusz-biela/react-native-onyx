import type {State} from './harness';

import {StorageMock, deepClone, isPlainObject, isRunningAsSuite} from './harness';

const REPLACE_MARK = 'ONYX_INTERNALS__REPLACE_OBJECT_MARK';

type StorageCall = {order: number; apply: (store: State) => void};

/** Serializes like SQLiteProvider: JSON text, with the replace marker dropped for merges only. */
function toJSON(value: unknown, dropMarkers: boolean): unknown {
    const text = JSON.stringify(value, (key: string, entry: unknown) => (dropMarkers && key === REPLACE_MARK ? undefined : entry));
    return text === undefined ? undefined : JSON.parse(text);
}

/** SQLite JSON_PATCH, which follows RFC 7396. */
function jsonPatch(target: unknown, patch: unknown): unknown {
    if (!isPlainObject(patch)) {
        return patch;
    }
    const result: State = isPlainObject(target) ? {...target} : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete result[key];
        } else {
            result[key] = jsonPatch(result[key], value);
        }
    }
    return result;
}

/** SQLite JSON_REPLACE, which only writes a path that already exists. */
function jsonReplace(target: unknown, path: string[], value: unknown): unknown {
    const [head, ...rest] = path;
    if (head === undefined) {
        return value;
    }
    if (!isPlainObject(target) || !(head in target)) {
        return target;
    }
    return {...target, [head]: jsonReplace(target[head], rest, value)};
}

function isPatchList(value: unknown): value is Array<[string[], unknown]> {
    return Array.isArray(value) && value.every((patch) => Array.isArray(patch) && Array.isArray(patch[0]));
}

function mergeLikeSQLite(store: State, key: string, change: unknown, patches: unknown): void {
    if (change === undefined) {
        return;
    }
    const serialized = toJSON(change, true);
    // eslint-disable-next-line no-param-reassign
    store[key] = key in store ? jsonPatch(store[key], serialized) : serialized;
    if (!isPatchList(patches) || !(key in store)) {
        return;
    }
    for (const [path, value] of patches) {
        // eslint-disable-next-line no-param-reassign
        store[key] = jsonReplace(store[key], path, toJSON(value, false));
    }
}

function setLikeSQLite(store: State, key: string, value: unknown): void {
    // eslint-disable-next-line no-param-reassign
    store[key] = toJSON(value === undefined ? null : value, false);
}

function removeFromStore(store: State, key: string): void {
    // eslint-disable-next-line no-param-reassign
    delete store[key];
}

function isPair(value: unknown): value is [string, unknown, unknown?] {
    return Array.isArray(value) && typeof value[0] === 'string';
}

function pairsOf(value: unknown): Array<[string, unknown, unknown?]> {
    return Array.isArray(value) ? value.filter(isPair) : [];
}

function keysOf(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
}

function collectCalls(): StorageCall[] {
    const calls: StorageCall[] = [];
    const add = (mock: {mock: {calls: unknown[][]; invocationCallOrder: number[]}}, apply: (args: unknown[], store: State) => void) => {
        for (const [index, args] of mock.mock.calls.entries()) calls.push({order: mock.mock.invocationCallOrder[index], apply: (store) => apply(args, store)});
    };
    add(StorageMock.setItem, ([key, value], store) => typeof key === 'string' && setLikeSQLite(store, key, value));
    add(StorageMock.multiSet, ([pairs], store) => {
        for (const [key, value] of pairsOf(pairs)) setLikeSQLite(store, key, value);
    });
    add(StorageMock.mergeItem, ([key, change, patches], store) => typeof key === 'string' && mergeLikeSQLite(store, key, change, patches));
    add(StorageMock.multiMerge, ([pairs], store) => {
        for (const [key, change, patches] of pairsOf(pairs)) mergeLikeSQLite(store, key, change, patches);
    });
    add(StorageMock.removeItem, ([key], store) => typeof key === 'string' && removeFromStore(store, key));
    add(StorageMock.removeItems, ([keys], store) => {
        for (const key of keysOf(keys)) removeFromStore(store, key);
    });
    add(StorageMock.clear, (_args, store) => {
        for (const key of Object.keys(store)) removeFromStore(store, key);
    });
    return calls.sort((left, right) => left.order - right.order);
}

/**
 * Starts recording the storage calls. The returned function replays them with SQLiteProvider semantics on top of
 * the storage content at start, because the in-memory mock merges with its own rules and ignores the replace patches.
 */
function recordStorageForSQLite(): () => State {
    const baseline: State = deepClone(StorageMock.getMockStore());
    for (const mock of [StorageMock.setItem, StorageMock.multiSet, StorageMock.mergeItem, StorageMock.multiMerge, StorageMock.removeItem, StorageMock.removeItems, StorageMock.clear]) {
        mock.mockClear();
    }
    return () => {
        const store: State = deepClone(baseline);
        for (const call of collectCalls()) {
            call.apply(store);
        }
        return Object.fromEntries(Object.entries(store).filter(([, value]) => value !== null && value !== undefined));
    };
}

export {recordStorageForSQLite, jsonPatch, jsonReplace};

if (isRunningAsSuite(__filename)) {
    describe('SQLite storage replay', () => {
        it('follows RFC 7396 for JSON_PATCH', () => {
            expect(jsonPatch({a: 1, b: {c: 1, d: 1}}, {a: null, b: {c: 2}, e: [1]})).toEqual({b: {c: 2, d: 1}, e: [1]});
            expect(jsonPatch([1], {a: 1})).toEqual({a: 1});
            expect(jsonPatch({a: 1}, 5)).toEqual(5);
        });

        it('only replaces paths that exist', () => {
            expect(jsonReplace({a: {b: 1}}, ['a'], {c: 1})).toEqual({a: {c: 1}});
            expect(jsonReplace({a: 1}, ['x', 'y'], 1)).toEqual({a: 1});
        });
    });
}
