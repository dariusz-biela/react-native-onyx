import ONYXKEYS from '@app/ONYXKEYS';
import type {ReportActions} from '@app/types';

import type {NullishDeep, OnyxKey} from 'react-native-onyx';

import OnyxMerge from 'react-native-onyx/dist/OnyxMerge';
import OnyxMergeWeb from 'react-native-onyx/dist/OnyxMerge/index.js';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * `OnyxMerge.applyMerge` is the platform-specific tail of every `Onyx.merge`: it merges the queued
 * changes, compares the result with the cache, broadcasts it and writes to storage.
 *
 * Which of the two implementations runs is decided by Jest's resolver, not by the suite: the
 * `jest-expo` preset sets `haste.defaultPlatform` to `ios`, so `react-native-onyx/dist/OnyxMerge`
 * resolves to `index.native.js`, the SQLite variant that also runs `mergeAndMarkChanges` and hands
 * the batched change to `Storage.mergeItem`. The counter `isNativeVariant` records which one the
 * directory import actually gave. The web variant, which merges in JS and hands the whole merged value
 * to `Storage.setItem`, only loads through the explicit `index.js` path, which the resolver does not
 * platform-substitute; `internals/OnyxMerge/apply-web` measures it that way.
 */
type ApplyMergeContext = {
    actionsKey: OnyxKey;
    existingValue: ReportActions;

    /** Three actions of the member the patches touch. */
    actionIDs: string[];

    /** One queue of changes per call in the sample, each with its own revision so no call is a no-op. */
    changeSets: Array<Array<NullishDeep<ReportActions>>>;
    state: {revision: number};
};

const QUEUED_CHANGES = 3;

/** One applyMerge is about 0.05 ms, under the harness floor, so a sample is this many calls back to back. */
const CALLS_PER_SAMPLE = 10;

/** The patches a sent comment's success data and a server update queue on a report actions member. */
function buildChangeSets(revision: number, actionIDs: string[]): Array<Array<NullishDeep<ReportActions>>> {
    const [first, second, third] = actionIDs;
    const changeSets: Array<Array<NullishDeep<ReportActions>>> = [];
    for (let call = 0; call < CALLS_PER_SAMPLE; call++) {
        const stamp = revision * CALLS_PER_SAMPLE + call;
        changeSets.push([{[first]: {pendingAction: stamp % 2 === 0 ? null : 'update'}}, {[second]: {isOptimisticAction: stamp % 2 === 0}}, {[third]: {errors: null}}]);
    }
    return changeSets;
}

/** Every applyMerge copies and compares the whole member, so a report actions member of the scale's size is the target. */
async function setupApplyMerge(): Promise<ApplyMergeContext> {
    const account = getHeavyAccount();
    await seedOnyxWithAccount(account);

    const actionsKey: `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}` = `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${account.activeReportIDs[0]}`;
    const existingValue = account.reportActions[actionsKey];

    if (!existingValue) {
        throw new Error('The heavy account fixture has no active report actions.');
    }

    return {actionsKey, existingValue, actionIDs: Object.keys(existingValue).slice(0, 3), changeSets: [], state: {revision: 0}};
}

/** Resolved once at module load: 1 when Jest picked the native (SQLite) variant, 0 for the web one. */
const IS_NATIVE_VARIANT = require.resolve('react-native-onyx/dist/OnyxMerge').endsWith('index.native.js') ? 1 : 0;

const applyMerge = defineScenario({
    id: 'internals/OnyxMerge/apply',
    title: 'ten OnyxMerge.applyMerge calls (the native SQLite variant, which is the one Jest resolves) of three queued patches over one report actions member of A actions',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1520, note: 'the success data merge into a report actions member, which ends in applyMerge after the queue has been flushed'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'every merge in a server response batch takes the same path'},
    ],
    scale: (profile) => ({changes: QUEUED_CHANGES, calls: CALLS_PER_SAMPLE, existingActions: profile.reportActionsPerActiveReport}),
    setup: setupApplyMerge,
    beforeEach: async (context) => {
        context.state.revision++;
        context.changeSets = buildChangeSets(context.state.revision, context.actionIDs);
    },
    run: async (context, params) => {
        let mergedFields = 0;
        for (const changes of context.changeSets) {
            const result = await OnyxMerge.applyMerge(context.actionsKey, context.existingValue, changes);
            mergedFields = Object.keys(result.mergedValue ?? {}).length;
        }

        return {changes: params.changes, calls: params.calls, isNativeVariant: IS_NATIVE_VARIANT, mergedFields};
    },
});

/** 1 when the explicit `index.js` import really is the web file, so a resolver change cannot silently turn this row into the native one. */
const IS_WEB_VARIANT = require.resolve('react-native-onyx/dist/OnyxMerge/index.js').endsWith('/index.js') ? 1 : 0;

const applyMergeWeb = defineScenario({
    id: 'internals/OnyxMerge/apply-web',
    title: 'ten OnyxMerge.applyMerge calls, the web variant loaded through its explicit index.js path, of three queued patches over one report actions member of A actions',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1520, note: 'the success data merge into a report actions member, which ends in applyMerge after the queue has been flushed'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'every merge in a server response batch takes the same path'},
    ],
    scale: (profile) => ({changes: QUEUED_CHANGES, calls: CALLS_PER_SAMPLE, existingActions: profile.reportActionsPerActiveReport}),
    setup: setupApplyMerge,
    beforeEach: async (context) => {
        context.state.revision++;
        context.changeSets = buildChangeSets(context.state.revision, context.actionIDs);
    },
    run: async (context, params) => {
        let mergedFields = 0;
        for (const changes of context.changeSets) {
            const result = await OnyxMergeWeb.applyMerge(context.actionsKey, context.existingValue, changes);
            mergedFields = Object.keys(result.mergedValue ?? {}).length;
        }

        return {changes: params.changes, calls: params.calls, isWebVariant: IS_WEB_VARIANT, mergedFields};
    },
});

runScenarios([applyMerge, applyMergeWeb]);
