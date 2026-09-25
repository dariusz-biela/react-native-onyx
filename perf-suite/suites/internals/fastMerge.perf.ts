import ONYXKEYS from '@app/ONYXKEYS';
import type {Report, ReportActions} from '@app/types';

import type {NullishDeep} from 'react-native-onyx';

import utils from 'react-native-onyx/dist/utils';

import {getHeavyAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/** `NullishDeep` is what Onyx itself merges: a patch may null out any nested field. */
type MergeableActions = NullishDeep<ReportActions>;

type FastMergeContext = {
    target: MergeableActions;
    source: MergeableActions;
};

type ShallowMergeContext = {
    target: NullishDeep<Report>;
    state: {revision: number; source: NullishDeep<Report>};
};

/**
 * `utils.fastMerge` is the deep merge under every `Onyx.merge`: `OnyxUtils.ts:995` in the clone calls
 * it once per pending change. This scenario exercises it directly on a report-actions collection
 * member, which is the biggest nested object the app merges into.
 */
const fastMergeReportActions = defineScenario({
    id: 'internals/utils/fastMerge-deep',
    title: 'utils.fastMerge of a pendingAction patch over a report-actions collection member with N actions',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1088, note: 'successData merges a pendingAction patch into the report actions of a report'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'every server response batch ends up in Onyx.merge, and so in fastMerge'},
    ],
    scale: (profile) => ({reportActionsPerActiveReport: profile.reportActionsPerActiveReport}),
    setup: async (): Promise<FastMergeContext> => {
        const account = getHeavyAccount();
        const reportID = account.activeReportIDs[0];
        const target: MergeableActions = account.reportActions[`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`];
        const source: MergeableActions = {};

        for (const [reportActionID, action] of Object.entries(target)) {
            if (!action) {
                continue;
            }

            source[reportActionID] = {...action, pendingAction: null, isOptimisticAction: null};
        }

        return {target, source};
    },
    run: async (context) => {
        const merged = utils.fastMerge(context.target, context.source, {shouldRemoveNestedNulls: true});
        return {mergedKeys: Object.keys(merged.result).length};
    },
});

/**
 * The other half of the merge traffic: a two-field patch over one report. Nearly every optimistic
 * update in the app is this shape, and it runs far more often than the deep case above.
 */
const fastMergeReportPatch = defineScenario({
    id: 'internals/utils/fastMerge-shallow',
    title: 'utils.fastMerge of a two-field patch over one report, the shape of almost every optimistic update',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 982, note: 'the optimistic report head fields merged after a comment is sent'},
        {file: 'src/libs/actions/Report/index.ts', line: 1542, note: 'clearAvatarErrors, a two-field merge into one report key'},
    ],
    scale: () => ({fields: 2}),
    sizeIndependent: 'one report has the same fields at every scale; internals/utils/fastMerge-deep is the row whose target grows',
    setup: async (): Promise<ShallowMergeContext> => {
        const account = getHeavyAccount();
        const target: NullishDeep<Report> | undefined = account.reports[`${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[0]}`];

        if (!target) {
            throw new Error('The heavy account fixture has no reports.');
        }

        return {target, state: {revision: 0, source: {}}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.state.source = {lastMessageText: `revision ${context.state.revision}`, errorFields: {avatar: null}};
    },
    run: async (context, params) => {
        const merged = utils.fastMerge(context.target, context.state.source, {shouldRemoveNestedNulls: true});

        return {fields: params.fields, mergedKeys: Object.keys(merged.result ?? {}).length};
    },
});

runScenarios([fastMergeReportActions, fastMergeReportPatch]);
