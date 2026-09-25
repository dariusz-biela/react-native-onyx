import type {MeasureLane, MeasureResult} from './measure';
import type {ScaleProfile} from './scale';
import type {Scenario} from './scenario';

import nowMs from './clock';
import {getArmNames, getHotswapBlockCount, isHotswapRun, setActiveArm} from './hotswap';
import measureScenario, {measureLanes, splitIntoBlocks} from './measure';
import {initOnyxForPerf, resetOnyx} from './onyx';
import {everyArm, hasOnyxModule} from './optionalOnyxModule';
import appendScenarioResult from './results';
import type {ResultOrigin} from './results';
import getScaleProfile from './scale';
import {median, medianAbsoluteDeviation} from './stats';

function selectScenarios(scenarios: readonly Scenario[]): Scenario[] {
    const filter = process.env.ONYX_PERF_FILTER;

    if (!filter) {
        return [...scenarios];
    }

    return scenarios.filter((scenario) => scenario.id.includes(filter) || scenario.title.includes(filter));
}

async function measureOnce(scenario: Scenario, profile: ScaleProfile, origin?: ResultOrigin): Promise<MeasureResult> {
    const startedAt = nowMs();
    await resetOnyx();

    const runner = await scenario.createRunner(profile);
    const result = await measureScenario(runner, scenario.measure);

    await resetOnyx();

    appendScenarioResult(scenario, runner.params, result, origin, {setupMs: runner.setupMs, wallMs: nowMs() - startedAt});

    return result;
}

function logResult(label: string, result: MeasureResult) {
    // eslint-disable-next-line no-console
    console.info(`${label}: median ${median(result.samples).toFixed(3)} ms, MAD ${medianAbsoluteDeviation(result.samples).toFixed(3)} ms, n=${result.samples.length}`);
}

type ArmLane = MeasureLane & {arm: string};

/**
 * Hot-swap: one runner per arm, both alive at once, measured iteration by iteration in lockstep
 * (`measureLanes` alternates which arm goes first). Each arm's samples are then split into
 * consecutive blocks and every block is written as a round, so compare.ts reads it exactly like a
 * classic multi-process run and its flag rule still asks for the same sign in every block.
 */
async function measureHotswapInterleaved(scenario: Scenario, profile: ScaleProfile): Promise<MeasureResult[]> {
    const startedAt = nowMs();
    const lanes: ArmLane[] = [];

    for (const arm of getArmNames()) {
        setActiveArm(arm);
        await resetOnyx();
        const runner = await scenario.createRunner(profile);
        lanes.push({arm, runner, activate: () => setActiveArm(arm)});
    }

    const results = await measureLanes(lanes, scenario.measure, `${scenario.id}@${profile.name}`);

    for (const lane of lanes) {
        lane.activate?.();
        await resetOnyx();
    }

    const wallMs = nowMs() - startedAt;

    results.forEach((result, index) => {
        const lane = lanes[index];
        logResult(`${scenario.id} [${lane.arm}]`, result);

        splitIntoBlocks(result, getHotswapBlockCount()).forEach((block, blockIndex) => {
            appendScenarioResult(scenario, lane.runner.params, block, {arm: lane.arm, round: blockIndex + 1}, {setupMs: lane.runner.setupMs, wallMs});
        });
    });

    return results;
}

function initEveryArm() {
    if (!isHotswapRun()) {
        initOnyxForPerf();
        return;
    }

    const arms = getArmNames();

    for (const arm of arms) {
        setActiveArm(arm);
        initOnyxForPerf();
    }

    setActiveArm(arms[0]);
}

type RunScenariosOptions = {
    /** `react-native-onyx/dist/<path>` modules the file measures; the file is skipped when an arm lacks one. */
    requiresOnyxModules?: readonly string[];
};

/**
 * Turns a suite file's scenarios into Jest tests, one test per scenario. Each test resets Onyx
 * before and after itself, so a scenario never inherits another one's keys or subscriptions.
 * A scenario the arm cannot run (see `requires` and `requiresOnyxModules`) is registered as skipped,
 * so the report simply has no row for it instead of the whole file failing.
 */
function runScenarios(scenarios: readonly Scenario[], options: RunScenariosOptions = {}): void {
    const missingModules = (options.requiresOnyxModules ?? []).filter((relativePath) => !hasOnyxModule(relativePath));

    if (missingModules.length > 0) {
        it.skip(`react-native-onyx/dist/${missingModules.join(', ')} is not part of this arm`, () => {});
        return;
    }

    const profile = getScaleProfile();
    const selected = selectScenarios(scenarios);

    beforeAll(() => {
        initEveryArm();
    });

    if (selected.length === 0) {
        it(`no scenario matches ONYX_PERF_FILTER="${process.env.ONYX_PERF_FILTER ?? ''}"`, () => {
            expect(scenarios.length).toBeGreaterThan(0);
        });
        return;
    }

    for (const scenario of selected) {
        if (!everyArm(scenario.isSupported)) {
            it.skip(`${scenario.id} (not supported by this arm)`, () => {});
            continue;
        }

        it(scenario.id, async () => {
            if (isHotswapRun()) {
                const results = await measureHotswapInterleaved(scenario, profile);
                expect(results.every((result) => result.samples.length >= 1)).toBe(true);
                return;
            }

            const result = await measureOnce(scenario, profile);
            logResult(scenario.id, result);

            expect(result.samples.length).toBeGreaterThanOrEqual(1);
        });
    }
}

export default runScenarios;
