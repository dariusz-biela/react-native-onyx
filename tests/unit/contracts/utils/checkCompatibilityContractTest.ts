/**
 * Contract tests for `utils.checkCompatibilityWithExistingValue`, the type check `Onyx.set`, `Onyx.merge` and
 * `mergeCollection` run before a write. An incompatible result drops the write and logs the two types, and an
 * empty array coercion lets an object replace an empty array that the server sent for an empty object.
 */
import utils from '../../../../lib/utils';

type Compatibility = {
    isCompatible: boolean;
    isEmptyArrayCoercion: boolean;
    existingValueType?: string;
    newValueType?: string;
};

/** What callers read from the result: the verdict, the coercion flag, and the two types only when the write is rejected. */
function compatibilityOf(value: unknown, existingValue: unknown): Compatibility {
    const result = utils.checkCompatibilityWithExistingValue(value, existingValue);
    if (result.isCompatible) {
        return {isCompatible: true, isEmptyArrayCoercion: result.isEmptyArrayCoercion === true};
    }
    return {isCompatible: false, isEmptyArrayCoercion: result.isEmptyArrayCoercion === true, existingValueType: result.existingValueType, newValueType: result.newValueType};
}

const COMPATIBLE: Compatibility = {isCompatible: true, isEmptyArrayCoercion: false};
const COERCED: Compatibility = {isCompatible: true, isEmptyArrayCoercion: true};
const OBJECT_OVER_ARRAY: Compatibility = {isCompatible: false, isEmptyArrayCoercion: false, existingValueType: 'array', newValueType: 'non-array'};
const ARRAY_OVER_OBJECT: Compatibility = {isCompatible: false, isEmptyArrayCoercion: false, existingValueType: 'non-array', newValueType: 'array'};

const VALUE_KINDS: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['an empty string', ''],
    ['false', false],
    ['a number', 5],
    ['a string', 'text'],
    ['true', true],
    ['an empty object', {}],
    ['an object', {a: 1}],
    ['an empty array', []],
    ['an array', [1]],
    ['a Date', new Date(1)],
    ['a RegExp', /x/],
];

function isFalsy(value: unknown): boolean {
    return value === undefined || value === null || value === 0 || value === '' || value === false;
}

/** The rules, written out: falsy on either side passes, an object may replace an empty array, otherwise array-ness must match. */
function expectedCompatibility(value: unknown, existingValue: unknown): Compatibility {
    if (isFalsy(value) || isFalsy(existingValue)) {
        return COMPATIBLE;
    }
    const isValueArray = Array.isArray(value);
    const isExistingArray = Array.isArray(existingValue);
    if (isExistingArray && existingValue.length === 0 && typeof value === 'object' && !isValueArray) {
        return COERCED;
    }
    if (isValueArray === isExistingArray) {
        return COMPATIBLE;
    }
    return isExistingArray ? OBJECT_OVER_ARRAY : ARRAY_OVER_OBJECT;
}

describe('utils.checkCompatibilityWithExistingValue contract', () => {
    describe.each(VALUE_KINDS)('a value that is %s', (_valueName, value) => {
        it.each(VALUE_KINDS)('over an existing value that is %s follows the rules', (_existingName, existingValue) => {
            expect(compatibilityOf(value, existingValue)).toStrictEqual(expectedCompatibility(value, existingValue));
        });
    });

    it.each([
        ['an object over an array', {a: 1}, [1], OBJECT_OVER_ARRAY],
        ['a string over an array', 'text', [1], OBJECT_OVER_ARRAY],
        ['a string over an empty array', 'text', [], OBJECT_OVER_ARRAY],
        ['an array over an object', [1], {a: 1}, ARRAY_OVER_OBJECT],
        ['an array over a string', [1], 'text', ARRAY_OVER_OBJECT],
        ['an array over a Date', [1], new Date(1), ARRAY_OVER_OBJECT],
        ['an object over an empty array', {a: 1}, [], COERCED],
        ['an empty object over an empty array', {}, [], COERCED],
        ['a Date over an empty array', new Date(1), [], COERCED],
        ['an array over an empty array', [1], [], COMPATIBLE],
        ['an empty array over an empty array', [], [], COMPATIBLE],
        ['null over an array', null, [1], COMPATIBLE],
        ['an array over null', [1], null, COMPATIBLE],
        ['an array over zero', [1], 0, COMPATIBLE],
        ['an object over an object', {a: 1}, {b: 1}, COMPATIBLE],
        ['a string over an object', 'text', {a: 1}, COMPATIBLE],
    ])('%s', (_name, value, existingValue, expected) => {
        expect(compatibilityOf(value, existingValue)).toStrictEqual(expected);
    });

    it('reports the rejected types only on a rejected write', () => {
        expect(utils.checkCompatibilityWithExistingValue({a: 1}, [1])).toStrictEqual({isCompatible: false, existingValueType: 'array', newValueType: 'non-array'});
        expect(utils.checkCompatibilityWithExistingValue([1], {a: 1})).toStrictEqual({isCompatible: false, existingValueType: 'non-array', newValueType: 'array'});
    });

    it('never writes to its inputs', () => {
        const value = Object.freeze({a: 1});
        const existing = Object.freeze([]);
        expect(() => utils.checkCompatibilityWithExistingValue(value, existing)).not.toThrow();
        expect(existing).toStrictEqual([]);
        expect(value).toStrictEqual({a: 1});
    });
});
