import Onyx from '../../../../lib';
import onyxSubscriptionManager from '../../../../lib/OnyxSubscriptionManager';
import OnyxUtils from '../../../../lib/OnyxUtils';
import type {OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    OTHER: 'other',
    COLLECTION: {
        ITEMS: 'items_',
    },
};

const ITEM_1 = `${KEYS.COLLECTION.ITEMS}1`;
const ITEM_2 = `${KEYS.COLLECTION.ITEMS}2`;

Onyx.init({keys: KEYS});

type Spy = jest.Mock<void, [unknown, unknown]>;

function createSpy(implementation?: (value: unknown, key: unknown) => void): Spy {
    return jest.fn<void, [unknown, unknown]>(implementation);
}

function valuesOf(spy: Spy): unknown[] {
    return spy.mock.calls.map(([value]) => value);
}

function subscribe(key: OnyxKey, listener: Spy): () => void {
    return onyxSubscriptionManager.subscribe(key, listener);
}

function noop(): void {
    return undefined;
}

beforeEach(async () => {
    onyxSubscriptionManager.clearAll();
    await Onyx.clear();
    await waitForPromisesToResolve();
});

afterEach(() => {
    onyxSubscriptionManager.clearAll();
});

// main pinned OnyxUtils.subscribeToKey/unsubscribeFromKey here; #834 replaced them with onyxSubscriptionManager.subscribe and the unsubscribe function it returns, which has no first delivery.
describe('onyxSubscriptionManager unsubscribe contracts', () => {
    it('stops key and collection notifications for the unsubscribed listener only', async () => {
        const removed = createSpy();
        const kept = createSpy();
        const removedCollection = createSpy();
        const keptCollection = createSpy();
        const unsubscribeRemoved = subscribe(KEYS.PLAIN, removed);
        subscribe(KEYS.PLAIN, kept);
        const unsubscribeRemovedCollection = subscribe(KEYS.COLLECTION.ITEMS, removedCollection);
        subscribe(KEYS.COLLECTION.ITEMS, keptCollection);

        unsubscribeRemoved();
        unsubscribeRemovedCollection();
        await Onyx.set(KEYS.PLAIN, 'a');
        await Onyx.set(ITEM_1, {v: 1});
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_2]: {v: 2}});

        expect(removed).not.toHaveBeenCalled();
        expect(removedCollection).not.toHaveBeenCalled();
        expect(valuesOf(kept)).toEqual(['a']);
        expect(valuesOf(keptCollection)).toEqual([{[ITEM_1]: {v: 1}}, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}}]);
    });

    it('is a no-op when called a second time, and does not remove another listener on the key', async () => {
        const kept = createSpy();
        const removed = createSpy();
        subscribe(KEYS.PLAIN, kept);
        const unsubscribeRemoved = subscribe(KEYS.PLAIN, removed);

        unsubscribeRemoved();
        expect(() => unsubscribeRemoved()).not.toThrow();
        await Onyx.set(KEYS.PLAIN, 'after');

        expect(valuesOf(kept)).toEqual(['after']);
        expect(removed).not.toHaveBeenCalled();
    });

    it('is a no-op when called after clearAll, and does not remove a listener added after the clear', async () => {
        const unsubscribeOld = subscribe(KEYS.PLAIN, createSpy());
        onyxSubscriptionManager.clearAll();
        const fresh = createSpy();
        subscribe(KEYS.PLAIN, fresh);

        unsubscribeOld();
        await Onyx.set(KEYS.PLAIN, 'x');

        expect(valuesOf(fresh)).toEqual(['x']);
    });

    it('never routes a delivery for another key to a released listener', async () => {
        const released = createSpy();
        const live = createSpy();

        subscribe(KEYS.PLAIN, released)();
        subscribe(KEYS.OTHER, live);
        await Onyx.set(KEYS.PLAIN, 'plain-2');
        await Onyx.set(KEYS.OTHER, 'other-2');

        expect(released).not.toHaveBeenCalled();
        expect(live.mock.calls).toEqual([['other-2', KEYS.OTHER]]);
    });

    it('removes only the given listeners even when the same key has many subscribers', async () => {
        const spies = Array.from({length: 8}, () => createSpy());
        const unsubscribes = spies.map((spy) => subscribe(KEYS.PLAIN, spy));

        unsubscribes[0]();
        unsubscribes[3]();
        unsubscribes[7]();
        await Onyx.set(KEYS.PLAIN, 'x');

        const calledWithX = spies.map((spy) => valuesOf(spy).includes('x'));
        expect(calledWithX).toEqual([false, true, true, false, true, true, true, false]);
    });

    it('gives a listener subscribed again after the key lost its last listener every later notification', async () => {
        const first = createSpy();
        subscribe(KEYS.PLAIN, first)();
        expect(onyxSubscriptionManager.hasListenersForKey(KEYS.PLAIN)).toBe(false);

        const second = createSpy();
        subscribe(KEYS.PLAIN, second);
        await Onyx.set(KEYS.PLAIN, 'x');

        expect(first).not.toHaveBeenCalled();
        expect(valuesOf(second)).toEqual(['x']);
    });

    it('unsubscribing from inside a notification lets every remaining subscriber on the key receive the value', () => {
        let unsubscribeSelf = noop;
        const selfRemoving = createSpy((value) => {
            if (value !== 'trigger') {
                return;
            }
            unsubscribeSelf();
        });
        const second = createSpy();
        const third = createSpy();
        unsubscribeSelf = subscribe(KEYS.PLAIN, selfRemoving);
        subscribe(KEYS.PLAIN, second);
        subscribe(KEYS.PLAIN, third);

        OnyxUtils.notifyKey(KEYS.PLAIN, 'trigger');
        OnyxUtils.notifyKey(KEYS.PLAIN, 'after');

        expect(valuesOf(selfRemoving)).toEqual(['trigger']);
        expect(valuesOf(second)).toEqual(['trigger', 'after']);
        expect(valuesOf(third)).toEqual(['trigger', 'after']);
    });

    it('unsubscribing a collection root from inside a collection notification lets the other collection roots receive the batch', async () => {
        let unsubscribeSelf = noop;
        const selfRemoving = createSpy(() => unsubscribeSelf());
        const second = createSpy();
        unsubscribeSelf = subscribe(KEYS.COLLECTION.ITEMS, selfRemoving);
        subscribe(KEYS.COLLECTION.ITEMS, second);

        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_2]: {v: 2}});

        expect(selfRemoving).toHaveBeenCalledTimes(1);
        expect(valuesOf(second)).toEqual([{[ITEM_1]: {v: 1}}, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}}]);
    });

    it.each([
        ['a new member', false],
        ['an existing member', true],
    ])('unsubscribing a member subscriber from a collection root notification of %s skips that member for the batch', async (_label, seed) => {
        if (seed) {
            await Onyx.set(ITEM_1, {v: 0});
        }
        let unsubscribeMember = noop;
        const collection = createSpy((value) => {
            if (!(value && typeof value === 'object' && ITEM_1 in value)) {
                return;
            }
            unsubscribeMember();
        });
        const member = createSpy();
        subscribe(KEYS.COLLECTION.ITEMS, collection);
        unsubscribeMember = subscribe(ITEM_1, member);

        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});

        expect(collection).toHaveBeenCalledTimes(1);
        expect(member).not.toHaveBeenCalled();
    });

    describe('current behaviour (#834 change)', () => {
        // main stopped the sibling before it received the value being dispatched; #834 dispatches over a copy of the listener set.
        it.each([
            ['a plain key', KEYS.PLAIN, 'trigger'],
            ['a collection member key', ITEM_1, {v: 'trigger'}],
        ])('unsubscribing a later sibling from inside notifyKey for %s still delivers that value to the sibling, but no later one', (_label, key, triggerValue) => {
            let unsubscribeSibling = noop;
            const remover = createSpy((value) => {
                if (value !== triggerValue) {
                    return;
                }
                unsubscribeSibling();
            });
            const sibling = createSpy();
            const bystander = createSpy();
            subscribe(key, remover);
            unsubscribeSibling = subscribe(key, sibling);
            subscribe(key, bystander);

            OnyxUtils.notifyKey(key, triggerValue);
            OnyxUtils.notifyKey(key, 'after');

            expect(valuesOf(sibling)).toEqual([triggerValue]);
            expect(valuesOf(bystander)).toEqual([triggerValue, 'after']);
        });

        // main stopped the later collection root before it received the batch.
        it('unsubscribing a later collection root from inside a collection notification still delivers that batch to it, but no later one', async () => {
            let unsubscribeLater = noop;
            const remover = createSpy(() => unsubscribeLater());
            const later = createSpy();
            const bystander = createSpy();
            subscribe(KEYS.COLLECTION.ITEMS, remover);
            unsubscribeLater = subscribe(KEYS.COLLECTION.ITEMS, later);
            subscribe(KEYS.COLLECTION.ITEMS, bystander);

            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_2]: {v: 2}});

            expect(valuesOf(later)).toEqual([{[ITEM_1]: {v: 1}}]);
            expect(valuesOf(bystander)).toEqual([{[ITEM_1]: {v: 1}}, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}}]);
        });

        // main stopped the later member subscriber before it received the batch.
        it.each([
            ['a new member', false],
            ['an existing member', true],
        ])('unsubscribing a later member subscriber from inside a collection notification for %s still delivers that batch to it, but no later one', async (_label, seed) => {
            if (seed) {
                await Onyx.set(ITEM_1, {v: 0});
            }
            let unsubscribeLater = noop;
            const remover = createSpy((value) => {
                if (!(value && typeof value === 'object' && 'v' in value && value.v === 1)) {
                    return;
                }
                unsubscribeLater();
            });
            const later = createSpy();
            const bystander = createSpy();
            subscribe(ITEM_1, remover);
            unsubscribeLater = subscribe(ITEM_1, later);
            subscribe(ITEM_1, bystander);

            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 2}});

            expect(valuesOf(later)).toEqual([{v: 1}]);
            expect(valuesOf(bystander)).toEqual([{v: 1}, {v: 2}]);
        });
    });
});

describe('first connection of a fresh module registry', () => {
    let IsolatedOnyx: typeof Onyx;

    beforeEach(() => {
        jest.isolateModules(() => {
            IsolatedOnyx = require('../../../../lib').default;
        });
        IsolatedOnyx.init({keys: KEYS});
    });

    it('can be disconnected through Onyx.disconnect like any other connection', async () => {
        const spy = createSpy();

        const connection = IsolatedOnyx.connect({key: KEYS.PLAIN, callback: spy});
        await waitForPromisesToResolve();
        IsolatedOnyx.disconnect(connection);
        await IsolatedOnyx.set(KEYS.PLAIN, 'x');

        expect(valuesOf(spy)).toEqual([undefined]);
    });
});
