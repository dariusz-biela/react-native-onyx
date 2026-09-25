import ONYXKEYS from '@app/ONYXKEYS';
import type {Report, Transaction} from '@app/types';

import type {Connection, OnyxUpdate} from 'react-native-onyx';
import type {Collection} from 'react-native-onyx/dist/types';

import Onyx from 'react-native-onyx';

import type {AccountUpdate, AccountUpdateKey, CommentUpdate} from '../../fixtures/updates';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import {buildOpenAppBatch, buildSendCommentOptimistic, buildSendCommentSuccess} from '../../fixtures/updates';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/** The three keys a Pusher report update touches, and the key union of a mixed-method batch. */
type PusherKey = typeof ONYXKEYS.COLLECTION.REPORT | typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS | typeof ONYXKEYS.COLLECTION.REPORT_METADATA;
type MixedKey = PusherKey | typeof ONYXKEYS.COLLECTION.TRANSACTION_DRAFT | typeof ONYXKEYS.PERSONAL_DETAILS_LIST;

type OpenAppContext = {
    state: {revision: number};
    batch: AccountUpdate[];
};

type PusherContext = {
    state: {revision: number};
    reportID: string;
    batch: Array<OnyxUpdate<PusherKey>>;
};

type CommentContext = {
    state: {revision: number};
    reportID: string;

    /** The action the iteration adds, removed again after it so the member keeps the size of the scale. */
    reportActionID: string;
    optimistic: CommentUpdate[];
    success: CommentUpdate[];
};

type MixedContext = {
    state: {revision: number};
    batch: Array<OnyxUpdate<MixedKey>>;
};

