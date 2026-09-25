import utils from '../../../../lib/utils';
import type {StorageKeyValuePair} from '../../../../lib/storage/providers/types';
import {PROVIDER_TARGETS} from './harness';
import type {OnyxKey} from '../../../../lib/types';

const KEY: OnyxKey = 'plain';
const OTHER: OnyxKey = 'other';
const MEMBER_1: OnyxKey = 'test_1';
const MEMBER_10: OnyxKey = 'test_10';
const MARK = utils.ONYX_INTERNALS__REPLACE_OBJECT_MARK;

type MergeCase = {
    title: string;
    existing: unknown;
    change: unknown;
    expected: unknown;
};

/** What a stored value becomes after one mergeItem, identical for every provider. */
const MERGE_CASES: MergeCase[] = [
    {
        title: 'adds new top-level properties and keeps the untouched ones',
        existing: {a: 1, b: 2},
        change: {c: 3},
        expected: {a: 1, b: 2, c: 3},
    },
    {
        title: 'overwrites a primitive property',
        existing: {a: 1, b: 'x'},
        change: {b: 'y'},
        expected: {a: 1, b: 'y'},
    },
    {
        title: 'deep merges nested objects',
        existing: {nested: {a: 1, deeper: {b: 2, c: 3}}},
        change: {nested: {deeper: {c: 4, d: 5}}},
        expected: {nested: {a: 1, deeper: {b: 2, c: 4, d: 5}}},
    },
    {
        title: 'removes a top-level property set to null',
        existing: {a: 1, b: 2},
        change: {a: null},
        expected: {b: 2},
    },
    {
        title: 'removes a nested property set to null and keeps its siblings',
        existing: {nested: {a: 1, b: 2}, other: true},
        change: {nested: {a: null, c: 3}},
        expected: {nested: {b: 2, c: 3}, other: true},
    },
    {
        title: 'removes a whole nested object set to null',
        existing: {nested: {a: 1}, kept: 1},
        change: {nested: null},
        expected: {kept: 1},
    },
    {
        title: 'drops null properties already stored in the existing value',
        existing: {a: null, b: 1, nested: {c: null, d: 2}},
        change: {e: 3},
        expected: {b: 1, nested: {c: null, d: 2}, e: 3},
    },
    {
        title: 'drops nested nulls of the existing value along a path the change merges into',
        existing: {nested: {c: null, d: 2}},
        change: {nested: {e: 3}},
        expected: {nested: {d: 2, e: 3}},
    },
    {
        title: 'strips nested nulls from a change written onto a missing key',
        existing: undefined,
        change: {a: {b: null, c: 1}, d: null, e: 2},
        expected: {a: {c: 1}, e: 2},
    },
    {
        title: 'strips nested nulls from an object change that replaces a primitive',
        existing: 'text',
        change: {a: null, b: {c: null, d: 1}},
        expected: {b: {d: 1}},
    },
    {
        title: 'turns an object whose only property was nulled into an empty object',
        existing: {nested: {a: 1}},
        change: {nested: {a: null}},
        expected: {nested: {}},
    },
    {
        title: 'ignores undefined properties of the change',
        existing: {a: 1, b: 2},
        change: {a: undefined, c: 3},
        expected: {a: 1, b: 2, c: 3},
    },
    {
        title: 'replaces arrays wholesale and keeps nulls inside them',
        existing: {list: [1, 2, 3], other: 1},
        change: {list: [4, null]},
        expected: {list: [4, null], other: 1},
    },
    {
        title: 'replaces an object property with an array',
        existing: {value: {a: 1}},
        change: {value: [1]},
        expected: {value: [1]},
    },
    {
        title: 'replaces an array property with an object',
        existing: {value: [1, 2]},
        change: {value: {a: 1}},
        expected: {value: {a: 1}},
    },
    {
        title: 'replaces the whole value with a top-level array',
        existing: {a: 1},
        change: [1, {b: 2}],
        expected: [1, {b: 2}],
    },
    {
        title: 'replaces the whole value with a primitive',
        existing: {a: 1},
        change: 42,
        expected: 42,
    },
    {
        title: 'stores falsy primitives',
        existing: 'text',
        change: 0,
        expected: 0,
    },
    {
        title: 'stores an empty object onto a missing key',
        existing: undefined,
        change: {},
        expected: {},
    },
    {
        title: 'keeps the existing value for an empty object change',
        existing: {a: 1, nested: {b: 2}},
        change: {},
        expected: {a: 1, nested: {b: 2}},
    },
    {
        title: 'replaces a marked nested object instead of merging it and drops the mark',
        existing: {nested: {a: 1, b: 2}, kept: true},
        change: {nested: {[MARK]: true, c: 3}},
        expected: {nested: {c: 3}, kept: true},
    },
    {
        title: 'replaces a marked object at depth and still merges its unmarked parent',
        existing: {outer: {inner: {a: 1}, sibling: 1}},
        change: {outer: {inner: {[MARK]: true, b: 2}, added: 2}},
        expected: {outer: {inner: {b: 2}, sibling: 1, added: 2}},
    },
];

