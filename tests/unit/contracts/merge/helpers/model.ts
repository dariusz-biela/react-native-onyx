/**
 * Reference model of the `Onyx.merge` value semantics, written independently of `lib/` so the contract
 * tests do not trust the code they check. It also holds the seeded generators the fuzz tests use.
 *
 * Jest treats every file under `tests/unit` as a test file, so the self-test at the bottom only registers
 * when Jest runs this file directly.
 */

type PlainObject = Record<string, unknown>;

type Rng = () => number;

const REPLACE_OBJECT_MARK = 'ONYX_INTERNALS__REPLACE_OBJECT_MARK';

function isPlainObject(value: unknown): value is PlainObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp);
}

function isObjectLike(value: unknown): boolean {
    return typeof value === 'object' && value !== null;
}

/** Deep merge of one change into a value: objects merge key by key, nested nulls delete, everything else replaces. */
function mergeValue(target: unknown, source: unknown): unknown {
    if (!isPlainObject(source)) {
        return source;
    }

    const base: PlainObject = isPlainObject(target) ? target : {};
    const result: PlainObject = {};

    for (const key of Object.keys(base)) {
        const baseProperty = base[key];
        if (baseProperty === undefined || baseProperty === null || source[key] === null) {
            continue;
        }
        result[key] = baseProperty;
    }

    for (const key of Object.keys(source)) {
        const sourceProperty = source[key];
        if (sourceProperty === undefined || sourceProperty === null) {
            continue;
        }
        result[key] = isPlainObject(sourceProperty) ? mergeValue(base[key], sourceProperty) : sourceProperty;
    }

    return result;
}

/** Whether Onyx accepts a change against the value the batch started from (arrays and non-arrays never mix, an empty array coerces). */
function isCompatible(change: unknown, existingValue: unknown): boolean {
    if (!existingValue || !change) {
        return true;
    }
    if (Array.isArray(existingValue) && existingValue.length === 0 && typeof change === 'object' && !Array.isArray(change)) {
        return true;
    }
    return Array.isArray(existingValue) === Array.isArray(change);
}

/**
 * The value a key holds after one batch of same-tick merges. `undefined` means the key is absent.
 * Compatibility is judged against the value before the batch, as Onyx does.
 */
function applyBatch(existingValue: unknown, changes: unknown[]): unknown {
    const validChanges = changes.filter((change) => change !== undefined && isCompatible(change, existingValue));
    if (validChanges.length === 0) {
        return existingValue;
    }

    const lastChange = validChanges.at(-1);
    if (lastChange === null) {
        return undefined;
    }
    if (Array.isArray(lastChange) || !validChanges.some(isObjectLike)) {
        return lastChange;
    }

    let value: unknown = existingValue ?? {};
    for (const change of validChanges) {
        value = mergeValue(value, change);
    }
    return value;
}

/** The states a key goes through for a list of batches, index 0 being the initial state. */
function statesForBatches(initialValue: unknown, batches: unknown[][]): unknown[] {
    const states = [initialValue];
    for (const batch of batches) {
        states.push(applyBatch(states.at(-1), batch));
    }
    return states;
}