function buildPusherBatch(reportID: string, revision: number): Array<OnyxUpdate<PusherKey>> {
    return [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT}${reportID}`,
            value: {lastMessageText: `pusher ${revision}`, lastActorAccountID: (revision % 20) + 1},
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`,
            value: {
                [`pusher-action-${revision % 5}`]: {
                    reportActionID: `pusher-action-${revision % 5}`,
                    actionName: 'ADDCOMMENT',
                    created: `2026-09-14 12:00:${String(revision % 60).padStart(2, '0')}.000`,
                },
            },
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT_METADATA}${reportID}`,
            value: {isOptimisticReport: revision % 2 === 0},
        },
    ];
}

const updateOpenAppBatch = defineScenario({
    id: 'api/update/openapp-batch',
    title: 'Onyx.update of an OpenApp-shaped batch (reports, report actions, personal details) applied onto an already populated store',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'updateHandler(response.onyxData) applies the server batch through Onyx.update'},
        {file: 'src/libs/Middleware/SaveResponseInOnyx.ts', line: 29, note: 'response.onyxData is what that batch is built from'},
    ],
    scale: (profile) => ({reports: profile.reports, activeReports: profile.activeReports, personalDetails: profile.personalDetails}),
    measure: {timeBudgetMs: 5000, maxIterations: 25},
    setup: async (): Promise<OpenAppContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}, batch: buildOpenAppBatch(account)};
    },
    beforeEach: async (context) => {
        const account = getHeavyAccount();
        context.state.revision++;

        const reports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report> = {};
        for (const reportID of account.reportIDs) {
            reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`] = {...account.reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`], lastMessageText: `revision ${context.state.revision}`};
        }

        const [, ...rest] = buildOpenAppBatch(account);
        context.batch = [{onyxMethod: Onyx.METHOD.MERGE_COLLECTION, key: ONYXKEYS.COLLECTION.REPORT, value: reports}, ...rest];
    },
    run: async (context, params) => {
        await Onyx.update<AccountUpdateKey>(context.batch);

        return {reportsMerged: params.reports, personalDetailsMerged: params.personalDetails};
    },
});

const updatePusherSmall = defineScenario({
    id: 'api/update/pusher-small',
    title: 'Onyx.update of three small merges (report, report actions, report metadata) for one report',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 128, note: 'each Pusher event applied with its own Onyx.update(update.data)'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 108, note: 'applyPusherOnyxUpdates, the caller that sequences those updates'},
    ],
    // The report actions merge compares the whole member, so the member size is the dimension.
    scale: (profile) => ({updates: 3, existingActions: profile.reportActionsPerActiveReport}),
    setup: async (): Promise<PusherContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportID = account.activeReportIDs[0];
        return {state: {revision: 0}, reportID, batch: buildPusherBatch(reportID, 0)};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.batch = buildPusherBatch(context.reportID, context.state.revision);
    },
    run: async (context, params) => {
        await Onyx.update<PusherKey>(context.batch);

        return {updatesApplied: params.updates};
    },
});

const updateOptimisticSuccessPair = defineScenario({
    id: 'api/update/optimistic-success-pair',
    title: 'the two Onyx.update calls of a sent comment, the optimistic batch followed by the success batch',
    realUsage: [
        {file: 'src/libs/Network/SequentialQueue.ts', line: 508, note: 'Onyx.update of successData once the request resolves'},
        {file: 'src/libs/actions/Report/index.ts', line: 2469, note: 'a report action merged into the report actions member key, the optimistic half'},
    ],
    scale: (profile) => ({updates: 3, existingActions: profile.reportActionsPerActiveReport}),
    setup: async (): Promise<CommentContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportID = account.activeReportIDs[0];
        return {state: {revision: 0}, reportID, reportActionID: '', optimistic: [], success: []};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        const reportActionID = `optimistic-${context.state.revision}`;
        context.reportActionID = reportActionID;
        context.optimistic = buildSendCommentOptimistic(context.reportID, reportActionID, `comment ${context.state.revision}`);
        context.success = buildSendCommentSuccess(context.reportID, reportActionID);
    },
    run: async (context, params) => {
        await Onyx.update(context.optimistic);
        await Onyx.update(context.success);

        return {updatesApplied: params.updates};
    },
    afterEach: async (context) => {
        // Without this every iteration left one more action behind, and the member grew by 200 actions over a run.
        await Onyx.merge(`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${context.reportID}`, {[context.reportActionID]: null});
    },
});

const updateFailureRollback = defineScenario({
    id: 'api/update/failure-rollback',
    title: 'Onyx.update of the failure batch that rolls back an optimistically added comment',
    realUsage: [
        {file: 'src/libs/Network/SequentialQueue.ts', line: 522, note: 'Onyx.update(requestToProcess.failureData) when a request fails for good'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 92, note: 'updateHandler(request.failureData) on a failed API response'},
    ],
    scale: (profile) => ({updates: 2, existingActions: profile.reportActionsPerActiveReport}),
    setup: async (): Promise<CommentContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportID = account.activeReportIDs[0];
        return {state: {revision: 0}, reportID, reportActionID: '', optimistic: [], success: []};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        const reportActionID = `optimistic-${context.state.revision}`;

        // The optimistic write is the pre-condition, not the measurement, so it stays untimed.
        await Onyx.update(buildSendCommentOptimistic(context.reportID, reportActionID, `comment ${context.state.revision}`));

        context.optimistic = [];
        context.success = [
            {
                onyxMethod: Onyx.METHOD.MERGE,
                key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${context.reportID}`,
                value: {[reportActionID]: null},
            },
            {
                onyxMethod: Onyx.METHOD.MERGE,
                key: `${ONYXKEYS.COLLECTION.REPORT}${context.reportID}`,
                value: {lastMessageText: `rolled back ${context.state.revision}`},
            },
        ];
    },
    run: async (context, params) => {
        await Onyx.update(context.success);

        return {updatesApplied: params.updates};
    },
});

