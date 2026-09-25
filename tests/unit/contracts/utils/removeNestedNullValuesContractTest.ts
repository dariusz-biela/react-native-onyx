/**
 * Contract tests for `utils.removeNestedNullValues`, which `Onyx.set`, `multiSet` and `setCollection` run on
 * every value before it reaches the cache, the subscribers and storage. `cache.hasValueChanged` and every
 * `===` check downstream depend on it returning the input when there is nothing to remove, and on it keeping
 * every untouched subtree by reference when there is.
 */
import type {PlainObject} from './helpers/values';

import utils from '../../../../lib/utils';
import {REPLACE_OBJECT_MARK, deepFreeze, isMergeable} from './helpers/values';

function objectOf(value: unknown): PlainObject {
    if (!isMergeable(value)) {
        throw new Error(`Expected a mergeable object, got ${String(value)}`);
    }
    return value;
}

function clean(value: unknown): unknown {
    return utils.removeNestedNullValues(deepFreeze(value));
}

class Profile {
    name: string;

    avatar: string | null;

    constructor(name: string, avatar: string | null) {
        this.name = name;
        this.avatar = avatar;
    }

    get label(): string {
        return this.name;
    }
}

describe('utils.removeNestedNullValues contract', () => {
    it('returns functions, dates, regular expressions, maps and arrays by reference, without looking inside arrays', () => {
        const values: unknown[] = [() => null, new Date(1), /x/, new Map([['a', null]]), [null, {a: null}]];
        for (const value of values) {
            expect(utils.removeNestedNullValues(value)).toBe(value);
        }
    });

    it('keeps nested arrays, dates and functions by reference while removing a null next to them', () => {
        const list = [null];
        const date = new Date(2);
        const callback = () => 1;
        const result = objectOf(clean({list, date, callback, gone: null}));

        expect(result.list).toBe(list);
        expect(result.date).toBe(date);
        expect(result.callback).toBe(callback);
        expect(Object.keys(result)).toStrictEqual(['list', 'date', 'callback']);
    });

    it('keeps falsy values that are not null or undefined', () => {
        const value = {zero: 0, empty: '', no: false, nan: Number.NaN};
        expect(clean(value)).toBe(value);
    });

    it('keeps objects that become empty instead of removing them', () => {
        expect(clean({a: {b: null}, c: {d: {e: undefined}}})).toStrictEqual({a: {}, c: {d: {}}});
    });

    it('keeps the key order of the input', () => {
        expect(Object.keys(objectOf(clean({z: 1, y: null, x: {w: null}, v: 2})))).toStrictEqual(['z', 'x', 'v']);
    });

    it('does not treat the replace-object mark as something to remove', () => {
        const value = {a: {[REPLACE_OBJECT_MARK]: true, b: 1}};
        expect(clean(value)).toBe(value);
        expect(clean({a: {[REPLACE_OBJECT_MARK]: true, b: null}})).toStrictEqual({a: {[REPLACE_OBJECT_MARK]: true}});
    });

    it('rebuilds every level on the path to a removed null and keeps each sibling subtree by reference', () => {
        const depth = 200;
        const siblings: PlainObject[] = [];
        let value: PlainObject = {leaf: 1, gone: null};
        for (let level = 0; level < depth; level++) {
            const sibling = {level, nested: {kept: true}};
            siblings.unshift(sibling);
            value = {next: value, sibling};
        }
        deepFreeze(value);

        let actual = objectOf(utils.removeNestedNullValues(value));
        let original = value;
        for (let level = 0; level < depth; level++) {
            expect(actual).not.toBe(original);
            expect(actual.sibling).toBe(siblings[level]);
            actual = objectOf(actual.next);
            original = objectOf(original.next);
        }
        expect(actual).toStrictEqual({leaf: 1});
    });

    it('returns the input for a 200 level deep value without nulls', () => {
        let value: PlainObject = {leaf: 1};
        for (let level = 0; level < 200; level++) {
            value = {next: value, list: [null]};
        }
        expect(clean(value)).toBe(value);
    });

    it('copies a personal details list only where an entry has nulls', () => {
        const list: PlainObject = {};
        for (let accountID = 1; accountID <= 30; accountID++) {
            list[accountID] = accountID % 3 === 0 ? {accountID, avatar: null, displayName: `${accountID}`} : {accountID, displayName: `${accountID}`};
        }
        const result = objectOf(clean(list));

        for (let accountID = 1; accountID <= 30; accountID++) {
            expect(result[accountID]).toStrictEqual({accountID, displayName: `${accountID}`});
            if (accountID % 3 === 0) {
                expect(result[accountID]).not.toBe(list[accountID]);
            } else {
                expect(result[accountID]).toBe(list[accountID]);
            }
        }
    });

    it('returns the same result for the same input on repeated calls, without caching a stale one', () => {
        const value: PlainObject = {a: {b: null, c: 1}};
        const first = clean(value);
        const second = utils.removeNestedNullValues(value);
        expect(second).toStrictEqual(first);

        const other = {a: {b: null, c: 2}};
        expect(utils.removeNestedNullValues(other)).toStrictEqual({a: {c: 2}});
    });

    it('keeps a class instance without nulls, and turns one with a null into a plain object of its own properties', () => {
        const complete = new Profile('a', 'x.png');
        expect(clean({profile: complete})).toStrictEqual({profile: complete});
        expect(objectOf(clean({profile: complete})).profile).toBe(complete);

        const partial = new Profile('b', null);
        const result = objectOf(clean({profile: partial}));
        expect(result.profile).not.toBeInstanceOf(Profile);
        expect(result.profile).toStrictEqual({name: 'b'});
    });

    it('never writes to the input', () => {
        const value = deepFreeze({a: null, b: {c: null, d: {e: undefined, f: 1}}, g: [null]});
        const snapshot = JSON.stringify(value);
        expect(() => utils.removeNestedNullValues(value)).not.toThrow();
        expect(JSON.stringify(value)).toBe(snapshot);
    });

    it('walks inherited enumerable properties and copies them onto the result when something is removed', () => {
        const value: PlainObject = Object.create({inherited: 1, inheritedNull: null});
        value.own = 1;
        const result = objectOf(utils.removeNestedNullValues(value));
        expect(Object.keys(result)).toStrictEqual(['own', 'inherited']);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });

    it('returns the input with inherited properties when none of them is null', () => {
        const value: PlainObject = Object.create({inherited: 1});
        value.own = 1;
        expect(utils.removeNestedNullValues(value)).toBe(value);
    });
});
