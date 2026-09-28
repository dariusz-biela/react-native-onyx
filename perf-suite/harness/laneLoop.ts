import type {IterationResult} from './iteration';
import type {MeasureOptions} from './measureOptions';
import type {Counters} from './scenario';

import nowMs from './clock';
import {MIN_WARMUP_ITERATIONS} from './measureOptions';

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
 * One arm as the loop drives it, wherever the arm runs: a runner in this Jest process (`harness/measure.ts`)
 * or a Chromium page (`browser/runner.ts`). Each call is awaited before the next one starts.
 */
type LaneDriver = {
    /** One iteration, timed where the arm runs. */
    iterate: () => Promise<IterationResult>;

    /** The collection between two iterations; returns the milliseconds it took. */
    collectGarbage: (options: MeasureOptions) => Promise<number>;

    /** The heap the arm's host holds right after that collection. */
    readHeapMb: () => Promise<number>;
    teardown: () => Promise<void>;
};

type MeasureDriversInput = {
    drivers: readonly LaneDriver[];
    options: MeasureOptions;

    /** Seeds the lane order, so a scenario gets the same order in every run. */
    orderSeed: string;

    /** The collection between the warm-up and the samples, run once for every host involved. */
    settle: () => Promise<void>;
};

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

type LaneState = {
    driver: LaneDriver;
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
 * `maxIterations` is exhausted, every lane taking one iteration per loop turn. Interleaving the lanes
 * iteration by iteration means a drift of the machine lands on both arms alike, so their per-block
 * medians can be compared directly.
 */
async function measureDrivers({drivers, options, orderSeed, settle}: MeasureDriversInput): Promise<MeasureResult[]> {
    const orderLanes = createLaneOrder(orderSeed);
    const states: LaneState[] = drivers.map((driver) => ({driver, samples: [], warmupSamples: [], counters: {}}));
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
            const result = await state.driver.iterate();
            state.warmupSamples.push(result.durationMs);
            await state.driver.collectGarbage(options);
        }
    }

    const warmupEndedAt = nowMs();
    await settle();
    const measuringStartedAt = nowMs();

    for (let iteration = 0; iteration < options.maxIterations; iteration++) {
        for (const state of orderLanes(states)) {
            const result = await state.driver.iterate();
            state.samples.push(result.durationMs);
            recordCounters(state.counters, result.counters);

            const gcMs = await state.driver.collectGarbage(options);

            // Recorded after the collection. In `major` mode it is retained memory; in `minor` mode the old
            // generation may still hold garbage, so read the trend rather than the level. A rising series is
            // the signature of a scenario that leaks state between iterations; a large `gcMs` means the
            // untimed part of the loop, not the scenario, is the slow bit.
            recordCounters(state.counters, {
                retainedHeapMb: await state.driver.readHeapMb(),
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
        await state.driver.teardown();
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

function sliceCounters(counters: Record<string, number[]>, start: number, end: number): Record<string, number[]> {
    return Object.fromEntries(Object.entries(counters).map(([name, values]) => [name, values.slice(start, end)]));
}

/** How many consecutive blocks an interleaved measurement is split into; each block is written as a round. */
function getBlockCount(): number {
    const blocks = Number(process.env.ONYX_PERF_HOTSWAP_ROUNDS ?? '');

    return Number.isInteger(blocks) && blocks > 0 ? blocks : 4;
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

export default measureDrivers;
export {getBlockCount, splitIntoBlocks};
export type {LaneDriver, MeasureResult};
