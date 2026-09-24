import Onyx from '../../../../lib';
import type {Connection} from '../../../../lib/OnyxConnectionManager';
import connectionManager from '../../../../lib/OnyxConnectionManager';
import OnyxCache from '../../../../lib/OnyxCache';
import {mockStore} from '../../../../lib/storage/providers/MemoryOnlyProvider';
import type {OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    OTHER: 'other',
    COLLECTION: {
        ITEMS: 'items_',
        NESTED: 'items_nested_',
        OTHER: 'otherItems_',
    },
};

const ITEM_1 = `${KEYS.COLLECTION.ITEMS}1`;
const ITEM_10 = `${KEYS.COLLECTION.ITEMS}10`;
const ITEM_2 = `${KEYS.COLLECTION.ITEMS}2`;
const NESTED_1 = `${KEYS.COLLECTION.NESTED}1`;

Onyx.init({keys: KEYS});

type Spy = jest.Mock<void, [unknown, unknown]>;

function createSpy(implementation?: (value: unknown, key: unknown) => void): Spy {
    return jest.fn<void, [unknown, unknown]>(implementation);
}

function valuesOf(spy: Spy): unknown[] {
    return spy.mock.calls.map(([value]) => value);
}

function connect(key: OnyxKey, callback: Spy, reuseConnection?: boolean): Connection {
    return Onyx.connect({key, callback, reuseConnection});
}

beforeEach(async () => {
    connectionManager.disconnectAll();
    await Onyx.clear();
    await waitForPromisesToResolve();
});

