import Onyx from 'react-native-onyx';

import type {CommentUpdate} from '../../fixtures/updates';
import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildSendCommentOptimistic, buildSendCommentSuccess} from '../../fixtures/updates';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * Sending a comment on the open report: the optimistic batch lands first, the success batch clears the
 * pending flags once the request resolves. Both halves are inside the timed region because the user sees
 * one interaction, and the report screen's own hooks are mounted so the re-renders they cause are counted.
 *
 * The derived-value engine (`app/derived`) is on here: the report and its report actions are dependencies of several
 * derived values, so the recompute they trigger is part of what sending a comment really costs.
 */
type CommentContext = {
    app: LoadedApp;
    reportID: string;
    optimistic: CommentUpdate[];
    success: CommentUpdate[];
    state: {revision: number};
};

const sendComment = defineScenario({
    id: 'flows/comment/send',
    title: 'the optimistic and success Onyx.update pair of one sent comment, with the report screen hooks and the real derived values live',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1054, note: 'addActions builds the optimistic report head and report action batch'},
        {file: 'src/libs/actions/Report/index.ts', line: 1088, note: 'the successData batch that clears pendingAction and isOptimisticAction'},
        {file: 'src/libs/Network/SequentialQueue.ts', line: 508, note: 'Onyx.update of successData once the request resolves'},
    ],
    scale: (profile) => ({
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
        reportActionsPerActiveReport: profile.reportActionsPerActiveReport,
    }),
    // The derived recompute walks the whole report collection on every merge, so the loop stays short.
    measure: {warmupIterations: 3, minIterations: 8, maxIterations: 20, timeBudgetMs: 6000},
    setup: async (params): Promise<CommentContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportID = account.activeReportIDs[0];
        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            currentReportID: reportID,
            initDerived: true,
        });

        return {app, reportID, optimistic: [], success: [], state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        const reportActionID = `optimistic-${context.state.revision}`;
        context.optimistic = buildSendCommentOptimistic(context.reportID, reportActionID, `comment ${context.state.revision}`);
        context.success = buildSendCommentSuccess(context.reportID, reportActionID);
        context.app.resetCounters();
    },
    run: async (context) => {
        // Two `act` calls, because the two halves are two moments: the optimistic batch renders while the
        // request is in flight, the success batch renders when it comes back.
        await actAsync(async () => {
            await Onyx.update(context.optimistic);
        });

        await actAsync(async () => {
            await Onyx.update(context.success);
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, updatesApplied: context.optimistic.length + context.success.length, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([sendComment]);
