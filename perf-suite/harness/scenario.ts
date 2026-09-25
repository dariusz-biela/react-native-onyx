import type {ScaleProfile} from './scale';

import nowMs from './clock';

/** The six areas of the suite. The area is derived from the first path segment of the scenario id. */
const AREAS = ['api', 'subscriptions', 'hooks', 'internals', 'flows', 'storage'] as const;

type ScenarioArea = (typeof AREAS)[number];

/** A verified call site in `src/` that justifies the scenario existing. */
type RealUsageAnchor = {
    /** Repo-relative path, for example `src/libs/actions/Report/index.ts`. */
    file: string;

    /** Line number in that file at the time the scenario was written. */
    line: number;

    /** What that line does, in a few words. */
    note: string;
};

/** Scale numbers a scenario picks out of the active profile, recorded next to its results. */
type ScenarioParams = Readonly<Record<string, number>>;

/** Extra per-iteration measurements, for example how many subscriber callbacks a write produced. */
type Counters = Readonly<Record<string, number>>;

/** Per-scenario overrides of the harness defaults in `measure.ts`. */
type MeasureOverrides = {
    warmupIterations?: number;

    /** Warm-up stops once it has run this long, after at least one iteration per lane. */
    warmupBudgetMs?: number;
    minIterations?: number;
    maxIterations?: number;
    timeBudgetMs?: number;
};

type ScenarioDefinition<TContext, TParams extends ScenarioParams> = {
    /** `<area>/<group>/<name>`, unique across the suite. */
    id: string;

    /** One sentence saying what is measured and under what load. */
    title: string;

    /** At least one anchor, so a regression can be traced to code that actually runs it. */
    realUsage: readonly RealUsageAnchor[];

    /** Picks the scale numbers this scenario cares about out of the active profile. */
    scale: (profile: ScaleProfile) => TParams;

    /**
     * Why the scenario does the same work at every scale, for a pure function whose cost does not depend on
     * any data size. The report lists it next to the reason instead of warning that its scales are identical.
     */
    sizeIndependent?: string;

    measure?: MeasureOverrides;

    /** True when the Onyx build under test has what `run` calls; a false answer skips the scenario instead of failing the file. */
    requires?: () => boolean;

    /** Runs once per scenario, untimed. Builds whatever `run` needs. */
    setup: (params: TParams) => Promise<TContext>;

    /** Runs before every iteration, untimed. Restores the pre-conditions `run` consumes. */
    beforeEach?: (context: TContext, params: TParams) => Promise<void>;

    /** The timed region. Keep it to the operation under measurement. */
    run: (context: TContext, params: TParams) => Promise<Counters | void>;

    /** Runs after every iteration, untimed. */
    afterEach?: (context: TContext, params: TParams) => Promise<void>;

    /** Runs once after the last iteration, untimed. */
    teardown?: (context: TContext, params: TParams) => Promise<void>;
};

/** One iteration's worth of callables, already bound to the scenario context. */
type ScenarioRunner = {
    params: ScenarioParams;

    /** Wall clock of the scenario's `setup`, untimed in the samples but part of what a run costs. */
    setupMs: number;
    beforeEach?: () => Promise<void>;
    run: () => Promise<Counters | void>;
    afterEach?: () => Promise<void>;
    teardown?: () => Promise<void>;
};

/** The generic-free shape `runScenarios` stores in a list. */
type Scenario = {
    id: string;
    area: ScenarioArea;
    title: string;
    realUsage: readonly RealUsageAnchor[];
    sizeIndependent?: string;
    measure?: MeasureOverrides;
    isSupported: () => boolean;
    resolveParams: (profile: ScaleProfile) => ScenarioParams;
    createRunner: (profile: ScaleProfile) => Promise<ScenarioRunner>;
};

function isScenarioArea(value: string): value is ScenarioArea {
    return AREAS.some((area) => area === value);
}

function areaOf(id: string): ScenarioArea {
    const [area] = id.split('/');

    if (!isScenarioArea(area)) {
        throw new Error(`Scenario id "${id}" must start with one of: ${AREAS.join(', ')}.`);
    }

    return area;
}

/**
 * Declares one measurable scenario. The two type parameters are inferred from `scale` and `setup`,
 * and are erased in the returned value so scenarios of different shapes can live in one list.
 */
function defineScenario<TContext, TParams extends ScenarioParams>(definition: ScenarioDefinition<TContext, TParams>): Scenario {
    if (definition.realUsage.length === 0) {
        throw new Error(`Scenario "${definition.id}" has no realUsage anchor.`);
    }

    return {
        id: definition.id,
        area: areaOf(definition.id),
        title: definition.title,
        realUsage: definition.realUsage,
        sizeIndependent: definition.sizeIndependent,
        measure: definition.measure,
        isSupported: () => definition.requires?.() ?? true,
        resolveParams: (profile) => definition.scale(profile),
        createRunner: async (profile) => {
            const params = definition.scale(profile);
            const setupStartedAt = nowMs();
            const context = await definition.setup(params);
            const setupMs = nowMs() - setupStartedAt;

            return {
                params,
                setupMs,
                beforeEach: definition.beforeEach && (() => definition.beforeEach?.(context, params) ?? Promise.resolve()),
                run: () => definition.run(context, params),
                afterEach: definition.afterEach && (() => definition.afterEach?.(context, params) ?? Promise.resolve()),
                teardown: definition.teardown && (() => definition.teardown?.(context, params) ?? Promise.resolve()),
            };
        },
    };
}

export default defineScenario;
export {AREAS, areaOf};
export type {Counters, MeasureOverrides, RealUsageAnchor, Scenario, ScenarioArea, ScenarioParams, ScenarioRunner};
