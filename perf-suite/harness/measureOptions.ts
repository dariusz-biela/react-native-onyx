import type {MeasureOverrides} from './scenario';

/**
 * What runs between two iterations. `minor` scavenges the young generation, which is where an
 * iteration's garbage lives, for well under a millisecond; `adaptive` does the same, but only once
 * the iterations since the last scavenge have allocated `ADAPTIVE_GC_THRESHOLD_BYTES`, so a row that
 * allocates a few kilobytes per iteration no longer pays a scavenge per iteration while V8 still never
 * has to start one inside a timed region; `major` is the full collection the suite used until
 * 2026-09-22, 60 to 90 ms on the heap a hooks run carries; `none` leaves it to V8.
 */
type GcMode = 'adaptive' | 'minor' | 'major' | 'none';

type MeasureOptions = Required<MeasureOverrides> & {
    gcMode: GcMode;

    /** Full collections per `collectGarbage` call in `major` mode; 2 by default, see `harness/gc.ts`. */
    gcPasses: number;

    /** Full collections between the warm-up and the samples; 0 skips them, see the comment where they run. */
    settleGcPasses: number;
};

/**
 * A lane always gets this many warm-up iterations, however slow one of them is. One is enough: on every
 * row whose iteration takes over 100 ms the first and the second warm-up sample were within 4% of each
 * other (for example 258.2 and 258.5 ms), so the second one only cost time.
 */
const MIN_WARMUP_ITERATIONS = 1;

// 200 iterations, not 50: since the collection between iterations is a scavenge, a sub-0.1 ms row costs
// nothing to sample 200 times, and 12 samples per block left such rows 10-18% apart in an A/A. Heavier rows
// are still bounded by the 3 s budget once they pass `minIterations`.
const DEFAULT_OPTIONS: MeasureOptions = {
    warmupIterations: 8,
    warmupBudgetMs: 300,
    minIterations: 15,
    maxIterations: 200,
    timeBudgetMs: 3000,
    gcMode: 'adaptive',
    gcPasses: 2,
    settleGcPasses: 0,
};

/**
 * A short budget for rows that exist to test one optimisation idea: two warm-up turns and twelve samples per
 * lane (three per block of a hot-swap run), stopping at 24 or one second, whichever comes first.
 */
const QUICK_MEASURE: MeasureOverrides = {warmupIterations: 2, warmupBudgetMs: 100, minIterations: 12, maxIterations: 24, timeBudgetMs: 1000};

function readPositiveIntegerEnv(name: string): number | undefined {
    const value = Number(process.env[name] ?? '');
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

function readNonNegativeIntegerEnv(name: string): number | undefined {
    const raw = process.env[name];
    const value = Number(raw ?? '');
    return raw !== undefined && raw !== '' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isGcMode(value: string): value is GcMode {
    return value === 'adaptive' || value === 'minor' || value === 'major' || value === 'none';
}

function readGcModeEnv(): GcMode | undefined {
    const value = process.env.ONYX_PERF_GC_MODE;

    if (value === undefined || value === '') {
        return undefined;
    }

    if (!isGcMode(value)) {
        throw new Error(`ONYX_PERF_GC_MODE must be adaptive, minor, major or none, got "${value}".`);
    }

    return value;
}

/**
 * Run-wide overrides that win over a scenario's own `measure` block, so one run can trade samples per
 * process for more processes.
 *
 * - ONYX_PERF_ITERATIONS=N: exactly N measured iterations per arm, the time budget no longer stops the loop.
 * - ONYX_PERF_WARMUP=N: warmup iterations.
 * - ONYX_PERF_GC_MODE=adaptive|minor|major|none: collection between iterations, see `GcMode`.
 * - ONYX_PERF_GC_PASSES=N: full collections between iterations in `major` mode.
 * - ONYX_PERF_SETTLE_PASSES=N: full collections between the warm-up and the samples, 0 for none.
 */
function readEnvOverrides(): Partial<MeasureOptions> {
    const overrides: Partial<MeasureOptions> = {};
    const iterations = readPositiveIntegerEnv('ONYX_PERF_ITERATIONS');
    const warmupIterations = readPositiveIntegerEnv('ONYX_PERF_WARMUP');
    const gcMode = readGcModeEnv();
    const gcPasses = readPositiveIntegerEnv('ONYX_PERF_GC_PASSES');
    const settleGcPasses = readNonNegativeIntegerEnv('ONYX_PERF_SETTLE_PASSES');

    if (iterations !== undefined) {
        overrides.minIterations = iterations;
        overrides.maxIterations = iterations;
        overrides.timeBudgetMs = Number.POSITIVE_INFINITY;
    }
    if (warmupIterations !== undefined) {
        overrides.warmupIterations = warmupIterations;
    }
    if (gcMode !== undefined) {
        overrides.gcMode = gcMode;
    }
    if (gcPasses !== undefined) {
        overrides.gcPasses = gcPasses;
    }
    if (settleGcPasses !== undefined) {
        overrides.settleGcPasses = settleGcPasses;
    }

    return overrides;
}

/** The harness defaults, then the scenario's own `measure` block, then the run-wide environment overrides. */
function resolveMeasureOptions(overrides?: MeasureOverrides): MeasureOptions {
    return {...DEFAULT_OPTIONS, ...overrides, ...readEnvOverrides()};
}

export {DEFAULT_OPTIONS, MIN_WARMUP_ITERATIONS, QUICK_MEASURE, resolveMeasureOptions};
export type {GcMode, MeasureOptions};
