import {deepEqual} from 'fast-equals';

/**
 * Wraps a selector function so that:
 * - Calling the wrapper with the same input reference twice short-circuits to the cached output
 *   (cheap `===` check, no recompute).
 * - Calling with a different input that produces a deep-equal output returns the *previous*
 *   output reference, so downstream `===` comparisons treat it as unchanged.
 *
 * This is the minimum needed for `useSyncExternalStore` to not loop when consumers pass
 * inline selectors that allocate fresh objects on every call (e.g. `(e) => ({id: e?.id})`):
 * without the deep-equal fallback, every `getSnapshot` would return a new reference and React
 * would re-render (or throw "getSnapshot should be cached") indefinitely.
 *
 * Stateful by design — each call to `createMemoizedSelector` produces an independent wrapper
 * with its own `lastInput`/`lastOutput` cache, so a wrapper must not be shared across
 * subscriptions that can see different inputs.
 *
 * `seedOutput` pre-fills the output cache, so the first call already gets the deep-equal fallback
 * against the output a previous wrapper delivered. The input cache stays empty, so the first call
 * always runs the selector.
 */
function createMemoizedSelector<TInput, TOutput>(selector: (input: TInput) => TOutput, seedOutput?: {value: TOutput}): (input: TInput) => TOutput {
    let lastInput: TInput;
    let lastOutput: TOutput;
    let hasComputed = false;
    let hasOutput = false;

    if (seedOutput) {
        lastOutput = seedOutput.value;
        hasOutput = true;
    }

    return (input) => {
        if (hasComputed && lastInput === input) {
            return lastOutput;
        }
        const next = selector(input);
        lastInput = input;
        hasComputed = true;
        if (!hasOutput || !deepEqual(lastOutput, next)) {
            lastOutput = next;
            hasOutput = true;
        }
        return lastOutput;
    };
}

export default createMemoizedSelector;