const updateMixedMethods = defineScenario({
    id: 'api/update/mixed-methods',
    title: 'Onyx.update of one batch mixing set, merge, mergeCollection and setCollection entries',
    realUsage: [
        {file: 'src/libs/actions/Search.ts', line: 1470, note: 'an optimistic batch that mixes a mergeCollection entry with plain merge entries'},
        {file: 'src/libs/actions/Card.ts', line: 1679, note: 'a direct Onyx.update batch call site'},
        {file: 'src/types/onyx/Request.ts', line: 26, note: 'the update methods a request batch is allowed to carry, setCollection included'},
    ],
    // Every collection entry of the batch has updateBatchKeys members; the personal details merge and the setCollection key scan grow with the store.
    scale: (profile) => ({collectionMembers: profile.updateBatchKeys, personalDetails: profile.personalDetails, storeKeys: storeKeyCount(profile)}),
    measure: {timeBudgetMs: 4000, maxIterations: 30},
    setup: async (): Promise<MixedContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}, batch: []};
    },
    beforeEach: async (context, params) => {
        const account = getHeavyAccount();
        context.state.revision++;
        const revision = context.state.revision;

        const mergedReports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report> = {};
        for (const reportID of account.reportIDs.slice(0, params.collectionMembers)) {
            mergedReports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`] = {...account.reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`], lastMessageText: `mixed ${revision}`};
        }

        const replacedDrafts: Collection<typeof ONYXKEYS.COLLECTION.TRANSACTION_DRAFT, {merchant: string}> = {};
        for (let index = 0; index < params.collectionMembers; index++) {
            replacedDrafts[`${ONYXKEYS.COLLECTION.TRANSACTION_DRAFT}${index + 1}`] = {merchant: `mixed ${revision}`};
        }

        context.batch = [
            {onyxMethod: Onyx.METHOD.SET, key: `${ONYXKEYS.COLLECTION.REPORT_METADATA}${account.reportIDs[0]}`, value: {isOptimisticReport: revision % 2 === 0}},
            {onyxMethod: Onyx.METHOD.MERGE, key: ONYXKEYS.PERSONAL_DETAILS_LIST, value: {'1': {displayName: `mixed ${revision}`}}},
            {onyxMethod: Onyx.METHOD.MERGE_COLLECTION, key: ONYXKEYS.COLLECTION.REPORT, value: mergedReports},
            {onyxMethod: Onyx.METHOD.SET_COLLECTION, key: ONYXKEYS.COLLECTION.TRANSACTION_DRAFT, value: replacedDrafts},
        ];
    },
    run: async (context, params) => {
        await Onyx.update<MixedKey>(context.batch);

        return {collectionMembers: params.collectionMembers};
    },
});

type TransactionKey = `${typeof ONYXKEYS.COLLECTION.TRANSACTION}${string}`;

type MemberSetContext = {
    state: {revision: number; callbacks: number};
    connections: Connection[];
    transactions: Transaction[];
    setBatch: Array<OnyxUpdate<TransactionKey>>;
    removeBatch: Array<OnyxUpdate<TransactionKey>>;
};

/**
 * `Onyx.update` groups two or more `set` entries on members of one collection, and `null` merges on them,
 * into one `OnyxUtils.partialSetCollection` call: cache set and drop, one collection notification and one
 * storage write per batch. It is the path of a bulk import and of its rollback, and no other row reaches it.
 */
const updateMemberSetAndRemove = defineScenario({
    id: 'api/update/member-set-and-remove',
    title: 'two Onyx.update calls on U transaction members, one setting them and one setting them to null, both grouped into partialSetCollection, with M collection listeners',
    realUsage: [
        {file: 'src/libs/actions/ImportTransactions.ts', line: 364, note: 'the optimistic Onyx.METHOD.SET of every imported transaction'},
        {file: 'src/libs/actions/ImportTransactions.ts', line: 369, note: 'the failure data setting every one of them back to null'},
    ],
    scale: (profile) => ({members: profile.updateBatchKeys, transactions: profile.transactions, moduleListeners: profile.moduleListeners}),
    measure: {timeBudgetMs: 4000, maxIterations: 30},
    setup: async (params): Promise<MemberSetContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const state = {revision: 0, callbacks: 0};
        const connections: Connection[] = [];

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: ONYXKEYS.COLLECTION.TRANSACTION,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }

        const transactions = Object.values(account.transactions)
            .slice(0, params.members)
            .filter((transaction): transaction is Transaction => !!transaction);

        return {state, connections, transactions, setBatch: [], removeBatch: []};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.state.callbacks = 0;
        const revision = context.state.revision;

        context.setBatch = context.transactions.map((transaction, index) => ({
            onyxMethod: Onyx.METHOD.SET,
            key: `${ONYXKEYS.COLLECTION.TRANSACTION}import-${index}`,
            value: {...transaction, transactionID: `import-${index}`, merchant: `import ${revision}`},
        }));
        context.removeBatch = context.transactions.map((transaction, index) => ({
            onyxMethod: Onyx.METHOD.SET,
            key: `${ONYXKEYS.COLLECTION.TRANSACTION}import-${index}`,
            value: null,
        }));
    },
    run: async (context, params) => {
        await Onyx.update(context.setBatch);
        await Onyx.update(context.removeBatch);

        return {members: params.members, listenerCallbacks: context.state.callbacks};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

runScenarios([updateOpenAppBatch, updatePusherSmall, updateOptimisticSuccessPair, updateFailureRollback, updateMixedMethods, updateMemberSetAndRemove]);
