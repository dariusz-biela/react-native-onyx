import initOnyxDerivedValues from '@app/derived';

import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';

import type {Connection, OnyxKey} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import type {ReactElement} from 'react';

import {createElement, Fragment} from 'react';

import type {RenderedTree} from './react';

import {waitForOnyx} from './onyx';
import {actAsync, unmountTree} from './react';
import {countRender, getRenderCount, resetRenderCount} from './renderCount';
import render from './renderer';

/**
 * What a booted, signed-in app has subscribed to Onyx, reproduced in one call so a `flows/` scenario
 * measures a write against a realistic subscriber population instead of an empty store.
 *
 * Three populations, each switchable on its own:
 *
 * - `moduleListeners`: `Onyx.connectWithoutView` listeners spread over the keys with the most call
 *   sites in `src/`. The weights are the call-site counts of
 *   `grep -rn "connectWithoutView(" src/ -A 2 | grep -oE "key: ONYXKEYS\.[A-Z_0-9.]+" | sort | uniq -c`
 *   taken on 2026-09-16: SESSION 26, COLLECTION.REPORT 14, NETWORK 7, COLLECTION.REPORT_ACTIONS 7,
 *   ACCOUNT 5, NVP_ONBOARDING 4, COLLECTION.POLICY 4, PERSONAL_DETAILS_LIST 3, BETAS 1.
 * - `hookComponents`: `useOnyx` probes over the four keys with the most hook call sites, weighted the
 *   same way from `grep -rnoE "useOnyx\(ONYXKEYS\.[A-Z_0-9.]+" src/`: PERSONAL_DETAILS_LIST 187,
 *   COLLECTION.POLICY 180, SESSION 173, COLLECTION.REPORT 76. Plus `lhnRows` probes, one per report
 *   member key, and the four hooks of the open report.
 * - `initDerived`: the derived-value engine (`app/derived`), wired the way `suites/subscriptions/derived.perf.ts`
 *   does it (the translations flag cleared, otherwise the locale dependency never fires and the derived values
 *   never write).
 *
 * The handle counts what the subscribers did, not only how long the write took: `moduleCallbacks` is how
 * many non-React callbacks fired and `renders` how many components React actually re-ran.
 */
type LoadedAppOptions = {
    /** `Onyx.connectWithoutView` listeners to attach, spread over the weighted module keys. */
    moduleListeners?: number;

    /** `useOnyx` probes to mount, spread over the weighted hook keys. */
    hookComponents?: number;

    /** LHN rows, each mounted on its own `${COLLECTION.REPORT}${id}` member key. */
    lhnRows?: number;

    /** Report ids the LHN rows read, in order. Required when `lhnRows` is greater than zero. */
    reportIDs?: readonly string[];

    /** When set, mounts the open report's four hooks: the report, its actions, its draft and its typing key. */
    currentReportID?: string;

    /** One extra probe per entry, for the screen-specific keys a flow needs (a search snapshot, for example). */
    extraKeys?: readonly OnyxKey[];

    /** Runs the derived-value engine (`app/derived`), so every derived value recomputes on the writes a flow makes. */
    initDerived?: boolean;
};

type LoadedAppCounters = {
    /** Module listener callbacks fired since the last `resetCounters()`. */
    moduleCallbacks: number;

    /** Component renders executed since the last `resetCounters()`. */
    renders: number;
};

type LoadedApp = {
    getCounters: () => LoadedAppCounters;
    resetCounters: () => void;
    unmount: () => Promise<void>;

    /** Re-renders the tree with the open report's four hooks pointed at another report, the way navigating does. */
    switchCurrentReport: (reportID: string) => Promise<void>;

    /** How many subscribers of each kind were actually attached, for the scenario to report as params. */
    mounted: {
        moduleListeners: number;
        hookComponents: number;
        lhnRows: number;
        currentReportHooks: number;
        extraKeys: number;
    };
};

type WeightedKey = {
    key: OnyxKey;
    weight: number;
};