describe('Onyx.disconnect contracts', () => {
    describe.each([
        ['a reused connection', undefined],
        ['a non-reused connection', false],
    ])('no delivery after disconnect on %s', (_label, reuseConnection) => {
        it('never calls the callback when disconnected in the same tick as connect, even for a key with a stored value', async () => {
            await Onyx.set(KEYS.PLAIN, 'stored');
            const spy = createSpy();

            const connection = connect(KEYS.PLAIN, spy, reuseConnection);
            Onyx.disconnect(connection);
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'changed');
            await waitForPromisesToResolve();

            expect(spy).not.toHaveBeenCalled();
            expect(OnyxCache.get(KEYS.PLAIN)).toBe('changed');
        });

        it('never calls the callback for a collection root disconnected in the same tick as connect', async () => {
            await Onyx.set(ITEM_1, {id: 1});
            const spy = createSpy();

            const connection = connect(KEYS.COLLECTION.ITEMS, spy, reuseConnection);
            Onyx.disconnect(connection);
            await waitForPromisesToResolve();
            await Onyx.set(ITEM_2, {id: 2});
            await waitForPromisesToResolve();

            expect(spy).not.toHaveBeenCalled();
        });

        it('stops every kind of write from reaching the callback once disconnected', async () => {
            const spy = createSpy();
            const connection = connect(KEYS.PLAIN, spy, reuseConnection);
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, {a: 1});
            expect(valuesOf(spy)).toEqual([undefined, {a: 1}]);

            Onyx.disconnect(connection);
            spy.mockClear();

            await Onyx.set(KEYS.PLAIN, {a: 2});
            await Onyx.merge(KEYS.PLAIN, {b: 3});
            await Onyx.multiSet({[KEYS.PLAIN]: {a: 4}});
            await Onyx.update([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.PLAIN, value: {c: 5}}]);
            await Onyx.set(KEYS.PLAIN, null);
            await Onyx.set(KEYS.PLAIN, {a: 6});
            await Onyx.clear();
            await waitForPromisesToResolve();

            expect(spy).not.toHaveBeenCalled();
        });

        it('does not deliver a merge that was scheduled in the same tick as the disconnect, while the write itself still lands', async () => {
            const spy = createSpy();
            const connection = connect(KEYS.PLAIN, spy, reuseConnection);
            await waitForPromisesToResolve();
            spy.mockClear();

            const mergePromise = Onyx.merge(KEYS.PLAIN, {merged: true});
            const updatePromise = Onyx.update([{onyxMethod: Onyx.METHOD.MERGE, key: KEYS.PLAIN, value: {updated: true}}]);
            Onyx.disconnect(connection);
            await Promise.all([mergePromise, updatePromise]);
            await waitForPromisesToResolve();

            expect(spy).not.toHaveBeenCalled();
            expect(OnyxCache.get(KEYS.PLAIN)).toEqual({merged: true, updated: true});
            expect(mockStore[KEYS.PLAIN]).toEqual({merged: true, updated: true});
        });

        it('stops collection-level writes from reaching a disconnected collection root while a member subscriber keeps receiving them', async () => {
            const collectionSpy = createSpy();
            const memberSpy = createSpy();
            const collectionConnection = connect(KEYS.COLLECTION.ITEMS, collectionSpy, reuseConnection);
            connect(ITEM_1, memberSpy, reuseConnection);
            await waitForPromisesToResolve();

            Onyx.disconnect(collectionConnection);
            collectionSpy.mockClear();
            memberSpy.mockClear();

            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}});
            await Onyx.set(ITEM_1, {v: 3});
            await Onyx.setCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 4}});
            await Onyx.set(ITEM_2, null);
            await waitForPromisesToResolve();

            expect(collectionSpy).not.toHaveBeenCalled();
            expect(valuesOf(memberSpy)).toEqual([{v: 1}, {v: 3}, {v: 4}]);
        });

        it('stops a disconnected member subscriber while the collection root keeps receiving the final collection', async () => {
            const collectionSpy = createSpy();
            const memberSpy = createSpy();
            connect(KEYS.COLLECTION.ITEMS, collectionSpy, reuseConnection);
            const memberConnection = connect(ITEM_1, memberSpy, reuseConnection);
            await waitForPromisesToResolve();

            Onyx.disconnect(memberConnection);
            collectionSpy.mockClear();
            memberSpy.mockClear();

            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}});
            await Onyx.set(ITEM_1, {v: 3});
            await waitForPromisesToResolve();

            expect(memberSpy).not.toHaveBeenCalled();
            expect(collectionSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
            expect(collectionSpy).toHaveBeenLastCalledWith({[ITEM_1]: {v: 3}, [ITEM_2]: {v: 2}}, KEYS.COLLECTION.ITEMS);
        });
    });

    describe('key isolation', () => {
        it('disconnecting a member subscriber leaves a subscriber of a prefix-colliding member key untouched', async () => {
            const item1Spy = createSpy();
            const item10Spy = createSpy();
            const item1Connection = connect(ITEM_1, item1Spy);
            connect(ITEM_10, item10Spy);
            await waitForPromisesToResolve();
            item1Spy.mockClear();
            item10Spy.mockClear();

            Onyx.disconnect(item1Connection);
            await Onyx.set(ITEM_1, 'one');
            await Onyx.set(ITEM_10, 'ten');
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: 'one-b', [ITEM_10]: 'ten-b'});

            expect(item1Spy).not.toHaveBeenCalled();
            expect(item10Spy.mock.calls).toEqual([
                ['ten', ITEM_10],
                ['ten-b', ITEM_10],
            ]);
        });

        it('disconnecting a subscriber of a prefix-colliding member key leaves the shorter member key untouched', async () => {
            const item1Spy = createSpy();
            const item10Spy = createSpy();
            connect(ITEM_1, item1Spy);
            const item10Connection = connect(ITEM_10, item10Spy);
            await waitForPromisesToResolve();
            item1Spy.mockClear();
            item10Spy.mockClear();

            Onyx.disconnect(item10Connection);
            await Onyx.set(ITEM_10, 'ten');
            await Onyx.set(ITEM_1, 'one');

            expect(item10Spy).not.toHaveBeenCalled();
            expect(item1Spy.mock.calls).toEqual([['one', ITEM_1]]);
        });

        it('disconnecting a nested collection root leaves the outer collection root working and vice versa', async () => {
            const outerSpy = createSpy();
            const nestedSpy = createSpy();
            const outerConnection = connect(KEYS.COLLECTION.ITEMS, outerSpy);
            const nestedConnection = connect(KEYS.COLLECTION.NESTED, nestedSpy);
            await waitForPromisesToResolve();
            outerSpy.mockClear();
            nestedSpy.mockClear();

            Onyx.disconnect(nestedConnection);
            await Onyx.set(NESTED_1, {nested: 1});
            await Onyx.set(ITEM_1, {outer: 1});

            expect(nestedSpy).not.toHaveBeenCalled();
            expect(outerSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
            expect(outerSpy.mock.lastCall?.[0]).toMatchObject({[ITEM_1]: {outer: 1}});

            const nestedAgainSpy = createSpy();
            connect(KEYS.COLLECTION.NESTED, nestedAgainSpy);
            await waitForPromisesToResolve();
            Onyx.disconnect(outerConnection);
            outerSpy.mockClear();
            nestedAgainSpy.mockClear();

            await Onyx.set(NESTED_1, {nested: 2});
            await Onyx.set(ITEM_1, {outer: 2});

            expect(outerSpy).not.toHaveBeenCalled();
            expect(nestedAgainSpy.mock.calls).toEqual([[{[NESTED_1]: {nested: 2}}, KEYS.COLLECTION.NESTED]]);
        });

        it('disconnecting a subscriber of one key does not affect subscribers of other keys or other collections', async () => {
            const plainSpy = createSpy();
            const otherSpy = createSpy();
            const otherCollectionSpy = createSpy();
            const plainConnection = connect(KEYS.PLAIN, plainSpy);
            connect(KEYS.OTHER, otherSpy);
            connect(KEYS.COLLECTION.OTHER, otherCollectionSpy);
            await waitForPromisesToResolve();
            otherSpy.mockClear();
            otherCollectionSpy.mockClear();

            Onyx.disconnect(plainConnection);
            await Onyx.multiSet({[KEYS.PLAIN]: 1, [KEYS.OTHER]: 2, [`${KEYS.COLLECTION.OTHER}1`]: 3});

            expect(valuesOf(otherSpy)).toEqual([2]);
            expect(valuesOf(otherCollectionSpy)).toEqual([{[`${KEYS.COLLECTION.OTHER}1`]: 3}]);
        });
    });

    describe('shared connection', () => {
        it('disconnecting one of several callbacks on a shared connection leaves the others receiving every change in order', async () => {
            const first = createSpy();
            const middle = createSpy();
            const last = createSpy();
            connect(KEYS.PLAIN, first);
            const middleConnection = connect(KEYS.PLAIN, middle);
            connect(KEYS.PLAIN, last);
            await waitForPromisesToResolve();

            Onyx.disconnect(middleConnection);
            await Onyx.set(KEYS.PLAIN, 'a');
            await Onyx.merge(KEYS.PLAIN, 'b');
            await Onyx.set(KEYS.PLAIN, 'b');

            expect(valuesOf(first)).toEqual([undefined, 'a', 'b']);
            expect(valuesOf(last)).toEqual([undefined, 'a', 'b']);
            expect(valuesOf(middle)).toEqual([undefined]);
        });

        it('disconnecting the first subscriber leaves late subscribers that joined an established connection working', async () => {
            await Onyx.set(KEYS.PLAIN, 'initial');
            const first = createSpy();
            const firstConnection = connect(KEYS.PLAIN, first);
            await waitForPromisesToResolve();
            const late = createSpy();
            connect(KEYS.PLAIN, late);
            await waitForPromisesToResolve();

            Onyx.disconnect(firstConnection);
            await Onyx.set(KEYS.PLAIN, 'next');

            expect(first.mock.calls).toEqual([['initial', KEYS.PLAIN]]);
            expect(late.mock.calls).toEqual([
                ['initial', KEYS.PLAIN],
                ['next', KEYS.PLAIN],
            ]);
        });

        it('disconnecting the same handle twice does not remove a sibling callback from the shared connection', async () => {
            const kept = createSpy();
            const removed = createSpy();
            connect(KEYS.PLAIN, kept);
            const removedConnection = connect(KEYS.PLAIN, removed);
            await waitForPromisesToResolve();

            Onyx.disconnect(removedConnection);
            Onyx.disconnect(removedConnection);
            Onyx.disconnect(removedConnection);
            await Onyx.set(KEYS.PLAIN, 'after');

            expect(valuesOf(kept)).toEqual([undefined, 'after']);
            expect(valuesOf(removed)).toEqual([undefined]);
        });

        it('a stale handle of a torn-down connection does not disconnect a newer connection to the same key', async () => {
            const oldSpy = createSpy();
            const oldConnection = connect(KEYS.PLAIN, oldSpy);
            await waitForPromisesToResolve();
            Onyx.disconnect(oldConnection);

            const newSpy = createSpy();
            const newConnection = connect(KEYS.PLAIN, newSpy);
            await waitForPromisesToResolve();
            Onyx.disconnect(oldConnection);
            await Onyx.set(KEYS.PLAIN, 'fresh');

            expect(newConnection.id).toBe(oldConnection.id);
            expect(valuesOf(oldSpy)).toEqual([undefined]);
            expect(valuesOf(newSpy)).toEqual([undefined, 'fresh']);
        });

        it('disconnecting an undefined or unknown handle neither throws nor affects live subscribers', async () => {
            const spy = createSpy();
            const connection = connect(KEYS.PLAIN, spy);
            await waitForPromisesToResolve();

            expect(() => Onyx.disconnect(undefined as unknown as Connection)).not.toThrow();
            expect(() => Onyx.disconnect({id: 'unknown', callbackID: '0'})).not.toThrow();
            expect(() => Onyx.disconnect({id: connection.id, callbackID: 'not-a-callback'})).not.toThrow();
            await Onyx.set(KEYS.PLAIN, 'still');

            expect(valuesOf(spy)).toEqual([undefined, 'still']);
        });

        it('keeps the non-reused connections of the same key independent when one is disconnected', async () => {
            const shared = createSpy();
            const uniqueA = createSpy();
            const uniqueB = createSpy();
            connect(KEYS.PLAIN, shared);
            const uniqueAConnection = connect(KEYS.PLAIN, uniqueA, false);
            connect(KEYS.PLAIN, uniqueB, false);
            await waitForPromisesToResolve();

            Onyx.disconnect(uniqueAConnection);
            await Onyx.set(KEYS.PLAIN, 'x');

            expect(valuesOf(shared)).toEqual([undefined, 'x']);
            expect(valuesOf(uniqueA)).toEqual([undefined]);
            expect(valuesOf(uniqueB)).toEqual([undefined, 'x']);
        });

        it('tears the connection down only when its last callback disconnects', async () => {
            const a = createSpy();
            const b = createSpy();
            const aConnection = connect(KEYS.PLAIN, a);
            const bConnection = connect(KEYS.PLAIN, b);
            await waitForPromisesToResolve();

            Onyx.disconnect(aConnection);
            await Onyx.set(KEYS.PLAIN, 1);
            Onyx.disconnect(bConnection);
            await Onyx.set(KEYS.PLAIN, 2);

            expect(valuesOf(a)).toEqual([undefined]);
            expect(valuesOf(b)).toEqual([undefined, 1]);
        });
    });

    describe('disconnect during a notification', () => {
        it.each([
            ['separate subscriptions', false],
            ['a shared connection', undefined],
        ])('a subscriber that disconnects itself does not stop the rest from receiving the same value (%s)', async (_label, reuseConnection) => {
            const connections: Connection[] = [];
            const selfDisconnecting = createSpy((value) => {
                if (value !== 'trigger') {
                    return;
                }
                Onyx.disconnect(connections[0]);
            });
            const second = createSpy();
            const third = createSpy();
            connections.push(connect(KEYS.PLAIN, selfDisconnecting, reuseConnection));
            connections.push(connect(KEYS.PLAIN, second, reuseConnection));
            connections.push(connect(KEYS.PLAIN, third, reuseConnection));
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 'trigger');
            await Onyx.set(KEYS.PLAIN, 'after');

            expect(valuesOf(selfDisconnecting)).toEqual([undefined, 'trigger']);
            expect(valuesOf(second)).toEqual([undefined, 'trigger', 'after']);
            expect(valuesOf(third)).toEqual([undefined, 'trigger', 'after']);
        });

        it.each([
            ['separate subscriptions', false],
            ['a shared connection', undefined],
        ])('a subscriber that disconnects a later sibling prevents the sibling from receiving the value being dispatched (%s)', async (_label, reuseConnection) => {
            let siblingConnection: Connection | undefined;
            const disconnector = createSpy((value) => {
                if (value !== 'trigger' || !siblingConnection) {
                    return;
                }
                Onyx.disconnect(siblingConnection);
            });
            const sibling = createSpy();
            const bystander = createSpy();
            connect(KEYS.PLAIN, disconnector, reuseConnection);
            siblingConnection = connect(KEYS.PLAIN, sibling, reuseConnection);
            connect(KEYS.PLAIN, bystander, reuseConnection);
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 'trigger');
            await Onyx.set(KEYS.PLAIN, 'after');

            expect(valuesOf(sibling)).toEqual([undefined]);
            expect(valuesOf(bystander)).toEqual([undefined, 'trigger', 'after']);
            expect(valuesOf(disconnector)).toEqual([undefined, 'trigger', 'after']);
        });

        it('a subscriber that disconnects a later sibling and reconnects to the same key in the callback gives the new subscriber exactly one delivery of the value', async () => {
            let siblingConnection: Connection | undefined;
            const fresh = createSpy();
            let freshConnection: Connection | undefined;
            const reconnector = createSpy((value) => {
                if (value !== 'trigger' || !siblingConnection) {
                    return;
                }
                Onyx.disconnect(siblingConnection);
                freshConnection = connect(KEYS.PLAIN, fresh);
            });
            const sibling = createSpy();
            connect(KEYS.PLAIN, reconnector, false);
            siblingConnection = connect(KEYS.PLAIN, sibling);
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 'trigger');
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'after');

            expect(freshConnection?.id).toBe(siblingConnection.id);
            expect(valuesOf(sibling)).toEqual([undefined]);
            expect(fresh.mock.calls).toEqual([
                ['trigger', KEYS.PLAIN],
                ['after', KEYS.PLAIN],
            ]);
        });

        it('a subscriber that disconnects an earlier sibling does not replay the value to anyone', async () => {
            let earlierConnection: Connection | undefined;
            const earlier = createSpy();
            const disconnector = createSpy((value) => {
                if (value !== 'trigger' || !earlierConnection) {
                    return;
                }
                Onyx.disconnect(earlierConnection);
            });
            earlierConnection = connect(KEYS.PLAIN, earlier, false);
            connect(KEYS.PLAIN, disconnector, false);
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 'trigger');
            await Onyx.set(KEYS.PLAIN, 'after');

            expect(valuesOf(earlier)).toEqual([undefined, 'trigger']);
            expect(valuesOf(disconnector)).toEqual([undefined, 'trigger', 'after']);
        });

        it.each([
            ['mergeCollection', () => Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}})],
            ['a single member set', () => Onyx.set(ITEM_1, {v: 1})],
        ])('a collection root that disconnects itself during %s does not stop the other collection roots', async (_label, write) => {
            const connections: Connection[] = [];
            const selfDisconnecting = createSpy((value) => {
                if (!value) {
                    return;
                }
                Onyx.disconnect(connections[0]);
            });
            const second = createSpy();
            const third = createSpy();
            connections.push(connect(KEYS.COLLECTION.ITEMS, selfDisconnecting, false));
            connections.push(connect(KEYS.COLLECTION.ITEMS, second, false));
            connections.push(connect(KEYS.COLLECTION.ITEMS, third, false));
            await waitForPromisesToResolve();
            second.mockClear();
            third.mockClear();

            await write();
            const expected = {...OnyxCache.getCollectionData(KEYS.COLLECTION.ITEMS)};
            await Onyx.set(`${KEYS.COLLECTION.ITEMS}3`, {v: 3});

            expect(selfDisconnecting).toHaveBeenCalledTimes(2);
            expect(second.mock.calls.map(([value]) => value)).toEqual([expected, {...expected, [`${KEYS.COLLECTION.ITEMS}3`]: {v: 3}}]);
            expect(third.mock.calls.map(([value]) => value)).toEqual([expected, {...expected, [`${KEYS.COLLECTION.ITEMS}3`]: {v: 3}}]);
        });

        it('a collection root that disconnects a member subscriber during mergeCollection prevents the member from receiving that batch', async () => {
            let memberConnection: Connection | undefined;
            const collection = createSpy((value) => {
                if (!value || !memberConnection) {
                    return;
                }
                Onyx.disconnect(memberConnection);
            });
            const member = createSpy();
            const otherMember = createSpy();
            connect(KEYS.COLLECTION.ITEMS, collection);
            memberConnection = connect(ITEM_1, member);
            connect(ITEM_2, otherMember);
            await waitForPromisesToResolve();

            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}});

            expect(valuesOf(member)).toEqual([undefined]);
            expect(valuesOf(otherMember)).toEqual([undefined, {v: 2}]);
        });

        it('a subscriber that disconnects itself and writes during the notification never sees its own write, and the shared sibling ends on the final value', async () => {
            const connections: Connection[] = [];
            const writer = createSpy((value) => {
                if (value !== 'first') {
                    return;
                }
                Onyx.disconnect(connections[0]);
                Onyx.set(KEYS.PLAIN, 'second');
            });
            const sibling = createSpy();
            connections.push(connect(KEYS.PLAIN, writer));
            connections.push(connect(KEYS.PLAIN, sibling));
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 'first');
            await waitForPromisesToResolve();

            expect(valuesOf(writer)).toEqual([undefined, 'first']);
            expect(OnyxCache.get(KEYS.PLAIN)).toBe('second');
            expect(sibling.mock.lastCall).toEqual(['second', KEYS.PLAIN]);
            expect(sibling.mock.calls.length).toBeLessThanOrEqual(3);
        });
    });

    describe('disconnect then reconnect', () => {
        it.each([
            ['a reused connection', undefined],
            ['a non-reused connection', false],
        ])('delivers the value written while disconnected instead of the stale one, then keeps receiving updates (%s)', async (_label, reuseConnection) => {
            await Onyx.set(KEYS.PLAIN, 'old');
            const oldSpy = createSpy();
            const oldConnection = connect(KEYS.PLAIN, oldSpy, reuseConnection);
            await waitForPromisesToResolve();
            Onyx.disconnect(oldConnection);

            await Onyx.set(KEYS.PLAIN, 'fresh');
            const newSpy = createSpy();
            connect(KEYS.PLAIN, newSpy, reuseConnection);
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'later');

            expect(oldSpy.mock.calls).toEqual([['old', KEYS.PLAIN]]);
            expect(newSpy.mock.calls).toEqual([
                ['fresh', KEYS.PLAIN],
                ['later', KEYS.PLAIN],
            ]);
        });

        it('delivers exactly one initial value to a subscriber that reconnects in the same tick as the disconnect', async () => {
            await Onyx.set(KEYS.PLAIN, 'value');
            const oldSpy = createSpy();
            const newSpy = createSpy();

            const oldConnection = connect(KEYS.PLAIN, oldSpy);
            Onyx.disconnect(oldConnection);
            connect(KEYS.PLAIN, newSpy);
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'next');

            expect(oldSpy).not.toHaveBeenCalled();
            expect(newSpy.mock.calls).toEqual([
                ['value', KEYS.PLAIN],
                ['next', KEYS.PLAIN],
            ]);
        });

        it('after many connect and disconnect cycles on a warm key only the surviving subscriber is called, once per change', async () => {
            await Onyx.set(KEYS.PLAIN, 'warm');
            const churned = createSpy();
            for (let index = 0; index < 50; index++) {
                Onyx.disconnect(connect(KEYS.PLAIN, churned));
            }
            const survivor = createSpy();
            connect(KEYS.PLAIN, survivor);
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'changed');
            await Onyx.set(KEYS.PLAIN, 'changed');

            expect(churned).not.toHaveBeenCalled();
            expect(survivor.mock.calls).toEqual([
                ['warm', KEYS.PLAIN],
                ['changed', KEYS.PLAIN],
            ]);
        });

        it('after many non-reused connect and disconnect cycles on different keys nothing leaks into later subscribers', async () => {
            await Onyx.multiSet({[KEYS.PLAIN]: 'p', [KEYS.OTHER]: 'o', [ITEM_1]: {v: 1}});
            const churned = createSpy();
            const keys = [KEYS.PLAIN, KEYS.OTHER, KEYS.COLLECTION.ITEMS, ITEM_1];
            for (let index = 0; index < 40; index++) {
                Onyx.disconnect(connect(keys[index % keys.length], churned, false));
            }
            const survivor = createSpy();
            connect(KEYS.OTHER, survivor, false);
            await waitForPromisesToResolve();
            await Onyx.multiSet({[KEYS.PLAIN]: 'p2', [KEYS.OTHER]: 'o2', [ITEM_1]: {v: 2}});

            expect(churned).not.toHaveBeenCalled();
            expect(survivor.mock.calls).toEqual([
                ['o', KEYS.OTHER],
                ['o2', KEYS.OTHER],
            ]);
        });

        it('a reconnected collection root receives the members added and misses the members removed while it was disconnected', async () => {
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}});
            const oldSpy = createSpy();
            const oldConnection = connect(KEYS.COLLECTION.ITEMS, oldSpy);
            await waitForPromisesToResolve();
            Onyx.disconnect(oldConnection);

            await Onyx.set(ITEM_2, null);
            await Onyx.set(ITEM_10, {v: 10});
            const newSpy = createSpy();
            connect(KEYS.COLLECTION.ITEMS, newSpy);
            await waitForPromisesToResolve();

            expect(oldSpy.mock.calls).toEqual([[{[ITEM_1]: {v: 1}, [ITEM_2]: {v: 2}}, KEYS.COLLECTION.ITEMS]]);
            expect(newSpy.mock.calls).toEqual([[{[ITEM_1]: {v: 1}, [ITEM_10]: {v: 10}}, KEYS.COLLECTION.ITEMS]]);
        });

        it('a subscription disconnected before its first delivery does not receive the delivery of a subscription created right after it for another key', async () => {
            await Onyx.multiSet({[KEYS.PLAIN]: 'plain', [KEYS.OTHER]: 'other'});
            const disconnected = createSpy();
            const live = createSpy();

            Onyx.disconnect(connect(KEYS.PLAIN, disconnected, false));
            connect(KEYS.OTHER, live, false);
            await waitForPromisesToResolve();

            expect(disconnected).not.toHaveBeenCalled();
            expect(live.mock.calls).toEqual([['other', KEYS.OTHER]]);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('a late subscriber of an established shared connection still receives the cached value when disconnected in the same tick as connect', async () => {
            await Onyx.set(KEYS.PLAIN, 'cached');
            const first = createSpy();
            connect(KEYS.PLAIN, first);
            await waitForPromisesToResolve();

            const late = createSpy();
            Onyx.disconnect(connect(KEYS.PLAIN, late));
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'after');

            expect(late.mock.calls).toEqual([['cached', KEYS.PLAIN]]);
            expect(valuesOf(first)).toEqual(['cached', 'after']);
        });

        it('a separate subscription dispatched after a subscriber that disconnects itself and writes ends on the stale dispatched value instead of the final one', async () => {
            const connections: Connection[] = [];
            const writer = createSpy((value) => {
                if (value !== 'first') {
                    return;
                }
                Onyx.disconnect(connections[0]);
                Onyx.set(KEYS.PLAIN, 'second');
            });
            const sibling = createSpy();
            connections.push(connect(KEYS.PLAIN, writer, false));
            connections.push(connect(KEYS.PLAIN, sibling, false));
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 'first');
            await waitForPromisesToResolve();

            expect(valuesOf(writer)).toEqual([undefined, 'first']);
            expect(OnyxCache.get(KEYS.PLAIN)).toBe('second');
            expect(valuesOf(sibling)).toEqual([undefined, 'second', 'first']);
        });
    });
});
