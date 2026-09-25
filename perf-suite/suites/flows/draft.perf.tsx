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
 * Typing a message into the composer. `saveReportDraftComment` merges a plain string onto the report's
 * draft key on every keystroke, so this is the highest-frequency write in the app and the only one where
 * the merged value is a scalar rather than an object. The keystrokes are awaited one after another, which
 * is what a real composer produces: each keystroke is its own tick.
 */
type DraftContext = {
    app: LoadedApp;
    draftKey: `${typeof ONYXKEYS.COLLECTION.REPORT_DRAFT_COMMENT}${string}`;
    state: {revision: number};
};

const KEYSTROKES = 30;

const draftKeystrokes = defineScenario({
    id: 'flows/draft/keystrokes',
    title: 'thirty draft-comment merges for the open report, one per keystroke, with the report screen hooks mounted',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 3326, note: 'saveReportDraftComment merges the draft on every keystroke'},
        {file: 'src/pages/inbox/report/ReportActionCompose/ComposerProvider.tsx', line: 50, note: 'the composer hook reading that draft key back'},
        {file: 'src/components/LHNOptionsList/OptionRowLHN/OptionRowLHNData.tsx', line: 127, note: 'the LHN row that shows the same draft'},
    ],
    scale: (profile) => ({
        keystrokes: KEYSTROKES,
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30},
    setup: async (params): Promise<DraftContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportID = account.activeReportIDs[0];
        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            currentReportID: reportID,
        });

        return {app, draftKey: `${ONYXKEYS.COLLECTION.REPORT_DRAFT_COMMENT}${reportID}`, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.app.resetCounters();
    },
    run: async (context, params) => {
        let draft = `draft ${context.state.revision}`;

        for (let index = 0; index < params.keystrokes; index++) {
            draft += String.fromCharCode(97 + (index % 26));

            // One `act` per keystroke, not one around the loop: a single `act` would batch all thirty
            // writes into one React commit, while a real composer commits once per keystroke.
            // eslint-disable-next-line no-await-in-loop
            await actAsync(async () => {
                await Onyx.merge(context.draftKey, draft);
            });
        }

        await actAsync(async () => {
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, keystrokes: params.keystrokes, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([draftKeystrokes]);
