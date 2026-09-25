import Onyx from '../../../../lib';
import OnyxCache from '../../../../lib/OnyxCache';
import onyxSubscriptionManager from '../../../../lib/OnyxSubscriptionManager';
import type {Connection, OnyxKey} from '../../../../lib/types';
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

function connect(key: OnyxKey, callback: Spy): Connection {
    return Onyx.connect({key, callback});
}

async function writeEverything(suffix: string): Promise<void> {
    await Onyx.set(KEYS.PLAIN, `plain-${suffix}`);
    await Onyx.merge(KEYS.OTHER, {suffix});
    await Onyx.set(ITEM_1, {suffix});
    await Onyx.mergeCollection(KEYS.COLLECTION.ITEMS, {[ITEM_2]: {suffix}});
    await Onyx.set(KEYS.WITH_DEFAULT, `default-${suffix}`);
}

beforeEach(async () => {
    onyxSubscriptionManager.clearAll();
    await Onyx.clear();
    await waitForPromisesToResolve();
});

afterEach(() => {
    jest.restoreAllMocks();
});

// main pinned connectionManager.disconnectAll; #834 removed it and onyxSubscriptionManager.clearAll is its closest equivalent.
describe('onyxSubscriptionManager.clearAll contracts', () => {
    it('stops every live subscriber, collection or member, from receiving any later write', async () => {
        const spies = [createSpy(), createSpy(), createSpy(), createSpy(), createSpy(), createSpy()];
        connect(KEYS.PLAIN, spies[0]);
        connect(KEYS.PLAIN, spies[1]);
        connect(KEYS.PLAIN, spies[2]);
        connect(KEYS.COLLECTION.ITEMS, spies[3]);
        connect(ITEM_1, spies[4]);
        connect(KEYS.WITH_DEFAULT, spies[5]);
        await waitForPromisesToResolve();
        for (const spy of spies) {
            spy.mockClear();
        }

        onyxSubscriptionManager.clearAll();
        await writeEverything('after');
        await Onyx.clear();
        await waitForPromisesToResolve();

        for (const spy of spies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it('removes the listener of every connection, whether its first delivery is pending or done', async () => {
        connect(KEYS.PLAIN, createSpy());
        connect(KEYS.PLAIN, createSpy());
        connect(KEYS.COLLECTION.ITEMS, createSpy());
        await waitForPromisesToResolve();
        connect(ITEM_1, createSpy());
        connect(KEYS.OTHER, createSpy());

        expect([KEYS.PLAIN, KEYS.COLLECTION.ITEMS, ITEM_1, KEYS.OTHER].map((key) => onyxSubscriptionManager.hasListenersForKey(key))).toEqual([true, true, true, true]);

        onyxSubscriptionManager.clearAll();

        expect([KEYS.PLAIN, KEYS.COLLECTION.ITEMS, ITEM_1, KEYS.OTHER].map((key) => onyxSubscriptionManager.hasListenersForKey(key))).toEqual([false, false, false, false]);
    });

    it('lets new subscribers connect afterwards and receive fresh values exactly once per change', async () => {
        await Onyx.set(KEYS.PLAIN, 'before');
        const old = createSpy();
        connect(KEYS.PLAIN, old);
        connect(KEYS.COLLECTION.ITEMS, createSpy());
        await waitForPromisesToResolve();

        onyxSubscriptionManager.clearAll();
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
            [{}, KEYS.COLLECTION.ITEMS],
            [{[ITEM_1]: {v: 1}}, KEYS.COLLECTION.ITEMS],
        ]);
    });

    it('turns disconnecting a pre-clearAll handle into a no-op that leaves a newer connection to the same key alive', async () => {
        const old = createSpy();
        const oldConnection = connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();

        onyxSubscriptionManager.clearAll();
        const fresh = createSpy();
        connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();
        Onyx.disconnect(oldConnection);
        await Onyx.set(KEYS.PLAIN, 'x');

        expect(valuesOf(old)).toEqual([undefined]);
        expect(valuesOf(fresh)).toEqual([undefined, 'x']);
    });

    it('can be called repeatedly and with no connections', async () => {
        expect(() => {
            onyxSubscriptionManager.clearAll();
            onyxSubscriptionManager.clearAll();
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

        onyxSubscriptionManager.clearAll();

        expect(OnyxCache.get(KEYS.PLAIN)).toBe('kept');
        expect(OnyxCache.get(ITEM_1)).toEqual({v: 1});
    });

    describe('current behaviour (#834 change)', () => {
        // main's disconnectAll cancelled first deliveries still pending in the same tick; clearAll only removes listeners.
        it('does not cancel first deliveries that were still pending in the same tick, but stops every later write', async () => {
            await Onyx.multiSet({[KEYS.PLAIN]: 'plain', [ITEM_1]: {v: 1}});
            const plain = createSpy();
            const collection = createSpy();
            const second = createSpy();

            connect(KEYS.PLAIN, plain);
            connect(KEYS.COLLECTION.ITEMS, collection);
            connect(KEYS.PLAIN, second);
            onyxSubscriptionManager.clearAll();
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'later');
            await Onyx.set(ITEM_1, {v: 2});

            expect(plain.mock.calls).toEqual([['plain', KEYS.PLAIN]]);
            expect(collection.mock.calls).toEqual([[{[ITEM_1]: {v: 1}}, KEYS.COLLECTION.ITEMS]]);
            expect(second.mock.calls).toEqual([['plain', KEYS.PLAIN]]);
        });
    });
});

// main pinned connectionManager.refreshSessionID here; #834 removed sessions, so only the independence they guaranteed is kept.
describe('independent connections and Onyx.clear', () => {
    it('keeps two connections to the same key independent of each other in both directions', async () => {
        const old = createSpy();
        const oldConnection = connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();

        const fresh = createSpy();
        const freshConnection = connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();

        Onyx.disconnect(oldConnection);
        await Onyx.set(KEYS.PLAIN, 'only-fresh');
        const oldAgain = createSpy();
        const oldAgainConnection = connect(KEYS.PLAIN, oldAgain);
        await waitForPromisesToResolve();
        Onyx.disconnect(freshConnection);
        await Onyx.set(KEYS.PLAIN, 'only-old-again');

        expect(valuesOf(old)).toEqual([undefined]);
        expect(valuesOf(fresh)).toEqual([undefined, 'only-fresh']);
        expect(valuesOf(oldAgain)).toEqual(['only-fresh', 'only-old-again']);
        Onyx.disconnect(oldAgainConnection);
    });

    it('delivers a first value built from the store to a later subscriber instead of an earlier connection last arguments', async () => {
        const old = createSpy();
        connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();
        await Onyx.set(KEYS.PLAIN, 'x');
        await Onyx.set(KEYS.PLAIN, null);

        const fresh = createSpy();
        connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();

        // main delivered (undefined, undefined) as the first call to both subscribers here.
        expect(old.mock.calls).toEqual([
            [undefined, KEYS.PLAIN],
            ['x', KEYS.PLAIN],
            [undefined, KEYS.PLAIN],
        ]);
        expect(fresh.mock.calls).toEqual([[undefined, KEYS.PLAIN]]);
    });

    it('keeps an old connection working across Onyx.clear and gives a subscriber connecting after the clear its own first delivery', async () => {
        await Onyx.set(KEYS.PLAIN, 'x');
        const old = createSpy();
        connect(KEYS.PLAIN, old);
        await waitForPromisesToResolve();

        await Onyx.clear();
        const fresh = createSpy();
        connect(KEYS.PLAIN, fresh);
        await waitForPromisesToResolve();
        await Onyx.set(KEYS.PLAIN, 'y');

        expect(old.mock.calls).toEqual([
            ['x', KEYS.PLAIN],
            [undefined, KEYS.PLAIN],
            ['y', KEYS.PLAIN],
        ]);
        // main delivered (undefined, undefined) as the first call here.
        expect(fresh.mock.calls).toEqual([
            [undefined, KEYS.PLAIN],
            ['y', KEYS.PLAIN],
        ]);
    });

    it('keeps the other of two same-tick subscribers alive when one disconnects', async () => {
        const first = createSpy();
        const second = createSpy();
        const firstConnection = connect(KEYS.PLAIN, first);
        connect(KEYS.PLAIN, second);
        await waitForPromisesToResolve();

        Onyx.disconnect(firstConnection);
        await Onyx.set(KEYS.PLAIN, 'x');

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
