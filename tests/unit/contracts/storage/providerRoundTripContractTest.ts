import type {StorageKeyValuePair} from '../../../../lib/storage/providers/types';
import {PROVIDER_TARGETS, sorted} from './harness';
import type {OnyxKey} from '../../../../lib/types';

const PLAIN: OnyxKey = 'plain';
const OTHER: OnyxKey = 'other';
const MEMBER_1: OnyxKey = 'test_1';
const MEMBER_10: OnyxKey = 'test_10';
const MEMBER_1X: OnyxKey = 'test_1x';
const OTHER_COLLECTION_MEMBER: OnyxKey = 'test2_1';

const NESTED_VALUE = {id: 1, nested: {list: [1, {deep: true}], flag: false, text: ''}};

/** Values an optimizer could mistake for "nothing to write" with a truthiness check. */
const EDGE_VALUES: Array<[string, unknown]> = [
    ['zero', 0],
    ['false', false],
    ['empty string', ''],
    ['empty object', {}],
    ['empty array', []],
    ['negative number', -1.5],
    ['string', 'value'],
    ['true', true],
    ['nested object', NESTED_VALUE],
    ['array of objects', [{id: 1}, {id: 2, nested: {deep: [3]}}]],
];

describe.each(PROVIDER_TARGETS)('$name round trips', (target) => {
    const {provider} = target;

    beforeEach(() => target.reset());

    describe('setItem and getItem', () => {
        it.each(EDGE_VALUES)('stores and returns %s', async (_label, value) => {
            await provider.setItem(PLAIN, value);

            expect(await provider.getItem(PLAIN)).toEqual(value);
            expect(await target.readRaw()).toEqual({[PLAIN]: value});
        });

        it('returns null, not undefined, for a key that was never written', async () => {
            await provider.setItem(OTHER, 'value');

            expect(await provider.getItem(PLAIN)).toBeNull();
        });

        it('replaces the previous value instead of merging into it', async () => {
            await provider.setItem(PLAIN, {a: 1, nested: {b: 2}});
            await provider.setItem(PLAIN, {nested: {c: 3}});

            expect(await provider.getItem(PLAIN)).toEqual({nested: {c: 3}});
        });

        it('replaces an object with a primitive and a primitive with an object', async () => {
            await provider.setItem(PLAIN, {a: 1});
            await provider.setItem(PLAIN, 'text');
            expect(await provider.getItem(PLAIN)).toBe('text');

            await provider.setItem(PLAIN, {b: 2});
            expect(await provider.getItem(PLAIN)).toEqual({b: 2});
        });

        it('keeps prefix-colliding keys apart', async () => {
            await provider.setItem(MEMBER_1, 'one');
            await provider.setItem(MEMBER_10, 'ten');
            await provider.setItem(MEMBER_1X, 'one x');

            expect(await provider.getItem(MEMBER_1)).toBe('one');
            expect(await provider.getItem(MEMBER_10)).toBe('ten');
            expect(await provider.getItem(MEMBER_1X)).toBe('one x');
        });

        it('does not change the value it was given', async () => {
            const value = {a: 1, nested: {b: [1, 2]}};
            const snapshot = structuredClone(value);

            await provider.setItem(PLAIN, value);

            expect(value).toEqual(snapshot);
        });
    });

    describe('multiSet', () => {
        it('writes every pair of the batch', async () => {
            const pairs: StorageKeyValuePair[] = [
                [PLAIN, 'plain value'],
                [MEMBER_1, {id: 1}],
                [MEMBER_10, 0],
                [OTHER_COLLECTION_MEMBER, false],
            ];

            await provider.multiSet(pairs);

            expect(await target.readRaw()).toEqual({[PLAIN]: 'plain value', [MEMBER_1]: {id: 1}, [MEMBER_10]: 0, [OTHER_COLLECTION_MEMBER]: false});
        });

        it('keeps a pair written with an undefined value as a listed key that reads as null', async () => {
            await provider.multiSet([
                [PLAIN, undefined],
                [OTHER, 'value'],
            ]);

            expect(sorted(await provider.getAllKeys())).toEqual(sorted([PLAIN, OTHER]));
            expect(await provider.getItem(PLAIN)).toBeNull();
        });

        it('replaces existing values instead of merging and leaves keys outside the batch alone', async () => {
            await provider.multiSet([
                [PLAIN, {a: 1, b: 2}],
                [OTHER, 'kept'],
            ]);

            await provider.multiSet([[PLAIN, {c: 3}]]);

            expect(await target.readRaw()).toEqual({[PLAIN]: {c: 3}, [OTHER]: 'kept'});
        });

        it('keeps the last value when a key appears twice in one batch', async () => {
            await provider.multiSet([
                [PLAIN, 'first'],
                [PLAIN, 'second'],
            ]);

            expect(await provider.getItem(PLAIN)).toBe('second');
        });

        it('accepts an empty batch without touching stored data', async () => {
            await provider.setItem(PLAIN, 'value');

            await provider.multiSet([]);

            expect(await target.readRaw()).toEqual({[PLAIN]: 'value'});
        });

        it('does not change the pairs it was given', async () => {
            const pairs: StorageKeyValuePair[] = [
                [PLAIN, {nested: {a: 1}}],
                [OTHER, [1, 2]],
            ];
            const snapshot = structuredClone(pairs);

            await provider.multiSet(pairs);

            expect(pairs).toEqual(snapshot);
        });

        it('writes a large batch completely', async () => {
            const pairs: StorageKeyValuePair[] = Array.from({length: 300}, (_, index) => [`test_${index}`, {index}]);

            await provider.multiSet(pairs);

            const raw = await target.readRaw();
            expect(Object.keys(raw)).toHaveLength(300);
            expect(raw.test_0).toEqual({index: 0});
            expect(raw.test_299).toEqual({index: 299});
        });
    });

    describe('multiGet', () => {
        beforeEach(() =>
            provider.multiSet([
                [PLAIN, 'plain value'],
                [MEMBER_1, {id: 1}],
                [MEMBER_10, {id: 10}],
            ]),
        );

        it('returns [key, value] pairs in the order the keys were requested', async () => {
            expect(await provider.multiGet([MEMBER_10, PLAIN, MEMBER_1])).toEqual([
                [MEMBER_10, {id: 10}],
                [PLAIN, 'plain value'],
                [MEMBER_1, {id: 1}],
            ]);
        });

        it('returns one pair per requested key, repeated keys included', async () => {
            expect(await provider.multiGet([PLAIN, PLAIN])).toEqual([
                [PLAIN, 'plain value'],
                [PLAIN, 'plain value'],
            ]);
        });

        it('returns an empty list for an empty request', async () => {
            expect(await provider.multiGet([])).toEqual([]);
        });

        it('returns a nullish value for a missing key, keeping its position', async () => {
            const pairs = await provider.multiGet([MEMBER_1, MEMBER_1X, MEMBER_10]);

            expect(pairs).toHaveLength(3);
            expect(pairs[0]).toEqual([MEMBER_1, {id: 1}]);
            expect(pairs[1][0]).toBe(MEMBER_1X);
            expect(pairs[1][1] == null).toBe(true);
            expect(pairs[2]).toEqual([MEMBER_10, {id: 10}]);
        });

        it('sees the latest write for each key', async () => {
            await provider.setItem(MEMBER_1, {id: 1, changed: true});

            expect(await provider.multiGet([MEMBER_1])).toEqual([[MEMBER_1, {id: 1, changed: true}]]);
        });
    });

    describe('getAllKeys and getAll', () => {
        it('return nothing for an empty store', async () => {
            expect(await provider.getAllKeys()).toEqual([]);
            expect(await provider.getAll()).toEqual([]);
        });

        it('return every stored key once, with its current value', async () => {
            await provider.multiSet([
                [PLAIN, 'plain value'],
                [MEMBER_1, {id: 1}],
                [MEMBER_10, {id: 10}],
                [MEMBER_1X, 0],
            ]);
            await provider.setItem(MEMBER_1, {id: 1, changed: true});

            expect(sorted(await provider.getAllKeys())).toEqual(sorted([PLAIN, MEMBER_1, MEMBER_10, MEMBER_1X]));

            const all = await provider.getAll();
            expect(all).toHaveLength(4);
            expect(Object.fromEntries(all.map(([key, value]) => [key, value]))).toEqual({
                [PLAIN]: 'plain value',
                [MEMBER_1]: {id: 1, changed: true},
                [MEMBER_10]: {id: 10},
                [MEMBER_1X]: 0,
            });
        });

        it('return pairs whose key and value belong together', async () => {
            await provider.multiSet([
                [MEMBER_10, 'ten'],
                [PLAIN, 'plain'],
                [MEMBER_1, 'one'],
            ]);

            for (const [key, value] of await provider.getAll()) {
                expect(value).toBe({[MEMBER_10]: 'ten', [PLAIN]: 'plain', [MEMBER_1]: 'one'}[key]);
            }
        });

        it('stop listing removed keys', async () => {
            await provider.multiSet([
                [PLAIN, 'plain value'],
                [MEMBER_1, 1],
            ]);
            await provider.removeItem(PLAIN);

            expect(await provider.getAllKeys()).toEqual([MEMBER_1]);
            expect(await provider.getAll()).toEqual([[MEMBER_1, 1]]);
        });
    });

    describe('removeItem and removeItems', () => {
        beforeEach(() =>
            provider.multiSet([
                [PLAIN, 'plain value'],
                [OTHER, 'other value'],
                [MEMBER_1, 1],
                [MEMBER_10, 10],
                [MEMBER_1X, 11],
            ]),
        );

        it('removeItem removes only the exact key, not keys it prefixes', async () => {
            await provider.removeItem(MEMBER_1);

            expect(await target.readRaw()).toEqual({[PLAIN]: 'plain value', [OTHER]: 'other value', [MEMBER_10]: 10, [MEMBER_1X]: 11});
            expect(await provider.getItem(MEMBER_1)).toBeNull();
        });

        it('removeItem of a missing key resolves and changes nothing', async () => {
            await provider.removeItem('missing');

            expect(sorted(Object.keys(await target.readRaw()))).toEqual(sorted([PLAIN, OTHER, MEMBER_1, MEMBER_10, MEMBER_1X]));
        });

        it('removeItems removes exactly the listed keys, tolerating repeated and missing ones', async () => {
            await provider.removeItems([MEMBER_10, PLAIN, MEMBER_10, 'missing']);

            expect(await target.readRaw()).toEqual({[OTHER]: 'other value', [MEMBER_1]: 1, [MEMBER_1X]: 11});
        });

        it('removeItems removes only the exact keys, not keys they prefix', async () => {
            await provider.removeItems([MEMBER_1]);

            expect(await target.readRaw()).toEqual({[PLAIN]: 'plain value', [OTHER]: 'other value', [MEMBER_10]: 10, [MEMBER_1X]: 11});
        });

        it('removeItems with an empty list changes nothing', async () => {
            await provider.removeItems([]);

            expect(Object.keys(await target.readRaw())).toHaveLength(5);
        });

        it('a removed key can be written again', async () => {
            await provider.removeItems([PLAIN]);
            await provider.setItem(PLAIN, 'again');

            expect(await provider.getItem(PLAIN)).toBe('again');
        });
    });

    describe('clear', () => {
        it('removes every key and leaves the store usable', async () => {
            await provider.multiSet([
                [PLAIN, 'plain value'],
                [MEMBER_1, 1],
            ]);

            await provider.clear();

            expect(await provider.getAllKeys()).toEqual([]);
            expect(await provider.getAll()).toEqual([]);
            expect(await provider.getItem(PLAIN)).toBeNull();

            await provider.setItem(MEMBER_10, 10);
            expect(await target.readRaw()).toEqual({[MEMBER_10]: 10});
        });

        it('on an empty store resolves', async () => {
            await provider.clear();

            expect(await provider.getAllKeys()).toEqual([]);
        });
    });

    describe('operations issued in one tick without awaiting', () => {
        it('apply in call order, so the last write wins', async () => {
            const writes = [provider.setItem(PLAIN, 1), provider.setItem(PLAIN, 2), provider.removeItem(PLAIN), provider.setItem(PLAIN, 3)];
            await Promise.all(writes);

            expect(await provider.getItem(PLAIN)).toBe(3);
        });

        it('let a merge build on a set issued just before it', async () => {
            await Promise.all([provider.setItem(PLAIN, {a: 1}), provider.mergeItem(PLAIN, {b: 2})]);

            expect(await provider.getItem(PLAIN)).toEqual({a: 1, b: 2});
        });

        it('let a removal issued after a merge win', async () => {
            await provider.setItem(PLAIN, {a: 1});

            await Promise.all([provider.multiMerge([[PLAIN, {b: 2}]]), provider.removeItems([PLAIN])]);

            expect(await target.readRaw()).toEqual({});
        });

        it('let a write issued after clear survive it', async () => {
            await provider.setItem(PLAIN, 'old');

            await Promise.all([provider.clear(), provider.setItem(OTHER, 'new')]);

            expect(await target.readRaw()).toEqual({[OTHER]: 'new'});
        });
    });
});
