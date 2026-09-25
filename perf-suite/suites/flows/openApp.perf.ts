import Onyx from 'react-native-onyx';

import type {AccountUpdate, AccountUpdateKey} from '../../fixtures/updates';
import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount} from '../../fixtures/account';
import {buildOpenAppBatch} from '../../fixtures/updates';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type OpenAppContext = {
    batch: AccountUpdate[];
    app: LoadedApp;
};

/**
 * The single biggest Onyx write of a cold boot: the OpenApp response applied into an empty store, with the
 * module listeners and the hook population of a booted app already attached. The store is cleared in
 * `beforeEach`, so the re-render the clear itself causes stays outside the timed region.
 *
 * The derived-value engine (`app/derived`) is deliberately left out here: every derived value that depends on the report
 * collection would recompute over the whole batch and dominate a measurement that is about the write.
 */
const applyOpenAppBatch = defineScenario({
    id: 'flows/openapp/apply-response',
    title: 'Onyx.update of an OpenApp-shaped batch into a cleared store with the loaded-app subscribers attached, timed until they have all settled',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 67, note: 'updateHandler(response.onyxData) applies the server batch through Onyx.update'},
        {file: 'src/libs/Middleware/SaveResponseInOnyx.ts', line: 29, note: 'response.onyxData is what that batch is built from'},
        {file: 'src/libs/actions/App.ts', line: 309, note: 'getOnyxDataForOpenOrReconnect, the OpenApp request whose response this batch is'},
    ],
    scale: (profile) => ({
        reports: profile.reports,
        activeReports: profile.activeReports,
        personalDetails: profile.personalDetails,
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    // The A/A run showed this scenario sitting in one of two execution regimes for a whole Jest process
    // (around 8.5 ms or around 10.5 ms) with identical counters, so a round needs enough samples for the
    // median not to be decided by a handful of iterations. See HANDOFF.md, phase 4b.
    measure: {timeBudgetMs: 12000, minIterations: 24, maxIterations: 30},
    setup: async (params): Promise<OpenAppContext> => {
        const account = getHeavyAccount();
        const app = await mountLoadedApp({moduleListeners: params.moduleListeners, hookComponents: params.hookComponents});

        return {batch: buildOpenAppBatch(account), app};
    },
    beforeEach: async (context) => {
        await Onyx.clear();
        await waitForOnyx();
        context.app.resetCounters();
    },
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.update<AccountUpdateKey>(context.batch);
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, reportsWritten: params.reports, moduleListeners: context.app.mounted.moduleListeners, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([applyOpenAppBatch]);