/* eslint-disable no-bitwise */
/** Deterministic PRNG (mulberry32), so every fuzz case is reproducible from its seed. */
function createRng(seed: number): Rng {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/* eslint-enable no-bitwise */

function pick<T>(rng: Rng, items: readonly T[]): T {
    return items[Math.floor(rng() * items.length)];
}

const PROPERTY_NAMES = ['a', 'b', 'c', 'd'] as const;
const PRIMITIVES = [0, 1, 2, '', 'x', 'y', true, false] as const;
const ARRAYS = [[], [1], [1, 2], [{a: 1}], [null, 1]] as const;

function generatePropertyValue(rng: Rng, depth: number): unknown {
    const roll = rng();
    if (roll < 0.3 && depth < 3) {
        return generatePatch(rng, depth + 1);
    }
    if (roll < 0.45) {
        return null;
    }
    if (roll < 0.5) {
        return undefined;
    }
    if (roll < 0.85) {
        return pick(rng, PRIMITIVES);
    }
    return JSON.parse(JSON.stringify(pick(rng, ARRAYS))) as unknown;
}

/** A random object patch with nested objects, nulls, undefined, primitives and arrays. */
function generatePatch(rng: Rng, depth = 1): PlainObject {
    const patch: PlainObject = {};
    const size = 1 + Math.floor(rng() * 3);
    for (let index = 0; index < size; index++) {
        patch[pick(rng, PROPERTY_NAMES)] = generatePropertyValue(rng, depth);
    }
    return patch;
}

/** A random top-level merge change: mostly object patches, sometimes null, undefined, an empty object, an array or a primitive. */
function generateChange(rng: Rng): unknown {
    const roll = rng();
    if (roll < 0.08) {
        return null;
    }
    if (roll < 0.13) {
        return undefined;
    }
    if (roll < 0.17) {
        return {};
    }
    if (roll < 0.2) {
        return JSON.parse(JSON.stringify(pick(rng, ARRAYS))) as unknown;
    }
    if (roll < 0.22) {
        return pick(rng, PRIMITIVES);
    }
    return generatePatch(rng);
}

function generateBatch(rng: Rng): unknown[] {
    const size = 1 + Math.floor(rng() * 4);
    return Array.from({length: size}, () => generateChange(rng));
}

type WriteKind = 'object' | 'null' | 'scalar';

function writeKind(value: unknown): WriteKind {
    if (value === null) {
        return 'null';
    }
    return isPlainObject(value) ? 'object' : 'scalar';
}

function containsNull(value: unknown): boolean {
    if (!isPlainObject(value)) {
        return false;
    }
    return Object.values(value).some((property) => property === null || containsNull(property));
}

type PathWrite = {kind: WriteKind; value: unknown; changeIndex: number};

/** Every write the changes make, grouped by the property path they write to (the top level is the empty path). */
function collectPathWrites(changes: unknown[]): Map<string, PathWrite[]> {
    const writes = new Map<string, PathWrite[]>();

    const visit = (value: unknown, path: string, changeIndex: number) => {
        if (value === undefined) {
            return;
        }
        const list = writes.get(path) ?? [];
        list.push({kind: writeKind(value), value, changeIndex});
        writes.set(path, list);
        if (isPlainObject(value)) {
            for (const [key, property] of Object.entries(value)) {
                visit(property, `${path}/${key}`, changeIndex);
            }
        }
    };

    for (const [changeIndex, change] of changes.entries()) {
        visit(change, '', changeIndex);
    }
    return writes;
}

function isDescendantOrSelf(path: string, ancestor: string): boolean {
    return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * Whether a batch avoids the patterns where the native variant is known to diverge from the web one in
 * the cache. Both are pinned by the suspected bug tests:
 * - a top-level scalar followed by an object, which native merges into the old value instead of replacing it;
 * - a scalar (or array) written to a nested path and then an object written to the same path;
 * - a nested null followed by an object at the same path, with a later null inside it, which native keeps.
 */
function isNativeCacheSafeBatch(changes: unknown[]): boolean {
    const definedChanges = changes.filter((change) => change !== undefined);
    const firstTopLevelScalar = definedChanges.findIndex((change) => change !== null && !isObjectLike(change));
    if (firstTopLevelScalar !== -1 && definedChanges.slice(firstTopLevelScalar + 1).some(isPlainObject)) {
        return false;
    }

    const writesByPath = collectPathWrites(definedChanges);
    for (const [path, pathWrites] of writesByPath) {
        if (path === '') {
            continue;
        }
        const firstScalar = pathWrites.findIndex((write) => write.kind === 'scalar');
        if (firstScalar !== -1 && pathWrites.slice(firstScalar + 1).some((write) => write.kind === 'object')) {
            return false;
        }
        const firstNull = pathWrites.find((write) => write.kind === 'null');
        if (!firstNull || !pathWrites.some((write) => write.kind === 'object' && write.changeIndex > firstNull.changeIndex)) {
            continue;
        }
        for (const [otherPath, otherWrites] of writesByPath) {
            if (otherPath !== path && isDescendantOrSelf(otherPath, path) && otherWrites.some((write) => write.kind === 'null' && write.changeIndex > firstNull.changeIndex)) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Whether a batch avoids every pattern where native storage (SQLite JSON_PATCH plus JSON_REPLACE of the
 * replace-null patches) is known to end up different from the cache. See the suspected bug tests.
 */
function isNativeStorageSafeBatch(existingValue: unknown, changes: unknown[]): boolean {
    const definedChanges = changes.filter((change) => change !== undefined);
    if (definedChanges.slice(0, -1).includes(null)) {
        return false;
    }
    if (existingValue === undefined && definedChanges.some(containsNull)) {
        return false;
    }
    if (!isNativeCacheSafeBatch(definedChanges)) {
        return false;
    }

    const writesByPath = collectPathWrites(definedChanges);
    for (const [path, pathWrites] of writesByPath) {
        if (path === '') {
            continue;
        }
        const lastNull = pathWrites.map((write) => write.kind).lastIndexOf('null');
        if (lastNull === -1) {
            continue;
        }
        const objectsAfterNull = pathWrites.slice(lastNull + 1).filter((write) => write.kind === 'object');
        if (objectsAfterNull.length === 0) {
            continue;
        }
        const [replacement] = objectsAfterNull;
        if (objectsAfterNull.length > 1 || containsNull(replacement.value)) {
            return false;
        }
        const firstNull = pathWrites.findIndex((write) => write.kind === 'null');
        if (pathWrites.slice(firstNull + 1, lastNull).some((write) => write.kind === 'object')) {
            return false;
        }
        for (const [otherPath, otherWrites] of writesByPath) {
            if (isDescendantOrSelf(otherPath, path) && otherWrites.some((write) => write.changeIndex > replacement.changeIndex)) {
                return false;
            }
        }
    }
    return true;
}

/** Recursively freezes a value so any in-place mutation by Onyx throws in strict mode. */
function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const property of Object.values(value)) {
            deepFreeze(property);
        }
    }
    return value;
}

/** Whether a stored value still carries anything Onyx must never keep: nested null or undefined, or the internal replace mark. */
function findForbiddenLeaf(value: unknown, path = ''): string | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    for (const [key, property] of Object.entries(value)) {
        if (key === REPLACE_OBJECT_MARK || property === null || property === undefined) {
            return `${path}/${key}`;
        }
        const nested = findForbiddenLeaf(property, `${path}/${key}`);
        if (nested) {
            return nested;
        }
    }
    return undefined;
}

if (expect.getState().testPath === __filename) {
    describe('merge contract reference model', () => {
        it('merges objects deeply, deletes nested nulls and replaces arrays', () => {
            expect(mergeValue({a: {b: 1, c: 2}, d: [1, 2]}, {a: {c: null, e: 3}, d: [3]})).toStrictEqual({a: {b: 1, e: 3}, d: [3]});
        });

        it('resets the base when a null precedes an object in one batch', () => {
            expect(applyBatch({old: 1}, [null, {fresh: 1}])).toStrictEqual({fresh: 1});
            expect(applyBatch({old: 1}, [{fresh: 1}, null])).toBeUndefined();
        });

        it('flags the known native divergences', () => {
            expect(isNativeStorageSafeBatch({a: 1}, [{a: null}, {a: {x: 1}}])).toBe(true);
            expect(isNativeStorageSafeBatch({a: 1}, [{a: null}, {a: {x: 1}}, {a: {y: 1}}])).toBe(false);
            expect(isNativeStorageSafeBatch({a: 1}, [null, {a: 1}])).toBe(false);
            expect(isNativeStorageSafeBatch({a: 1}, [{a: null}, {a: {x: 1}}, {a: [1]}])).toBe(false);
            expect(isNativeStorageSafeBatch(undefined, [{a: 1, b: null}])).toBe(false);
            expect(isNativeCacheSafeBatch([{a: 1}, {a: {x: 1}}])).toBe(false);
            expect(isNativeCacheSafeBatch(['text', {a: 1}])).toBe(false);
            expect(isNativeCacheSafeBatch([{a: null}, {a: {b: null}}])).toBe(false);
            expect(isNativeCacheSafeBatch([{a: null}, {a: {b: 1}}])).toBe(true);
        });

        it('generates the same sequence for the same seed', () => {
            expect(generateBatch(createRng(7))).toStrictEqual(generateBatch(createRng(7)));
        });
    });
}

export type {PlainObject, Rng};
export {
    REPLACE_OBJECT_MARK,
    applyBatch,
    createRng,
    deepFreeze,
    findForbiddenLeaf,
    generateBatch,
    generatePatch,
    isNativeCacheSafeBatch,
    isNativeStorageSafeBatch,
    isPlainObject,
    mergeValue,
    pick,
    statesForBatches,
};
