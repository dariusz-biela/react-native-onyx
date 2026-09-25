/**
 * Contract tests for the smaller `lib/utils.ts` exports: `needsNormalization` (which decides whether the cache
 * may store a hydrated value by reference), `isEmptyObject`, `pick`, `omit`, `chunkArray` (SQLite query
 * batching) and `formatActionName` (DevTools action names).
 */
import type {FastMergeOptions} from '../../../../lib/utils';
import type {PlainObject} from './helpers/values';

import utils from '../../../../lib/utils';
import {REPLACE_OBJECT_MARK, createRng, deepFreeze, describeValue, generateValue} from './helpers/values';

const CACHE_OPTIONS: FastMergeOptions = {shouldRemoveNestedNulls: true, objectRemovalMode: 'replace'};

/** True when some object level, walked the way the cache walks it, holds a null, an undefined or the replace mark. */
function hasSomethingToNormalize(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    // eslint-disable-next-line no-restricted-syntax, guard-for-in
    for (const key in value) {
        const property: unknown = Reflect.get(value, key);
        if (key === REPLACE_OBJECT_MARK || property === null || property === undefined || hasSomethingToNormalize(property)) {
            return true;
        }
    }
    return false;
}

describe('utils.needsNormalization contract', () => {
    it('agrees with the rules for generated values', () => {
        let needed = 0;
        for (let seed = 1; seed <= 400; seed++) {
            const value = deepFreeze(generateValue(createRng(seed * 13), 0, {withMarks: true}));
            const actual = utils.needsNormalization(value);
            expect({label: describeValue(value), actual}).toStrictEqual({label: describeValue(value), actual: hasSomethingToNormalize(value)});
            if (actual) {
                needed++;
            }
        }
        expect(needed).toBeGreaterThan(40);
        expect(needed).toBeLessThan(360);
    });

    it('answers false only for values the cache merge would store unchanged, so storing them by reference is safe', () => {
        for (let seed = 1; seed <= 400; seed++) {
            const value = deepFreeze(generateValue(createRng(seed * 17), 0, {withMarks: true}));
            const normalized = utils.fastMerge<unknown>(undefined, value, CACHE_OPTIONS).result;
            const label = describeValue(value);

            if (!utils.needsNormalization(value)) {
                expect({label, normalized}).toStrictEqual({label, normalized: value});
            }
        }
    });

    it('answers true for a nested null, a nested undefined and any replace mark, even a false one', () => {
        const values: unknown[] = [
            {a: null},
            {a: undefined},
            {a: {b: {c: null}}},
            {a: {[REPLACE_OBJECT_MARK]: true, b: 1}},
            {a: {[REPLACE_OBJECT_MARK]: false}},
            {[REPLACE_OBJECT_MARK]: true},
        ];
        for (const value of values) {
            expect(utils.needsNormalization(value)).toBe(true);
        }
    });

    it('looks at inherited enumerable properties and inside class instances', () => {
        const inherited: PlainObject = Object.create({gone: null});
        expect(utils.needsNormalization(inherited)).toBe(true);

        class Holder {
            value: unknown;

            constructor(value: unknown) {
                this.value = value;
            }
        }
        expect(utils.needsNormalization({holder: new Holder(null)})).toBe(true);
        expect(utils.needsNormalization({holder: new Holder(1)})).toBe(false);
    });

    it('does not look inside arrays, even at depth', () => {
        expect(utils.needsNormalization({a: {b: [{c: null}, null, {[REPLACE_OBJECT_MARK]: true}]}})).toBe(false);
    });
});

