import {KEYS} from '../connect/utils/freshOnyx';
import type {Harness} from './utils/harness';
import {ACTIONS_1, EMPTY_1, NESTED_1, R1, R10, R2, REPORT, countFor, receiverNames, startHarness, valuesFor} from './utils/harness';

/** Subscribes one listener to every key a routing row can reach, including the prefix-colliding ones. */
function subscribeEveryListener(subscribe: Harness['connect'] | Harness['listen']): void {
    subscribe('plain', KEYS.PLAIN);
    subscribe('nvp', KEYS.WITH_UNDERSCORE);
    subscribe('R1', R1);
    subscribe('R10', R10);
    subscribe('R2', R2);
    subscribe('report root', REPORT);
    subscribe('nested root', KEYS.COLLECTION.REPORT_NESTED);
    subscribe('NESTED_1', NESTED_1);
    subscribe('actions root', KEYS.COLLECTION.REPORT_ACTIONS);
    subscribe('ACTIONS_1', ACTIONS_1);
}

const ROUTES: Array<[string, string, string[]]> = [
    ['a plain key', KEYS.PLAIN, ['plain']],
    ['a plain key containing an underscore', KEYS.WITH_UNDERSCORE, ['nvp']],
    ['a member', R1, ['R1', 'report root']],
    ['a member whose ID extends another member ID', R10, ['R10', 'report root']],
    ['a member of a collection nested under another collection prefix', NESTED_1, ['NESTED_1', 'nested root']],
    ['a member of a collection sharing a prefix without the underscore', ACTIONS_1, ['ACTIONS_1', 'actions root']],
    ['a plain key nobody watches', KEYS.PLAIN_2, []],
    ['a member of a collection nobody watches', EMPTY_1, []],
];

describe('notifyKey routing', () => {
    it.each(ROUTES)('notifies only the listeners of the written key for a public write to %s', async (_label, key, expected) => {
        const harness = await startHarness();
        subscribeEveryListener(harness.connect);
        await harness.settle();

        await harness.Onyx.set(key, {written: key});

        expect(receiverNames(harness.log)).toEqual(expected);
    });

    it.each(ROUTES)('notifies only the store listeners of the changed key when notifyKey is called for %s', async (_label, key, expected) => {
        const harness = await startHarness();
        subscribeEveryListener(harness.listen);
        await harness.settle();

        harness.OnyxUtils.notifyKey(key, {written: key});

        expect(receiverNames(harness.log)).toEqual(expected);
    });

    it('hands exact subscribers the written value by reference with the written key', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('plain', KEYS.PLAIN);
        connect('R1', R1);
        await settle();
        const plainValue = {a: 1};
        const memberValue = {id: 1};

        OnyxUtils.notifyKey(KEYS.PLAIN, plainValue);
        OnyxUtils.notifyKey(R1, memberValue);

        expect(log).toEqual([
            {name: 'plain', value: plainValue, key: KEYS.PLAIN},
            {name: 'R1', value: memberValue, key: R1},
        ]);
        expect(log.at(0)?.value).toBe(plainValue);
        expect(log.at(1)?.value).toBe(memberValue);
    });

    it('hands root listeners the cached collection with the collection key, not the value argument', async () => {
        const {Onyx, OnyxUtils, cache, log, listen, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        listen('root', REPORT);
        await settle();

        OnyxUtils.notifyKey(R1, {id: 'not in the cache'});
        await Onyx.set(R2, {id: 22});

        expect(log).toEqual([
            {name: 'root', value: {[R1]: {id: 1}, [R2]: {id: 2}}, key: REPORT},
            {name: 'root', value: {[R1]: {id: 1}, [R2]: {id: 22}}, key: REPORT},
        ]);
        expect(log.at(-1)?.value).toEqual(cache.getCollectionData(REPORT));
    });

    it('gives a root a snapshot of the cache at each dispatch, never one from an earlier dispatch', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        connect('root', REPORT);
        await settle();

        await Onyx.set(R1, {id: 1});
        await Onyx.set(R2, {id: 2});
        await Onyx.merge(R1, {name: 'one'});
        await Onyx.set(R2, null);

        expect(valuesFor(log, 'root')).toEqual([{[R1]: {id: 1}}, {[R1]: {id: 1}, [R2]: {id: 2}}, {[R1]: {id: 1, name: 'one'}, [R2]: {id: 2}}, {[R1]: {id: 1, name: 'one'}}]);
    });

    it('delivers undefined, never null, to exact subscribers when a public write removes the key', async () => {
        const {Onyx, log, connect, settle} = await startHarness({storedValues: {[KEYS.PLAIN]: 'p', [KEYS.PLAIN_2]: 'q', [R1]: {id: 1}, [R2]: {id: 2}}});
        connect('plain', KEYS.PLAIN);
        connect('plain2', KEYS.PLAIN_2);
        connect('R1', R1);
        connect('R2', R2);
        await settle();

        await Onyx.set(KEYS.PLAIN, null);
        await Onyx.multiSet({[KEYS.PLAIN_2]: null});
        await Onyx.merge(R1, null);
        // @ts-expect-error The public type forbids null members, but mergeCollection documents null as a removal.
        await Onyx.mergeCollection(REPORT, {[R2]: null});

        expect(log.map(({name, value}) => [name, value])).toEqual([
            ['plain', undefined],
            ['plain2', undefined],
            ['R1', undefined],
            ['R2', undefined],
        ]);
    });
});

