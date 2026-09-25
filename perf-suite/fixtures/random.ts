import {seed} from '@ngneat/falso';

/**
 * Fixtures must be byte-identical between the baseline and the candidate arm, otherwise the two
 * arms measure different data. `@ngneat/falso` exposes `seed()` (see
 * `node_modules/@ngneat/falso/src/lib/random.d.ts`), but some generators in `tests/utils/collections`
 * bypass it and call `Math.random` directly (`tests/utils/collections/reportActions.ts:22`), so the
 * global is pinned as well for the duration of the build.
 */
const FIXTURE_SEED = 'onyx-perf';

/** mulberry32: 32 bits of state, uniform output, and no dependency. */
function createSeededRandom(initialState: number): () => number {
    let state = initialState >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/** Runs `build` with both falso's seed and `Math.random` pinned, then restores the real generator. */
function withDeterministicRandom<T>(build: () => T): T {
    const originalRandom = Math.random;

    Math.random = createSeededRandom(0x9e3779b9);
    seed(FIXTURE_SEED);

    try {
        return build();
    } finally {
        Math.random = originalRandom;
        seed();
    }
}

export {createSeededRandom, FIXTURE_SEED, withDeterministicRandom};
