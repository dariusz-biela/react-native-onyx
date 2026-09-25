import ONYXKEYS from '@app/ONYXKEYS';

import type {Connection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import KEYS_TO_PRESERVE_ON_SIGN_OUT from '../../fixtures/signOutKeys';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type ClearContext = {
    connections: Connection[];
    state: {callbacks: number};
};

// Both scenarios reseed the account before every iteration, which costs more than the measured call, so the
// loop is bounded by a short time budget instead of an iteration cap. A cap of 10 left the small scale, where
// ten iterations take 40 ms, with 2 or 3 samples per block and a 16% A/A delta; the budget gives it about 200
// samples and changes nothing at heavy, where one iteration takes 100 ms.
const CLEAR_MEASURE = {warmupIterations: 2, minIterations: 5, timeBudgetMs: 1000};

const clearOnSignOut = defineScenario({
    id: 'api/clear/sign-out',
    title: 'Onyx.clear with the sign-out preserve list, a fully loaded account and M module listeners attached',
    realUsage: [
        {file: 'src/libs/actions/SignInRedirect.ts', line: 104, note: 'clearStorageAndRedirect clears everything but the preserve list'},
        {file: 'src/libs/actions/SignInRedirect.ts', line: 53, note: 'the KEYS_TO_PRESERVE_ON_SIGN_OUT list this scenario copies'},
    ],
    scale: (profile) => ({reports: profile.reports, personalDetails: profile.personalDetails, moduleListeners: profile.moduleListeners}),
    measure: CLEAR_MEASURE,
    setup: async (params): Promise<ClearContext> => {
        const state = {callbacks: 0};
        const connections: Connection[] = [];

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: index % 2 === 0 ? ONYXKEYS.COLLECTION.REPORT : ONYXKEYS.SESSION,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }

        return {connections, state};
    },
    beforeEach: async (context) => {
        await seedOnyxWithAccount(getHeavyAccount());
        context.state.callbacks = 0;
    },
    run: async (context) => {
        await Onyx.clear(KEYS_TO_PRESERVE_ON_SIGN_OUT);

        return {listenerCallbacks: context.state.callbacks};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

const clearPreserveNone = defineScenario({
    id: 'api/clear/preserve-none',
    title: 'Onyx.clear with no preserve list and no subscribers, the state import path',
    realUsage: [
        {file: 'src/libs/actions/ImportOnyxState.ts', line: 10, note: 'clearOnyxStateBeforeImport wipes the store before importing a state file'},
        {file: 'src/libs/actions/clearOnyxAndSeedFullReconnect.ts', line: 32, note: 'the reconnect path that clears the store around a reseed'},
    ],
    scale: (profile) => ({reports: profile.reports, personalDetails: profile.personalDetails}),
    measure: CLEAR_MEASURE,
    setup: async (): Promise<ClearContext> => ({connections: [], state: {callbacks: 0}}),
    beforeEach: async () => {
        await seedOnyxWithAccount(getHeavyAccount());
    },
    run: async () => {
        await Onyx.clear();
    },
});

runScenarios([clearOnSignOut, clearPreserveNone]);