describe('notifyCollection routing', () => {
    it('notifies the root listeners of the collection and the listeners of the changed members only', async () => {
        const harness = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        subscribeEveryListener(harness.listen);
        await harness.settle();

        harness.OnyxUtils.notifyCollection(REPORT, {[R1]: {id: 1}}, {[R1]: {id: 0}});

        expect(receiverNames(harness.log)).toEqual(['R1', 'report root']);
    });

    it('notifies the same listeners for a public mergeCollection', async () => {
        const harness = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        subscribeEveryListener(harness.connect);
        await harness.settle();

        await harness.Onyx.mergeCollection(REPORT, {[R1]: {id: 11}, [R10]: {id: 10}});

        expect(receiverNames(harness.log)).toEqual(['R1', 'R10', 'report root']);
    });

    it('hands member listeners their cached value, not the partial value, and root listeners the cached collection', async () => {
        const {OnyxUtils, cache, log, listen, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        listen('R1', R1);
        listen('root', REPORT);
        await settle();

        OnyxUtils.notifyCollection(REPORT, {[R1]: {id: 'partial only'}}, {[R1]: {id: 0}});

        expect(log).toEqual([
            {name: 'root', value: {[R1]: {id: 1}}, key: REPORT},
            {name: 'R1', value: {id: 1}, key: R1},
        ]);
        expect(log.at(1)?.value).toBe(cache.get(R1));
    });

    it('delivers the merged member to a member subscriber when mergeCollection patches part of it', async () => {
        const {Onyx, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1, name: 'one'}}});
        connect('R1', R1);
        connect('root', REPORT);
        await settle();

        await Onyx.mergeCollection(REPORT, {[R1]: {name: 'uno'}});

        expect(valuesFor(log, 'R1')).toEqual([{id: 1, name: 'uno'}]);
        expect(valuesFor(log, 'root')).toEqual([{[R1]: {id: 1, name: 'uno'}}]);
    });

    it('does not notify a member listener whose cached value is the same reference as its previous value', async () => {
        const {OnyxUtils, cache, log, listen, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        listen('R1', R1);
        listen('R2', R2);
        await settle();

        OnyxUtils.notifyCollection(REPORT, {[R1]: cache.get(R1), [R2]: cache.get(R2)}, {[R1]: cache.get(R1), [R2]: {id: 0}});

        expect(receiverNames(log)).toEqual(['R2']);
    });

    it('treats a missing previous collection as every member having changed', async () => {
        const {OnyxUtils, log, listen, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        listen('R1', R1);
        await settle();

        OnyxUtils.notifyCollection(REPORT, {[R1]: {id: 1}}, undefined);

        expect(valuesFor(log, 'R1')).toEqual([{id: 1}]);
    });

    it('does not re-notify a member left untouched by multiSet but still notifies the one that changed', async () => {
        const {Onyx, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        connect('R1', R1);
        connect('R2', R2);
        await settle();

        await Onyx.multiSet({[R1]: cache.get(R1), [R2]: {id: 22}});

        expect(receiverNames(log)).toEqual(['R2']);
        expect(valuesFor(log, 'R2')).toEqual([{id: 22}]);
    });
});

describe('writes to the collection key itself', () => {
    // Fixed by #834: main appended the root subscriptions to themselves and notified a root twice per write.
    it('notifies a root once for one write to the collection key itself', async () => {
        const {Onyx, OnyxUtils, log, connect, listen, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('root', REPORT);
        listen('root listener', REPORT);
        await settle();

        OnyxUtils.notifyKey(REPORT, {});
        expect(countFor(log, 'root')).toBe(1);
        expect(countFor(log, 'root listener')).toBe(1);
        await settle();

        await Onyx.set(REPORT, {});
        expect(countFor(log, 'root')).toBe(1);
        expect(countFor(log, 'root listener')).toBe(1);
    });
});

describe('empty collection batches', () => {
    // Fixed by #834: main had no early return for an empty batch, so nothing-changed writes still reached roots.
    it('does not notify a root when an empty batch changes nothing', async () => {
        const {Onyx, OnyxUtils, log, connect, listen, settle} = await startHarness();
        connect('root', REPORT);
        listen('root listener', REPORT);
        await settle();

        await Onyx.setCollection(REPORT, {});
        OnyxUtils.notifyCollection(REPORT, {}, {});

        expect(log).toEqual([]);
    });
});

describe('current behaviour (#834 change)', () => {
    // Main handed the root the cached collection {report_1: ...}; #834 treats the collection key as an opaque single key.
    it('hands a root the value written to the collection key itself, not the cached collection', async () => {
        const {Onyx, OnyxUtils, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('root', REPORT);
        await settle();
        const directValue = {};
        const written = {};

        OnyxUtils.notifyKey(REPORT, directValue);
        await Onyx.set(REPORT, written);

        expect(log).toEqual([
            {name: 'root', value: {}, key: REPORT},
            {name: 'root', value: {}, key: REPORT},
        ]);
        expect(log.at(0)?.value).toBe(directValue);
        expect(log.at(1)?.value).toEqual(cache.get(REPORT));
        expect(cache.getCollectionData(REPORT)).toEqual({[R1]: {id: 1}});
    });
});
