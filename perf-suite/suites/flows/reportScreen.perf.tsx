import Onyx from 'react-native-onyx';

import type {ReportActionsPageKey, ReportActionsPageUpdate} from '../../fixtures/updates';
import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildReportActionsPage} from '../../fixtures/updates';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * Navigating to another report. Two things happen at once and both are timed: the open report's four hooks
 * swap their member keys (the report, its actions, its draft and its typing key), and the OpenReport
 * response merges a page of actions into the report that was just opened.
 *
 * The scenario rotates over `ROTATED_REPORTS` reports instead of restoring one report in `beforeEach`, so
 * every iteration is a genuine key switch onto a different report without any untimed teardown.
 */
type ReportScreenContext = {
    app: LoadedApp;
    reportIDs: string[];
    page: ReportActionsPageUpdate[];
    state: {revision: number};
};

const PAGE_ACTIONS = 50;
const ROTATED_REPORTS = 10;

const openReportScreen = defineScenario({
    id: 'flows/report-screen/open',
    title: 'switching the open report hooks to another report and merging that report 50-action page, timed until the screen has settled',
    realUsage: [
        {file: 'src/pages/inbox/ReportScreen.tsx', line: 95, note: 'the report screen reads the report member key of the route it is showing'},
        {file: 'src/libs/actions/Report/index.ts', line: 1658, note: 'openReport, the request whose response carries the first page of actions'},
        {file: 'src/libs/Middleware/Pagination.ts', line: 151, note: 'the page id list the pagination middleware sets next to that page of actions'},
    ],
    scale: (profile) => ({
        pageActions: PAGE_ACTIONS,
        rotatedReports: Math.min(ROTATED_REPORTS, profile.activeReports),
        // The opened report's actions member and the derived values recomputed over the store grow with these.
        existingActions: profile.reportActionsPerActiveReport,
        reports: profile.reports,
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {warmupIterations: 3, minIterations: 8, maxIterations: 20, timeBudgetMs: 6000},
    setup: async (params): Promise<ReportScreenContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportIDs = account.activeReportIDs.slice(0, params.rotatedReports);
        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            currentReportID: reportIDs[0],
            initDerived: true,
        });

        return {app, reportIDs, page: [], state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.app.resetCounters();
    },
    run: async (context, params) => {
        const reportID = context.reportIDs[context.state.revision % context.reportIDs.length];

        // The key switch is its own React commit, the way a navigation is, and `switchCurrentReport`
        // already wraps it in `act`, so it must stay outside the `actAsync` below.
        await context.app.switchCurrentReport(reportID);

        await actAsync(async () => {
            await Onyx.update<ReportActionsPageKey>(buildReportActionsPage(reportID, params.pageActions, context.state.revision));
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, actionsWritten: params.pageActions, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([openReportScreen]);
