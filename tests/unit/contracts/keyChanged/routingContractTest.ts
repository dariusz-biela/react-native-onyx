import {KEYS} from '../connect/utils/freshOnyx';
import type {Harness} from './utils/harness';
import {ACTIONS_1, EMPTY_1, NESTED_1, R1, R10, R2, REPORT, countFor, receiverNames, startHarness, valuesFor} from './utils/harness';

/** Subscribes one listener to every key a routing row can reach, including the prefix-colliding ones. */
function connectEveryListener({connect}: Harness): void {
    connect('plain', KEYS.PLAIN);
    connect('nvp', KEYS.WITH_UNDERSCORE);
    connect('R1', R1);
    connect('R10', R10);
    connect('R2', R2);
    connect('report root', REPORT);
    connect('nested root', KEYS.COLLECTION.REPORT_NESTED);
    connect('NESTED_1', NESTED_1);
    connect('actions root', KEYS.COLLECTION.REPORT_ACTIONS);
    connect('ACTIONS_1', ACTIONS_1);
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

describe('keyChanged routing', () => {
    it.each(ROUTES)('notifies only the listeners of the written key for a public write to %s', async (_label, key, expected) => {
        const harness = await startHarness();
        connectEveryListener(harness);
        await harness.settle();

        await harness.Onyx.set(key, {written: key});

        expect(receiverNames(harness.log)).toEqual(expected);
    });

    it.each(ROUTES)('notifies only the listeners of the changed key when keyChanged is called for %s', async (_label, key, expected) => {
        const harness = await startHarness();
        connectEveryListener(harness);
        await harness.settle();

        harness.OnyxUtils.keyChanged(key, {written: key});

        expect(receiverNames(harness.log)).toEqual(expected);
    });

    it('hands exact subscribers the written value by reference with the written key', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('plain', KEYS.PLAIN);
        connect('R1', R1);
        await settle();
        const plainValue = {a: 1};
        const memberValue = {id: 1};

        OnyxUtils.keyChanged(KEYS.PLAIN, plainValue);
        OnyxUtils.keyChanged(R1, memberValue);

        expect(log).toEqual([
            {name: 'plain', value: plainValue, key: KEYS.PLAIN},
            {name: 'R1', value: memberValue, key: R1},
        ]);
        expect(log.at(0)?.value).toBe(plainValue);
        expect(log.at(1)?.value).toBe(memberValue);
    });

    it('hands roots the cached collection with the collection key, not the value argument', async () => {
        const {Onyx, OnyxUtils, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        connect('root', REPORT);
        await settle();

        OnyxUtils.keyChanged(R1, {id: 'not in the cache'});
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

    describe('canUpdateSubscriber', () => {
        it('is asked about each matching subscription in subscription order and skips the ones it rejects', async () => {
            const {OnyxUtils, log, subscribe, settle} = await startHarness();
            const rejected = subscribe('rejected', R1);
            const accepted = subscribe('accepted', R1);
            const root = subscribe('root', REPORT);
            await settle();
            const asked: Array<number | undefined> = [];

            OnyxUtils.keyChanged(R1, {id: 1}, (subscriber) => {
                asked.push(subscriber?.subscriptionID);
                return subscriber?.subscriptionID !== rejected;
            });

            expect(asked).toEqual([rejected, accepted, root]);
            expect(receiverNames(log)).toEqual(['accepted', 'root']);
        });

        it('lets a rejected subscriber receive the same value on the next unfiltered keyChanged', async () => {
            const {OnyxUtils, log, subscribe, settle} = await startHarness();
            const rejected = subscribe('rejected', KEYS.PLAIN);
            subscribe('accepted', KEYS.PLAIN);
            await settle();
            const value = {a: 1};

            OnyxUtils.keyChanged(KEYS.PLAIN, value, (subscriber) => subscriber?.subscriptionID !== rejected);
            OnyxUtils.keyChanged(KEYS.PLAIN, value);

            expect(valuesFor(log, 'rejected')).toEqual([value]);
            expect(countFor(log, 'accepted')).toBe(1);
        });
    });
});

describe('keysChanged routing', () => {
    it('notifies the roots of the collection and the subscribers of the changed members only', async () => {
        const harness = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        connectEveryListener(harness);
        await harness.settle();

        harness.OnyxUtils.keysChanged(REPORT, {[R1]: {id: 1}}, {[R1]: {id: 0}});

        expect(receiverNames(harness.log)).toEqual(['R1', 'report root']);
    });

    it('notifies the same listeners for a public mergeCollection', async () => {
        const harness = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        connectEveryListener(harness);
        await harness.settle();

        await harness.Onyx.mergeCollection(REPORT, {[R1]: {id: 11}, [R10]: {id: 10}});

        expect(receiverNames(harness.log)).toEqual(['R1', 'R10', 'report root']);
    });

    it('hands members their cached value, not the partial value, and roots the cached collection', async () => {
        const {OnyxUtils, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('R1', R1);
        connect('root', REPORT);
        await settle();

        OnyxUtils.keysChanged(REPORT, {[R1]: {id: 'partial only'}}, {[R1]: {id: 0}});

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

    it('does not notify a member subscriber whose cached value is the same reference as its previous value', async () => {
        const {OnyxUtils, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        connect('R1', R1);
        connect('R2', R2);
        await settle();

        OnyxUtils.keysChanged(REPORT, {[R1]: cache.get(R1), [R2]: cache.get(R2)}, {[R1]: cache.get(R1), [R2]: {id: 0}});

        expect(receiverNames(log)).toEqual(['R2']);
    });

    it('treats a missing previous collection as every member having changed', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('R1', R1);
        await settle();

        OnyxUtils.keysChanged(REPORT, {[R1]: {id: 1}}, undefined);

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

describe('current behaviour (suspected bug)', () => {
    // The collection key is its own collection key, so keyChanged appends the root subscriptions to themselves.
    it('notifies a root twice for one write to the collection key itself', async () => {
        const {Onyx, OnyxUtils, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('root', REPORT);
        await settle();

        OnyxUtils.keyChanged(REPORT, {});
        expect(countFor(log, 'root')).toBe(2);
        await settle();

        await Onyx.set(REPORT, {});
        expect(countFor(log, 'root')).toBe(2);
    });

    // keysChanged has no early return for an empty batch, so nothing-changed writes still reach roots.
    it('notifies a root with an empty collection when an empty batch changes nothing', async () => {
        const {Onyx, OnyxUtils, log, connect, settle} = await startHarness();
        connect('root', REPORT);
        await settle();

        await Onyx.setCollection(REPORT, {});
        OnyxUtils.keysChanged(REPORT, {}, {});

        expect(valuesFor(log, 'root')).toEqual([{}, {}]);
    });
});
