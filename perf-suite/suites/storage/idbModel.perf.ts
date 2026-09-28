import ONYXKEYS from '@app/ONYXKEYS';
import type {ReportAction} from '@app/types';

import type {OnyxMergeCollectionInput, OnyxUpdate} from 'react-native-onyx';
import type {StorageKeyValuePair} from 'react-native-onyx/dist/storage/providers/types';

import Onyx from 'react-native-onyx';

import type {HeavyAccount} from '../../fixtures/account';
import type {IDBModel} from '../../harness/idbModel';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildReconnectDelta} from '../../fixtures/updates';
import installIDBModel from '../../harness/idbModel';
import {QUICK_MEASURE} from '../../harness/measure';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * What an Onyx write asks of the web storage provider once it leaves the cache: `IDBKeyValProvider` runs on
 * the in-memory IndexedDB model of `harness/idbModel.ts`, so every structured clone and every transaction the
 * provider opens is counted. Onyx is seeded through the in-memory mock first; the model then holds only the
 * members a row writes. The counters are the point of these rows: `reads` on a merge the cache already
 * resolved, and `writeTransactions` per `Onyx.update` batch.
 */
type ReportKey = `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;
type ReportActionsKey = `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}`;
type PlainKey = typeof ONYXKEYS.IS_LOADING_APP | typeof ONYXKEYS.HAS_LOADED_APP | typeof ONYXKEYS.LAST_VISITED_PATH;

type ModelContext<TPatch> = {
    model: IDBModel;
    state: {revision: number};
    patch: TPatch;
};

const NEW_ACTION_ID = 'perf-idb-model-action';

function reportKeys(account: HeavyAccount, count: number): ReportKey[] {
    return account.reportIDs.slice(0, count).map((reportID): ReportKey => `${ONYXKEYS.COLLECTION.REPORT}${reportID}`);
}

function reportActionsKeys(account: HeavyAccount): ReportActionsKey[] {
    return account.activeReportIDs.map((reportID): ReportActionsKey => `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`);
}

function pairsOf<TKey extends ReportKey | ReportActionsKey>(keys: readonly TKey[], values: Partial<Record<TKey, unknown>>): StorageKeyValuePair[] {
    return keys.map((key): StorageKeyValuePair => [key, values[key]]);
}

/** Seeds Onyx through the in-memory mock, then moves the storage layer onto the model holding only `pairs`. */
async function setupModel(pairs: readonly StorageKeyValuePair[]): Promise<IDBModel> {
    await seedOnyxWithAccount(getHeavyAccount());

    const model = installIDBModel();
    model.seed(pairs);

    return model;
}

function firstActionOf(account: HeavyAccount, key: ReportActionsKey): ReportAction {
    const [action] = Object.values(account.reportActions[key] ?? {});

    if (!action) {
        throw new Error(`idbModel.perf: ${key} has no report action to copy`);
    }

    return action;
}

const REPORTS_REAL_USAGE = [
    {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'a server response batch applied through Onyx.update, whose report entries go through mergeCollection'},
    {file: 'src/libs/actions/Report/index.ts', line: 982, note: 'the optimistic report head fields merged into existing report members'},
];

const mergeReportsIntoModel = defineScenario({
    id: 'storage/idb-model/mergeCollection-reports',
    title: 'Onyx.mergeCollection of one field into U existing report members, with web IndexedDB modelled underneath: the storage merge re-reads every member the cache already holds',
    realUsage: REPORTS_REAL_USAGE,
    scale: (profile) => ({members: profile.updateBatchKeys}),
    measure: QUICK_MEASURE,
    setup: async (params): Promise<ModelContext<OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT>>> => {
        const account = getHeavyAccount();
        const model = await setupModel(pairsOf(reportKeys(account, params.members), account.reports));

        return {model, state: {revision: 0}, patch: {}};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;

        const patch: OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT> = {};
        for (const key of reportKeys(getHeavyAccount(), params.members)) {
            patch[key] = {lastMessageText: `idb model ${context.state.revision}`};
        }

        context.patch = patch;
        context.model.resetCounters();
    },
    run: async (context, params) => {
        await Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT, context.patch);

        return {members: params.members, ...context.model.counters};
    },
    teardown: async (context) => {
        context.model.uninstall();
    },
});

const mergeReportActionsIntoModel = defineScenario({
    id: 'storage/idb-model/mergeCollection-report-actions',
    title: 'Onyx.mergeCollection of one new action into each active report-actions member, with web IndexedDB modelled underneath: the storage merge re-reads and re-clones every whole member',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'a response batch through Onyx.update, which regroups its report-actions member merges into one collection merge'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 126, note: 'push updates applied through Onyx.update, each new action a merge into its report-actions member'},
    ],
    scale: (profile) => ({members: profile.activeReports, actionsPerReport: profile.reportActionsPerActiveReport}),
    measure: QUICK_MEASURE,
    setup: async (): Promise<ModelContext<OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS>>> => {
        const account = getHeavyAccount();
        const model = await setupModel(pairsOf(reportActionsKeys(account), account.reportActions));

        return {model, state: {revision: 0}, patch: {}};
    },
    beforeEach: async (context) => {
        const account = getHeavyAccount();
        context.state.revision++;

        const patch: OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS> = {};
        for (const key of reportActionsKeys(account)) {
            const action = firstActionOf(account, key);
            patch[key] = {[NEW_ACTION_ID]: {...action, reportActionID: NEW_ACTION_ID, created: `2026-09-28 12:00:${String(context.state.revision % 60).padStart(2, '0')}.000`}};
        }

        context.patch = patch;
        context.model.resetCounters();
    },
    run: async (context, params) => {
        await Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT_ACTIONS, context.patch);

        return {members: params.members, ...context.model.counters};
    },
    teardown: async (context) => {
        context.model.uninstall();
    },
});

type BatchUpdate = OnyxUpdate<ReportKey | ReportActionsKey | PlainKey>;

/** The plain keys a response batch usually carries next to its collection data. */
function buildPlainKeyUpdates(revision: number): BatchUpdate[] {
    const isEven = revision % 2 === 0;

    return [
        {onyxMethod: Onyx.METHOD.SET, key: ONYXKEYS.IS_LOADING_APP, value: isEven},
        {onyxMethod: Onyx.METHOD.SET, key: ONYXKEYS.HAS_LOADED_APP, value: !isEven},
        {onyxMethod: Onyx.METHOD.SET, key: ONYXKEYS.LAST_VISITED_PATH, value: `/r/${revision}`},
    ];
}

const updateBatchIntoModel = defineScenario({
    id: 'storage/idb-model/update-batch',
    title: 'one Onyx.update reconnect batch (a mergeCollection of U reports, action merges into 5 reports, 3 plain-key sets), with web IndexedDB modelled underneath: how many storage transactions one batch opens',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'the whole response batch applied in one Onyx.update'},
        {file: 'src/libs/actions/App.ts', line: 423, note: 'app loading flags written next to the collection data of the same response'},
    ],
    scale: (profile) => ({changedReports: profile.updateBatchKeys}),
    measure: QUICK_MEASURE,
    setup: async (params): Promise<ModelContext<BatchUpdate[]>> => {
        const account = getHeavyAccount();
        const pairs = [...pairsOf(reportKeys(account, params.changedReports), account.reports), ...pairsOf(reportActionsKeys(account), account.reportActions)];
        const model = await setupModel(pairs);

        return {model, state: {revision: 0}, patch: []};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;
        context.patch = [...buildReconnectDelta(getHeavyAccount(), params.changedReports, context.state.revision), ...buildPlainKeyUpdates(context.state.revision)];
        context.model.resetCounters();
    },
    run: async (context, params) => {
        await Onyx.update(context.patch);

        return {updates: context.patch.length, changedReports: params.changedReports, ...context.model.counters};
    },
    teardown: async (context) => {
        context.model.uninstall();
    },
});

runScenarios([mergeReportsIntoModel, mergeReportActionsIntoModel, updateBatchIntoModel]);
