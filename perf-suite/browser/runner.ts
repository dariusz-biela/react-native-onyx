import fs from 'fs';
import path from 'path';

import type {Lane} from './lane';
import type {PageScenario} from './page/api';

import nowMs from '../harness/clock';
import measureDrivers, {getBlockCount, splitIntoBlocks} from '../harness/laneLoop';
import {listSuiteFiles, selectSuiteFiles} from '../harness/loadSuites';
import {resolveMeasureOptions} from '../harness/measureOptions';
import appendScenarioResult, {logResult} from '../harness/results';
import {matchesFilter} from '../harness/scenario';
import bundlePage from './bundlePage';
import {listScenarios, openLane, settleLane, setUpScenario, toDriver} from './lane';

type Arm = {name: string; bundleFile: string};

const BROWSER_SUITE_FILE_PATTERN = /\.browser\.ts$/;

function isStringRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ONYX_PERF_BROWSER_ARMS: `{"baseline": "<dist dir>", "candidate": "<dist dir>"}`, built by `scripts/build-arm.sh`. */
function readArmDirs(): Array<[string, string]> {
    const parsed: unknown = JSON.parse(process.env.ONYX_PERF_BROWSER_ARMS ?? '{}');

    if (!isStringRecord(parsed)) {
        throw new Error('ONYX_PERF_BROWSER_ARMS must be a JSON object of arm name to dist directory');
    }

    const armDirs = Object.entries(parsed).flatMap(([name, dir]): Array<[string, string]> => (typeof dir === 'string' ? [[name, dir]] : []));

    if (armDirs.length === 0) {
        throw new Error('ONYX_PERF_BROWSER_ARMS names no arm');
    }

    return armDirs;
}

async function bundleArms(perfSuiteDir: string, suiteFiles: readonly string[]): Promise<Arm[]> {
    const outDir = path.join(perfSuiteDir, '.build/browser');
    fs.mkdirSync(outDir, {recursive: true});

    const arms: Arm[] = [];
    for (const [name, armDir] of readArmDirs()) {
        const bundleFile = path.join(outDir, `${name}.js`);
        await bundlePage({perfSuiteDir, armDir, suiteFiles, outFile: bundleFile});
        arms.push({name, bundleFile});
    }

    return arms;
}

/** Every arm's page lists the same suite files; a scenario runs only where every arm supports it. */
async function listRunnableScenarios(arms: readonly Arm[]): Promise<PageScenario[]> {
    const catalogs: PageScenario[][] = [];

    for (const arm of arms) {
        const lane = await openLane(arm.name, arm.bundleFile);
        try {
            catalogs.push(await listScenarios(lane));
        } finally {
            await lane.close();
        }
    }

    const [first = [], ...others] = catalogs;
    const isSupportedEverywhere = (id: string) => others.every((catalog) => catalog.some((scenario) => scenario.metadata.id === id && scenario.isSupported));

    return first.filter((scenario) => scenario.isSupported && isSupportedEverywhere(scenario.metadata.id) && matchesFilter(scenario.metadata, process.env.ONYX_PERF_FILTER));
}

async function openLanes(arms: readonly Arm[], scenarioId: string): Promise<Array<{lane: Lane; setupMs: number}>> {
    const opened: Lane[] = [];
    const lanes: Array<{lane: Lane; setupMs: number}> = [];

    try {
        for (const arm of arms) {
            const lane = await openLane(arm.name, arm.bundleFile);
            opened.push(lane);
            lanes.push({lane, setupMs: await setUpScenario(lane, scenarioId)});
        }
    } catch (error) {
        await Promise.all(opened.map((lane) => lane.close()));
        throw error;
    }

    return lanes;
}

async function runScenario(arms: readonly Arm[], scenario: PageScenario): Promise<void> {
    const {metadata, params} = scenario;
    const startedAt = nowMs();
    const options = resolveMeasureOptions(scenario.measure);
    const lanes = await openLanes(arms, metadata.id);

    try {
        const results = await measureDrivers({
            drivers: lanes.map(({lane}) => toDriver(lane)),
            options,
            orderSeed: `${metadata.id}@${process.env.ONYX_PERF_SCALE ?? 'medium'}`,
            settle: async () => {
                for (const {lane} of lanes) {
                    await settleLane(lane, options);
                }
            },
        });
        const wallMs = nowMs() - startedAt;

        results.forEach((result, laneIndex) => {
            const {lane, setupMs} = lanes[laneIndex];
            logResult(`${metadata.id} [${lane.arm}]`, result);

            splitIntoBlocks(result, getBlockCount()).forEach((block, blockIndex) => {
                appendScenarioResult(metadata, params, block, {arm: lane.arm, round: blockIndex + 1}, {setupMs, wallMs});
            });
        });
    } finally {
        await Promise.all(lanes.map(({lane}) => lane.close()));
    }
}

/**
 * The browser lanes of the suite: the `.browser.ts` suite files, bundled once per arm and run in headless
 * Chromium on the browser's own IndexedDB. Both arms run in lockstep through the same loop as the Jest lanes
 * (`harness/laneLoop.ts`), one Chromium each, and the results land in the run's NDJSON like any other row.
 */
async function runBrowserSuites(perfSuiteDir: string): Promise<void> {
    const suiteFiles = selectSuiteFiles(listSuiteFiles(path.join(perfSuiteDir, 'suites'), BROWSER_SUITE_FILE_PATTERN));

    if (suiteFiles.length === 0) {
        console.info(`browser: no suite file matches ONYX_PERF_FILES="${process.env.ONYX_PERF_FILES ?? ''}"`);
        return;
    }

    const arms = await bundleArms(perfSuiteDir, suiteFiles);
    const scenarios = await listRunnableScenarios(arms);

    for (const scenario of scenarios) {
        await runScenario(arms, scenario);
    }
}

export default runBrowserSuites;
