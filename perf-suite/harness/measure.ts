import type {Counters, MeasureOverrides, ScenarioRunner} from './scenario';

import v8 from 'v8';

import nowMs from './clock';

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

    /** Full collections per `collectGarbage` call in `major` mode; 2 by default, see the comment on the function. */
    gcPasses: number;

    /** Full collections between the warm-up and the samples; 0 skips them, see the comment where they run. */
    settleGcPasses: number;
};

/** Half of a semi-space of the young generation V8 grows to for this heap (32 MB), so its own scavenge stays out of the samples. */
const ADAPTIVE_GC_THRESHOLD_BYTES = 8 * 1024 * 1024;

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

type MeasureResult = {
    /** Timed durations in milliseconds, one per measured iteration, in the order they ran. */
    samples: number[];

    /** Warmup durations, kept for diagnosing a scenario that never reaches a steady state. */
    warmupSamples: number[];

    /** Extra counters returned by `run`, one array of samples per counter name. */
    counters: Record<string, number[]>;

    /** Wall clock spent on the whole scenario, hooks and gc included. */
    totalDurationMs: number;

    /** Where `totalDurationMs` went, shared by every lane: warm-up, the full collection after it, the measured loop, teardown. */
    phasesMs: {warmup: number; fullGc: number; measured: number; teardown: number};

    options: MeasureOptions;
};

/**
 * One runner measured in lockstep with the others. `activate` runs before every call into the runner;
 * a hot-swap lane switches the active Onyx arm there, a classic run has a single lane and no switch.
 */
type MeasureLane = {
    runner: ScenarioRunner;
    activate?: () => void;
};

/**
 * The Onyx storage mock wraps every provider method in `jest.fn()`, and a jest mock retains every
 * argument it was ever called with. Left alone over an iteration loop that pins every fixture the
 * scenario ever wrote, which shows up as a slow upward drift in the samples. Clearing the call
 * records first is what makes the following collection actually free anything.
 */
function clearRecordedMockCalls() {
    jest.clearAllMocks();
}

/** Twice by default: the first pass frees the iteration's garbage, the second collects what that pass made unreachable. */
function collectFully(passes: number) {
    for (let pass = 0; pass < passes; pass++) {
        global.gc?.();
    }
}

/** Heap size right after the last collection this harness asked for, the base `adaptive` mode measures growth from. */
let heapBytesAfterLastCollection = 0;

function readUsedHeapBytes(): number {
    return v8.getHeapStatistics().used_heap_size;
}

function scavenge() {
    global.gc?.({type: 'minor'});
    heapBytesAfterLastCollection = readUsedHeapBytes();
}

function collectGarbage(options: MeasureOptions): number {
    const startedAt = nowMs();
    clearRecordedMockCalls();

    if (options.gcMode === 'adaptive') {
        if (readUsedHeapBytes() - heapBytesAfterLastCollection >= ADAPTIVE_GC_THRESHOLD_BYTES) {
            scavenge();
        }
    } else if (options.gcMode === 'minor') {
        scavenge();
    } else if (options.gcMode === 'major') {
        collectFully(options.gcPasses);
    }

    return nowMs() - startedAt;
}

function recordCounters(target: Record<string, number[]>, counters: Counters | void) {
    if (!counters) {
        return;
    }

    for (const [name, value] of Object.entries(counters)) {
        const samples = target[name] ?? [];
        samples.push(value);
        target[name] = samples;
    }
}

type IterationResult = {
    durationMs: number;
    counters: Counters | void;

    /** The untimed hooks around `run`, recorded so the report can show what an iteration costs beyond its sample. */
    beforeEachMs: number;
    afterEachMs: number;
};

async function runIteration(runner: ScenarioRunner): Promise<IterationResult> {
    const beforeEachStartedAt = nowMs();
    await runner.beforeEach?.();

    const startedAt = nowMs();
    const counters = await runner.run();
    const endedAt = nowMs();

    await runner.afterEach?.();

    return {durationMs: endedAt - startedAt, counters, beforeEachMs: startedAt - beforeEachStartedAt, afterEachMs: nowMs() - endedAt};
}

type LaneState = MeasureLane & {
    samples: number[];
    warmupSamples: number[];
    counters: Record<string, number[]>;
};

/** mulberry32: a small seeded generator, so a scenario gets the same lane order in every run. */
function createRandom(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(value: string): number {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index++) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }

    return hash >>> 0;
}

/** Turns per shuffled block: two in declared order and two reversed, so every block is balanced. */
const ORDER_BLOCK_TURNS = 4;

/**
 * The lane order of every loop turn: blocks of four turns, two in declared order and two reversed,
 * shuffled within the block. Every arm therefore runs first in exactly half of the turns, and the order
 * follows no period another periodic effect could lock onto.
 *
 * Measured 2026-09-23 (A/A, large scale, the 19 rows most prone to it, two runs each): a fixed flip every
 * turn (A B, B A, A B) had rows 18-21% apart in all four blocks, because a scenario whose own state
 * alternates (`api/setCollection/replace` swaps two member sets) or a collection that comes every other
 * turn kept landing on the same arm; strict A B made the arm running first 5-15% slower on most rows; the
 * shuffled order kept every row within 6.4%.
 */
function createLaneOrder(seedText: string): <T>(lanes: readonly T[]) => T[] {
    const random = createRandom(hashString(seedText));
    let pending: boolean[] = [];

    return <T>(lanes: readonly T[]): T[] => {
        if (pending.length === 0) {
            pending = Array.from({length: ORDER_BLOCK_TURNS}, (value, index) => index % 2 === 1);

            for (let index = pending.length - 1; index > 0; index--) {
                const swapIndex = Math.floor(random() * (index + 1));
                [pending[index], pending[swapIndex]] = [pending[swapIndex], pending[index]];
            }
        }

        const isReversed = pending.pop();
        return isReversed ? [...lanes].reverse() : [...lanes];
    };
}

