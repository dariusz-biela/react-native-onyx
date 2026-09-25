import Onyx from 'react-native-onyx';

import type {LoadedApp} from '../../harness/loadedApp';

import {CURRENT_USER_ACCOUNT_ID, getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildPersonalDetailsPatch} from '../../fixtures/updates';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * One user renaming themselves. `PERSONAL_DETAILS_LIST` is a single plain key holding every account, and it
 * is the key with the most `useOnyx` call sites in the app (187), so a one-field change on one entry wakes
 * the largest share of the loaded-app hook population. The derived values are live because the personal
 * details list is a dependency of report attributes.
 */
type PersonalDetailsContext = {
    app: LoadedApp;
    state: {revision: number};
};

const oneUserChanges = defineScenario({
    id: 'flows/personal-details/one-user-changes',
    title: 'one display-name merge into the personal details list of N users, with the loaded-app hook population and the real derived values live',
    realUsage: [
        {file: 'src/libs/actions/PersonalDetails.ts', line: 144, note: 'updateDisplayName optimistic data merging one entry into the list'},
        {file: 'src/libs/actions/PersonalDetails.ts', line: 127, note: 'setDisplayName, the same patch written directly'},
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 44, note: 'one of the 187 hooks reading the whole personal details list'},
    ],
    scale: (profile) => ({
        personalDetails: profile.personalDetails,
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {warmupIterations: 3, minIterations: 8, maxIterations: 20, timeBudgetMs: 6000},
    setup: async (params): Promise<PersonalDetailsContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            initDerived: true,
        });

        return {app, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.app.resetCounters();
    },
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.update(buildPersonalDetailsPatch(CURRENT_USER_ACCOUNT_ID, context.state.revision));
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, personalDetails: params.personalDetails, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([oneUserChanges]);
