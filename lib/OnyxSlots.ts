import createMemoizedSelector from './createMemoizedSelector';
import memoizedShallowEqual from './memoizedShallowEqual';
import OnyxCache, {TASK} from './OnyxCache';
import type {Connection} from './OnyxConnectionManager';
import connectionManager from './OnyxConnectionManager';
import OnyxUtils from './OnyxUtils';
import type {CollectionKeyBase, OnyxKey, OnyxValue} from './types';
import type {ResultMetadata, UseOnyxResult, UseOnyxSelector} from './useOnyx';

/**
 * Every result carries one of these two objects instead of a freshly allocated one, so an updating
 * hook only pays for the result tuple.
 */
const LOADING_METADATA: ResultMetadata = {status: 'loading'};
const LOADED_METADATA: ResultMetadata = {status: 'loaded'};

/** Distinguishes a slot that has never computed a value from one that computed `undefined`. */
const PENDING_FIRST_READ = Symbol('PENDING_FIRST_READ');

/**
 * The shared state behind `useOnyx`. One slot per (Onyx key, selector) pair holds the Onyx
 * connection, the computed result and the set of React subscribers, so N components watching the
 * same pair run the selector once per change instead of once each, and `getSnapshot()` is a field
 * read for all of them but the first.
 *
 * The identity fields are deliberately untyped: the registry is heterogeneous, and the hook only
 * ever compares them by reference.
 */
type OnyxSlot<TReturnValue> = {
    /** The Onyx key this slot is subscribed to. Part of the slot's identity. */
    key: OnyxKey;

    /** The selector this slot computes with. Part of the slot's identity. */
    selector: unknown;

    /** Whether the connection behind this slot may be shared. Part of the slot's identity. */
    reuseConnection: boolean | undefined;

    /** Passed to `useSyncExternalStore`. Stable for the lifetime of the slot. */
    subscribe: (onStoreChange: () => void) => () => void;

    /** Passed to `useSyncExternalStore`. Stable for the lifetime of the slot. */
    getSnapshot: () => UseOnyxResult<TReturnValue>;

    /** The state a slot created for the same key by the same hook starts from. */
    getSeed: () => OnyxSlotSeed<TReturnValue>;
};

/**
 * A slot is identified by its selector, so a hook that renders a fresh selector reference gets a
 * fresh slot on every render. Left alone, that slot has no previous value to compare against and
 * publishes a newly allocated result, which every consumer of the result identity (an effect
 * dependency, a memo, `useSyncExternalStore` itself) reads as a change. The hook therefore hands
 * the state of its previous slot to the new one, which restores the per-hook memory the legacy
 * refs used to provide while slots for stable selectors stay shared.
 */
type OnyxSlotSeed<TReturnValue> = {
    isConnected: boolean;
    previousValue: NonNullable<TReturnValue> | undefined | typeof PENDING_FIRST_READ;
    result: UseOnyxResult<TReturnValue>;
};

type SlotRegistry = Map<OnyxKey, OnyxSlot<unknown>>;

/** The slots of hooks without a selector, one per Onyx key. */
const slotsWithoutSelector: SlotRegistry = new Map();

/**
 * The slots of hooks with a selector, one registry per selector. Keyed weakly, because a render
 * that React discards (a suspension, an error, an interrupted concurrent render) never subscribes
 * to the slot it created, and nothing else would ever evict it. With an inline selector that slot
 * is only reachable through the selector, so it goes away with the discarded render.
 */
const slotsBySelector = new WeakMap<object, SlotRegistry>();

/**
 * Bumped whenever the store is swapped from under the slots, e.g. by `Onyx.clear()`. A slot that
 * last computed under an older generation reads the Onyx cache again.
 */
let storeGeneration = 0;

function getRegistry(selector: object | undefined): SlotRegistry {
    if (!selector) {
        return slotsWithoutSelector;
    }

    let registry = slotsBySelector.get(selector);
    if (!registry) {
        registry = new Map();
        slotsBySelector.set(selector, registry);
    }
    return registry;
}