/**
 * Warms every lane up, then iterates until `minIterations` is reached and either the time budget or
 * `maxIterations` is exhausted, every lane taking one iteration per loop turn. Only the `run` call
 * is inside the timed region. Interleaving the lanes iteration by iteration means a drift of the
 * machine lands on both arms alike, so their per-block medians can be compared directly.
 */
async function measureLanes(lanes: readonly MeasureLane[], overrides?: MeasureOverrides, orderSeed = ''): Promise<MeasureResult[]> {
    const options: MeasureOptions = {...DEFAULT_OPTIONS, ...overrides, ...readEnvOverrides()};
    const orderLanes = createLaneOrder(orderSeed);
    const states: LaneState[] = lanes.map((lane) => ({...lane, samples: [], warmupSamples: [], counters: {}}));
    const scenarioStartedAt = nowMs();

    // The warmup loop runs exactly like the measured loop, gc included: a warmup without the collection
    // left the first measured iterations three times slower than the rest of the run. Past the first
    // iteration it stops at `warmupBudgetMs`: a lane whose iteration takes tens of milliseconds has run its
    // code paths often enough by then, and eight such iterations per arm were a quarter of a heavy run.
    for (let iteration = 0; iteration < options.warmupIterations; iteration++) {
        if (iteration >= MIN_WARMUP_ITERATIONS && nowMs() - scenarioStartedAt >= options.warmupBudgetMs) {
            break;
        }

        for (const state of orderLanes(states)) {
            state.activate?.();
            const result = await runIteration(state.runner);
            state.warmupSamples.push(result.durationMs);
            collectGarbage(options);
        }
    }

    const warmupEndedAt = nowMs();

    // A scavenge before the samples, so no lane starts with the warm-up's young garbage. The suite used to
    // run two full collections here, 50 to 150 ms each on the heap the App's modules make, which added up
    // to more than the measured work of a whole small-scale run. Dropping them (2026-09-23) left the
    // heavy-scale A/A as stable as before or better (p90 of the paired deltas 2.0% against 2.6%), since the
    // lanes are interleaved and a major collection that lands in the loop hits both arms alike.
    // ONYX_PERF_SETTLE_PASSES=N brings N full passes back.
    collectFully(options.settleGcPasses);
    scavenge();

    const measuringStartedAt = nowMs();

    for (let iteration = 0; iteration < options.maxIterations; iteration++) {
        for (const state of orderLanes(states)) {
            state.activate?.();
            const result = await runIteration(state.runner);
            state.samples.push(result.durationMs);
            recordCounters(state.counters, result.counters);

            const gcMs = collectGarbage(options);

            // Recorded after the collection. In `major` mode it is retained memory; in `minor` mode the old
            // generation may still hold garbage, so read the trend rather than the level. A rising series is
            // the signature of a scenario that leaks state between iterations; a large `gcMs` means the
            // untimed part of the loop, not the scenario, is the slow bit.
            recordCounters(state.counters, {
                retainedHeapMb: process.memoryUsage().heapUsed / 1024 / 1024,
                gcMs,
                beforeEachMs: result.beforeEachMs,
                afterEachMs: result.afterEachMs,
            });
        }

        const isOverBudget = nowMs() - measuringStartedAt >= options.timeBudgetMs;
        if (isOverBudget && iteration + 1 >= options.minIterations) {
            break;
        }
    }

    const measuringEndedAt = nowMs();

    for (const state of states) {
        state.activate?.();
        await state.runner.teardown?.();
    }

    const endedAt = nowMs();
    const totalDurationMs = endedAt - scenarioStartedAt;
    const phasesMs = {
        warmup: warmupEndedAt - scenarioStartedAt,
        fullGc: measuringStartedAt - warmupEndedAt,
        measured: measuringEndedAt - measuringStartedAt,
        teardown: endedAt - measuringEndedAt,
    };

    return states.map((state) => ({
        samples: state.samples,
        warmupSamples: state.warmupSamples,
        counters: state.counters,
        totalDurationMs,
        phasesMs,
        options,
    }));
}

async function measureScenario(runner: ScenarioRunner, overrides?: MeasureOverrides): Promise<MeasureResult> {
    const [result] = await measureLanes([{runner}], overrides);

    return result;
}

function sliceCounters(counters: Record<string, number[]>, start: number, end: number): Record<string, number[]> {
    return Object.fromEntries(Object.entries(counters).map(([name, values]) => [name, values.slice(start, end)]));
}

/**
 * Splits one interleaved measurement into `blocks` consecutive slices, so the report can ask for the
 * same sign in every block the way it asks for the same sign in every round of a classic run.
 */
function splitIntoBlocks(result: MeasureResult, blocks: number): MeasureResult[] {
    const count = Math.max(1, Math.min(blocks, result.samples.length));
    const sliced: MeasureResult[] = [];

    for (let block = 0; block < count; block++) {
        const start = Math.floor((result.samples.length * block) / count);
        const end = Math.floor((result.samples.length * (block + 1)) / count);

        sliced.push({
            samples: result.samples.slice(start, end),
            warmupSamples: block === 0 ? result.warmupSamples : [],
            counters: sliceCounters(result.counters, start, end),
            totalDurationMs: result.totalDurationMs / count,
            phasesMs: result.phasesMs,
            options: result.options,
        });
    }

    return sliced;
}

export default measureScenario;
export {DEFAULT_OPTIONS, measureLanes, splitIntoBlocks};
export type {GcMode, MeasureLane, MeasureOptions, MeasureResult};
