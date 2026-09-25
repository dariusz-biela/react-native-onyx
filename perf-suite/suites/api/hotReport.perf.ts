import ONYXKEYS from '@app/ONYXKEYS';
import type {ReportAction, ReportActions} from '@app/types';

import Onyx from 'react-native-onyx';
import createRandomReportAction from '@app/collections/reportActions';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {withDeterministicRandom} from '../../fixtures/random';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The hot report: the one actions member that is an order of magnitude larger than the rest (Concierge,
 * #announce, a busy expense chat). `api/merge/report-actions-batch` merges into a typical active report;
 * these two rows merge into the largest member key an account carries, because `fastMerge` and the cache
 * comparison both walk the whole member, so the cost of one new message scales with the history behind it.
 */
type HotReportContext = {
    reportActionsKey: `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}`;
    pageActions: ReportAction[];
    nextChange: ReportActions;
    state: {revision: number};
};

const PAGE_SIZE = 50;

function buildContext(): HotReportContext {
    const account = getHeavyAccount();
    const pageActions = withDeterministicRandom(() => {
        const actions: ReportAction[] = [];
        for (let index = 0; index < PAGE_SIZE; index++) {
            actions.push({...createRandomReportAction(index + 1), reportActionID: `hot-page-${index}`});
        }
        return actions;
    });

    return {reportActionsKey: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${account.hotReportID}`, pageActions, nextChange: {}, state: {revision: 0}};
}

const mergeHotSingleAction = defineScenario({
    id: 'api/merge/hot-report-single-action',
    title: 'Onyx.merge of one new action into the hot report actions member that already holds H actions',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 2469, note: 'a report action merged into the report actions member key'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'a Pusher update for a busy chat lands on the same member through Onyx.update'},
    ],
    scale: (profile) => ({hotReportActions: profile.hotReportActions}),
    setup: async (): Promise<HotReportContext> => {
        await seedOnyxWithAccount(getHeavyAccount());
        return buildContext();
    },
    beforeEach: async (context) => {
        context.state.revision++;

        const action = context.pageActions[0];
        const reportActionID = `hot-single-${context.state.revision}`;
        context.nextChange = {
            [reportActionID]: {...action, reportActionID, message: [{type: 'COMMENT', html: `revision ${context.state.revision}`, text: `revision ${context.state.revision}`}]},
        };
    },
    run: async (context, params) => {
        await Onyx.merge(context.reportActionsKey, context.nextChange);

        return {existingActions: params.hotReportActions, actionsMerged: 1};
    },
});

const mergeHotPage = defineScenario({
    id: 'api/merge/hot-report-page',
    title: 'Onyx.merge of a 50-action page into the hot report actions member that already holds H actions',
    realUsage: [
        {file: 'src/libs/Middleware/Pagination.ts', line: 173, note: 'the pagination middleware appends its page to the response onyxData applied through Onyx.update'},
        {file: 'src/libs/actions/Report/index.ts', line: 2469, note: 'a report action merged into the report actions member key'},
    ],
    scale: (profile) => ({hotReportActions: profile.hotReportActions, pageActions: PAGE_SIZE}),
    setup: async (): Promise<HotReportContext> => {
        await seedOnyxWithAccount(getHeavyAccount());
        return buildContext();
    },
    beforeEach: async (context) => {
        context.state.revision++;

        const page: ReportActions = {};
        for (const action of context.pageActions) {
            page[action.reportActionID] = {...action, lastModified: `2026-09-17 12:00:00.${String(context.state.revision).padStart(3, '0')}`};
        }
        context.nextChange = page;
    },
    run: async (context, params) => {
        await Onyx.merge(context.reportActionsKey, context.nextChange);

        return {existingActions: params.hotReportActions, actionsMerged: params.pageActions};
    },
});

runScenarios([mergeHotSingleAction, mergeHotPage]);