describe('utils.isEmptyObject contract', () => {
    it.each([
        ['an empty object', {}, true],
        ['null', null, true],
        ['an empty array', [], true],
        ['a Date', new Date(1), true],
        ['a Map with entries', new Map([['a', 1]]), true],
        ['an object with only inherited properties', Object.create({a: 1}), true],
        ['an object with only a symbol key', {[Symbol('s')]: 1}, true],
        ['an object with only a non-enumerable property', Object.defineProperty({}, 'a', {value: 1, enumerable: false}), true],
        ['undefined', undefined, false],
        ['an object with an undefined property', {a: undefined}, false],
        ['an object with a null property', {a: null}, false],
        ['a non-empty array', [undefined], false],
        ['an empty string', '', false],
        ['zero', 0, false],
        ['a function', () => undefined, false],
    ])('%s', (_name, value, expected) => {
        expect(utils.isEmptyObject(value)).toBe(expected);
    });
});

describe('utils.pick and utils.omit contract', () => {
    const source = deepFreeze({b: {x: 1}, a: 2, c: null, d: undefined});

    it('pick keeps the named keys in the order of the object, with the same values', () => {
        const picked = utils.pick<unknown>(source, ['d', 'a', 'b', 'missing']);
        expect(Object.keys(picked)).toStrictEqual(['b', 'a', 'd']);
        expect(picked.b).toBe(source.b);
        expect('d' in picked).toBe(true);
    });

    it('pick and omit split the keys between them for every kind of condition', () => {
        const conditions: Array<string | string[] | ((entry: [string, unknown]) => boolean)> = ['a', ['a', 'c'], [], ([key, value]) => key === 'b' || value === null];
        for (const condition of conditions) {
            const picked = utils.pick<unknown>(source, condition);
            const omitted = utils.omit<unknown>(source, condition);
            expect(Object.keys({...picked, ...omitted}).sort()).toStrictEqual(['a', 'b', 'c', 'd']);
            expect(Object.keys(picked).filter((key) => key in omitted)).toStrictEqual([]);
        }
    });

    it('a string condition matches the whole key, not a prefix', () => {
        const prefixed = {report_: 1, report_1: 2, report_12: 3};
        expect(utils.pick(prefixed, 'report_1')).toStrictEqual({report_1: 2});
        expect(utils.omit(prefixed, 'report_1')).toStrictEqual({report_: 1, report_12: 3});
    });

    it('a function condition sees each own entry once, in order', () => {
        const seen: Array<[string, unknown]> = [];
        utils.omit<unknown>(source, (entry) => {
            seen.push(entry);
            return false;
        });
        expect(seen).toStrictEqual([
            ['b', {x: 1}],
            ['a', 2],
            ['c', null],
            ['d', undefined],
        ]);
    });

    it('omit keeps the remaining keys in order and returns a new object', () => {
        const omitted = utils.omit<unknown>(source, ['a']);
        expect(Object.keys(omitted)).toStrictEqual(['b', 'c', 'd']);
        expect(omitted).not.toBe(source);
        expect(utils.omit<unknown>(source, [])).toStrictEqual(source);
    });
});

describe('utils.chunkArray contract', () => {
    it('splits into consecutive chunks that concatenate back to the input, without touching it', () => {
        const items = Object.freeze(Array.from({length: 23}, (_, index) => index));
        for (const size of [1, 2, 5, 22, 23, 24, 100]) {
            const chunks = utils.chunkArray(items, size);
            expect(chunks.flat()).toStrictEqual([...items]);
            expect(chunks.length).toBe(Math.ceil(items.length / size));
            expect(chunks.slice(0, -1).every((chunk) => chunk.length === size)).toBe(true);
        }
    });

    it('returns chunks that are copies once the input is split', () => {
        const items = [1, 2, 3];
        const chunks = utils.chunkArray(items, 2);
        expect(chunks[0]).not.toBe(items);
        chunks[0].push(99);
        expect(items).toStrictEqual([1, 2, 3]);
    });
});

describe('utils.formatActionName contract', () => {
    it.each([
        ['merge', 'report_1', 'MERGE/report_1'],
        ['mergecollection', 'report_', 'MERGECOLLECTION/report_'],
        ['Set', 'a/b', 'SET/a/b'],
        ['clear', undefined, 'CLEAR'],
        ['set', '', 'SET'],
    ])('formats %s with key %s', (method, key, expected) => {
        expect(utils.formatActionName(method, key)).toBe(expected);
    });
});
