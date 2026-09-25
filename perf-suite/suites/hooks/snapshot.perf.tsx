import {SearchQueryContext, SearchResultsContext, SearchScopeProvider} from '@app/search';

import useOnyx from '@app/useOnyx';

import CONST from '@app/CONST';
import ONYXKEYS from '@app/ONYXKEYS';
import type {SearchResults} from '@app/types';

import Onyx from 'react-native-onyx';

import type {ReactElement, ReactNode} from 'react';

import {createElement, useContext} from 'react';

import type {HeavyAccount} from '../../fixtures/account';
import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {waitForOnyx} from '../../harness/onyx';
import type {ProbeProps} from '../../harness/probes';
import {buildProbeGrid} from '../../harness/probes';
import type {RenderedTree} from '../../harness/react';
import {actAsync, unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import render from '../../harness/renderer';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The snapshot branch of the app's `useOnyx` wrapper (`src/hooks/useOnyx.ts:76-104`): on a search
 * screen, a read of a snapshot-compatible key is rewritten into a read of
 * `snapshot_<currentSearchHash>` and the key's slice is pulled back out of the snapshot's `data`.
 *
 * The real `SearchQueryContext` and `SearchResultsContext` are used, but their providers live in
 * `SearchContextProvider.tsx`, which drags the whole search page (and its own `useOnyx` consumers)
 * into the tree. `SearchProviders` below therefore re-provides the contexts' own default values with
 * only the two fields the wrapper reads overridden, which is enough to take the snapshot path without
 * mounting any of the search UI.
 */
const SEARCH_HASH = 987654321;

type SnapshotKey = `${typeof ONYXKEYS.COLLECTION.SNAPSHOT}${string}`;

type ReportKey = `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;

/** The one member the measured merge touches, annotated so the merge patch keeps a literal key. */
const MERGED_REPORT_KEY: `${typeof ONYXKEYS.COLLECTION.REPORT}1` = `${ONYXKEYS.COLLECTION.REPORT}1`;

type SnapshotContext = {
    tree: RenderedTree;
    snapshotKey: SnapshotKey;
    state: {revision: number};
};

function SearchProviders({children}: {children: ReactNode}): ReactElement {
    const queryContext = useContext(SearchQueryContext);
    const resultsContext = useContext(SearchResultsContext);

    return createElement(
        SearchScopeProvider,
        null,
        createElement(
            SearchQueryContext.Provider,
            {value: {...queryContext, currentSearchHash: SEARCH_HASH}},
            createElement(SearchResultsContext.Provider, {value: {...resultsContext, shouldUseLiveData: false}}, children),
        ),
    );
}

/** Reads a report member key, which on a search screen is served out of the snapshot instead. */
function SnapshotReportProbe({index}: ProbeProps) {
    countRender();
    useOnyx(`${ONYXKEYS.COLLECTION.REPORT}${index + 1}`);
    return null;
}

/** A search snapshot holding the report collection, the shape `Search.ts` writes after a search request. */
function buildSnapshot(account: HeavyAccount, revision: number): SearchResults {
    const data: SearchResults['data'] = {};

    for (const reportID of account.reportIDs) {
        const reportKey: ReportKey = `${ONYXKEYS.COLLECTION.REPORT}${reportID}`;
        const report = account.reports[reportKey];

        if (!report) {
            continue;
        }

        data[reportKey] = {...report, lastMessageText: `snapshot ${revision}`};
    }

    return {
        search: {
            offset: 0,
            type: CONST.SEARCH.DATA_TYPES.EXPENSE,
            hash: SEARCH_HASH,
            hasMoreResults: false,
            hasResults: true,
            isLoading: false,
            sortBy: CONST.SEARCH.TABLE_COLUMNS.DATE,
            sortOrder: CONST.SEARCH.SORT_ORDER.DESC,
        },
        data,
    };
}

async function renderInSearchScope(count: number): Promise<RenderedTree> {
    const tree = render(createElement(SearchProviders, null, buildProbeGrid(count, SnapshotReportProbe, ONYXKEYS.COLLECTION.REPORT, 0)));
    await actAsync(() => {});

    return tree;
}

const snapshotSearchPath = defineScenario({
    id: 'hooks/snapshot/search-path',
    title: 'one snapshot merge seen by K hooks that read report member keys through the search snapshot branch of the app wrapper',
    realUsage: [
        {file: 'src/hooks/useOnyx.ts', line: 76, note: 'the snapshot branch: a snapshot-compatible key is rewritten into a read of the search snapshot'},
        {file: 'src/libs/actions/Search.ts', line: 562, note: 'the search response merged into `${ONYXKEYS.COLLECTION.SNAPSHOT}${hash}`'},
    ],
    scale: (profile) => ({hookComponents: Math.min(profile.hookComponents, profile.reports), reports: profile.reports}),
    measure: {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30},
    setup: async (params): Promise<SnapshotContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const snapshotKey: SnapshotKey = `${ONYXKEYS.COLLECTION.SNAPSHOT}${SEARCH_HASH}`;
        await Onyx.set(snapshotKey, buildSnapshot(account, 0));
        await waitForOnyx();

        return {tree: await renderInSearchScope(params.hookComponents), snapshotKey, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        resetRenderCount();
    },
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.merge(context.snapshotKey, {data: {[MERGED_REPORT_KEY]: {lastMessageText: `snapshot ${context.state.revision}`}}});
            await waitForOnyx();
        });

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    teardown: async (context) => {
        await unmountTree(context.tree);
    },
});

runScenarios([snapshotSearchPath]);
