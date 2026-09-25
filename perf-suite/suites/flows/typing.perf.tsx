import ONYXKEYS from '@app/ONYXKEYS';

import Onyx from 'react-native-onyx';

import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * Somebody typing in the open report. Ten merges land on one RAM-only member key while the open report's
 * four hooks are mounted, one per Pusher event and one React commit each. The coalesced shape, where a
 * whole burst arrives in a single tick and the merge queue folds it into one write, is already covered by
 * `hooks/update/burst`.
 */
type TypingContext = {
    app: LoadedApp;
    typingKey: `${typeof ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${string}`;
    state: {revision: number};
};

const TYPING_MERGES = 10;

const typingIndicator = defineScenario({
    id: 'flows/typing/indicator',
    title: 'ten typing-status merges for the open report, one React commit each, with the report screen hooks mounted',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 654, note: 'the Pusher typing event merged into the report typing key'},
        {file: 'src/libs/actions/Report/index.ts', line: 632, note: 'the same key reset when the report is subscribed to'},
        {file: 'src/pages/inbox/report/ReportTypingIndicator.tsx', line: 23, note: 'the hook the open report has on that key'},
    ],
    scale: (profile) => ({
        merges: TYPING_MERGES,
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {timeBudgetMs: 12000, minIterations: 24, maxIterations: 30},
    setup: async (params): Promise<TypingContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportID = account.activeReportIDs[0];
        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            currentReportID: reportID,
        });

        return {app, typingKey: `${ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${reportID}`, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.app.resetCounters();
    },
    run: async (context, params) => {
        for (let index = 0; index < params.merges; index++) {
            // One `act` per event: each typing event is its own Pusher message and its own commit. The
            // coalesced variant, where a whole burst lands in one tick, is `hooks/update/burst`.
            // eslint-disable-next-line no-await-in-loop
            await actAsync(async () => {
                await Onyx.merge(context.typingKey, {[`user${index}`]: (context.state.revision + index) % 2 === 0});
            });
        }

        await actAsync(async () => {
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, merges: params.merges, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([typingIndicator]);
