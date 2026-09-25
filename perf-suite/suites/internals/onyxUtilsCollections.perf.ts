import CONST from '@app/CONST';
import ONYXKEYS from '@app/ONYXKEYS';
import type {Report, SearchResults} from '@app/types';

import type {OnyxEntry, OnyxUpdate} from 'react-native-onyx';

import Onyx from 'react-native-onyx';
import OnyxUtils from 'react-native-onyx/dist/OnyxUtils';

import type {HeavyAccount} from '../../fixtures/account';
import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {waitForOnyx} from '../../harness/onyx';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The collection-shaped reads of `OnyxUtils`: what a collection subscriber pays on every change
 * (`getCachedCollection`, `reduceCollectionWithSelector`), what every `getSnapshot` pays
 * (`tryGetCachedValue`) and what keeping the search snapshots in sync costs (`updateSnapshots`).
 */
type SnapshotKey = `${typeof ONYXKEYS.COLLECTION.SNAPSHOT}${string}`;

type CollectionContext = {
    state: {revision: number};
};

type SnapshotsContext = {
    snapshotKeys: SnapshotKey[];
    updates: Array<OnyxUpdate<typeof ONYXKEYS.COLLECTION.REPORT>>;
    state: {revision: number};
};

const SNAPSHOT_COUNT = 5;
const CACHED_READS = 10000;

type ReportRow = {reportID: string | undefined; lastMessageText: string | undefined};

/** Only the fields an LHN row reads, the shape a real collection selector returns. */
function reportRowSelector(report: OnyxEntry<Report>): ReportRow {
    return {reportID: report?.reportID, lastMessageText: report?.lastMessageText};
}

