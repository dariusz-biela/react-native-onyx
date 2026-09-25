/**
 * Fixture sizes. A default run (`ab.sh`) measures every scenario at three of them, `small`, `large` and
 * `heavy`, and each field of the three grows from one to the next, so every row sees three data sizes;
 * `medium` is kept for single-scale runs.
 *
 * `hookComponents` is K, the number of hooks on one key, and is deliberately kept at realistic App
 * counts rather than scaled with the fixtures: 1 is the no-sharing floor, 30 a hot key on one phone
 * screen, 150 a hot key on web with the LHN and a report mounted (estimated from the code, 2026-09-18),
 * 300 the same on a P95 account whose LHN mounts twice the rows.
 */
type ScaleName = 'small' | 'medium' | 'large' | 'heavy';

type ScaleProfile = {
    /** Name of the profile, carried into every result line. */
    name: ScaleName;

    /** Reports written under ONYXKEYS.COLLECTION.REPORT. */
    reports: number;

    /** Reports that also get a report-actions collection member. */
    activeReports: number;

    /** Report actions inside each active report's collection member. */
    reportActionsPerActiveReport: number;

    /** Report actions inside the one hot report (Concierge, #announce): the largest single member key an account carries. */
    hotReportActions: number;

    /** Entries in the single ONYXKEYS.PERSONAL_DETAILS_LIST object. */
    personalDetails: number;

    /** Policies written under ONYXKEYS.COLLECTION.POLICY. */
    policies: number;

    /** Transactions written under ONYXKEYS.COLLECTION.TRANSACTION. */
    transactions: number;

    /** Non-React subscribers, the `Onyx.connectWithoutView` population of a booted app. */
    moduleListeners: number;

    /** React components mounted on one key for the hook scenarios. */
    hookComponents: number;

    /** Keys touched by a single simulated server update batch. */
    updateBatchKeys: number;
};

const PROFILES: Record<ScaleName, ScaleProfile> = {
    small: {
        name: 'small',
        reports: 50,
        activeReports: 5,
        reportActionsPerActiveReport: 20,
        hotReportActions: 100,
        personalDetails: 50,
        policies: 5,
        transactions: 50,
        moduleListeners: 20,
        hookComponents: 1,
        updateBatchKeys: 10,
    },
    medium: {
        name: 'medium',
        reports: 300,
        activeReports: 20,
        reportActionsPerActiveReport: 60,
        hotReportActions: 500,
        personalDetails: 500,
        policies: 20,
        transactions: 500,
        moduleListeners: 100,
        hookComponents: 30,
        updateBatchKeys: 40,
    },
    large: {
        name: 'large',
        reports: 1500,
        activeReports: 60,
        reportActionsPerActiveReport: 150,
        hotReportActions: 2000,
        personalDetails: 3000,
        policies: 60,
        transactions: 3000,
        moduleListeners: 400,
        hookComponents: 150,
        updateBatchKeys: 150,
    },
    // A P95 customer account, the size the app's own perf issues quote: about 20k personal details
    // (Expensify/App#101083), thousands of reports and a hot report with thousands of actions. Every field
    // is at least the `large` one (until 2026-09-23 K, the batch size, the module listeners and the actions
    // per report were equal or smaller, so rows depending only on those measured large twice).
    heavy: {
        name: 'heavy',
        reports: 5000,
        activeReports: 100,
        reportActionsPerActiveReport: 200,
        hotReportActions: 5000,
        personalDetails: 20000,
        policies: 100,
        transactions: 5000,
        moduleListeners: 500,
        hookComponents: 300,
        updateBatchKeys: 300,
    },
};

function isScaleName(value: string): value is ScaleName {
    return value === 'small' || value === 'medium' || value === 'large' || value === 'heavy';
}

/** Resolves the active profile from ONYX_PERF_SCALE, defaulting to `medium`. */
function getScaleProfile(): ScaleProfile {
    const requested = process.env.ONYX_PERF_SCALE ?? 'medium';

    if (!isScaleName(requested)) {
        throw new Error(`Unknown ONYX_PERF_SCALE "${requested}". Use small, medium, large or heavy.`);
    }

    const profile = PROFILES[requested];
    const hookComponentsOverride = Number(process.env.ONYX_PERF_HOOK_COMPONENTS ?? '');

    // Lets a run vary K (hooks on one key) without a dedicated profile, e.g. K=1 as the no-sharing floor.
    if (Number.isInteger(hookComponentsOverride) && hookComponentsOverride > 0) {
        return {...profile, hookComponents: hookComponentsOverride};
    }

    return profile;
}

export default getScaleProfile;
export {PROFILES, isScaleName};
export type {ScaleName, ScaleProfile};