const MODULE_LISTENER_KEYS: readonly WeightedKey[] = [
    {key: ONYXKEYS.SESSION, weight: 26},
    {key: ONYXKEYS.COLLECTION.REPORT, weight: 14},
    {key: ONYXKEYS.NETWORK, weight: 7},
    {key: ONYXKEYS.COLLECTION.REPORT_ACTIONS, weight: 7},
    {key: ONYXKEYS.ACCOUNT, weight: 5},
    {key: ONYXKEYS.NVP_ONBOARDING, weight: 4},
    {key: ONYXKEYS.COLLECTION.POLICY, weight: 4},
    {key: ONYXKEYS.PERSONAL_DETAILS_LIST, weight: 3},
    {key: ONYXKEYS.BETAS, weight: 1},
];

type KeyProbeProps = {onyxKey: OnyxKey};

function SessionProbe(): null {
    countRender();
    useOnyx(ONYXKEYS.SESSION);
    return null;
}

function PersonalDetailsProbe(): null {
    countRender();
    useOnyx(ONYXKEYS.PERSONAL_DETAILS_LIST);
    return null;
}

function PolicyCollectionProbe(): null {
    countRender();
    useOnyx(ONYXKEYS.COLLECTION.POLICY);
    return null;
}

function ReportCollectionProbe(): null {
    countRender();
    useOnyx(ONYXKEYS.COLLECTION.REPORT);
    return null;
}

/** One hook on one member key: an LHN row, or one of the open report's four reads. */
function MemberKeyProbe({onyxKey}: KeyProbeProps): null {
    countRender();
    useOnyx(onyxKey);
    return null;
}

const HOOK_PROBES: ReadonlyArray<WeightedKey & {Probe: () => null}> = [
    {key: ONYXKEYS.PERSONAL_DETAILS_LIST, weight: 187, Probe: PersonalDetailsProbe},
    {key: ONYXKEYS.COLLECTION.POLICY, weight: 180, Probe: PolicyCollectionProbe},
    {key: ONYXKEYS.SESSION, weight: 173, Probe: SessionProbe},
    {key: ONYXKEYS.COLLECTION.REPORT, weight: 76, Probe: ReportCollectionProbe},
];

/**
 * Splits `total` over the weights so the parts sum to exactly `total`. Largest remainder rather than a
 * plain floor, because a floor drops up to one subscriber per key and the smallest weights would never
 * get a subscriber at all at the small scale profile.
 */
function distributeByWeight(total: number, weights: readonly number[]): number[] {
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

    if (total <= 0 || weightSum <= 0) {
        return weights.map(() => 0);
    }

    const exact = weights.map((weight) => (total * weight) / weightSum);
    const parts = exact.map((value) => Math.floor(value));
    const remainders = exact.map((value, index) => ({index, remainder: value - parts[index]}));

    let assigned = parts.reduce((sum, part) => sum + part, 0);
    remainders.sort((a, b) => b.remainder - a.remainder);

    for (let index = 0; assigned < total; index++) {
        parts[remainders[index % remainders.length].index] += 1;
        assigned += 1;
    }

    return parts;
}

function buildCurrentReportKeys(reportID: string): OnyxKey[] {
    return [
        `${ONYXKEYS.COLLECTION.REPORT}${reportID}`,
        `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`,
        `${ONYXKEYS.COLLECTION.REPORT_DRAFT_COMMENT}${reportID}`,
        `${ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${reportID}`,
    ];
}

function buildLhnKeys(lhnRows: number, reportIDs: readonly string[]): OnyxKey[] {
    if (lhnRows <= 0) {
        return [];
    }

    if (reportIDs.length === 0) {
        throw new Error('mountLoadedApp: lhnRows was requested without reportIDs to read.');
    }

    const keys: OnyxKey[] = new Array<OnyxKey>(lhnRows);

    for (let index = 0; index < lhnRows; index++) {
        keys[index] = `${ONYXKEYS.COLLECTION.REPORT}${reportIDs[index % reportIDs.length]}`;
    }

    return keys;
}

/**
 * The probes that never change key. Built once and reused by reference on every re-render: React bails out
 * of a child whose element object is identical to the previous one, so switching the open report re-renders
 * the four hooks that actually changed key instead of the whole mounted app.
 */
function buildStaticChildren(hookCounts: readonly number[], staticKeys: readonly OnyxKey[]): ReactElement[] {
    const children: ReactElement[] = [];

    HOOK_PROBES.forEach(({Probe}, probeIndex) => {
        for (let index = 0; index < hookCounts[probeIndex]; index++) {
            children.push(createElement(Probe, {key: `hook-${probeIndex}-${index}`}));
        }
    });

    staticKeys.forEach((onyxKey, index) => {
        children.push(createElement(MemberKeyProbe, {key: `member-${index}`, onyxKey}));
    });

    return children;
}

