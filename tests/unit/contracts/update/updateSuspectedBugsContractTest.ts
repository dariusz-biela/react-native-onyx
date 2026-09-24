import Onyx from '../../../../lib';
import {
    DEFAULT_VALUE,
    ONYX_KEYS,
    initOnyx,
    readCache,
    readStorage,
    readThroughConnection,
    recordCollectionAfterInitial,
    recordConnectionAfterInitial,
    resetOnyx,
    seedColdKey,
    SKIPPABLE_ID,
} from './harness';

const TEST = ONYX_KEYS.TEST_KEY;
const OTHER = ONYX_KEYS.OTHER_KEY;
const {A, B, NEST, NEST_LEVEL, SNAPSHOT} = ONYX_KEYS.COLLECTION;
const WITH_DEFAULT = {[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE};
const REPLACE_MARK = 'ONYX_INTERNALS__REPLACE_OBJECT_MARK';

describe('Onyx.update', () => {
    beforeAll(initOnyx);
    beforeEach(resetOnyx);

    describe('current behaviour (suspected bug)', () => {
        it('leaks the internal replace marker into the cache, subscribers and storage for a grouped member set whose property goes from null to an object', async () => {
            await Onyx.set(`${B}2`, {nested: {left: 1}});
            const subscriber = await recordConnectionAfterInitial(`${B}2`);

            await Onyx.update([
                {onyxMethod: 'multiset', key: '', value: {[`${B}1`]: {x: 1}, [`${B}2`]: {nested: null}}},
                {onyxMethod: 'mergecollection', key: B, value: {[`${B}2`]: {nested: {right: 1}}}},
            ]);

            // Applying the entries one by one gives {nested: {right: 1}}.
            const leaked = {nested: {[REPLACE_MARK]: true, right: 1}};
            expect(readCache()[`${B}2`]).toEqual(leaked);
            expect(readStorage()[`${B}2`]).toEqual(leaked);
            expect(subscriber.last()).toEqual(leaked);
        });

        it('leaks the internal replace marker into storage for a new grouped member whose property goes from null to an object', async () => {
            await Onyx.update([
                {onyxMethod: 'merge', key: `${B}1`, value: {nested: null}},
                {onyxMethod: 'merge', key: `${B}1`, value: {nested: {right: 1}}},
                {onyxMethod: 'merge', key: `${B}2`, value: {x: 1}},
            ]);

            expect(readCache()[`${B}1`]).toEqual({nested: {right: 1}});
            expect(readStorage()[`${B}1`]).toEqual({nested: {[REPLACE_MARK]: true, right: 1}});
        });

        it('applies a merge queued before a setcollection of the same collection after it', async () => {
            await Onyx.set(`${A}1`, {a: 1});

            await Onyx.update([
                {onyxMethod: 'merge', key: `${A}1`, value: {x: 1}},
                {onyxMethod: 'setcollection', key: A, value: {[`${A}2`]: {b: 1}}},
            ]);

            // Applying the entries one by one removes colA_1.
            const expected = {...WITH_DEFAULT, [`${A}1`]: {a: 1, x: 1}, [`${A}2`]: {b: 1}};
            expect(readCache()).toEqual(expected);
            expect(readStorage()).toEqual(expected);
        });

        it('lets a setcollection remove a member that a later entry of the same batch writes', async () => {
            await Onyx.update([
                {onyxMethod: 'setcollection', key: A, value: {[`${A}2`]: {b: 1}}},
                {onyxMethod: 'set', key: `${A}3`, value: {w: 1}},
            ]);

            // Applying the entries one by one keeps colA_3.
            const expected = {...WITH_DEFAULT, [`${A}2`]: {b: 1}};
            expect(readCache()).toEqual(expected);
            expect(readStorage()).toEqual(expected);
        });

        it('runs a clear before the entries queued ahead of it', async () => {
            await Onyx.set(TEST, {a: 1});

            await Onyx.update([
                {onyxMethod: 'set', key: OTHER, value: 2},
                {onyxMethod: 'clear', key: ''},
            ]);

            // Applying the entries one by one clears other as well.
            const expected = {...WITH_DEFAULT, [OTHER]: 2};
            expect(readCache()).toEqual(expected);
            expect(readStorage()).toEqual(expected);
        });

        it('groups members of a prefix-colliding child collection under the parent and skips their subscribers', async () => {
            await Onyx.set(`${NEST_LEVEL}1`, {a: 1});
            const member = await recordConnectionAfterInitial(`${NEST_LEVEL}1`);
            const child = await recordCollectionAfterInitial(NEST_LEVEL);
            const parent = await recordCollectionAfterInitial(NEST);

            await Onyx.update([
                {onyxMethod: 'merge', key: `${NEST_LEVEL}1`, value: {b: 1}},
                {onyxMethod: 'merge', key: `${NEST_LEVEL}2`, value: {c: 1}},
            ]);

            const expected = {...WITH_DEFAULT, [`${NEST_LEVEL}1`]: {a: 1, b: 1}, [`${NEST_LEVEL}2`]: {c: 1}};
            expect(readCache()).toEqual(expected);
            expect(readStorage()).toEqual(expected);
            expect(member.calls).toEqual([]);
            expect(child.calls).toEqual([]);
            expect(parent.calls).toEqual([{}]);
        });

        it('groups a child collection member with a parent member and skips the child subscribers', async () => {
            await Onyx.set(`${NEST_LEVEL}1`, {a: 1});
            const member = await recordConnectionAfterInitial(`${NEST_LEVEL}1`);
            const child = await recordCollectionAfterInitial(NEST_LEVEL);
            const parent = await recordCollectionAfterInitial(NEST);

            await Onyx.update([
                {onyxMethod: 'merge', key: `${NEST}1`, value: {b: 1}},
                {onyxMethod: 'merge', key: `${NEST_LEVEL}1`, value: {c: 1}},
            ]);

            expect(readCache()[`${NEST_LEVEL}1`]).toEqual({a: 1, c: 1});
            expect(member.calls).toEqual([]);
            expect(child.calls).toEqual([]);
            expect(parent.calls).toEqual([{[`${NEST}1`]: {b: 1}}]);
        });

        it('lets a setcollection of a parent collection delete child collection members without telling their subscribers', async () => {
            await Onyx.multiSet({[`${NEST_LEVEL}1`]: {a: 1}, [`${NEST}1`]: {a: 1}});
            const member = await recordConnectionAfterInitial(`${NEST_LEVEL}1`);
            const child = await recordCollectionAfterInitial(NEST_LEVEL);

            await Onyx.update([{onyxMethod: 'setcollection', key: NEST, value: {[`${NEST}2`]: {b: 1}}}]);

            const expected = {...WITH_DEFAULT, [`${NEST}2`]: {b: 1}};
            expect(readCache()).toEqual(expected);
            expect(readStorage()).toEqual(expected);
            expect(member.calls).toEqual([]);
            expect(child.calls).toEqual([]);
        });

        it('accepts a change of the other kind after an array merged into an empty key', async () => {
            await Onyx.update([
                {onyxMethod: 'merge', key: TEST, value: [1]},
                {onyxMethod: 'merge', key: TEST, value: {b: 1}},
                {onyxMethod: 'merge', key: `${A}1`, value: [1]},
                {onyxMethod: 'merge', key: `${A}1`, value: {b: 1}},
                {onyxMethod: 'merge', key: `${A}2`, value: {c: 1}},
            ]);

            // Applying the entries one by one keeps the arrays, the object change being incompatible.
            const expected = {...WITH_DEFAULT, [TEST]: {b: 1}, [`${A}1`]: {b: 1}, [`${A}2`]: {c: 1}};
            expect(readCache()).toEqual(expected);
            expect(readStorage()).toEqual(expected);
        });

        it('drops every earlier change of a key when a later entry writes undefined to it', async () => {
            await Onyx.multiSet({[TEST]: {old: 1}, [OTHER]: {old: 1}, [`${A}1`]: {old: 1}, [`${B}1`]: {old: 1}});

            await Onyx.update([
                {onyxMethod: 'set', key: TEST, value: {a: 1}},
                {onyxMethod: 'merge', key: TEST, value: undefined},
                {onyxMethod: 'set', key: OTHER, value: {a: 1}},
                {onyxMethod: 'multiset', key: '', value: {[OTHER]: undefined}},
                {onyxMethod: 'merge', key: `${A}1`, value: {a: 1}},
                {onyxMethod: 'merge', key: `${A}1`, value: undefined},
                {onyxMethod: 'merge', key: `${A}2`, value: {b: 1}},
            ]);

            // Applying the entries one by one ignores the undefined writes and keeps {a: 1} on test, other and colA_1.
            const expected = {...WITH_DEFAULT, [TEST]: {old: 1}, [OTHER]: {old: 1}, [`${A}1`]: {old: 1}, [`${A}2`]: {b: 1}, [`${B}1`]: {old: 1}};
            expect(readCache()).toEqual(expected);
            expect(readStorage()).toEqual(expected);
        });

        it('merges a set issued in the same tick after grouped member merges with those merges', async () => {
            await Onyx.multiSet({[`${A}1`]: {a: 0}, [`${A}2`]: {a: 0}});

            await Promise.all([
                Onyx.update([
                    {onyxMethod: 'merge', key: `${A}1`, value: {a: 1}},
                    {onyxMethod: 'merge', key: `${A}2`, value: {a: 1}},
                ]),
                Onyx.update([{onyxMethod: 'set', key: `${A}2`, value: {c: 2}}]),
            ]);

            // Applying the calls in order leaves colA_2 as {c: 2}.
            expect(readCache()[`${A}2`]).toEqual({c: 2, a: 1});
            expect(readStorage()[`${A}2`]).toEqual({c: 2, a: 1});
        });

        it('does not remove an evicted key that the batch sets or merges to null', async () => {
            seedColdKey(TEST, {a: 1});
            seedColdKey(OTHER, {a: 1});
            seedColdKey(`${A}1`, {a: 1});

            await Onyx.update([
                {onyxMethod: 'merge', key: TEST, value: null},
                {onyxMethod: 'set', key: OTHER, value: null},
                {onyxMethod: 'multiset', key: '', value: {[`${A}1`]: null}},
            ]);

            // Onyx.merge(key, null) on its own removes an evicted key.
            expect(await readThroughConnection(TEST)).toEqual({a: 1});
            expect(await readThroughConnection(OTHER)).toEqual({a: 1});
            expect(await readThroughConnection(`${A}1`)).toEqual({a: 1});
            expect(readStorage()).toEqual({...WITH_DEFAULT, [TEST]: {a: 1}, [OTHER]: {a: 1}, [`${A}1`]: {a: 1}});
        });

        it('removes a stored skippable member when its merge is grouped, while a single merge leaves it in storage', async () => {
            seedColdKey(`${A}${SKIPPABLE_ID}`, {a: 1});
            seedColdKey(`${B}${SKIPPABLE_ID}`, {a: 1});

            await Onyx.update([
                {onyxMethod: 'merge', key: `${A}${SKIPPABLE_ID}`, value: {b: 1}},
                {onyxMethod: 'merge', key: `${A}2`, value: {c: 1}},
                {onyxMethod: 'merge', key: `${B}${SKIPPABLE_ID}`, value: {b: 1}},
            ]);

            expect(readStorage()).toEqual({...WITH_DEFAULT, [`${A}2`]: {c: 1}, [`${B}${SKIPPABLE_ID}`]: {a: 1}});
        });

        it('leaves snapshots stale for mergecollection entries and for multiset entries that carry a key', async () => {
            await Onyx.multiSet({[`${A}1`]: {a: 1}, [TEST]: {a: 1}, [`${SNAPSHOT}1`]: {data: {[`${A}1`]: {a: 1}, [TEST]: {a: 1}}}});

            await Onyx.update([
                {onyxMethod: 'mergecollection', key: A, value: {[`${A}1`]: {a: 2}}},
                {onyxMethod: 'multiset', key: '', value: {[TEST]: {a: 2}}},
            ]);

            expect(readCache()[`${A}1`]).toEqual({a: 2});
            expect(readCache()[TEST]).toEqual({a: 2});
            expect(readCache()[`${SNAPSHOT}1`]).toEqual({data: {[`${A}1`]: {a: 1}, [TEST]: {a: 1}}});
        });
    });
});
