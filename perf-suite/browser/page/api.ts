import type {IterationResult} from '../../harness/iteration';
import type {MeasureOptions} from '../../harness/measureOptions';
import type {MeasureOverrides, Scenario, ScenarioMetadata, ScenarioParams, ScenarioRunner} from '../../harness/scenario';

import createGarbageCollector from '../../harness/gc';
import runIteration from '../../harness/iteration';
import {initOnyxForPerf, waitForOnyx} from '../../harness/onyx';
import getScaleProfile from '../../harness/scale';
import {installIDBCounters} from './idbCounters';

/** What the runner needs to know about a scenario before it opens a page for it. */
type PageScenario = {
    metadata: ScenarioMetadata;
    params: ScenarioParams;
    measure?: MeasureOverrides;
    isSupported: boolean;
};

/**
 * The page side of one lane. The runner calls it through `page.evaluate`, one call per step of the loop in
 * `harness/laneLoop.ts`, so every timing is taken here, inside the page, and none of the CDP round trip lands
 * in a sample.
 */
type OnyxPerfPage = {
    list: () => PageScenario[];

    /** Initialises Onyx on the page's IndexedDB and runs the scenario's `setup`; returns its duration. */
    setup: (id: string) => Promise<number>;
    iterate: () => Promise<IterationResult>;
    collectGarbage: (options: MeasureOptions) => number;
    settle: (options: MeasureOptions) => void;
    readHeapMb: () => number;
    teardown: () => Promise<void>;
};

declare global {
    // eslint-disable-next-line no-var
    var onyxPerf: OnyxPerfPage;
}

/** Chromium's non-standard `performance.memory`; exact only with `--enable-precise-memory-info`. */
function readUsedHeapBytes(): number {
    const memory: unknown = Reflect.get(performance, 'memory');

    return typeof memory === 'object' && memory !== null && 'usedJSHeapSize' in memory && typeof memory.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : 0;
}

const collector = createGarbageCollector({
    readUsedHeapBytes,
    gc: globalThis.gc,
});

function registerScenarios(scenarios: readonly Scenario[]): void {
    installIDBCounters();

    const profile = getScaleProfile();
    let runner: ScenarioRunner | undefined;

    function requireRunner(): ScenarioRunner {
        if (!runner) {
            throw new Error('onyxPerf: no scenario is set up on this page');
        }

        return runner;
    }

    globalThis.onyxPerf = {
        list: () =>
            scenarios.map((scenario) => ({
                metadata: {id: scenario.id, area: scenario.area, title: scenario.title, realUsage: scenario.realUsage, sizeIndependent: scenario.sizeIndependent},
                params: scenario.resolveParams(profile),
                measure: scenario.measure,
                isSupported: scenario.isSupported(),
            })),
        setup: async (id) => {
            const scenario = scenarios.find((candidate) => candidate.id === id);

            if (!scenario) {
                throw new Error(`onyxPerf: no scenario "${id}" on this page`);
            }

            initOnyxForPerf();
            await waitForOnyx();

            runner = await scenario.createRunner(profile);

            return runner.setupMs;
        },
        iterate: () => runIteration(requireRunner()),
        collectGarbage: (options) => collector.collectBetweenIterations(options),
        settle: (options) => collector.settle(options),
        readHeapMb: () => readUsedHeapBytes() / 1024 / 1024,
        teardown: async () => {
            await requireRunner().teardown?.();
        },
    };
}

export default registerScenarios;
export type {OnyxPerfPage, PageScenario};
