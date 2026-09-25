import ONYXKEYS from '@app/ONYXKEYS';
import type {PersonalDetailsList} from '@app/types';

import Onyx from 'react-native-onyx';

import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The batch of a hundred personal details a ReconnectApp delivers, applied with the loaded app mounted:
 * the personal-details hooks are the largest hook population in `src/` (187 call sites), every one of
 * them wakes on any change to the single list key, and the real derived values recompute report
 * attributes from the same list. Expensify/App#101083 measured this case at 835 ms on web for a 20k
 * list; `flows/personal-details/one-user-changes` is the single-person variant.
 */
type PersonalDetailsBatchFlowContext = {
    app: LoadedApp;
    accountIDs: number[];
    nextPatch: PersonalDetailsList;
    state: {revision: number};
};

const BATCH_SIZE = 100;

const personalDetailsBatchUpdate = defineScenario({
    id: 'flows/personal-details/batch-update',
    title: 'a 100-entry personal details merge with the loaded app mounted and the real derived values live',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'ReconnectApp responses merge the list through Onyx.update'},
        {file: 'src/libs/actions/OnyxDerived/configs/reportAttributes.ts', line: 219, note: 'report attributes recompute from the personal details list'},
        {file: 'src/components/LHNOptionsList/OptionRowLHN/OptionRowLHNData.tsx', line: 125, note: 'one of the 187 hooks on the whole list'},
    ],
    scale: (profile) => ({
        personalDetails: profile.personalDetails,
        batch: Math.min(BATCH_SIZE, profile.personalDetails),
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {warmupIterations: 3, minIterations: 8, maxIterations: 20, timeBudgetMs: 6000},
    setup: async (params): Promise<PersonalDetailsBatchFlowContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            initDerived: true,
        });

        const accountIDs: number[] = [];
        const step = Math.max(1, Math.floor(params.personalDetails / params.batch));
        for (let index = 0; index < params.batch; index++) {
            accountIDs.push(index * step + 1);
        }

        return {app, accountIDs, nextPatch: {}, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.app.resetCounters();

        const patch: PersonalDetailsList = {};
        for (const accountID of context.accountIDs) {
            patch[accountID] = {accountID, displayName: `person ${accountID} r${context.state.revision}`};
        }
        context.nextPatch = patch;
    },
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.merge(ONYXKEYS.PERSONAL_DETAILS_LIST, context.nextPatch);
            await waitForOnyx();
        });

        return {...context.app.getCounters(), entries: params.personalDetails, entriesMerged: params.batch, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([personalDetailsBatchUpdate]);
