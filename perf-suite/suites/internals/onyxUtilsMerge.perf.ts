import ONYXKEYS from '@app/ONYXKEYS';
import type {ReportAction, ReportActions} from '@app/types';

import type {OnyxInput, OnyxKey} from 'react-native-onyx';

import OnyxUtils from 'react-native-onyx/dist/OnyxUtils';

import {getHeavyAccount} from '../../fixtures/account';
import {toOnyxInputRecord} from '../../harness/onyxRecords';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The write half of `OnyxUtils`: the merge-queue flush (`mergeChanges` for the value broadcast to
 * subscribers and `mergeAndMarkChanges` for the batched change handed to storage) and the pair
 * preparation every multiSet and mergeCollection runs before the write.
 */
type MergeChangesContext = {
    existingValue: ReportActions;
    actionIDs: string[];
    changes: Array<Record<string, Partial<ReportAction>>>;
    state: {revision: number};
};

type PreparePairsContext = {
    pairs: Partial<Record<OnyxKey, OnyxInput<OnyxKey>>>;
    state: {revision: number};
};

const QUEUED_CHANGES = 20;

const mergeChangesQueue = defineScenario({
    id: 'internals/OnyxUtils/mergeChanges',
    title: 'mergeChanges and mergeAndMarkChanges over a queue of 20 patches to one report actions member of A actions, the flush of one merge queue entry',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1520, note: 'success data merges into a report actions member, several of which can queue on the key before a flush'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'every server response batch merges through the same queue'},
    ],
    // Merging the queue into the existing value copies every action of the member once per patch.
    scale: (profile) => ({changes: QUEUED_CHANGES, existingActions: profile.reportActionsPerActiveReport}),
    setup: async (): Promise<MergeChangesContext> => {
        const account = getHeavyAccount();
        const existingValue = account.reportActions[`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${account.activeReportIDs[0]}`];

        if (!existingValue) {
            throw new Error('The heavy account fixture has no active report actions.');
        }

        return {existingValue, actionIDs: Object.keys(existingValue), changes: [], state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        const changes: Array<Record<string, Partial<ReportAction>>> = [];
        for (let index = 0; index < QUEUED_CHANGES; index++) {
            const actionID = context.actionIDs[index % context.actionIDs.length];
            changes.push({[actionID]: {isOptimisticAction: (context.state.revision + index) % 2 === 0, lastModified: `2026-09-14 12:00:${String(index % 60).padStart(2, '0')}.000`}});
        }

        context.changes = changes;
    },
    run: async (context, params) => {
        const merged = OnyxUtils.mergeChanges(context.changes, context.existingValue);
        const marked = OnyxUtils.mergeAndMarkChanges(context.changes);

        return {changes: params.changes, mergedFields: Object.keys(merged.result ?? {}).length, markedFields: Object.keys(marked.result ?? {}).length};
    },
});

const preparePairs = defineScenario({
    id: 'internals/OnyxUtils/prepareKeyValuePairsForStorage',
    title: 'prepareKeyValuePairsForStorage over N report pairs where every third one carries nested nulls to strip',
    realUsage: [
        {file: 'src/libs/actions/App.ts', line: 423, note: 'Onyx.multiSet of the boot keys, which prepares its pairs this way'},
        {file: 'src/libs/actions/Report/index.ts', line: 791, note: 'a report write whose nested nulls are removed before it reaches storage'},
    ],
    scale: (profile) => ({pairs: profile.reports}),
    setup: async (): Promise<PreparePairsContext> => ({pairs: {}, state: {revision: 0}}),
    beforeEach: async (context, params) => {
        context.state.revision++;

        const account = getHeavyAccount();
        const pairs: Partial<Record<OnyxKey, OnyxInput<OnyxKey>>> = {};

        for (let index = 0; index < params.pairs; index++) {
            const reportID = account.reportIDs[index % account.reportIDs.length];
            const report = account.reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`];

            // Every third entry carries nested nulls, the shape a partial server response has.
            pairs[`${ONYXKEYS.COLLECTION.REPORT}prepare-${index}-${context.state.revision}`] =
                index % 3 === 0 ? {...report, errorFields: {avatar: null}, pendingFields: {avatar: null}} : report;
        }

        context.pairs = pairs;
    },
    run: async (context, params) => {
        const prepared = OnyxUtils.prepareKeyValuePairsForStorage(toOnyxInputRecord(context.pairs), true);

        return {pairs: params.pairs, preparedPairs: prepared.pairs.length, removedKeys: prepared.keysToRemove.length};
    },
});

runScenarios([mergeChangesQueue, preparePairs]);