describe.each(PROVIDER_TARGETS)('$name merges', (target) => {
    const {provider} = target;

    beforeEach(() => target.reset());

    async function seed(value: unknown): Promise<void> {
        if (value === undefined) {
            return;
        }
        await provider.setItem(KEY, value);
    }

    describe('mergeItem', () => {
        it.each(MERGE_CASES)('$title', async ({existing, change, expected}) => {
            await seed(existing);

            await provider.mergeItem(KEY, change);

            expect(await provider.getItem(KEY)).toEqual(expected);
        });

        it('only touches the merged key', async () => {
            await provider.multiSet([
                [KEY, {a: 1}],
                [OTHER, {a: 1}],
                [MEMBER_10, {a: 1}],
            ]);

            await provider.mergeItem(KEY, {b: 2});

            expect(await target.readRaw()).toEqual({[KEY]: {a: 1, b: 2}, [OTHER]: {a: 1}, [MEMBER_10]: {a: 1}});
        });

        it('applies consecutive merges on top of each other', async () => {
            await provider.mergeItem(KEY, {a: 1});
            await provider.mergeItem(KEY, {b: {c: 1}});
            await provider.mergeItem(KEY, {b: {d: 2}, a: null});

            expect(await provider.getItem(KEY)).toEqual({b: {c: 1, d: 2}});
        });

        it('does not change the change object it was given, including the replace mark', async () => {
            await seed({nested: {a: 1}, list: [1]});
            const change = {nested: {[MARK]: true, b: 2}, removed: null, deep: {x: {y: null}}};
            const snapshot = structuredClone(change);

            await provider.mergeItem(KEY, change);

            expect(change).toEqual(snapshot);
        });

        it('does not change a value previously read from the provider', async () => {
            await seed({nested: {a: 1, b: 2}, other: {c: 3}});
            const before = await provider.getItem(KEY);
            const snapshot = structuredClone(before);

            await provider.mergeItem(KEY, {nested: {a: null, d: 4}, other: null});

            expect(before).toEqual(snapshot);
            expect(await provider.getItem(KEY)).toEqual({nested: {b: 2, d: 4}});
        });

        it('accepts and ignores replace-null patches', async () => {
            await seed({nested: {a: 1}});

            await provider.mergeItem(KEY, {nested: {b: 2}}, [[['nested'], {b: 2}]]);

            expect(await provider.getItem(KEY)).toEqual({nested: {a: 1, b: 2}});
        });
    });

    describe('multiMerge', () => {
        it.each(MERGE_CASES)('applies the mergeItem rule per pair: $title', async ({existing, change, expected}) => {
            await seed(existing);
            await provider.setItem(OTHER, {untouched: true});

            await provider.multiMerge([[KEY, change]]);

            expect(await provider.getItem(KEY)).toEqual(expected);
            expect(await provider.getItem(OTHER)).toEqual({untouched: true});
        });

        it('merges each pair into its own key, existing and missing ones alike', async () => {
            await provider.multiSet([
                [MEMBER_1, {id: 1, name: 'one', stale: true}],
                [MEMBER_10, {id: 10, nested: {a: 1}}],
            ]);

            await provider.multiMerge([
                [MEMBER_1, {name: 'uno', stale: null}],
                [MEMBER_10, {nested: {b: 2}}],
                [KEY, {created: {deep: null, kept: 1}}],
            ]);

            expect(await target.readRaw()).toEqual({
                [MEMBER_1]: {id: 1, name: 'uno'},
                [MEMBER_10]: {id: 10, nested: {a: 1, b: 2}},
                [KEY]: {created: {kept: 1}},
            });
        });

        it('keeps prefix-colliding members apart', async () => {
            await provider.multiSet([
                [MEMBER_1, {id: 1}],
                [MEMBER_10, {id: 10}],
            ]);

            await provider.multiMerge([[MEMBER_1, {changed: true}]]);

            expect(await provider.getItem(MEMBER_1)).toEqual({id: 1, changed: true});
            expect(await provider.getItem(MEMBER_10)).toEqual({id: 10});
        });

        it('accepts an empty batch', async () => {
            await provider.setItem(KEY, {a: 1});

            await provider.multiMerge([]);

            expect(await target.readRaw()).toEqual({[KEY]: {a: 1}});
        });

        it('does not change the pairs it was given', async () => {
            await provider.setItem(MEMBER_1, {nested: {a: 1}});
            const pairs: StorageKeyValuePair[] = [
                [MEMBER_1, {nested: {[MARK]: true, b: null}}],
                [MEMBER_10, {x: null, y: {z: 1}}],
            ];
            const snapshot = structuredClone(pairs);

            await provider.multiMerge(pairs);

            expect(pairs).toEqual(snapshot);
        });

        it('builds on the result of a multiSet issued in the same tick', async () => {
            await Promise.all([
                provider.multiSet([
                    [MEMBER_1, {a: 1}],
                    [MEMBER_10, {a: 10}],
                ]),
                provider.multiMerge([
                    [MEMBER_1, {b: 1}],
                    [MEMBER_10, {a: null, b: 10}],
                ]),
            ]);

            expect(await target.readRaw()).toEqual({[MEMBER_1]: {a: 1, b: 1}, [MEMBER_10]: {b: 10}});
        });
    });
});
