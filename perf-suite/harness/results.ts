import fs from 'fs';
import os from 'os';
import path from 'path';

import type {MeasureResult} from './measure';
import type {Scenario, ScenarioParams} from './scenario';

/** Bumped whenever the NDJSON line shape changes, so `compare.ts` can refuse an old run. */
const RESULT_SCHEMA_VERSION = 1;

type RunMetadata = {
    runId: string;
    arm: string;
    round: number;
    scale: string;
    nodeVersion: string;
    platform: string;
    cpuModel: string;
};

type ScenarioResultLine = RunMetadata & {
    schema: number;
    recordedAt: string;
    id: string;
    area: string;
    title: string;
    realUsage: Array<{file: string; line: number; note: string}>;
    params: ScenarioParams;
    sizeIndependent?: string;
    samples: number[];
    warmupSamples: number[];
    counters: Record<string, number[]>;
    totalDurationMs: number;
    phasesMs: MeasureResult['phasesMs'];

    /** The scenario's untimed `setup` for this arm, and the whole Jest test around it (both arms, resets included). */
    setupMs?: number;
    wallMs?: number;
    options: MeasureResult['options'];
};

type ScenarioCost = {setupMs: number; wallMs: number};

function requireEnv(name: string): string {
    const value = process.env[name];

    if (!value) {
        throw new Error(`${name} is not set. Run the suite through repo/onyx-perf/scripts/run-arm.sh.`);
    }

    return value;
}

/** Which arm produced a result and in which round; a hot-swap run sets both per scenario, a classic run per process. */
type ResultOrigin = {arm: string; round: number};

function getRunMetadata(origin?: ResultOrigin): RunMetadata {
    return {
        runId: requireEnv('ONYX_PERF_RUN_ID'),
        arm: origin?.arm ?? requireEnv('ONYX_PERF_ARM'),
        round: origin?.round ?? Number(process.env.ONYX_PERF_ROUND ?? '1'),
        scale: process.env.ONYX_PERF_SCALE ?? 'medium',
        nodeVersion: process.version,
        platform: `${os.platform()}-${os.arch()}`,
        cpuModel: os.cpus().at(0)?.model ?? 'unknown',
    };
}

/** Appends one line per scenario. Appending keeps a crashed suite file's earlier scenarios usable. */
function appendScenarioResult(scenario: Scenario, params: ScenarioParams, result: MeasureResult, origin?: ResultOrigin, cost?: ScenarioCost): void {
    const resultsFile = requireEnv('ONYX_PERF_RESULTS_FILE');
    fs.mkdirSync(path.dirname(resultsFile), {recursive: true});

    const line: ScenarioResultLine = {
        ...getRunMetadata(origin),
        schema: RESULT_SCHEMA_VERSION,
        recordedAt: new Date().toISOString(),
        id: scenario.id,
        area: scenario.area,
        title: scenario.title,
        realUsage: scenario.realUsage.map((anchor) => ({file: anchor.file, line: anchor.line, note: anchor.note})),
        params,
        sizeIndependent: scenario.sizeIndependent,
        samples: result.samples,
        warmupSamples: result.warmupSamples,
        counters: result.counters,
        totalDurationMs: result.totalDurationMs,
        phasesMs: result.phasesMs,
        setupMs: cost?.setupMs,
        wallMs: cost?.wallMs,
        options: result.options,
    };

    fs.appendFileSync(resultsFile, `${JSON.stringify(line)}\n`, 'utf8');
}

export default appendScenarioResult;
export {RESULT_SCHEMA_VERSION, getRunMetadata};
export type {RunMetadata, ScenarioResultLine};
export type {ResultOrigin, ScenarioCost};
