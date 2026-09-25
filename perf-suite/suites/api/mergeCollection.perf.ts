import ONYXKEYS from '@app/ONYXKEYS';
import type {Report, Transaction} from '@app/types';

import type {Connection} from 'react-native-onyx';
import type {Collection} from 'react-native-onyx/dist/types';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type TransactionDraftsContext = {
    state: {revision: number};
    nextDrafts: Collection<typeof ONYXKEYS.COLLECTION.TRANSACTION_DRAFT, Transaction>;
};

type ReportsContext = {
    state: {revision: number; callbacks: number};
    connections: Connection[];
    nextReports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report>;
};

const mergeTransactionDrafts = defineScenario({
    id: 'api/mergeCollection/transactions',
    title: 'Onyx.mergeCollection of K transaction drafts with no subscribers',
    realUsage: [
        {file: 'src/libs/actions/IOU/MoneyRequest.ts', line: 670, note: 'the whole set of edited transaction drafts written in one mergeCollection'},
        {file: 'src/libs/actions/Search.ts', line: 1470, note: 'a mergeCollection entry inside an optimistic Onyx.update batch'},
    ],
    scale: (profile) => ({transactions: profile.transactions}),
    measure: {timeBudgetMs: 4000, maxIterations: 30},
    setup: async (): Promise<TransactionDraftsContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}, nextDrafts: {}};
    },
    beforeEach: async (context, params) => {
        const account = getHeavyAccount();
        context.state.revision++;

        const drafts: Collection<typeof ONYXKEYS.COLLECTION.TRANSACTION_DRAFT, Transaction> = {};
        for (let index = 0; index < params.transactions; index++) {
            const transactionID = String(index + 1);
            const transaction = account.transactions[`${ONYXKEYS.COLLECTION.TRANSACTION}${transactionID}`];
            drafts[`${ONYXKEYS.COLLECTION.TRANSACTION_DRAFT}${transactionID}`] = {...transaction, merchant: `revision ${context.state.revision}`};
        }

        context.nextDrafts = drafts;
    },
    run: async (context, params) => {
        await Onyx.mergeCollection(ONYXKEYS.COLLECTION.TRANSACTION_DRAFT, context.nextDrafts);

        return {membersWritten: params.transactions};
    },
});

const mergeReportsFull = defineScenario({
    id: 'api/mergeCollection/reports-full',
    title: 'Onyx.mergeCollection of the whole N-report collection while M module listeners watch it, the OpenApp-sized write',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'the OpenApp response batch is applied through Onyx.update, which routes collection entries into mergeCollection'},
        {file: 'src/libs/actions/Report/index.ts', line: 521, note: 'Onyx.connect on the whole report collection, one of the listeners this write has to notify'},
    ],
    scale: (profile) => ({reports: profile.reports, moduleListeners: profile.moduleListeners}),
    measure: {timeBudgetMs: 5000, maxIterations: 25},
    setup: async (params): Promise<ReportsContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const state = {revision: 0, callbacks: 0};
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

        return {state, connections, nextReports: {}};
    },
    beforeEach: async (context) => {
        const account = getHeavyAccount();
        context.state.revision++;
        context.state.callbacks = 0;

        const reports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report> = {};
        for (const reportID of account.reportIDs) {
            reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`] = {...account.reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`], lastMessageText: `revision ${context.state.revision}`};
        }

        context.nextReports = reports;
    },
    run: async (context, params) => {
        await Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT, context.nextReports);

        return {membersWritten: params.reports, listenerCallbacks: context.state.callbacks};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

runScenarios([mergeTransactionDrafts, mergeReportsFull]);