function createSlot<TKey extends OnyxKey, TReturnValue>(
    key: TKey,
    selector: UseOnyxSelector<TKey, TReturnValue> | undefined,
    reuseConnection: boolean | undefined,
    seed: OnyxSlotSeed<TReturnValue> | undefined,
    onFirstSubscriber?: () => void,
    onLastSubscriber?: () => void,
): OnyxSlot<TReturnValue> {
    const subscribers = new Set<() => void>();

    let connection: Connection | null = null;
    let isConnected = seed ? seed.isConnected : false;
    let isDirty = true;
    let computedGeneration = storeGeneration;
    let previousValue: NonNullable<TReturnValue> | undefined | typeof PENDING_FIRST_READ = seed ? seed.previousValue : PENDING_FIRST_READ;
    let result: UseOnyxResult<TReturnValue> = seed ? seed.result : [undefined, LOADING_METADATA];

    // Caches by input reference with a deepEqual fallback on the output, so the returned reference
    // stays stable when an unrelated part of the key's value changes. Seeded with the value the
    // previous slot delivered, so a new selector reference producing deep-equal data keeps it.
    const seedOutput = previousValue === PENDING_FIRST_READ ? undefined : {value: previousValue};
    const memoizedSelector = selector ? createMemoizedSelector<OnyxValue<TKey> | undefined, TReturnValue | undefined>(selector, seedOutput) : undefined;

    function getSnapshot(): UseOnyxResult<TReturnValue> {
        if (!isDirty && computedGeneration === storeGeneration) {
            return result;
        }

        // Until the first connection callback fires we serve whatever the cache already holds, so a
        // hook mounting on a warm key renders the value right away instead of flashing `undefined`.
        const isFirstConnection = !isConnected;

        const cachedValue = OnyxUtils.tryGetCachedValue(key) as OnyxValue<TKey>;
        const selectedValue = memoizedSelector ? memoizedSelector(cachedValue) : cachedValue;

        // `useOnyx` cannot return `null`, so it is mapped to `undefined` for compatibility.
        let newValue = (selectedValue ?? undefined) as NonNullable<TReturnValue> | undefined;

        // While a merge for the key is still queued during the first connection we report `loading`,
        // because the cache doesn't hold the final value yet.
        let metadata = LOADED_METADATA;
        if (isFirstConnection && OnyxUtils.hasPendingMergeForKey(key)) {
            newValue = undefined;
            metadata = LOADING_METADATA;
        }

        const hasComputedBefore = previousValue !== PENDING_FIRST_READ;
        const areValuesEqual = memoizedShallowEqual(hasComputedBefore ? previousValue : undefined, newValue);

        // Publish a new result when the value changed, or when we have nothing yet and the key is
        // known to be settled (it is in the cache, `Onyx.clear()` is running, or the connection
        // callback already fired), which is what moves the slot out of its initial loading state.
        const shouldUpdateResult = !areValuesEqual || (!hasComputedBefore && (OnyxCache.hasCacheForKey(key) || OnyxCache.hasPendingTask(TASK.CLEAR) || !isFirstConnection));
        if (shouldUpdateResult) {
            previousValue = newValue;
            result = [newValue, metadata];
        }

        // Cleared only after a successful compute, so a throwing selector is retried by React and the
        // error reaches its error boundary instead of a retry serving the stale result.
        isDirty = false;
        computedGeneration = storeGeneration;
        return result;
    }

    function onConnectionCallback(): void {
        isConnected = true;
        isDirty = true;

        // Copied because a subscriber can mount or unmount another one while being notified.
        for (const onStoreChange of [...subscribers]) {
            onStoreChange();
        }
    }

    function subscribe(onStoreChange: () => void): () => void {
        if (subscribers.size === 0) {
            onFirstSubscriber?.();
        }
        subscribers.add(onStoreChange);

        if (!connection) {
            connection = connectionManager.connect<CollectionKeyBase>({
                key,
                callback: onConnectionCallback,
                reuseConnection,
            });
        }

        return () => {
            subscribers.delete(onStoreChange);

            if (subscribers.size > 0) {
                return;
            }

            isDirty = true;

            // Tearing the slot down is deferred by a microtask so that a hook which resubscribes
            // right away keeps both the slot and its live connection. That happens whenever a
            // component renders a new selector reference (its slot is swapped) and on any remount,
            // and rebuilding a subscription re-runs the whole `subscribeToKey` pipeline, which scans
            // every key for a collection.
            Promise.resolve().then(() => {
                if (subscribers.size > 0) {
                    return;
                }

                if (connection) {
                    connectionManager.disconnect(connection);
                    connection = null;
                }
                isConnected = false;
                onLastSubscriber?.();
            });
        };
    }

    return {
        key,
        selector,
        reuseConnection,
        subscribe,
        getSnapshot,
        getSeed: () => ({isConnected, previousValue, result}),
    };
}

/**
 * Returns the slot for a (key, selector) pair, creating it on first use. A slot is shared by every
 * hook using that pair, so they also share one Onyx connection.
 *
 * `previousSlot` is the slot the calling hook used until this render. It is returned as is while
 * the triple matches. A newly created slot for the same key starts from its state (see
 * `OnyxSlotSeed`); a slot found in the registry keeps its own.
 *
 * `reuseConnection: false` opts out of sharing entirely and gets a standalone slot that is never
 * published to the registry.
 */
function acquireSlot<TKey extends OnyxKey, TReturnValue>(
    key: TKey,
    selector: UseOnyxSelector<TKey, TReturnValue> | undefined,
    reuseConnection: boolean | undefined,
    previousSlot: OnyxSlot<TReturnValue> | null,
): OnyxSlot<TReturnValue> {
    if (previousSlot !== null && previousSlot.key === key && previousSlot.selector === selector && previousSlot.reuseConnection === reuseConnection) {
        return previousSlot;
    }

    const seed = previousSlot?.key === key ? previousSlot.getSeed() : undefined;

    // A subscriber that opted out of connection reuse also opts out of slot sharing, so its slot is
    // never published to the registry.
    if (reuseConnection === false) {
        return createSlot(key, selector, reuseConnection, seed);
    }

    const registry = getRegistry(selector);

    const existingSlot = registry.get(key);
    if (existingSlot) {
        // The registries are heterogeneous by nature. An entry is found under exactly this selector
        // and Onyx key, so it was created for this pair and computes exactly this value type.
        return existingSlot as OnyxSlot<TReturnValue>;
    }

    const slot: OnyxSlot<TReturnValue> = createSlot(
        key,
        selector,
        reuseConnection,
        seed,
        // Re-publishes a slot that was evicted while its last hook was between two subscriptions,
        // which is what React does on a StrictMode remount.
        () => {
            if (registry.has(key)) {
                return;
            }
            registry.set(key, slot);
        },
        () => {
            if (registry.get(key) !== slot) {
                return;
            }
            registry.delete(key);
        },
    );

    registry.set(key, slot);

    return slot;
}

/**
 * Forces every slot to recompute on its next read. Called when the whole store is swapped from
 * under the hooks, e.g. by `Onyx.clear()`.
 */
function invalidateAllSlots(): void {
    storeGeneration++;
}

export default acquireSlot;
export {invalidateAllSlots};
export type {OnyxSlot};
