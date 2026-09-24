import Onyx from '../../../../lib';
import type {Connection} from '../../../../lib/OnyxConnectionManager';
import connectionManager from '../../../../lib/OnyxConnectionManager';
import OnyxCache from '../../../../lib/OnyxCache';
import OnyxUtils from '../../../../lib/OnyxUtils';
import type {OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    OTHER: 'other',
    WITH_DEFAULT: 'withDefault',
    COLLECTION: {
        ITEMS: 'items_',
    },
};

const ITEM_1 = `${KEYS.COLLECTION.ITEMS}1`;
const ITEM_2 = `${KEYS.COLLECTION.ITEMS}2`;

Onyx.init({keys: KEYS, initialKeyStates: {[KEYS.WITH_DEFAULT]: 'default'}});

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

async function writeEverything(suffix: string): Promise<void> {
    await Onyx.set(KEYS.PLAIN, `plain-${suffix}`);
    await Onyx.merge(KEYS.OTHER, {suffix});
    await Onyx.set(ITEM_1, {suffix});
    await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_2]: {suffix}});
    await Onyx.set(KEYS.WITH_DEFAULT, `default-${suffix}`);
}

beforeEach(async () => {
    connectionManager.disconnectAll();
    await Onyx.clear();
    await waitForPromisesToResolve();
});

afterEach(() => {
    jest.restoreAllMocks();
});

function trackSubscriptions(): {opened: () => number[]; released: () => unknown[]} {
    const subscribeSpy = jest.spyOn(OnyxUtils, 'subscribeToKey');
    const unsubscribeSpy = jest.spyOn(OnyxUtils, 'unsubscribeFromKey');
    return {
        opened: () => subscribeSpy.mock.results.flatMap((result) => (result.type === 'return' ? [result.value] : [])),
        released: () => unsubscribeSpy.mock.calls.map(([subscriptionID]) => subscriptionID),
    };
}

