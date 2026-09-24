import type {Update} from './harness';

import Onyx from '../../../../lib';
import {DEFAULT_VALUE, ONYX_KEYS, initOnyx, readCache, readStorage, recordConnectionAfterInitial, resetOnyx} from './harness';

const TEST = ONYX_KEYS.TEST_KEY;
const {A, B} = ONYX_KEYS.COLLECTION;
const WITH_DEFAULT = {[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE};
const INITIAL = {[TEST]: {a: 1}, [`${A}1`]: {a: 1}, [`${B}1`]: {b: 1}};
const VALID_BEFORE: Update = {onyxMethod: 'merge', key: `${A}2`, value: {before: true}};
const VALID_AFTER: Update = {onyxMethod: 'merge', key: TEST, value: {after: true}};

type InvalidCase = {
    name: string;
    entry: Update;
};

const INVALID_CASES: InvalidCase[] = [
    // @ts-expect-error an unknown method is invalid input
    {name: 'an unknown method', entry: {onyxMethod: 'upsert', key: TEST, value: {x: 1}}},
    // @ts-expect-error a non-string key is invalid input
    {name: 'a set with a numeric key', entry: {onyxMethod: 'set', key: 1, value: {x: 1}}},
    // @ts-expect-error a non-string key is invalid input
    {name: 'a merge with an undefined key', entry: {onyxMethod: 'merge', key: undefined, value: {x: 1}}},
    // @ts-expect-error a non-string key is invalid input
    {name: 'a mergecollection with a null key', entry: {onyxMethod: 'mergecollection', key: null, value: {[`${A}1`]: {x: 1}}}},
    // @ts-expect-error an array is not a collection
    {name: 'a mergecollection with an array value', entry: {onyxMethod: 'mergecollection', key: A, value: [{x: 1}]}},
    {name: 'a mergecollection with an empty value', entry: {onyxMethod: 'mergecollection', key: A, value: {}}},
    // @ts-expect-error null is not a collection
    {name: 'a mergecollection with a null value', entry: {onyxMethod: 'mergecollection', key: A, value: null}},
    {name: 'a mergecollection with a member of another collection', entry: {onyxMethod: 'mergecollection', key: A, value: {[`${A}1`]: {x: 1}, [`${B}1`]: {x: 1}}}},
    // @ts-expect-error an array is not a key-value map
    {name: 'a multiset with an array value', entry: {onyxMethod: 'multiset', key: '', value: [{x: 1}]}},
    // @ts-expect-error a string is not a key-value map
    {name: 'a multiset with a string value', entry: {onyxMethod: 'multiset', key: '', value: 'text'}},
    {name: 'a setcollection with a member of another collection', entry: {onyxMethod: 'setcollection', key: A, value: {[`${A}1`]: {x: 1}, [`${B}1`]: {x: 1}}}},
];

describe('Onyx.update skips invalid entries', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);

    it.each(INVALID_CASES)('skips $name and still applies the valid entries around it', async ({entry}) => {
        await Onyx.multiSet(INITIAL);
        const collectionMember = await recordConnectionAfterInitial(`${A}1`);
        const otherCollectionMember = await recordConnectionAfterInitial(`${B}1`);

        await expect(Onyx.update([VALID_BEFORE, entry, VALID_AFTER])).resolves.toBeUndefined();

        const expected = {...WITH_DEFAULT, ...INITIAL, [`${A}2`]: {before: true}, [TEST]: {a: 1, after: true}};
        expect(readCache()).toEqual(expected);
        expect(readStorage()).toEqual(expected);
        expect(collectionMember.calls).toEqual([]);
        expect(otherCollectionMember.calls).toEqual([]);
    });

    it('resolves for a batch of only invalid entries without changing anything', async () => {
        await Onyx.multiSet(INITIAL);
        const subscriber = await recordConnectionAfterInitial(TEST);

        await expect(Onyx.update(INVALID_CASES.map(({entry}) => entry))).resolves.toBeUndefined();

        expect(readCache()).toEqual({...WITH_DEFAULT, ...INITIAL});
        expect(readStorage()).toEqual({...WITH_DEFAULT, ...INITIAL});
        expect(subscriber.calls).toEqual([]);
    });
});