function buildSnapshotValue(account: HeavyAccount, hash: number, revision: number, rows: number): SearchResults {
    const data: SearchResults['data'] = {};

    for (let index = 0; index < rows; index++) {
        const reportID = account.reportIDs[index % account.reportIDs.length];
        const report = account.reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`];

        if (!report) {
            continue;
        }

        data[`${ONYXKEYS.COLLECTION.REPORT}snapshot-${index}`] = {...report, lastMessageText: `revision ${revision}`};
    }

    return {
        search: {
            offset: 0,
            type: CONST.SEARCH.DATA_TYPES.EXPENSE,
            hash,
            hasMoreResults: false,
            hasResults: true,
            isLoading: false,
            sortBy: CONST.SEARCH.TABLE_COLUMNS.DATE,
            sortOrder: CONST.SEARCH.SORT_ORDER.DESC,
        },
        data,
    };
}

const cachedCollection = defineScenario({
    id: 'internals/OnyxUtils/getCachedCollection',
    title: 'getCachedCollection for the report collection with N members, the read behind every collection callback',
    realUsage: [
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'a whole-collection report subscriber, served by getCachedCollection'},
        {file: 'src/libs/actions/OnyxDerived/index.ts', line: 266, note: 'the derived report attributes that depend on the whole report collection'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    setup: async (): Promise<CollectionContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        // The collection has to be dirty again, otherwise every iteration after the first is served the
        // frozen snapshot and measures nothing.
        await Onyx.merge(`${ONYXKEYS.COLLECTION.REPORT}1`, {lastMessageText: `revision ${context.state.revision}`});
        await waitForOnyx();
    },
    run: async (context, params) => {
        const collection = OnyxUtils.getCachedCollection(ONYXKEYS.COLLECTION.REPORT);

        return {reports: params.reports, members: Object.keys(collection).length};
    },
});

const reduceWithSelector = defineScenario({
    id: 'internals/OnyxUtils/reduceCollectionWithSelector',
    title: 'reduceCollectionWithSelector over the N-member report collection with an LHN-row selector',
    realUsage: [
        {file: 'src/components/Navigation/QuickCreationActionsBar/index.tsx', line: 70, note: 'a selector applied to the whole policy collection through useOnyx'},
        {file: 'src/components/Tables/WorkspaceRoomsTable/index.tsx', line: 44, note: 'another collection read that narrows to one member through a selector'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    setup: async (): Promise<CollectionContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        await Onyx.merge(`${ONYXKEYS.COLLECTION.REPORT}1`, {lastMessageText: `revision ${context.state.revision}`});
        await waitForOnyx();
    },
    run: async (context, params) => {
        const collection = OnyxUtils.getCachedCollection(ONYXKEYS.COLLECTION.REPORT);
        const reduced = OnyxUtils.reduceCollectionWithSelector<typeof ONYXKEYS.COLLECTION.REPORT, ReportRow>(collection, reportRowSelector);

        return {reports: params.reports, selected: Object.keys(reduced).length};
    },
});

const snapshotUpdates = defineScenario({
    id: 'internals/OnyxUtils/updateSnapshots',
    title: 'updateSnapshots with five search snapshots of R rows each and a batch of U report updates, R a fifth of the reports and U the update batch of the scale',
    realUsage: [
        {file: 'src/libs/actions/Search.ts', line: 562, note: 'the snapshot the search response writes, which every later report write has to keep in sync'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'the update batches whose keys updateSnapshots mirrors into every live snapshot'},
    ],
    // Every update is looked up in every snapshot and merged into the rows it matches.
    scale: (profile) => ({snapshots: SNAPSHOT_COUNT, rows: Math.max(10, Math.round(profile.reports / 5)), updates: profile.updateBatchKeys}),
    setup: async (params): Promise<SnapshotsContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const snapshotKeys: SnapshotKey[] = [];
        for (let index = 0; index < SNAPSHOT_COUNT; index++) {
            const snapshotKey: SnapshotKey = `${ONYXKEYS.COLLECTION.SNAPSHOT}${1000 + index}`;
            snapshotKeys.push(snapshotKey);
            // eslint-disable-next-line no-await-in-loop
            await Onyx.set(snapshotKey, buildSnapshotValue(account, 1000 + index, 0, params.rows));
        }

        await waitForOnyx();

        return {snapshotKeys, updates: [], state: {revision: 0}};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;

        const updates: Array<OnyxUpdate<typeof ONYXKEYS.COLLECTION.REPORT>> = [];
        for (let index = 0; index < params.updates; index++) {
            updates.push({
                onyxMethod: Onyx.METHOD.MERGE,
                key: `${ONYXKEYS.COLLECTION.REPORT}snapshot-${index % params.rows}`,
                value: {lastMessageText: `revision ${context.state.revision}`},
            });
        }

        context.updates = updates;
    },
    run: async (context, params) => {
        const tasks = OnyxUtils.updateSnapshots(context.updates, Onyx.merge);
        await Promise.all(tasks.map((task) => task()));

        return {snapshots: params.snapshots, rows: params.rows, updates: params.updates, tasks: tasks.length};
    },
});

const cachedValueReads = defineScenario({
    id: 'internals/OnyxUtils/tryGetCachedValue',
    title: 'ten thousand tryGetCachedValue reads, half on a plain key and half on the report collection key',
    realUsage: [
        {file: 'src/hooks/useOnyx.ts', line: 75, note: 'every getSnapshot of every one of the 5150 useOnyx call sites reads through this'},
        {file: 'src/DeepLinkHandler.tsx', line: 40, note: 'a plain-key hook read, the cheap half of this scenario'},
    ],
    // A clean read is O(1); the collection snapshot it returns holds the reports of the scale.
    scale: (profile) => ({reads: CACHED_READS, reports: profile.reports}),
    // ONYX-PR#834 dropped tryGetCachedValue.
    requires: () => typeof OnyxUtils.tryGetCachedValue === 'function',
    setup: async (): Promise<CollectionContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
    },
    run: async (context, params) => {
        let hits = 0;

        for (let index = 0; index < CACHED_READS / 2; index++) {
            if (OnyxUtils.tryGetCachedValue(ONYXKEYS.SESSION)) {
                hits++;
            }

            if (OnyxUtils.tryGetCachedValue(ONYXKEYS.COLLECTION.REPORT)) {
                hits++;
            }
        }

        return {reads: params.reads, hits};
    },
});

runScenarios([cachedCollection, reduceWithSelector, snapshotUpdates, cachedValueReads]);
