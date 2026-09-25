import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {KEYS, makeCold, startOnyx} from './harness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const REPORT_3 = `${KEYS.COLLECTION.REPORT}3`;
const NESTED_1 = `${KEYS.COLLECTION.REPORT_NESTED}1`;
const ACTIONS_1 = `${KEYS.COLLECTION.REPORT_ACTIONS}1`;

const SEEDED = {
    [REPORT_1]: {id: 1},
    [REPORT_2]: {id: 2},
    [NESTED_1]: {id: 'nested'},
    [ACTIONS_1]: {id: 'actions'},
    [KEYS.PLAIN]: 'plain',
};

function tryToWrite(target: Record<string, unknown>, key: string, value: unknown): void {
    try {
        // eslint-disable-next-line no-param-reassign
        target[key] = value;
    } catch {
        // Frozen snapshots throw in strict mode, which is an allowed way to refuse the write.
    }
}

function tryToDelete(target: Record<string, unknown>, key: string): void {
    try {
        // eslint-disable-next-line no-param-reassign
        delete target[key];
    } catch {
        // Same as above.
    }
}

describe('OnyxUtils.getCachedCollection', () => {
    describe('whole collection', () => {
        it('holds only its own members, never prefix-colliding collections, the collection key or plain keys', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT_NESTED)).toEqual({[NESTED_1]: {id: 'nested'}});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT_ACTIONS)).toEqual({[ACTIONS_1]: {id: 'actions'}});
        });

        it('keeps members written after init in their own collection only', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'plain'}});

            await Onyx.multiSet({[REPORT_1]: {id: 1}, [NESTED_1]: {id: 'nested'}, [ACTIONS_1]: {id: 'actions'}});

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT_NESTED)).toEqual({[NESTED_1]: {id: 'nested'}});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT_ACTIONS)).toEqual({[ACTIONS_1]: {id: 'actions'}});
        });

        it('holds each member by the same reference the cache holds', async () => {
            const {OnyxUtils, cache} = await startOnyx({storedValues: SEEDED});

            const collection = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            expect(collection[REPORT_1]).toBe(cache.get(REPORT_1));
            expect(collection[REPORT_2]).toBe(cache.get(REPORT_2));
        });

        it('returns the same reference on every call while nothing changes', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});

            const first = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toBe(first);
            expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT)).toBe(first);
        });

        it('returns a new reference after a member changes and keeps the unchanged members by reference', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await Onyx.merge(REPORT_1, {name: 'changed'});
            const after = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            expect(after).not.toBe(before);
            expect(after).toEqual({[REPORT_1]: {id: 1, name: 'changed'}, [REPORT_2]: {id: 2}});
            expect(after[REPORT_2]).toBe(before[REPORT_2]);
            expect(before).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        });

        it('returns a new reference after a member is added', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await Onyx.set(REPORT_3, {id: 3});
            const after = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            expect(after).not.toBe(before);
            expect(after).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [REPORT_3]: {id: 3}});
            expect(after[REPORT_1]).toBe(before[REPORT_1]);
        });

        it('keeps the reference when a set or merge writes an equal value', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await Onyx.set(REPORT_1, {id: 1});
            await Onyx.merge(REPORT_2, {id: 2});
            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {id: 1}});

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toBe(before);
        });

        it('keeps the reference when other collections or plain keys change', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await Onyx.merge(NESTED_1, {name: 'changed'});
            await Onyx.set(ACTIONS_1, null);
            await Onyx.set(KEYS.PLAIN, 'changed');
            await Onyx.set(`${KEYS.COLLECTION.REPORT_NESTED}2`, {id: 'new'});

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toBe(before);
        });

        it('keeps the reference when a key of the collection is read into the cache with the value it already had', async () => {
            const modules = await startOnyx({storedValues: SEEDED});
            const {OnyxUtils} = modules;
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await OnyxUtils.get(REPORT_1);
            await OnyxUtils.multiGet([REPORT_1, REPORT_2]);

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toBe(before);
        });

        it('keeps the reference when a read finds a member missing from storage', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await OnyxUtils.multiGet([REPORT_3]);
            await OnyxUtils.get(`${KEYS.COLLECTION.REPORT}4`);

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toBe(before);
        });

        it('keeps the empty reference of an empty collection when a read finds a member missing from storage', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.EMPTY);

            await OnyxUtils.multiGet([`${KEYS.COLLECTION.EMPTY}1`]);

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.EMPTY)).toBe(before);
            expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.EMPTY)).toBe(before);
        });

        it('drops a member another instance removed and keeps the others by reference', async () => {
            const {OnyxUtils, storage} = await startOnyx({storedValues: SEEDED, shouldSyncMultipleInstances: true});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);
            const onRemoteChange: (pairs: Array<[string, unknown]>) => void = storage.keepInstancesSync.mock.calls[0][0];

            onRemoteChange([[REPORT_1, null]]);
            await waitForPromisesToResolve();
            const after = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            expect(after).toEqual({[REPORT_2]: {id: 2}});
            expect(after[REPORT_2]).toBe(before[REPORT_2]);
        });

        it('drops a removed member and returns a new reference', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await Onyx.set(REPORT_1, null);
            const after = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            expect(after).not.toBe(before);
            expect(after).toEqual({[REPORT_2]: {id: 2}});
            expect(Object.keys(after)).toEqual([REPORT_2]);
        });

        it('returns a new reference when one member is removed and another added in the same tick', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await Promise.all([Onyx.set(REPORT_1, null), Onyx.set(REPORT_3, {id: 1})]);
            const after = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            expect(after).not.toBe(before);
            expect(after).toEqual({[REPORT_2]: {id: 2}, [REPORT_3]: {id: 1}});
        });

        it('returns an empty, stable object once the last member is removed', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});

            await Onyx.set(REPORT_1, null);
            await Onyx.merge(REPORT_2, null);
            const empty = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            expect(empty).toEqual({});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toBe(empty);
        });

        it('returns an empty object for a collection that never had members', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.EMPTY)).toEqual({});
        });

        it('returns an empty object on a store with no keys at all', async () => {
            const {OnyxUtils} = await startOnyx();

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({});
        });

        it('leaves out members that went cold and brings them back by value once read again', async () => {
            const modules = await startOnyx({storedValues: SEEDED});
            const {OnyxUtils} = modules;
            makeCold(modules, REPORT_1);

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_2]: {id: 2}});

            await OnyxUtils.get(REPORT_1);

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        });

        it('shows a value that was valid at some point while a merge is pending, and the merged value after it lands', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            const merge = Onyx.merge(REPORT_1, {name: 'merged'});
            const during = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);
            expect([{id: 1}, {id: 1, name: 'merged'}]).toContainEqual(during[REPORT_1]);
            expect(during[REPORT_2]).toBe(before[REPORT_2]);

            await merge;
            const after = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);
            expect(after).toEqual({[REPORT_1]: {id: 1, name: 'merged'}, [REPORT_2]: {id: 2}});
            expect(after).not.toBe(before);
        });

        it('applies several un-awaited writes to one member in order', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});

            const writes = [Onyx.merge(REPORT_1, {a: 1}), Onyx.merge(REPORT_1, {b: 2}), Onyx.set(REPORT_2, {replaced: true}), Onyx.merge(REPORT_1, {a: 3})];
            await Promise.all(writes);
            await waitForPromisesToResolve();

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1, a: 3, b: 2}, [REPORT_2]: {replaced: true}});
        });

        it('shows the current collection to a subscriber that reads it while being notified', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const seen: unknown[] = [];
            Onyx.connect({
                key: KEYS.COLLECTION.REPORT,
                callback: (value) => {
                    seen.push({value, cached: OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)});
                },
            });
            await waitForPromisesToResolve();
            seen.length = 0;

            await Onyx.merge(REPORT_1, {name: 'changed'});
            await waitForPromisesToResolve();

            expect(seen.length).toBeGreaterThanOrEqual(1);
            expect(seen.at(-1)).toEqual({
                value: {[REPORT_1]: {id: 1, name: 'changed'}, [REPORT_2]: {id: 2}},
                cached: {[REPORT_1]: {id: 1, name: 'changed'}, [REPORT_2]: {id: 2}},
            });
        });

        it('cannot be changed through the returned object', async () => {
            const {OnyxUtils, cache} = await startOnyx({storedValues: SEEDED});
            const collection = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            tryToWrite(collection, REPORT_3, {id: 'injected'});
            tryToWrite(collection, REPORT_1, {id: 'overwritten'});
            tryToDelete(collection, REPORT_2);

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
            expect(cache.get(REPORT_1)).toEqual({id: 1});
            expect(cache.get(REPORT_3)).toBeUndefined();
        });

        it('cannot be changed through the empty object it returns for an empty collection', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});
            const empty = OnyxUtils.getCachedCollection(KEYS.COLLECTION.EMPTY);

            tryToWrite(empty, `${KEYS.COLLECTION.EMPTY}1`, {id: 'injected'});

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.EMPTY)).toEqual({});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT_ACTIONS)).toEqual({[ACTIONS_1]: {id: 'actions'}});
        });
    });

    describe('with a member list', () => {
        it('returns only the listed members that have values, by cache reference', async () => {
            const {OnyxUtils, cache} = await startOnyx({storedValues: {...SEEDED, [REPORT_3]: {id: 3}}});

            const filtered = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, [REPORT_1, REPORT_3, `${KEYS.COLLECTION.REPORT}unknown`]);

            expect(filtered).toEqual({[REPORT_1]: {id: 1}, [REPORT_3]: {id: 3}});
            expect(Object.keys(filtered)).not.toContain(`${KEYS.COLLECTION.REPORT}unknown`);
            expect(filtered[REPORT_1]).toBe(cache.get(REPORT_1));
        });

        it('keeps members whose value is falsy', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            await Onyx.multiSet({[REPORT_3]: 0, [`${KEYS.COLLECTION.REPORT}4`]: '', [`${KEYS.COLLECTION.REPORT}5`]: false});
            const members = [REPORT_3, `${KEYS.COLLECTION.REPORT}4`, `${KEYS.COLLECTION.REPORT}5`];

            const filtered = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, members);

            expect(filtered).toStrictEqual({[REPORT_3]: 0, [`${KEYS.COLLECTION.REPORT}4`]: '', [`${KEYS.COLLECTION.REPORT}5`]: false});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toMatchObject(filtered);
        });

        it('returns an object the caller may change without touching the cache', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});

            const filtered = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, [REPORT_1, REPORT_2]);
            tryToDelete(filtered, REPORT_1);
            tryToWrite(filtered, REPORT_3, {id: 'injected'});

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, [REPORT_1, REPORT_2])).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        });

        it('lists keys known to be empty as own properties with an undefined value', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});
            await OnyxUtils.multiGet([REPORT_3]);

            const filtered = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, [REPORT_1, REPORT_3]);

            expect(Object.keys(filtered).sort()).toEqual([REPORT_1, REPORT_3]);
            expect(filtered[REPORT_3]).toBeUndefined();
            expect(filtered[REPORT_1]).toEqual({id: 1});
        });

        it('lists a member removed after init as an own property with an undefined value', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: SEEDED});
            await Onyx.merge(REPORT_1, null);

            const filtered = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, [REPORT_1, REPORT_2]);

            expect(filtered[REPORT_1]).toBeUndefined();
            expect(filtered[REPORT_2]).toEqual({id: 2});
        });

        it('returns an empty object for an empty list', async () => {
            const {OnyxUtils} = await startOnyx({storedValues: SEEDED});

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, [])).toEqual({});
        });

        it('leaves out listed members that went cold', async () => {
            const modules = await startOnyx({storedValues: SEEDED});
            makeCold(modules, REPORT_1);

            expect(modules.OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, [REPORT_1, REPORT_2])).toEqual({[REPORT_2]: {id: 2}});
        });

        it('filters listed members on a store with no keys at all to the ones in memory', async () => {
            const {OnyxUtils} = await startOnyx();

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT, [REPORT_1])).toEqual({});
        });
    });
});

describe('current behaviour (suspected bug)', () => {
    it('multiSet with an equal member value replaces the member reference and the collection snapshot, unlike set', async () => {
        const {Onyx, OnyxUtils, cache} = await startOnyx({storedValues: SEEDED});
        const before = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);
        const memberBefore = cache.get(REPORT_1);

        await Onyx.multiSet({[REPORT_1]: {id: 1}});
        const after = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

        expect(after).toEqual(before);
        // Expected: the same references, as Onyx.set of an equal value keeps them.
        expect(after).not.toBe(before);
        expect(cache.get(REPORT_1)).not.toBe(memberBefore);
    });
});
