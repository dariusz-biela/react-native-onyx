import Onyx from 'react-native-onyx';

import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import KEYS_TO_PRESERVE_ON_SIGN_OUT from '../../fixtures/signOutKeys';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * Signing out of a fully loaded app: one `Onyx.clear` with the preserve list, seen by every module listener
 * and every mounted hook at once. `api/clear/sign-out` measures the same call with module listeners only;
 * this row adds the React side, so the difference between the two is what the components cost.
 *
 * Reseeding the account in `beforeEach` costs about a hundred times more than the measured call, so this is
 * the most expensive iteration in the suite. The derived values are left out: they would recompute over an
 * emptied store on every iteration and the measurement would stop being about `Onyx.clear`.
 */
type SignOutContext = {
    app: LoadedApp;
};

const signOutClear = defineScenario({
    id: 'flows/sign-out/clear',
    title: 'Onyx.clear with the sign-out preserve list on a fully loaded account, with the loaded-app listeners and hooks mounted',
    realUsage: [
        {file: 'src/libs/actions/SignInRedirect.ts', line: 104, note: 'clearStorageAndRedirect clears everything but the preserve list'},
        {file: 'src/libs/actions/SignInRedirect.ts', line: 53, note: 'the KEYS_TO_PRESERVE_ON_SIGN_OUT list fixtures/signOutKeys.ts copies'},
    ],
    scale: (profile) => ({
        reports: profile.reports,
        personalDetails: profile.personalDetails,
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    // Ten samples were not enough for a stable median: the A/A run put this row at -10.8% against itself.
    // An iteration costs about 350 ms of untimed reseed and collection for 4 ms of measured call.
    measure: {warmupIterations: 4, minIterations: 20, maxIterations: 24, timeBudgetMs: 20000},
    setup: async (params): Promise<SignOutContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            currentReportID: account.activeReportIDs[0],
        });

        return {app};
    },
    beforeEach: async (context) => {
        await seedOnyxWithAccount(getHeavyAccount());
        await waitForOnyx();
        context.app.resetCounters();
    },
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.clear(KEYS_TO_PRESERVE_ON_SIGN_OUT);
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, keysPreserved: KEYS_TO_PRESERVE_ON_SIGN_OUT.length, moduleListeners: context.app.mounted.moduleListeners, hookComponents: params.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([signOutClear]);