function buildAppTree(staticChildren: readonly ReactElement[], currentReportKeys: readonly OnyxKey[]): ReactElement {
    const children: ReactElement[] = [...staticChildren];

    currentReportKeys.forEach((onyxKey, index) => {
        children.push(createElement(MemberKeyProbe, {key: `current-${index}`, onyxKey}));
    });

    return createElement(Fragment, null, children);
}

/**
 * Clears the translations loading flag, the pre-condition every derived value with a locale dependency waits on,
 * then wires the derived values. The App loads the English locale first; the port's engine reads a fixed one.
 */
async function prepareDerivedValues(): Promise<void> {
    await Onyx.set(ONYXKEYS.RAM_ONLY_ARE_TRANSLATIONS_LOADING, false);
    await waitForOnyx();

    initOnyxDerivedValues();
    await waitForOnyx();
}

/**
 * Mounts the requested slice of a loaded app and returns once every subscriber has received its first
 * value, so a scenario's timed region only ever contains the write it is measuring.
 */
async function mountLoadedApp(options: LoadedAppOptions = {}): Promise<LoadedApp> {
    const moduleListeners = options.moduleListeners ?? 0;
    const hookComponents = options.hookComponents ?? 0;
    const lhnRows = options.lhnRows ?? 0;

    if (options.initDerived) {
        await prepareDerivedValues();
    }

    const state = {moduleCallbacks: 0};
    const connections: Connection[] = [];
    const listenerCounts = distributeByWeight(
        moduleListeners,
        MODULE_LISTENER_KEYS.map((entry) => entry.weight),
    );

    MODULE_LISTENER_KEYS.forEach(({key}, keyIndex) => {
        for (let index = 0; index < listenerCounts[keyIndex]; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key,
                    callback: () => {
                        state.moduleCallbacks++;
                    },
                }),
            );
        }
    });

    const staticKeys: OnyxKey[] = [...buildLhnKeys(lhnRows, options.reportIDs ?? []), ...(options.extraKeys ?? [])];
    let currentReportKeys = options.currentReportID ? buildCurrentReportKeys(options.currentReportID) : [];

    const hookCounts = distributeByWeight(
        hookComponents,
        HOOK_PROBES.map((entry) => entry.weight),
    );

    const staticChildren = buildStaticChildren(hookCounts, staticKeys);

    let tree: RenderedTree | undefined;
    if (staticChildren.length > 0 || currentReportKeys.length > 0) {
        tree = render(buildAppTree(staticChildren, currentReportKeys));
        await actAsync(() => {});
    }

    await waitForOnyx();
    state.moduleCallbacks = 0;
    resetRenderCount();

    return {
        getCounters: () => ({moduleCallbacks: state.moduleCallbacks, renders: getRenderCount()}),
        resetCounters: () => {
            state.moduleCallbacks = 0;
            resetRenderCount();
        },
        switchCurrentReport: async (reportID: string) => {
            if (!tree) {
                throw new Error('mountLoadedApp: switchCurrentReport needs a mounted tree; mount with currentReportID first.');
            }

            currentReportKeys = buildCurrentReportKeys(reportID);
            // `rerender` wraps its own commit in `act`, so this must not be nested in another `act` call.
            tree.rerender(buildAppTree(staticChildren, currentReportKeys));
            await actAsync(() => {});
        },
        unmount: async () => {
            if (tree) {
                await unmountTree(tree);
            }

            for (const connection of connections) {
                Onyx.disconnect(connection);
            }
        },
        mounted: {
            moduleListeners: connections.length,
            hookComponents: hookCounts.reduce((sum, count) => sum + count, 0),
            lhnRows,
            currentReportHooks: currentReportKeys.length,
            extraKeys: options.extraKeys?.length ?? 0,
        },
    };
}

export default mountLoadedApp;
export {distributeByWeight, HOOK_PROBES, MODULE_LISTENER_KEYS, prepareDerivedValues};
export type {LoadedApp, LoadedAppCounters, LoadedAppOptions};
