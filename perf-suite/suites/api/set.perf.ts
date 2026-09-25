import ONYXKEYS from '@app/ONYXKEYS';
import type {PersonalDetailsList} from '@app/types';

import type {Connection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type RevisionContext = {
    state: {revision: number};
};

type PersonalDetailsContext = RevisionContext & {
    /** Rebuilt every iteration so `Onyx.set` never sees the value it already holds. */
    nextValue: PersonalDetailsList;
};

type SubscribedContext = RevisionContext & {
    connections: Connection[];
    callbacks: {count: number};
};

const setSmallObject = defineScenario({
    id: 'api/set/single-small',
    title: 'Onyx.set of a two-field object on a plain key with no subscribers',
    realUsage: [
        {file: 'src/libs/actions/UserLocation.ts', line: 10, note: 'setUserLocation writes {longitude, latitude} with Onyx.set'},
        {file: 'src/libs/actions/App.ts', line: 941, note: 'Onyx.set of a plain flag key, one of the 260 Onyx.set sites'},
    ],
    scale: (profile) => ({storeKeys: storeKeyCount(profile)}),
    setup: async (): Promise<RevisionContext> => {
        // The write itself is O(1); the store behind it grows with the scale, which is what a regression to O(N) would show.
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
    },
    run: async (context) => {
        await Onyx.set(ONYXKEYS.USER_LOCATION, {longitude: context.state.revision, latitude: -context.state.revision});
    },
});

const setLargeObject = defineScenario({
    id: 'api/set/single-large',
    title: 'Onyx.set of the whole personal details list with N entries',
    realUsage: [
        {file: 'src/libs/actions/ImportOnyxState.ts', line: 22, note: 'importOnyxRegularState writes whole-key values such as the personal details list'},
        {file: 'src/libs/actions/PersonalDetails.ts', line: 83, note: 'PERSONAL_DETAILS_LIST written as one key from an API update'},
    ],
    scale: (profile) => ({personalDetails: profile.personalDetails}),
    // The value is a fresh N-entry object every iteration, so both the cache compare and the storage write are real work.
    measure: {timeBudgetMs: 4000, maxIterations: 30},
    setup: async (): Promise<PersonalDetailsContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}, nextValue: {...account.personalDetails}};
    },
    beforeEach: async (context) => {
        const account = getHeavyAccount();
        context.state.revision++;

        const next: PersonalDetailsList = {...account.personalDetails};
        const [firstAccountID] = Object.keys(next);
        const firstEntry = next[firstAccountID];

        if (firstEntry) {
            next[firstAccountID] = {...firstEntry, displayName: `revision ${context.state.revision}`};
        }

        context.nextValue = next;
    },
    run: async (context, params) => {
        await Onyx.set(ONYXKEYS.PERSONAL_DETAILS_LIST, context.nextValue);

        return {entriesWritten: params.personalDetails};
    },
});

const setNullRemoves = defineScenario({
    id: 'api/set/null-removes',
    title: 'Onyx.set(key, null) removing a draft key that currently holds a value',
    realUsage: [
        {file: 'src/libs/actions/OdometerTransactionUtils.ts', line: 104, note: 'clearOdometerDraft sets the draft key to null'},
        {file: 'src/libs/actions/Wallet.ts', line: 293, note: 'resetWalletAdditionalDetailsDraft sets a form draft to null'},
    ],
    scale: (profile) => ({storeKeys: storeKeyCount(profile)}),
    setup: async (): Promise<RevisionContext> => {
        // The write itself is O(1); the store behind it grows with the scale, which is what a regression to O(N) would show.
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        // Restoring the value is what makes the measured removal real work every iteration.
        await Onyx.set(ONYXKEYS.ODOMETER_DRAFT, {odometerStartReading: context.state.revision, odometerEndReading: context.state.revision + 100});
    },
    run: async () => {
        await Onyx.set(ONYXKEYS.ODOMETER_DRAFT, null);
    },
});

const setWithSubscribers = defineScenario({
    id: 'api/set/with-subscribers',
    title: 'Onyx.set on the session key while M module listeners watch it, including their synchronous callbacks',
    realUsage: [
        {file: 'src/libs/actions/Delegate.ts', line: 836, note: 'Onyx.set(ONYXKEYS.SESSION, ...) when connecting as a delegate'},
        {file: 'src/libs/SessionUtils.ts', line: 73, note: 'one of the module listeners on ONYXKEYS.SESSION'},
        {file: 'src/libs/ApiUtils.ts', line: 23, note: 'connectWithoutView for non-render logic, 207 sites in src/'},
    ],
    scale: (profile) => ({moduleListeners: profile.moduleListeners}),
    setup: async (params): Promise<SubscribedContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const callbacks = {count: 0};
        const connections: Connection[] = [];

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: ONYXKEYS.SESSION,
                    callback: () => {
                        callbacks.count++;
                    },
                }),
            );
        }

        return {state: {revision: 0}, connections, callbacks};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.callbacks.count = 0;
    },
    run: async (context) => {
        const account = getHeavyAccount();
        await Onyx.set(ONYXKEYS.SESSION, {...account.session, authToken: `perf-auth-token-${context.state.revision}`});

        return {listenerCallbacks: context.callbacks.count};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

runScenarios([setSmallObject, setLargeObject, setNullRemoves, setWithSubscribers]);
