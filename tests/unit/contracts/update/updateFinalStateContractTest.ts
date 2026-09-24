import type {State, Update} from './harness';

import Onyx from '../../../../lib';
import {DEFAULT_VALUE, ONYX_KEYS, SKIPPABLE_ID, initOnyx, readCache, readStorage, resetOnyx, toUpdate} from './harness';
import {applyUpdates} from './referenceModel';

const TEST = ONYX_KEYS.TEST_KEY;
const OTHER = ONYX_KEYS.OTHER_KEY;
const {A, B} = ONYX_KEYS.COLLECTION;
const WITH_DEFAULT = {[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE};

type FinalStateCase = {
    name: string;
    initial: State;
    batch: Update[];
    expected: State;
};

const SINGLE_METHOD_CASES: FinalStateCase[] = [
    {name: 'set writes a new key', initial: {}, batch: [{onyxMethod: 'set', key: TEST, value: {a: 1}}], expected: {[TEST]: {a: 1}}},
    {name: 'set replaces the whole existing value', initial: {[TEST]: {a: 1, b: 1}}, batch: [{onyxMethod: 'set', key: TEST, value: {c: 1}}], expected: {[TEST]: {c: 1}}},
    {
        name: 'set drops nested nulls',
        initial: {},
        batch: [{onyxMethod: 'set', key: TEST, value: {a: 1, b: null, c: {d: null, e: 1}}}],
        expected: {[TEST]: {a: 1, c: {e: 1}}},
    },
    {name: 'set null removes the key', initial: {[TEST]: {a: 1}}, batch: [{onyxMethod: 'set', key: TEST, value: null}], expected: {}},
    {name: 'set undefined is ignored', initial: {[TEST]: {a: 1}}, batch: [{onyxMethod: 'set', key: TEST, value: undefined}], expected: {[TEST]: {a: 1}}},
    {name: 'set writes primitives', initial: {[TEST]: 'text'}, batch: [{onyxMethod: 'set', key: TEST, value: 5}], expected: {[TEST]: 5}},
    {name: 'set writes arrays', initial: {[TEST]: [1, 2]}, batch: [{onyxMethod: 'set', key: TEST, value: [3]}], expected: {[TEST]: [3]}},
    {
        name: 'merge deep merges objects',
        initial: {[TEST]: {a: 1, nested: {x: 1, y: 1}}},
        batch: [{onyxMethod: 'merge', key: TEST, value: {b: 2, nested: {y: 2, z: 2}}}],
        expected: {[TEST]: {a: 1, b: 2, nested: {x: 1, y: 2, z: 2}}},
    },
    {
        name: 'merge removes fields merged with null',
        initial: {[TEST]: {a: 1, b: 1, nested: {x: 1, y: 1}}},
        batch: [{onyxMethod: 'merge', key: TEST, value: {a: null, nested: {x: null}}}],
        expected: {[TEST]: {b: 1, nested: {y: 1}}},
    },
    {name: 'merge replaces arrays inside objects', initial: {[TEST]: {list: [1, 2]}}, batch: [{onyxMethod: 'merge', key: TEST, value: {list: [3]}}], expected: {[TEST]: {list: [3]}}},
    {name: 'merge replaces a top level array', initial: {[TEST]: [1, 2]}, batch: [{onyxMethod: 'merge', key: TEST, value: [3]}], expected: {[TEST]: [3]}},
    {name: 'merge replaces a primitive', initial: {[TEST]: 'text'}, batch: [{onyxMethod: 'merge', key: TEST, value: 'other'}], expected: {[TEST]: 'other'}},
    {name: 'merge null removes the key', initial: {[TEST]: {a: 1}}, batch: [{onyxMethod: 'merge', key: TEST, value: null}], expected: {}},
    {name: 'merge undefined is ignored', initial: {[TEST]: {a: 1}}, batch: [{onyxMethod: 'merge', key: TEST, value: undefined}], expected: {[TEST]: {a: 1}}},
    {
        name: 'merge onto a missing key drops nested nulls',
        initial: {},
        batch: [{onyxMethod: 'merge', key: TEST, value: {a: 1, b: null, nested: {c: null}}}],
        expected: {[TEST]: {a: 1, nested: {}}},
    },
    {
        name: 'multiset replaces every listed key and removes null entries',
        initial: {[TEST]: {a: 1}, [OTHER]: {b: 1}, [`${A}1`]: {c: 1}},
        batch: [{onyxMethod: 'multiset', key: '', value: {[TEST]: {z: 1}, [OTHER]: null, [`${A}1`]: {y: 1}, [`${A}2`]: {x: 1}}}],
        expected: {[TEST]: {z: 1}, [`${A}1`]: {y: 1}, [`${A}2`]: {x: 1}},
    },
    {
        name: 'mergecollection merges members and removes null members',
        initial: {[`${A}1`]: {a: 1}, [`${A}2`]: {b: 1}, [`${A}3`]: {c: 1}},
        batch: [toUpdate({onyxMethod: 'mergecollection', key: A, value: {[`${A}1`]: {a: 2, d: 1}, [`${A}2`]: null, [`${A}4`]: {e: 1}}})],
        expected: {[`${A}1`]: {a: 2, d: 1}, [`${A}3`]: {c: 1}, [`${A}4`]: {e: 1}},
    },
    {
        name: 'mergecollection with a single member',
        initial: {[`${A}1`]: {a: 1}},
        batch: [{onyxMethod: 'mergecollection', key: A, value: {[`${A}1`]: {b: 1}}}],
        expected: {[`${A}1`]: {a: 1, b: 1}},
    },
    {
        name: 'setcollection replaces the collection and keeps other collections',
        initial: {[`${A}1`]: {a: 1}, [`${A}2`]: {b: 1}, [`${B}1`]: {c: 1}},
        batch: [{onyxMethod: 'setcollection', key: A, value: {[`${A}2`]: {z: 1}, [`${A}3`]: {y: 1}}}],
        expected: {[`${A}2`]: {z: 1}, [`${A}3`]: {y: 1}, [`${B}1`]: {c: 1}},
    },
    {
        name: 'an empty batch changes nothing',
        initial: {[TEST]: {a: 1}},
        batch: [],
        expected: {[TEST]: {a: 1}},
    },
];

const SAME_KEY_CASES: FinalStateCase[] = [
    {
        name: 'set then merge merges onto the set value',
        initial: {[TEST]: {old: 1}},
        batch: [
            {onyxMethod: 'set', key: TEST, value: {a: 1}},
            {onyxMethod: 'merge', key: TEST, value: {b: 1}},
        ],
        expected: {[TEST]: {a: 1, b: 1}},
    },
    {
        name: 'merge then set keeps only the set value',
        initial: {[TEST]: {old: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {a: 1}},
            {onyxMethod: 'set', key: TEST, value: {b: 1}},
        ],
        expected: {[TEST]: {b: 1}},
    },
    {
        name: 'merge then merge null removes the key',
        initial: {[TEST]: {old: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {a: 1}},
            {onyxMethod: 'merge', key: TEST, value: null},
        ],
        expected: {},
    },
    {
        name: 'merge null then merge starts from an empty value',
        initial: {[TEST]: {old: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: null},
            {onyxMethod: 'merge', key: TEST, value: {a: 1}},
        ],
        expected: {[TEST]: {a: 1}},
    },
    {
        name: 'set, merge null, merge keeps only the last merge',
        initial: {[TEST]: {old: 1}},
        batch: [
            {onyxMethod: 'set', key: TEST, value: {a: 1}},
            {onyxMethod: 'merge', key: TEST, value: null},
            {onyxMethod: 'merge', key: TEST, value: {b: 1}},
        ],
        expected: {[TEST]: {b: 1}},
    },
    {
        name: 'merges accumulate and the later one wins a shared field',
        initial: {[TEST]: {a: 0, keep: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {a: 1, nested: {x: 1}}},
            {onyxMethod: 'merge', key: TEST, value: {a: 2, nested: {y: 1}}},
            {onyxMethod: 'merge', key: TEST, value: {nested: {x: null}}},
        ],
        expected: {[TEST]: {a: 2, keep: 1, nested: {y: 1}}},
    },
    {
        name: 'a later merge restores a field an earlier merge removed',
        initial: {[TEST]: {a: 1, b: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {a: null}},
            {onyxMethod: 'merge', key: TEST, value: {a: 3}},
        ],
        expected: {[TEST]: {a: 3, b: 1}},
    },
    {
        name: 'merges around a merge undefined still apply',
        initial: {[TEST]: {old: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: undefined},
            {onyxMethod: 'merge', key: TEST, value: {a: 1}},
            {onyxMethod: 'merge', key: TEST, value: undefined},
        ],
        expected: {[TEST]: {old: 1, a: 1}},
    },
    {
        name: 'multiset then merge on the same key',
        initial: {[TEST]: {old: 1}},
        batch: [
            {onyxMethod: 'multiset', key: '', value: {[TEST]: {a: 1}}},
            {onyxMethod: 'merge', key: TEST, value: {b: 1}},
        ],
        expected: {[TEST]: {a: 1, b: 1}},
    },
    {
        name: 'merge then multiset on the same key',
        initial: {[TEST]: {old: 1}},
        batch: [
            {onyxMethod: 'merge', key: TEST, value: {a: 1}},
            {onyxMethod: 'multiset', key: '', value: {[TEST]: {b: 1}}},
        ],
        expected: {[TEST]: {b: 1}},
    },
    {
        name: 'mergecollection then merge on the same member',
        initial: {[`${A}1`]: {old: 1}},
        batch: [
            {onyxMethod: 'mergecollection', key: A, value: {[`${A}1`]: {a: 1}, [`${A}2`]: {b: 1}}},
            {onyxMethod: 'merge', key: `${A}1`, value: {c: 1}},
        ],
        expected: {[`${A}1`]: {old: 1, a: 1, c: 1}, [`${A}2`]: {b: 1}},
    },
    {
        name: 'merge then mergecollection on the same member',
        initial: {[`${A}1`]: {old: 1}},
        batch: [
            {onyxMethod: 'merge', key: `${A}1`, value: {a: 1, c: 1}},
            {onyxMethod: 'mergecollection', key: A, value: {[`${A}1`]: {a: 2}}},
        ],
        expected: {[`${A}1`]: {old: 1, a: 2, c: 1}},
    },
    {
        name: 'set then mergecollection on grouped members',
        initial: {[`${A}1`]: {old: 1}, [`${A}2`]: {old: 2}},
        batch: [
            {onyxMethod: 'set', key: `${A}1`, value: {a: 1}},
            {onyxMethod: 'mergecollection', key: A, value: {[`${A}1`]: {b: 1}, [`${A}2`]: {b: 2}}},
        ],
        expected: {[`${A}1`]: {a: 1, b: 1}, [`${A}2`]: {old: 2, b: 2}},
    },
    {
        name: 'grouped members removed and written again in one batch',
        initial: {[`${A}1`]: {old: 1}, [`${A}2`]: {old: 2}},
        batch: [
            {onyxMethod: 'merge', key: `${A}1`, value: null},
            {onyxMethod: 'merge', key: `${A}2`, value: null},
            {onyxMethod: 'merge', key: `${A}1`, value: {fresh: 1}},
        ],
        expected: {[`${A}1`]: {fresh: 1}},
    },
    {
        name: 'a grouped member merged, removed and merged again keeps only the last merge',
        initial: {[`${A}1`]: {old: 1}, [`${A}2`]: {old: 2}},
        batch: [
            {onyxMethod: 'merge', key: `${A}1`, value: {a: 1}},
            {onyxMethod: 'merge', key: `${A}1`, value: null},
            {onyxMethod: 'merge', key: `${A}1`, value: {b: 1}},
            {onyxMethod: 'merge', key: `${A}2`, value: {c: 1}},
        ],
        expected: {[`${A}1`]: {b: 1}, [`${A}2`]: {old: 2, c: 1}},
    },
    {
        name: 'grouped merges on two collections in one batch',
        initial: {[`${A}1`]: {a: 1}, [`${B}1`]: {b: 1}},
        batch: [
            {onyxMethod: 'merge', key: `${A}1`, value: {x: 1}},
            {onyxMethod: 'merge', key: `${B}1`, value: {y: 1}},
            {onyxMethod: 'merge', key: `${A}2`, value: {x: 2}},
            {onyxMethod: 'merge', key: `${B}2`, value: {y: 2}},
        ],
        expected: {[`${A}1`]: {a: 1, x: 1}, [`${A}2`]: {x: 2}, [`${B}1`]: {b: 1, y: 1}, [`${B}2`]: {y: 2}},
    },
    {
        name: 'an underscore key next to a grouped collection stays a plain key',
        initial: {[ONYX_KEYS.NVP_KEY]: {a: 1}},
        batch: [
            {onyxMethod: 'merge', key: ONYX_KEYS.NVP_KEY, value: {b: 1}},
            {onyxMethod: 'merge', key: `${A}1`, value: {x: 1}},
            {onyxMethod: 'merge', key: `${A}2`, value: {x: 2}},
        ],
        expected: {[ONYX_KEYS.NVP_KEY]: {a: 1, b: 1}, [`${A}1`]: {x: 1}, [`${A}2`]: {x: 2}},
    },
];

const SPECIAL_KEY_CASES: FinalStateCase[] = [
    {
        name: 'writes to a skippable member are ignored',
        initial: {},
        batch: [
            {onyxMethod: 'set', key: `${A}${SKIPPABLE_ID}`, value: {a: 1}},
            {onyxMethod: 'merge', key: `${B}${SKIPPABLE_ID}`, value: {a: 1}},
            {onyxMethod: 'mergecollection', key: A, value: {[`${A}${SKIPPABLE_ID}`]: {a: 1}, [`${A}1`]: {b: 1}}},
        ],
        expected: {[`${A}1`]: {b: 1}},
    },
    {
        name: 'merge null on a key with a default removes it',
        initial: {},
        batch: [{onyxMethod: 'merge', key: ONYX_KEYS.WITH_DEFAULT, value: null}],
        expected: {[ONYX_KEYS.WITH_DEFAULT]: undefined},
    },
    {
        name: 'an object may be set over an empty array',
        initial: {[TEST]: []},
        batch: [{onyxMethod: 'set', key: TEST, value: {a: 1}}],
        expected: {[TEST]: {a: 1}},
    },
    {
        name: 'an array set over an object is dropped',
        initial: {[TEST]: {a: 1}},
        batch: [{onyxMethod: 'set', key: TEST, value: [1]}],
        expected: {[TEST]: {a: 1}},
    },
    {
        name: 'an object merged over a non-empty array is dropped',
        initial: {[TEST]: [1]},
        batch: [{onyxMethod: 'merge', key: TEST, value: {a: 1}}],
        expected: {[TEST]: [1]},
    },
    {
        name: 'an incompatible grouped member change is dropped while its siblings apply',
        initial: {[`${A}1`]: {a: 1}, [`${A}2`]: {b: 1}},
        batch: [
            {onyxMethod: 'merge', key: `${A}1`, value: [1]},
            {onyxMethod: 'merge', key: `${A}2`, value: {c: 1}},
        ],
        expected: {[`${A}1`]: {a: 1}, [`${A}2`]: {b: 1, c: 1}},
    },
];

function withDefaults(state: State): State {
    const merged: State = {...WITH_DEFAULT, ...state};
    return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
}

async function runCase({initial, batch}: FinalStateCase): Promise<void> {
    await Onyx.multiSet(initial);
    await Onyx.update(batch);
}

describe('Onyx.update final state', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);

    describe.each([
        ['single method', SINGLE_METHOD_CASES],
        ['same key mixes', SAME_KEY_CASES],
        ['special keys', SPECIAL_KEY_CASES],
    ])('%s', (_, cases) => {
        it.each(cases)('$name', async (testCase) => {
            await runCase(testCase);

            const expected = withDefaults(testCase.expected);
            expect(readCache()).toEqual(expected);
            expect(readStorage()).toEqual(expected);
            expect(applyUpdates({...WITH_DEFAULT, ...testCase.initial}, testCase.batch)).toEqual(expected);
        });
    });

    it('keeps RAM-only keys and collections in memory without persisting them', async () => {
        await Onyx.update([
            {onyxMethod: 'set', key: ONYX_KEYS.RAM_ONLY_KEY, value: {a: 1}},
            {onyxMethod: 'merge', key: `${ONYX_KEYS.COLLECTION.RAM}1`, value: {b: 1}},
            {onyxMethod: 'merge', key: `${ONYX_KEYS.COLLECTION.RAM}2`, value: {c: 1}},
            {onyxMethod: 'set', key: TEST, value: {d: 1}},
        ]);

        expect(readCache()).toEqual({...WITH_DEFAULT, [ONYX_KEYS.RAM_ONLY_KEY]: {a: 1}, [`${ONYX_KEYS.COLLECTION.RAM}1`]: {b: 1}, [`${ONYX_KEYS.COLLECTION.RAM}2`]: {c: 1}, [TEST]: {d: 1}});
        expect(readStorage()).toEqual({...WITH_DEFAULT, [TEST]: {d: 1}});
    });

    it('resolves once every write is visible in the cache and the storage', async () => {
        const pending = Onyx.update([
            {onyxMethod: 'merge', key: `${A}1`, value: {a: 1}},
            {onyxMethod: 'merge', key: `${A}2`, value: {a: 2}},
            {onyxMethod: 'set', key: TEST, value: {b: 1}},
            {onyxMethod: 'setcollection', key: B, value: {[`${B}1`]: {c: 1}}},
        ]);
        await pending;

        const expected = {...WITH_DEFAULT, [`${A}1`]: {a: 1}, [`${A}2`]: {a: 2}, [TEST]: {b: 1}, [`${B}1`]: {c: 1}};
        expect(readCache()).toEqual(expected);
        expect(readStorage()).toEqual(expected);
    });
});
