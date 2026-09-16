import {useRef, useSyncExternalStore} from 'react';
import acquireSlot from './OnyxSlots';
import type {OnyxSlot} from './OnyxSlots';
import type {OnyxKey, OnyxValue} from './types';

type UseOnyxSelector<TKey extends OnyxKey, TReturnValue = OnyxValue<TKey>> = (data: OnyxValue<TKey> | undefined) => TReturnValue;

type UseOnyxOptions<TKey extends OnyxKey, TReturnValue> = {
    /**
     * If set to `false`, the connection won't be reused between other subscribers that are listening to the same Onyx key
     * with the same connect configurations.
     */
    reuseConnection?: boolean;

    /**
     * This will be used to subscribe to a subset of an Onyx key's data.
     * Using this setting on `useOnyx` can have very positive performance benefits because the component will only re-render
     * when the subset of data changes. Otherwise, any change of data on any property would normally
     * cause the component to re-render (and that can be expensive from a performance standpoint).
     * @see `useOnyx` cannot return `null` and so selector will replace `null` with `undefined` to maintain compatibility.
     */
    selector?: UseOnyxSelector<TKey, TReturnValue>;
};

type FetchStatus = 'loading' | 'loaded';

type ResultMetadata = {
    status: FetchStatus;
};

type UseOnyxResult<TValue> = [NonNullable<TValue> | undefined, ResultMetadata];

/**
 * The hook itself owns no state beyond a pointer to its slot. Reading the value, running the
 * selector, comparing it with the previous one and holding the Onyx connection all live in the slot
 * (see `OnyxSlots`), which is shared by every hook watching the same key and selector.
 */
function useOnyx<TKey extends OnyxKey, TReturnValue = OnyxValue<TKey>>(key: TKey, options?: UseOnyxOptions<TKey, TReturnValue>): UseOnyxResult<TReturnValue> {
    const selector = options?.selector;
    const reuseConnection = options?.reuseConnection;

    // The slot the hook used until this render. A changed key, selector or reuseConnection swaps
    // it (see `acquireSlot`), which also swaps `subscribe` and `getSnapshot`, and that is what
    // makes React resubscribe and read the new key's value in the same render.
    /* eslint-disable react-hooks/refs -- render state that has to survive a selector reference change, so no hook dependency can hold it */
    const slotRef = useRef<OnyxSlot<TReturnValue> | null>(null);
    const slot = acquireSlot<TKey, TReturnValue>(key, selector, reuseConnection, slotRef.current);
    slotRef.current = slot;
    /* eslint-enable react-hooks/refs */

    return useSyncExternalStore<UseOnyxResult<TReturnValue>>(slot.subscribe, slot.getSnapshot);
}

export default useOnyx;

export type {FetchStatus, ResultMetadata, UseOnyxResult, UseOnyxOptions, UseOnyxSelector};
