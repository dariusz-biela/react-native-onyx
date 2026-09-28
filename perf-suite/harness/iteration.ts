import type {Counters, ScenarioRunner} from './scenario';

import nowMs from './clock';

type IterationResult = {
    durationMs: number;
    counters: Counters | void;

    /** The untimed hooks around `run`, recorded so the report can show what an iteration costs beyond its sample. */
    beforeEachMs: number;
    afterEachMs: number;
};

/** One iteration of a runner: only the `run` call is inside the timed region. */
async function runIteration(runner: ScenarioRunner): Promise<IterationResult> {
    const beforeEachStartedAt = nowMs();
    await runner.beforeEach?.();

    const startedAt = nowMs();
    const counters = await runner.run();
    const endedAt = nowMs();

    await runner.afterEach?.();

    return {durationMs: endedAt - startedAt, counters, beforeEachMs: startedAt - beforeEachStartedAt, afterEachMs: nowMs() - endedAt};
}

export default runIteration;
export type {IterationResult};