describe('connectionManager.disconnectAll contracts', () => {
    it('stops every live subscriber, shared or not, collection or member, from receiving any later write', async () => {
        const spies = [createSpy(), createSpy(), createSpy(), createSpy(), createSpy(), createSpy()];
        connect(KEYS.PLAIN, spies[0]);
        connect(KEYS.PLAIN, spies[1]);
        connect(KEYS.PLAIN, spies[2], false);
        connect(KEYS.COLLECTION.ITEMS, spies[3]);
        connect(ITEM_1, spies[4]);
        connect(KEYS.WITH_DEFAULT, spies[5]);
        await waitForPromisesToResolve();
        for (const spy of spies) {
            spy.mockClear();
        }

        connectionManager.disconnectAll();
        await writeEverything('after');
        await Onyx.clear();
        await waitForPromisesToResolve();

        for (const spy of spies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it('releases the underlying subscription of every connection, reused or not, pending or established', async () => {
        const subscriptions = trackSubscriptions();
        connect(KEYS.PLAIN, createSpy());
        connect(KEYS.PLAIN, createSpy());
        connect(KEYS.PLAIN, createSpy(), false);
        connect(KEYS.COLLECTION.ITEMS, createSpy(), false);
        await waitForPromisesToResolve();
        connect(ITEM_1, createSpy());
        connect(KEYS.OTHER, createSpy(), false);

        connectionManager.disconnectAll();

        expect(subscriptions.opened()).toHaveLength(5);
        expect(subscriptions.released()).toEqual(expect.arrayContaining(subscriptions.opened()));
    });

    it('cancels first deliveries that were still pending in the same tick', async () => {
        await Onyx.multiSet({[KEYS.PLAIN]: 'plain', [ITEM_1]: {v: 1}});
        const plain = createSpy();
        const collection = createSpy();
        const unique = createSpy();

        connect(KEYS.PLAIN, plain);
        connect(KEYS.COLLECTION.ITEMS, collection);
        connect(KEYS.PLAIN, unique, false);
        connectionManager.disconnectAll();
        await waitForPromisesToResolve();

        expect(plain).not.toHaveBeenCalled();
        expect(collection).not.toHaveBeenCalled();
        expect(unique).not.toHaveBeenCalled();
    });

    it('lets new subscribers connect afterwards and receive fresh values exactly once per change', async () => {
        await Onyx.set(KEYS.PLAIN, 'before');
        const old = createSpy();
        connect(KEYS.PLAIN, old);
        connect(KEYS.COLLECTION.ITEMS, createSpy());
        await waitForPromisesToResolve();

        connectionManager.disconnectAll();
        await Onyx.set(KEYS.PLAIN, 'while-disconnected');
        const plain = createSpy();
        const collection = createSpy();
        connect(KEYS.PLAIN, plain);
        connect(KEYS.COLLECTION.ITEMS, collection);
        await waitForPromisesToResolve();
        await Onyx.set(KEYS.PLAIN, 'after');
        await Onyx.set(ITEM_1, {v: 1});

        expect(valuesOf(old)).toEqual(['before']);
        expect(plain.mock.calls).toEqual([
            ['while-disconnected', KEYS.PLAIN],
            ['after', KEYS.PLAIN],
        ]);
        expect(collection.mock.calls).toEqual([
            [undefined, KEYS.COLLECTION.ITEMS],
            [{[ITEM_1]: {v: 1}}, KEYS.COLLECTION.ITEMS],
        ]);
    });

    it('turns disconnecting a pre-disconnectAll handle into a no-op that leaves a newer connection to the same key alive', async () => {
        const old = createSpy();
        const oldConnection = connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();

        connectionManager.disconnectAll();
        const fresh = createSpy();
        const freshConnection = connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();
        Onyx.disconnect(oldConnection);
        await Onyx.set(KEYS.PLAIN, 'x');

        expect(freshConnection.id).toBe(oldConnection.id);
        expect(valuesOf(old)).toEqual([undefined]);
        expect(valuesOf(fresh)).toEqual([undefined, 'x']);
    });

    it('can be called repeatedly and with no connections', async () => {
        expect(() => {
            connectionManager.disconnectAll();
            connectionManager.disconnectAll();
        }).not.toThrow();

        const spy = createSpy();
        connect(KEYS.PLAIN, spy);
        await waitForPromisesToResolve();
        await Onyx.set(KEYS.PLAIN, 'x');

        expect(valuesOf(spy)).toEqual([undefined, 'x']);
    });

    it('does not touch the stored data', async () => {
        await Onyx.multiSet({[KEYS.PLAIN]: 'kept', [ITEM_1]: {v: 1}});
        connect(KEYS.PLAIN, createSpy());
        await waitForPromisesToResolve();

        connectionManager.disconnectAll();

        expect(OnyxCache.get(KEYS.PLAIN)).toBe('kept');
        expect(OnyxCache.get(ITEM_1)).toEqual({v: 1});
    });
});

describe('connectionManager.refreshSessionID contracts', () => {
    it('keeps every connection made before the refresh receiving updates', async () => {
        const shared = createSpy();
        const collection = createSpy();
        connect(KEYS.PLAIN, shared);
        connect(KEYS.COLLECTION.ITEMS, collection);
        await waitForPromisesToResolve();

        connectionManager.refreshSessionID();
        await Onyx.set(KEYS.PLAIN, 'x');
        await Onyx.set(ITEM_1, {v: 1});

        expect(valuesOf(shared)).toEqual([undefined, 'x']);
        expect(valuesOf(collection)).toEqual([undefined, {[ITEM_1]: {v: 1}}]);
    });

    it('gives a subscriber connecting after the refresh its own connection, independent of the old one in both directions', async () => {
        const old = createSpy();
        const oldConnection = connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();

        connectionManager.refreshSessionID();
        const fresh = createSpy();
        const freshConnection = connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();

        expect(freshConnection.id).not.toBe(oldConnection.id);

        Onyx.disconnect(oldConnection);
        await Onyx.set(KEYS.PLAIN, 'only-fresh');
        const oldAgain = createSpy();
        connectionManager.refreshSessionID();
        const oldAgainConnection = connect(KEYS.PLAIN, oldAgain);
        await waitForPromisesToResolve();
        Onyx.disconnect(freshConnection);
        await Onyx.set(KEYS.PLAIN, 'only-old-again');

        expect(valuesOf(old)).toEqual([undefined]);
        expect(valuesOf(fresh)).toEqual([undefined, 'only-fresh']);
        expect(valuesOf(oldAgain)).toEqual(['only-fresh', 'only-old-again']);
        Onyx.disconnect(oldAgainConnection);
    });

    it('delivers a first value built from the store to a subscriber connecting after the refresh instead of the old connection cached arguments', async () => {
        const old = createSpy();
        connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();
        await Onyx.set(KEYS.PLAIN, 'x');
        await Onyx.set(KEYS.PLAIN, null);

        connectionManager.refreshSessionID();
        const fresh = createSpy();
        connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();

        expect(old.mock.calls).toEqual([
            [undefined, undefined],
            ['x', KEYS.PLAIN],
            [undefined, KEYS.PLAIN],
        ]);
        expect(fresh.mock.calls).toEqual([[undefined, undefined]]);
    });

    it('lets disconnectAll tear down connections from before and after the refresh', async () => {
        const old = createSpy();
        const fresh = createSpy();
        connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();
        connectionManager.refreshSessionID();
        connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();

        connectionManager.disconnectAll();
        await Onyx.set(KEYS.PLAIN, 'x');

        expect(valuesOf(old)).toEqual([undefined]);
        expect(valuesOf(fresh)).toEqual([undefined]);
    });

    it('is triggered by Onyx.clear, so a subscriber connecting after the clear gets a fresh connection while the old one keeps working', async () => {
        await Onyx.set(KEYS.PLAIN, 'x');
        const old = createSpy();
        const oldConnection = connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();

        await Onyx.clear();
        const fresh = createSpy();
        const freshConnection = connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();
        await Onyx.set(KEYS.PLAIN, 'y');

        expect(freshConnection.id).not.toBe(oldConnection.id);
        expect(old.mock.calls).toEqual([
            ['x', KEYS.PLAIN],
            [undefined, KEYS.PLAIN],
            ['y', KEYS.PLAIN],
        ]);
        expect(fresh.mock.calls).toEqual([
            [undefined, undefined],
            ['y', KEYS.PLAIN],
        ]);
    });

    it('does not create a new connection for subscribers that join before the refresh', async () => {
        const first = createSpy();
        const second = createSpy();
        const firstConnection = connect(KEYS.PLAIN, first);
        const secondConnection = connect(KEYS.PLAIN, second);
        connectionManager.refreshSessionID();
        await waitForPromisesToResolve();

        Onyx.disconnect(firstConnection);
        await Onyx.set(KEYS.PLAIN, 'x');

        expect(secondConnection.id).toBe(firstConnection.id);
        expect(valuesOf(first)).toEqual([undefined]);
        expect(valuesOf(second)).toEqual([undefined, 'x']);
    });

    it('resets a key with a default back to its default for old subscribers on clear, and new subscribers read the default', async () => {
        await Onyx.set(KEYS.WITH_DEFAULT, 'custom');
        const old = createSpy();
        connect(KEYS.WITH_DEFAULT, old);
        await waitForPromisesToResolve();

        await Onyx.clear();
        const fresh = createSpy();
        connect(KEYS.WITH_DEFAULT, fresh);
        await waitForPromisesToResolve();

        expect(valuesOf(old)).toEqual(['custom', 'default']);
        expect(fresh.mock.calls).toEqual([['default', KEYS.WITH_DEFAULT]]);
    });
});
