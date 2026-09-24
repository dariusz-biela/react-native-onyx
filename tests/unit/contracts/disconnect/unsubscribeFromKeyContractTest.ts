import Onyx from '../../../../lib';
import connectionManager from '../../../../lib/OnyxConnectionManager';
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

const liveSubscriptionIDs = new Set<number>();

function subscribe(key: OnyxKey, callback: Spy): number {
    const subscriptionID = OnyxUtils.subscribeToKey({key, callback});
    liveSubscriptionIDs.add(subscriptionID);
    return subscriptionID;
}

beforeEach(async () => {
    connectionManager.disconnectAll();
    await Onyx.clear();
    await waitForPromisesToResolve();
});

afterEach(() => {
    for (const subscriptionID of liveSubscriptionIDs) {
        OnyxUtils.unsubscribeFromKey(subscriptionID);
    }
    liveSubscriptionIDs.clear();
});

describe('OnyxUtils.unsubscribeFromKey contracts', () => {
    it('cancels the pending first delivery when called in the same tick as subscribeToKey', async () => {
        await Onyx.multiSet({[KEYS.PLAIN]: 'plain', [ITEM_1]: {v: 1}});
        const plainSpy = createSpy();
        const collectionSpy = createSpy();

        OnyxUtils.unsubscribeFromKey(subscribe(KEYS.PLAIN, plainSpy));
        OnyxUtils.unsubscribeFromKey(subscribe(KEYS.COLLECTION.ITEMS, collectionSpy));
        await waitForPromisesToResolve();

        expect(plainSpy).not.toHaveBeenCalled();
        expect(collectionSpy).not.toHaveBeenCalled();
    });

    it('cancels the pending first delivery of a key that has no value yet', async () => {
        const spy = createSpy();

        OnyxUtils.unsubscribeFromKey(subscribe(KEYS.OTHER, spy));
        await waitForPromisesToResolve();

        expect(spy).not.toHaveBeenCalled();
    });

    it('stops keyChanged and keysChanged notifications for the unsubscribed ID only', async () => {
        const removed = createSpy();
        const kept = createSpy();
        const removedCollection = createSpy();
        const keptCollection = createSpy();
        const removedID = subscribe(KEYS.PLAIN, removed);
        subscribe(KEYS.PLAIN, kept);
        const removedCollectionID = subscribe(KEYS.COLLECTION.ITEMS, removedCollection);
        subscribe(KEYS.COLLECTION.ITEMS, keptCollection);
        await waitForPromisesToResolve();
        removed.mockClear();
        kept.mockClear();
        removedCollection.mockClear();
        keptCollection.mockClear();

        OnyxUtils.unsubscribeFromKey(removedID);
        OnyxUtils.unsubscribeFromKey(removedCollectionID);
        await Onyx.set(KEYS.PLAIN, 'a');
        await Onyx.set(ITEM_1, {v: 1});
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_2]: {v: 2}});

        expect(removed).not.toHaveBeenCalled();
        expect(removedCollection).not.toHaveBeenCalled();
        expect(valuesOf(kept)).toEqual(['a']);
        expect(valuesOf(keptCollection)).toEqual([{[ITEM_1]: {v: 1}}, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}}]);
    });

    it('is a no-op for an unknown ID and for a second call with the same ID', async () => {
        const kept = createSpy();
        const removed = createSpy();
        subscribe(KEYS.PLAIN, kept);
        const removedID = subscribe(KEYS.PLAIN, removed);
        await waitForPromisesToResolve();

        expect(() => OnyxUtils.unsubscribeFromKey(-1)).not.toThrow();
        expect(() => OnyxUtils.unsubscribeFromKey(Number.MAX_SAFE_INTEGER)).not.toThrow();
        OnyxUtils.unsubscribeFromKey(removedID);
        OnyxUtils.unsubscribeFromKey(removedID);
        await Onyx.set(KEYS.PLAIN, 'after');

        expect(valuesOf(kept)).toEqual([undefined, 'after']);
        expect(valuesOf(removed)).toEqual([undefined]);
    });

    it('never hands out an ID that is still in use or was released', () => {
        const seen = new Set<number>();
        for (let index = 0; index < 30; index++) {
            const subscriptionID = subscribe(index % 2 === 0 ? KEYS.PLAIN : KEYS.COLLECTION.ITEMS, createSpy());
            expect(seen.has(subscriptionID)).toBe(false);
            seen.add(subscriptionID);
            if (index % 3 === 0) {
                OnyxUtils.unsubscribeFromKey(subscriptionID);
            }
        }
    });

    it('an ID released before its first delivery never routes a later subscription delivery to the released callback', async () => {
        await Onyx.multiSet({[KEYS.PLAIN]: 'plain', [KEYS.OTHER]: 'other'});
        const released = createSpy();
        const live = createSpy();

        OnyxUtils.unsubscribeFromKey(subscribe(KEYS.PLAIN, released));
        subscribe(KEYS.OTHER, live);
        await waitForPromisesToResolve();
        await Onyx.set(KEYS.PLAIN, 'plain-2');

        expect(released).not.toHaveBeenCalled();
        expect(live.mock.calls).toEqual([['other', KEYS.OTHER]]);
    });

    it('unsubscribing from inside a notification lets every remaining subscriber on the key receive the value', async () => {
        const ids: number[] = [];
        const selfRemoving = createSpy((value) => {
            if (value !== 'trigger') {
                return;
            }
            OnyxUtils.unsubscribeFromKey(ids[0]);
        });
        const second = createSpy();
        const third = createSpy();
        ids.push(subscribe(KEYS.PLAIN, selfRemoving));
        ids.push(subscribe(KEYS.PLAIN, second));
        ids.push(subscribe(KEYS.PLAIN, third));
        await waitForPromisesToResolve();

        OnyxUtils.keyChanged(KEYS.PLAIN, 'trigger');
        OnyxUtils.keyChanged(KEYS.PLAIN, 'after');

        expect(valuesOf(selfRemoving)).toEqual([undefined, 'trigger']);
        expect(valuesOf(second)).toEqual([undefined, 'trigger', 'after']);
        expect(valuesOf(third)).toEqual([undefined, 'trigger', 'after']);
    });

    it('unsubscribing a collection root from inside keysChanged lets the other collection roots receive the batch', async () => {
        const ids: number[] = [];
        const selfRemoving = createSpy((value) => {
            if (!value) {
                return;
            }
            OnyxUtils.unsubscribeFromKey(ids[0]);
        });
        const second = createSpy();
        ids.push(subscribe(KEYS.COLLECTION.ITEMS, selfRemoving));
        ids.push(subscribe(KEYS.COLLECTION.ITEMS, second));
        await waitForPromisesToResolve();
        second.mockClear();

        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_2]: {v: 2}});

        expect(selfRemoving).toHaveBeenCalledTimes(2);
        expect(valuesOf(second)).toEqual([{[ITEM_1]: {v: 1}}, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}}]);
    });

    it('unsubscribing a member subscriber from inside a collection root notification skips that member for the batch', async () => {
        let memberID = -1;
        const collection = createSpy((value) => {
            if (!value) {
                return;
            }
            OnyxUtils.unsubscribeFromKey(memberID);
        });
        const member = createSpy();
        subscribe(KEYS.COLLECTION.ITEMS, collection);
        memberID = subscribe(ITEM_1, member);
        await waitForPromisesToResolve();
        member.mockClear();

        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});

        expect(member).not.toHaveBeenCalled();
    });

    it.each([
        ['a plain key', KEYS.PLAIN, 'trigger'],
        ['a collection member key', ITEM_1, {v: 'trigger'}],
    ])('unsubscribing a later sibling from inside keyChanged for %s stops the sibling before it receives that value', async (_label, key, triggerValue) => {
        let siblingID = -1;
        const remover = createSpy((value) => {
            if (value !== triggerValue) {
                return;
            }
            OnyxUtils.unsubscribeFromKey(siblingID);
        });
        const sibling = createSpy();
        const bystander = createSpy();
        subscribe(key, remover);
        siblingID = subscribe(key, sibling);
        subscribe(key, bystander);
        await waitForPromisesToResolve();

        OnyxUtils.keyChanged(key, triggerValue);
        OnyxUtils.keyChanged(key, 'after');

        expect(valuesOf(sibling)).toEqual([undefined]);
        expect(valuesOf(bystander)).toEqual([undefined, triggerValue, 'after']);
    });

    it('unsubscribing a later collection root from inside keysChanged stops it before it receives the batch', async () => {
        let laterID = -1;
        const remover = createSpy((value) => {
            if (!value) {
                return;
            }
            OnyxUtils.unsubscribeFromKey(laterID);
        });
        const later = createSpy();
        const bystander = createSpy();
        subscribe(KEYS.COLLECTION.ITEMS, remover);
        laterID = subscribe(KEYS.COLLECTION.ITEMS, later);
        subscribe(KEYS.COLLECTION.ITEMS, bystander);
        await waitForPromisesToResolve();

        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});

        expect(valuesOf(later)).toEqual([undefined]);
        expect(valuesOf(bystander)).toEqual([undefined, {[ITEM_1]: {v: 1}}]);
    });

    it.each([
        ['a new member', false],
        ['an existing member', true],
    ])('unsubscribing a later member subscriber from inside keysChanged for %s stops it before it receives the batch', async (_label, seed) => {
        if (seed) {
            await Onyx.set(ITEM_1, {v: 0});
        }
        let laterID = -1;
        const remover = createSpy((value) => {
            if (!(value && typeof value === 'object' && 'v' in value && value.v === 1)) {
                return;
            }
            OnyxUtils.unsubscribeFromKey(laterID);
        });
        const later = createSpy();
        const bystander = createSpy();
        subscribe(ITEM_1, remover);
        laterID = subscribe(ITEM_1, later);
        subscribe(ITEM_1, bystander);
        await waitForPromisesToResolve();
        later.mockClear();
        bystander.mockClear();

        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});

        expect(later).not.toHaveBeenCalled();
        expect(valuesOf(bystander)).toEqual([{v: 1}]);
    });

    it.each([
        ['a new member', false],
        ['an existing member', true],
    ])('unsubscribing a member subscriber from a collection root notification of %s skips that member for the batch', async (_label, seed) => {
        if (seed) {
            await Onyx.set(ITEM_1, {v: 0});
        }
        let memberID = -1;
        const collection = createSpy((value) => {
            if (!(value && typeof value === 'object' && ITEM_1 in value)) {
                return;
            }
            OnyxUtils.unsubscribeFromKey(memberID);
        });
        const member = createSpy();
        subscribe(KEYS.COLLECTION.ITEMS, collection);
        await waitForPromisesToResolve();
        memberID = subscribe(ITEM_1, member);
        await waitForPromisesToResolve();
        member.mockClear();

        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}});

        expect(member).not.toHaveBeenCalled();
    });
});

