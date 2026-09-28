import type {LaneDriver, MeasureResult} from './laneLoop';
import type {MeasureOverrides, ScenarioRunner} from './scenario';

import v8 from 'v8';

import createGarbageCollector from './gc';
import runIteration from './iteration';
import measureDrivers from './laneLoop';
import {resolveMeasureOptions} from './measureOptions';

/**
 * The Onyx storage mock wraps every provider method in `jest.fn()`, and a jest mock retains every
 * argument it was ever called with. Left alone over an iteration loop that pins every fixture the
 * scenario ever wrote, which shows up as a slow upward drift in the samples. Clearing the call
 * records first is what makes the following collection actually free anything.
 */
const collector = createGarbageCollector({
    readUsedHeapBytes: () => v8.getHeapStatistics().used_heap_size,
    gc: global.gc,
    beforeCollect: () => jest.clearAllMocks(),
});

/**
 * One runner measured in lockstep with the others. `activate` runs before every call into the runner;
 * a hot-swap lane switches the active Onyx arm there, a classic run has a single lane and no switch.
 */
type MeasureLane = {
    runner: ScenarioRunner;
    activate?: () => void;
};

function toDriver(lane: MeasureLane): LaneDriver {
    return {
        iterate: () => {
            lane.activate?.();
            return runIteration(lane.runner);
        },
        collectGarbage: async (options) => collector.collectBetweenIterations(options),
        readHeapMb: async () => process.memoryUsage().heapUsed / 1024 / 1024,
        teardown: async () => {
            lane.activate?.();
            await lane.runner.teardown?.();
        },
    };
}

/** Measures the lanes of this Jest process in lockstep, see `measureDrivers`. */
function measureLanes(lanes: readonly MeasureLane[], overrides?: MeasureOverrides, orderSeed = ''): Promise<MeasureResult[]> {
    const options = resolveMeasureOptions(overrides);

    return measureDrivers({drivers: lanes.map(toDriver), options, orderSeed, settle: async () => collector.settle(options)});
}

async function measureScenario(runner: ScenarioRunner, overrides?: MeasureOverrides): Promise<MeasureResult> {
    const [result] = await measureLanes([{runner}], overrides);

    return result;
}

export default measureScenario;
export {measureLanes};
export type {MeasureLane};
