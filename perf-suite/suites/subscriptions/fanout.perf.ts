import ONYXKEYS from '@app/ONYXKEYS';
import type {Report} from '@app/types';

import type {Connection} from 'react-native-onyx';
import type {Collection} from 'react-native-onyx/dist/types';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type FanoutState = {revision: number; callbacks: number};

type PlainKeyContext = {
    connections: Connection[];
    state: FanoutState;
};

type MemberContext = PlainKeyContext & {
    reportKey: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;
};

type UnrelatedContext = PlainKeyContext;

type MergeCollectionContext = PlainKeyContext & {
    nextReports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report>;
};

const fanoutPlainKey = defineScenario({
    id: 'subscriptions/fanout/plain-key',
    title: 'one Onyx.merge on the network key with M module listeners attached, timed until the last callback has run',
    realUsage: [
        {file: 'src/libs/actions/SignInRedirect.ts', line: 21, note: 'a module listener on ONYXKEYS.NETWORK'},
        {file: 'src/libs/SessionUtils.ts', line: 73, note: 'a module listener on ONYXKEYS.SESSION, the other heavily watched plain key'},
    ],
    scale: (profile) => ({moduleListeners: profile.moduleListeners}),
    setup: async (params): Promise<PlainKeyContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const state: FanoutState = {revision: 0, callbacks: 0};
        const connections: Connection[] = [];

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: ONYXKEYS.NETWORK,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }

        return {connections, state};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.state.callbacks = 0;
    },
    run: async (context) => {
        await Onyx.merge(ONYXKEYS.NETWORK, {timeSkew: context.state.revision, shouldForceOffline: context.state.revision % 2 === 0});

        return {listenerCallbacks: context.state.callbacks};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

const fanoutCollectionMember = defineScenario({
    id: 'subscriptions/fanout/collection-member',
    title: 'one report member merge with M collection-root listeners and M member-key listeners attached, timed until the last callback has run',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 521, note: 'Onyx.connect on the whole report collection'},
        {file: 'src/libs/actions/OnyxDerived/index.ts', line: 266, note: 'every derived value with a collection dependency connects to the collection root'},
        {file: 'src/libs/actions/TransactionEdit.ts', line: 41, note: 'the member-key listener shape'},
    ],
    // The collection-root listeners receive the whole N-report collection, rebuilt after the write.
    scale: (profile) => ({moduleListeners: profile.moduleListeners, reports: profile.reports}),
    setup: async (params): Promise<MemberContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const state: FanoutState = {revision: 0, callbacks: 0};
        const connections: Connection[] = [];
        const reportKey: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}` = `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[0]}`;

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: ONYXKEYS.COLLECTION.REPORT,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
            connections.push(
                Onyx.connectWithoutView({
                    key: reportKey,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }

        return {connections, state, reportKey};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.state.callbacks = 0;
    },
    run: async (context) => {
        await Onyx.merge(context.reportKey, {lastMessageText: `revision ${context.state.revision}`});

        return {listenerCallbacks: context.state.callbacks};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

const fanoutUnrelatedKey = defineScenario({
    id: 'subscriptions/fanout/unrelated-key',
    title: 'one Onyx.merge on a key nobody watches while M listeners watch other keys, the cost of the keyChanged lookup alone',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 3326, note: 'a draft comment merge, a write that most of a booted app does not listen to'},
        {file: 'src/libs/ApiUtils.ts', line: 23, note: 'one of the many module listeners a booted app keeps on other keys'},
    ],
    scale: (profile) => ({moduleListeners: profile.moduleListeners}),
    setup: async (params): Promise<UnrelatedContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const state: FanoutState = {revision: 0, callbacks: 0};
        const connections: Connection[] = [];
        const watchedKeys = [ONYXKEYS.SESSION, ONYXKEYS.NETWORK, ONYXKEYS.ACCOUNT, ONYXKEYS.COLLECTION.REPORT, ONYXKEYS.PERSONAL_DETAILS_LIST];

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: watchedKeys[index % watchedKeys.length],
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }

        return {connections, state};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.state.callbacks = 0;
    },
    run: async (context) => {
        await Onyx.merge(ONYXKEYS.ODOMETER_DRAFT, {odometerStartReading: context.state.revision});

        return {listenerCallbacks: context.state.callbacks};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

const fanoutMergeCollection = defineScenario({
    id: 'subscriptions/fanout/mergeCollection',
    title: 'mergeCollection of U reports with M collection-root listeners, U the update batch of the scale, checking each listener is called once rather than once per member',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'the server batch that lands as one mergeCollection per collection'},
        {file: 'src/libs/actions/OnyxDerived/index.ts', line: 266, note: 'the derived values watching the collection root while that batch lands'},
    ],
    scale: (profile) => ({moduleListeners: profile.moduleListeners, members: profile.updateBatchKeys}),
    measure: {timeBudgetMs: 4000, maxIterations: 30},
    setup: async (params): Promise<MergeCollectionContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const state: FanoutState = {revision: 0, callbacks: 0};
        const connections: Connection[] = [];

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: ONYXKEYS.COLLECTION.REPORT,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }

        return {connections, state, nextReports: {}};
    },
    beforeEach: async (context, params) => {
        const account = getHeavyAccount();
        context.state.revision++;
        context.state.callbacks = 0;

        const reports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report> = {};
        for (const reportID of account.reportIDs.slice(0, params.members)) {
            reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`] = {...account.reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`], lastMessageText: `revision ${context.state.revision}`};
        }

        context.nextReports = reports;
    },
    run: async (context, params) => {
        await Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT, context.nextReports);

        return {listenerCallbacks: context.state.callbacks, membersWritten: params.members};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

runScenarios([fanoutPlainKey, fanoutCollectionMember, fanoutUnrelatedKey, fanoutMergeCollection]);