describe('OnyxUtils.deleteKeyBySubscriptions contracts', () => {
    it('stops change notifications for that ID while other IDs on the same key keep receiving them', async () => {
        const removed = createSpy();
        const kept = createSpy();
        const removedID = subscribe(KEYS.PLAIN, removed);
        subscribe(KEYS.PLAIN, kept);
        await waitForPromisesToResolve();

        OnyxUtils.deleteKeyBySubscriptions(removedID);
        await Onyx.set(KEYS.PLAIN, 'a');
        OnyxUtils.keyChanged(KEYS.PLAIN, 'b');

        expect(valuesOf(removed)).toEqual([undefined]);
        expect(valuesOf(kept)).toEqual([undefined, 'a', 'b']);
    });

    it('stops collection and member notifications for that ID only', async () => {
        const removedCollection = createSpy();
        const keptCollection = createSpy();
        const removedMember = createSpy();
        const keptMember = createSpy();
        const removedCollectionID = subscribe(KEYS.COLLECTION.ITEMS, removedCollection);
        subscribe(KEYS.COLLECTION.ITEMS, keptCollection);
        const removedMemberID = subscribe(ITEM_1, removedMember);
        subscribe(ITEM_1, keptMember);
        await waitForPromisesToResolve();
        removedCollection.mockClear();
        keptCollection.mockClear();
        removedMember.mockClear();
        keptMember.mockClear();

        OnyxUtils.deleteKeyBySubscriptions(removedCollectionID);
        OnyxUtils.deleteKeyBySubscriptions(removedMemberID);
        await Onyx.set(ITEM_1, {v: 1});
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 2}});

        expect(removedCollection).not.toHaveBeenCalled();
        expect(removedMember).not.toHaveBeenCalled();
        expect(valuesOf(keptMember)).toEqual([{v: 1}, {v: 2}]);
        expect(valuesOf(keptCollection)).toEqual([{[ITEM_1]: {v: 1}}, {[ITEM_1]: {v: 2}}]);
    });

    it('is a no-op for an unknown ID and when repeated, and a later unsubscribeFromKey still works', async () => {
        const kept = createSpy();
        const removed = createSpy();
        subscribe(KEYS.PLAIN, kept);
        const removedID = subscribe(KEYS.PLAIN, removed);
        await waitForPromisesToResolve();

        expect(() => OnyxUtils.deleteKeyBySubscriptions(-1)).not.toThrow();
        OnyxUtils.deleteKeyBySubscriptions(removedID);
        OnyxUtils.deleteKeyBySubscriptions(removedID);
        OnyxUtils.unsubscribeFromKey(removedID);
        await Onyx.set(KEYS.PLAIN, 'after');

        expect(valuesOf(kept)).toEqual([undefined, 'after']);
        expect(valuesOf(removed)).toEqual([undefined]);
    });

    it('removes only the given ID even when the same key has many subscribers', async () => {
        const spies = Array.from({length: 8}, () => createSpy());
        const ids = spies.map((spy) => subscribe(KEYS.PLAIN, spy));
        await waitForPromisesToResolve();

        OnyxUtils.deleteKeyBySubscriptions(ids[0]);
        OnyxUtils.deleteKeyBySubscriptions(ids[3]);
        OnyxUtils.deleteKeyBySubscriptions(ids[7]);
        await Onyx.set(KEYS.PLAIN, 'x');

        const calledWithX = spies.map((spy) => valuesOf(spy).includes('x'));
        expect(calledWithX).toEqual([false, true, true, false, true, true, true, false]);
    });

    it('a subscriber re-added for the same key after its ID was removed receives notifications under its new ID', async () => {
        const first = createSpy();
        const firstID = subscribe(KEYS.PLAIN, first);
        await waitForPromisesToResolve();
        OnyxUtils.unsubscribeFromKey(firstID);

        const second = createSpy();
        subscribe(KEYS.PLAIN, second);
        await waitForPromisesToResolve();
        await Onyx.set(KEYS.PLAIN, 'x');

        expect(valuesOf(first)).toEqual([undefined]);
        expect(valuesOf(second)).toEqual([undefined, 'x']);
    });
});

describe('first subscription ID of a fresh module registry', () => {
    let IsolatedOnyx: typeof Onyx;
    let IsolatedOnyxUtils: typeof OnyxUtils;

    beforeEach(() => {
        jest.isolateModules(() => {
            IsolatedOnyx = require('../../../../lib').default;
            IsolatedOnyxUtils = require('../../../../lib/OnyxUtils').default;
        });
        IsolatedOnyx.init({keys: KEYS});
    });

    it('can be unsubscribed like any other ID', async () => {
        const spy = createSpy();

        const subscriptionID = IsolatedOnyxUtils.subscribeToKey({key: KEYS.PLAIN, callback: spy});
        IsolatedOnyxUtils.unsubscribeFromKey(subscriptionID);
        await waitForPromisesToResolve();
        await IsolatedOnyx.set(KEYS.PLAIN, 'x');

        expect(subscriptionID).toBe(0);
        expect(spy).not.toHaveBeenCalled();
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
