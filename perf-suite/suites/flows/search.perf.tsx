import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxKey} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import type {SearchSnapshotKey, SearchSnapshotUpdate} from '../../fixtures/updates';
import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildSearchSnapshot, buildSearchSnapshotUpdate} from '../../fixtures/updates';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * A search screen taking an action on its results. The batch merges the snapshot's own `search` state and
 * a handful of report members, and `OnyxUtils.updateSnapshots` mirrors those report merges back into every
 * cached snapshot. `pendingAction` and `pendingFields` are absent from the snapshot's rows, so they only
 * travel because the app registers them as `snapshotMergeKeys`; without that list this scenario would
 * measure a snapshot pass that copies nothing.
 *
 * The consumers are hooks on the snapshot member key itself, which is how `SearchResultsProvider` reads a
 * search result, rather than the snapshot branch of the app's `useOnyx` wrapper (that path already has its
 * own scenario, `hooks/snapshot/search-path`).
 */
type SearchContext = {
    app: LoadedApp;
    reportIDs: string[];
    batch: SearchSnapshotUpdate[];
    state: {revision: number};
};

const SEARCH_HASH = 987654321;
/** A search snapshot of the scale holds a fifth of the account's reports, never fewer than this. */
const MIN_SNAPSHOT_ROWS = 50;
const CHANGED_ROWS = 10;

const snapshotMerge = defineScenario({
    id: 'flows/search/snapshot-merge',
    title: 'a search action batch (snapshot state merge plus report merges carrying pendingAction and pendingFields) with K snapshot consumers mounted',
    realUsage: [
        {file: 'src/libs/actions/Search.ts', line: 562, note: 'the search action success data merging into the snapshot data of the open search'},
        {file: 'src/libs/actions/Search.ts', line: 797, note: 'the optimistic merge of the search request state into the same snapshot key'},
        {file: 'src/components/Search/SearchResultsProvider.tsx', line: 46, note: 'the hook every search screen has on `${ONYXKEYS.COLLECTION.SNAPSHOT}${currentSearchHash}`'},
    ],
    scale: (profile) => ({
        snapshotRows: Math.min(profile.reports, Math.max(MIN_SNAPSHOT_ROWS, Math.round(profile.reports / 5))),
        changedRows: CHANGED_ROWS,
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {timeBudgetMs: 5000, minIterations: 10, maxIterations: 25},
    setup: async (params): Promise<SearchContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const snapshotKey: OnyxKey = `${ONYXKEYS.COLLECTION.SNAPSHOT}${SEARCH_HASH}`;
        await Onyx.set(`${ONYXKEYS.COLLECTION.SNAPSHOT}${SEARCH_HASH}`, buildSearchSnapshot(account, SEARCH_HASH, params.snapshotRows));
        await waitForOnyx();

        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            extraKeys: new Array<OnyxKey>(params.hookComponents).fill(snapshotKey),
        });

        return {app, reportIDs: account.reportIDs.slice(0, params.snapshotRows), batch: [], state: {revision: 0}};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;
        context.batch = buildSearchSnapshotUpdate(SEARCH_HASH, context.reportIDs, params.changedRows, context.state.revision);
        context.app.resetCounters();
    },
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.update<SearchSnapshotKey>(context.batch);
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, rowsChanged: params.changedRows, snapshotConsumers: context.app.mounted.extraKeys, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([snapshotMerge]);
