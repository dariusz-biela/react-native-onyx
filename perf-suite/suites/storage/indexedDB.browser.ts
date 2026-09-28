import ONYXKEYS from '@app/ONYXKEYS';
import type {ReportAction} from '@app/types';

import type {OnyxMergeCollectionInput, OnyxUpdate} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import type {HeavyAccount} from '../../fixtures/account';

import {readIDBCounters, resetIDBCounters, whenIDBIdle} from '../../browser/page/idbCounters';
import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildReconnectDelta} from '../../fixtures/updates';
import {QUICK_MEASURE} from '../../harness/measureOptions';
import defineScenario from '../../harness/scenario';

/**
 * What an Onyx write costs on web once it reaches storage, measured in headless Chromium on the browser's own
 * IndexedDB (see `browser/runner.ts`): the whole heavy account is seeded into a fresh, disk-backed profile, and
 * every row's timed region ends when Onyx's promise does, which for a storage write is the commit of its
 * IndexedDB transaction. The counters (`browser/page/idbCounters.ts`) are the point next to the timings:
 * `reads` on a merge the cache already resolved, and `writeTransactions` per `Onyx.update` batch.
 */
type ReportKey = `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;
type ReportActionsKey = `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}`;
type PlainKey = typeof ONYXKEYS.IS_LOADING_APP | typeof ONYXKEYS.HAS_LOADED_APP | typeof ONYXKEYS.LAST_VISITED_PATH;

type WriteContext<TPatch> = {
    state: {revision: number};
    patch: TPatch;
};

const NEW_ACTION_ID = 'perf-web-storage-action';

function reportKeys(account: HeavyAccount, count: number): ReportKey[] {
    return account.reportIDs.slice(0, count).map((reportID): ReportKey => `${ONYXKEYS.COLLECTION.REPORT}${reportID}`);
}

function reportActionsKeys(account: HeavyAccount): ReportActionsKey[] {
    return account.activeReportIDs.map((reportID): ReportActionsKey => `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`);
}

function firstActionOf(account: HeavyAccount, key: ReportActionsKey): ReportAction {
    const [action] = Object.values(account.reportActions[key] ?? {});

    if (!action) {
        throw new Error(`indexedDB.browser: ${key} has no report action to copy`);
    }

    return action;
}

async function seedAccount<TPatch>(patch: TPatch): Promise<WriteContext<TPatch>> {
    await seedOnyxWithAccount(getHeavyAccount());
    await whenIDBIdle();

    return {state: {revision: 0}, patch};
}

/** Lets the writes of the iteration that outlive Onyx's promise finish outside the next sample. */
const waitForStorage = () => whenIDBIdle();

const mergeReports = defineScenario({
    id: 'storage/web/mergeCollection-reports',
    title: 'Onyx.mergeCollection of one field into U existing report members, down to the IndexedDB commit in Chromium: the storage merge re-reads every member the cache already holds',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'a server response batch applied through Onyx.update, whose report entries go through mergeCollection'},
        {file: 'src/libs/actions/Report/index.ts', line: 982, note: 'the optimistic report head fields merged into existing report members'},
    ],
    scale: (profile) => ({members: profile.updateBatchKeys}),
    measure: QUICK_MEASURE,
    setup: () => seedAccount<OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT>>({}),
    beforeEach: async (context, params) => {
        context.state.revision++;

        const patch: OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT> = {};
        for (const key of reportKeys(getHeavyAccount(), params.members)) {
            patch[key] = {lastMessageText: `web storage ${context.state.revision}`};
        }

        context.patch = patch;
        resetIDBCounters();
    },
    run: async (context, params) => {
        await Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT, context.patch);

        return {members: params.members, ...readIDBCounters()};
    },
    afterEach: waitForStorage,
});

const mergeReportActions = defineScenario({
    id: 'storage/web/mergeCollection-report-actions',
    title: 'Onyx.mergeCollection of one new action into each active report-actions member, down to the IndexedDB commit in Chromium: the storage merge re-reads and re-clones every whole member',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'a response batch through Onyx.update, which regroups its report-actions member merges into one collection merge'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 126, note: 'push updates applied through Onyx.update, each new action a merge into its report-actions member'},
    ],
    scale: (profile) => ({members: profile.activeReports, actionsPerReport: profile.reportActionsPerActiveReport}),
    measure: QUICK_MEASURE,
    setup: () => seedAccount<OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS>>({}),
    beforeEach: async (context) => {
        const account = getHeavyAccount();
        context.state.revision++;

        const patch: OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS> = {};
        for (const key of reportActionsKeys(account)) {
            const action = firstActionOf(account, key);
            patch[key] = {[NEW_ACTION_ID]: {...action, reportActionID: NEW_ACTION_ID, created: `2026-09-28 12:00:${String(context.state.revision % 60).padStart(2, '0')}.000`}};
        }

        context.patch = patch;
        resetIDBCounters();
    },
    run: async (context, params) => {
        await Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT_ACTIONS, context.patch);

        return {members: params.members, ...readIDBCounters()};
    },
    afterEach: waitForStorage,
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

const updateBatch = defineScenario({
    id: 'storage/web/update-batch',
    title: 'one Onyx.update reconnect batch (a mergeCollection of U reports, action merges into 5 reports, 3 plain-key sets), down to the IndexedDB commits in Chromium: how many storage transactions one batch opens',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'the whole response batch applied in one Onyx.update'},
        {file: 'src/libs/actions/App.ts', line: 423, note: 'app loading flags written next to the collection data of the same response'},
    ],
    scale: (profile) => ({changedReports: profile.updateBatchKeys}),
    measure: QUICK_MEASURE,
    setup: () => seedAccount<BatchUpdate[]>([]),
    beforeEach: async (context, params) => {
        context.state.revision++;
        context.patch = [...buildReconnectDelta(getHeavyAccount(), params.changedReports, context.state.revision), ...buildPlainKeyUpdates(context.state.revision)];
        resetIDBCounters();
    },
    run: async (context, params) => {
        await Onyx.update(context.patch);

        return {updates: context.patch.length, changedReports: params.changedReports, ...readIDBCounters()};
    },
    afterEach: waitForStorage,
});

export default [mergeReports, mergeReportActions, updateBatch];
