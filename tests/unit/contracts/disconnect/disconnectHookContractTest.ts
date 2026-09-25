import {act, renderHook} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import onyxSubscriptionManager from '../../../../lib/OnyxSubscriptionManager';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    OTHER: 'other',
    COLLECTION: {
        ITEMS: 'items_',
    },
};

const ITEM_1 = `${KEYS.COLLECTION.ITEMS}1`;

Onyx.init({keys: KEYS});

beforeEach(async () => {
    onyxSubscriptionManager.clearAll();
    await Onyx.clear();
    await waitForPromisesToResolve();
});

afterEach(() => {
    jest.restoreAllMocks();
});

async function write(callback: () => Promise<void>): Promise<void> {
    await act(async () => {
        await callback();
        await waitForPromisesToResolve();
    });
}

describe('useOnyx unmount disconnect contracts', () => {
    it('keeps a sibling hook on the same key updating after the other hooks on that key unmount one by one', async () => {
        const first = renderHook(() => useOnyx(KEYS.PLAIN));
        const sibling = renderHook(() => useOnyx(KEYS.PLAIN));
        const third = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());

        first.unmount();
        await write(() => Onyx.set(KEYS.PLAIN, 'after-unmount'));
        third.unmount();
        await write(() => Onyx.merge(KEYS.PLAIN, 'after-second-unmount'));

        expect(sibling.result.current[0]).toBe('after-second-unmount');
        expect(sibling.result.current[1].status).toBe('loaded');
    });

    it('shows the current value, not the value from before the unmount, when a hook mounts again', async () => {
        await Onyx.set(KEYS.PLAIN, 'before');
        const first = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());
        expect(first.result.current[0]).toBe('before');

        first.unmount();
        await Onyx.set(KEYS.PLAIN, 'while-unmounted');
        const second = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());

        expect(second.result.current[0]).toBe('while-unmounted');
        await write(() => Onyx.set(KEYS.PLAIN, 'after-remount'));
        expect(second.result.current[0]).toBe('after-remount');
    });

    it('keeps an Onyx.connect subscriber on the same key alive after the hook unmounts, and the hook alive after the subscriber disconnects', async () => {
        const callback = jest.fn<void, [unknown, unknown]>();
        const connection = Onyx.connect({key: KEYS.PLAIN, callback});
        const hook = renderHook(() => useOnyx(KEYS.PLAIN));
        const survivor = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());

        hook.unmount();
        await write(() => Onyx.set(KEYS.PLAIN, 'a'));
        Onyx.disconnect(connection);
        await write(() => Onyx.set(KEYS.PLAIN, 'b'));

        expect(callback.mock.calls.map(([value]) => value)).toEqual([undefined, 'a']);
        expect(survivor.result.current[0]).toBe('b');
    });

    it('keeps a member hook updating after a collection hook unmounts, and the other way round', async () => {
        const collection = renderHook(() => useOnyx(KEYS.COLLECTION.ITEMS));
        const member = renderHook(() => useOnyx(ITEM_1));
        await act(async () => waitForPromisesToResolve());

        collection.unmount();
        await write(() => Onyx.set(ITEM_1, {v: 1}));
        expect(member.result.current[0]).toEqual({v: 1});

        const collectionAgain = renderHook(() => useOnyx(KEYS.COLLECTION.ITEMS));
        await act(async () => waitForPromisesToResolve());
        member.unmount();
        await write(() => Onyx.merge(ITEM_1, {v: 2}));

        expect(collectionAgain.result.current[0]).toEqual({[ITEM_1]: {v: 2}});
    });

    // main pinned connectionManager.disconnectAll in the next two tests; #834 replaced it with onyxSubscriptionManager.clearAll.
    it('does not throw when a hook unmounts after clearAll, and new hooks still subscribe', async () => {
        const hook = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());

        onyxSubscriptionManager.clearAll();
        expect(() => hook.unmount()).not.toThrow();

        const fresh = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());
        await write(() => Onyx.set(KEYS.PLAIN, 'x'));

        expect(fresh.result.current[0]).toBe('x');
    });

    it('does not break a hook mounted after clearAll when a pre-clearAll hook on the same key unmounts', async () => {
        const old = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());

        onyxSubscriptionManager.clearAll();
        const fresh = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());
        old.unmount();
        await write(() => Onyx.set(KEYS.PLAIN, 'x'));

        expect(fresh.result.current[0]).toBe('x');
    });

    it('moves the subscription when the key changes, so writes to the old key no longer reach the hook', async () => {
        await Onyx.multiSet({[KEYS.PLAIN]: 'plain', [KEYS.OTHER]: 'other'});
        const hook = renderHook((key: string) => useOnyx(key), {initialProps: KEYS.PLAIN});
        await act(async () => waitForPromisesToResolve());

        hook.rerender(KEYS.OTHER);
        await act(async () => waitForPromisesToResolve());
        await write(() => Onyx.set(KEYS.PLAIN, 'plain-changed'));

        expect(hook.result.current[0]).toBe('other');
        await write(() => Onyx.set(KEYS.OTHER, 'other-changed'));
        expect(hook.result.current[0]).toBe('other-changed');
    });

    // main detected a leaked shared connection through the key argument of a later Onyx.connect; #834 has no shared connections, so these read the listener registry.
    it('releases the subscription on unmount', async () => {
        const hook = renderHook(() => useOnyx(KEYS.PLAIN));
        await act(async () => waitForPromisesToResolve());
        expect(onyxSubscriptionManager.hasListenersForKey(KEYS.PLAIN)).toBe(true);

        hook.unmount();

        expect(onyxSubscriptionManager.hasListenersForKey(KEYS.PLAIN)).toBe(false);
    });

    it('releases the subscription of a hook unmounted before its first delivery arrived', async () => {
        const hook = renderHook(() => useOnyx(KEYS.PLAIN));
        hook.unmount();
        await waitForPromisesToResolve();

        expect(onyxSubscriptionManager.hasListenersForKey(KEYS.PLAIN)).toBe(false);
    });

    it('releases the subscription of the previous key when the key changes', async () => {
        const hook = renderHook((key: string) => useOnyx(key), {initialProps: KEYS.PLAIN});
        await act(async () => waitForPromisesToResolve());

        hook.rerender(KEYS.OTHER);
        await act(async () => waitForPromisesToResolve());

        expect(onyxSubscriptionManager.hasListenersForKey(KEYS.PLAIN)).toBe(false);
        expect(onyxSubscriptionManager.hasListenersForKey(KEYS.OTHER)).toBe(true);
    });

    it('releases every underlying subscription once all hooks have unmounted', async () => {
        const hooks = [renderHook(() => useOnyx(KEYS.PLAIN)), renderHook(() => useOnyx(KEYS.PLAIN)), renderHook(() => useOnyx(KEYS.PLAIN)), renderHook(() => useOnyx(KEYS.COLLECTION.ITEMS))];
        await act(async () => waitForPromisesToResolve());
        expect([KEYS.PLAIN, KEYS.COLLECTION.ITEMS].map((key) => onyxSubscriptionManager.hasListenersForKey(key))).toEqual([true, true]);

        for (const hook of hooks) {
            hook.unmount();
        }

        expect([KEYS.PLAIN, KEYS.COLLECTION.ITEMS].map((key) => onyxSubscriptionManager.hasListenersForKey(key))).toEqual([false, false]);
    });

    it('keeps many hooks correct through repeated mount and unmount churn on one key', async () => {
        const survivor = renderHook(() => useOnyx(KEYS.PLAIN));
        for (let i = 0; i < 20; i++) {
            const transient = renderHook(() => useOnyx(KEYS.PLAIN));
            await write(() => Onyx.set(KEYS.PLAIN, `v${i}`));
            expect(transient.result.current[0]).toBe(`v${i}`);
            transient.unmount();
        }
        await write(() => Onyx.set(KEYS.PLAIN, 'final'));

        expect(survivor.result.current[0]).toBe('final');
    });
});
