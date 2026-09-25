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
 * One report moving to the top of the LHN. The heaviest tree in the suite by design: K rows each on their
 * own `${COLLECTION.REPORT}${id}` member key, plus the whole-collection subscribers the sidebar itself has,
 * plus the real derived values, which recompute report attributes from the report collection on every
 * change. One member merge therefore has to reach exactly one row and one collection subscriber per read.
 */
type LhnContext = {
    app: LoadedApp;
    reportKey: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;
    state: {revision: number};
};

const lhnReportUpdate = defineScenario({
    id: 'flows/lhn/report-update',
    title: 'one report lastVisibleActionCreated merge with K LHN rows on member keys, the sidebar collection subscribers and the real derived values live',
    realUsage: [
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'the sidebar reads the whole report collection'},
        {file: 'src/components/LHNOptionsList/OptionRowLHN/OptionRowLHNData.tsx', line: 125, note: 'an LHN row reading one report member key'},
        {file: 'src/libs/actions/Report/index.ts', line: 982, note: 'the optimistic report head fields, lastVisibleActionCreated included, merged into one report member'},
    ],
    scale: (profile) => ({
        lhnRows: Math.min(profile.hookComponents, profile.reports),
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {warmupIterations: 3, minIterations: 8, maxIterations: 20, timeBudgetMs: 6000},
    setup: async (params): Promise<LhnContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            lhnRows: params.lhnRows,
            reportIDs: account.reportIDs,
            initDerived: true,
        });

        return {app, reportKey: `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[0]}`, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.app.resetCounters();
    },
    run: async (context) => {
        const created = `2026-09-14 14:${String(context.state.revision % 60).padStart(2, '0')}:00.000`;

        await actAsync(async () => {
            await Onyx.merge(context.reportKey, {
                lastVisibleActionCreated: created,
                lastMessageText: `lhn ${context.state.revision}`,
                lastActorAccountID: (context.state.revision % 20) + 1,
            });
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, lhnRows: context.app.mounted.lhnRows, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([lhnReportUpdate]);
