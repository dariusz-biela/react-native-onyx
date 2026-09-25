/**
 * Seeded value generators and small predicates shared by the `lib/utils.ts` contract tests. They are written
 * independently of `lib/` so the tests do not trust the code they check.
 *
 * Jest treats every file under `tests/unit` as a test file, so the self-test at the bottom only registers
 * when Jest runs this file directly.
 */

type PlainObject = Record<string, unknown>;

type Rng = () => number;

const REPLACE_OBJECT_MARK = 'ONYX_INTERNALS__REPLACE_OBJECT_MARK';

const KEY_POOL = ['a', 'b', 'c', 'd', 'e'];

const SHARED_DATES: readonly Date[] = [new Date(0), new Date(86400000)];

const SHARED_ARRAYS: ReadonlyArray<readonly unknown[]> = [Object.freeze([1, 2]), Object.freeze([null]), Object.freeze([Object.freeze({a: null})])];

/** Mulberry32, so a failing seed can be replayed exactly. */
/* eslint-disable no-bitwise -- a seeded PRNG needs 32-bit integer mixing */
function createRng(seed: number): Rng {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}
/* eslint-enable no-bitwise */

function pickOne<T>(rng: Rng, items: readonly T[]): T {
    return items[Math.floor(rng() * items.length)];
}

/** The same notion of "mergeable" the Onyx docs describe: a non-null object that is not an array, a Date or a RegExp. */
function isMergeable(value: unknown): value is PlainObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp);
}

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const property of Object.values(value)) {
            deepFreeze(property);
        }
    }
    return value;
}

/** Every object reachable from the value, including arrays and dates, so reference reuse can be checked. */
function collectObjectNodes(value: unknown, nodes = new Set<object>()): Set<object> {
    if (typeof value !== 'object' || value === null || nodes.has(value)) {
        return nodes;
    }
    nodes.add(value);
    for (const property of Object.values(value)) {
        collectObjectNodes(property, nodes);
    }
    return nodes;
}

function generateLeaf(rng: Rng): unknown {
    const roll = rng();
    if (roll < 0.14) {
        return null;
    }
    if (roll < 0.22) {
        return undefined;
    }
    if (roll < 0.42) {
        return Math.floor(rng() * 3);
    }
    if (roll < 0.57) {
        return pickOne(rng, ['x', 'y', '']);
    }
    if (roll < 0.67) {
        return rng() < 0.5;
    }
    if (roll < 0.77) {
        return pickOne(rng, SHARED_ARRAYS);
    }
    if (roll < 0.85) {
        return [Math.floor(rng() * 3), null];
    }
    if (roll < 0.93) {
        return pickOne(rng, SHARED_DATES);
    }
    return {};
}

type GenerateOptions = {
    withMarks: boolean;
};

function generateObject(rng: Rng, depth: number, options: GenerateOptions): PlainObject {
    const result: PlainObject = {};
    const keys = KEY_POOL.filter(() => rng() < 0.5).sort(() => rng() - 0.5);
    for (const key of keys) {
        result[key] = depth < 3 && rng() < 0.35 ? generateObject(rng, depth + 1, options) : generateLeaf(rng);
    }
    if (options.withMarks && depth > 0 && rng() < 0.2) {
        result[REPLACE_OBJECT_MARK] = rng() < 0.85;
    }
    return result;
}

function generateValue(rng: Rng, depth: number, options: GenerateOptions): unknown {
    return rng() < 0.8 ? generateObject(rng, depth, options) : generateLeaf(rng);
}

/**
 * A source that overlaps the target: some keys repeat the target's own values or references, some nested
 * objects are derived from the target's nested objects, and some keys are new. This makes the no-op and the
 * partial no-op paths common instead of rare.
 */
function deriveSource(rng: Rng, target: unknown, depth: number, options: GenerateOptions): unknown {
    if (!isMergeable(target) || rng() < 0.2) {
        return generateValue(rng, depth, options);
    }

    const result: PlainObject = {};
    for (const key of Object.keys(target)) {
        const roll = rng();
        if (roll < 0.35) {
            continue;
        }
        const targetProperty = target[key];
        if (targetProperty === null && depth < 3 && roll < 0.6) {
            result[key] = generateObject(rng, depth + 1, options);
        } else if (roll < 0.7) {
            result[key] = targetProperty;
        } else if (isMergeable(targetProperty) && depth < 3 && roll < 0.9) {
            result[key] = deriveSource(rng, targetProperty, depth + 1, options);
        } else {
            result[key] = depth < 3 && rng() < 0.3 ? generateObject(rng, depth + 1, options) : generateLeaf(rng);
        }
    }
    for (const key of KEY_POOL) {
        if (!(key in result) && rng() < 0.2) {
            result[key] = depth < 3 && rng() < 0.3 ? generateObject(rng, depth + 1, options) : generateLeaf(rng);
        }
    }
    if (options.withMarks && depth > 0 && rng() < 0.2) {
        result[REPLACE_OBJECT_MARK] = true;
    }
    return result;
}

/** JSON with `undefined` spelled out, so a failure message shows every input exactly. */
function describeValue(value: unknown): string {
    return JSON.stringify(value, (_key, property: unknown) => {
        if (property === undefined) {
            return '__undefined__';
        }
        if (property instanceof Date) {
            return `__date_${property.getTime()}__`;
        }
        return property;
    });
}

if (expect.getState().testPath === __filename) {
    describe('utils contract helpers', () => {
        it('generates the same sequence for the same seed', () => {
            expect(describeValue(generateValue(createRng(3), 0, {withMarks: true}))).toBe(describeValue(generateValue(createRng(3), 0, {withMarks: true})));
        });

        it('treats arrays, dates and regular expressions as not mergeable', () => {
            expect([isMergeable([]), isMergeable(new Date()), isMergeable(/a/), isMergeable(null), isMergeable('a'), isMergeable({})]).toStrictEqual([
                false,
                false,
                false,
                false,
                false,
                true,
            ]);
        });

        it('collects every nested object once', () => {
            const shared = {a: 1};
            expect(collectObjectNodes({x: shared, y: shared, z: [shared]}).size).toBe(3);
        });
    });
}

export type {GenerateOptions, PlainObject, Rng};
export {REPLACE_OBJECT_MARK, collectObjectNodes, createRng, deepFreeze, deriveSource, describeValue, generateLeaf, generateObject, generateValue, isMergeable, pickOne};
