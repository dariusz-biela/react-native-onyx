import type {Report, Session} from '@app/types';
import {sessionEmailAndAccountIDSelector} from '@app/selectors';

import type {OnyxCollection, OnyxEntry} from 'react-native-onyx';

import {getHeavyAccount} from '../../fixtures/account';
import requireOnyxModule from '../../harness/optionalOnyxModule';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

// Removed by ONYX-PR#834, so the file is skipped on arms built from it (see runScenarios below).
const createMemoizedSelector = requireOnyxModule<typeof import('react-native-onyx/dist/createMemoizedSelector')>('createMemoizedSelector').default;

/**
 * `createMemoizedSelector` wraps every selector a hook passes. It has three paths, and one iteration
 * here walks all of them: the same input reference (short-circuit), a new input whose output differs
 * (full recompute) and a new input whose output is deep-equal to the last one (recompute plus the
 * deep comparison that keeps the previous reference, which is what stops a re-render).
 */
type ReportSummary = {reportID: string | undefined; lastMessageText: string | undefined};

type MemoizedSelectorContext = {
    memoized: (session: OnyxEntry<Session>) => {email: string | undefined; accountID: number | undefined};
    sameInput: Session;
    changedOutput: Session;
    equalOutput: Session;

    /** A collection selector: its equal-output path deep-compares an output with one entry per report. */
    memoizedCollection: (reports: OnyxCollection<Report>) => ReportSummary[];
    reports: OnyxCollection<Report>;
    equalReports: OnyxCollection<Report>;
    state: {revision: number};
};

const CALLS_PER_PATH = 2000;
const COLLECTION_CALLS_PER_PATH = 20;

/** The shape of the LHN-style selectors that project one small record per report out of the collection. */
function selectReportSummaries(reports: OnyxCollection<Report>): ReportSummary[] {
    return Object.values(reports ?? {}).map((report) => ({reportID: report?.reportID, lastMessageText: report?.lastMessageText}));
}

const selectorHitAndMiss = defineScenario({
    id: 'internals/createMemoizedSelector/hit-miss',
    title: 'two thousand calls each of the same-reference, changed-output and equal-output paths of a session selector, plus the equal-output path of a selector projecting the N-report collection',
    realUsage: [
        {file: 'src/selectors/Session.ts', line: 12, note: 'sessionEmailAndAccountIDSelector, the selector this scenario wraps'},
        {file: 'src/pages/inbox/sidebar/FABPopoverContent/menuItems/CreateReportMenuItem.tsx', line: 44, note: 'one of the 943 useOnyx call sites that pass a selector'},
    ],
    // The session paths are O(1); the collection path deep-compares one entry per report, so the reports of the scale are the dimension.
    scale: (profile) => ({callsPerPath: CALLS_PER_PATH, collectionCallsPerPath: COLLECTION_CALLS_PER_PATH, reports: profile.reports}),
    setup: async (): Promise<MemoizedSelectorContext> => {
        const account = getHeavyAccount();

        return {
            memoized: createMemoizedSelector(sessionEmailAndAccountIDSelector),
            sameInput: account.session,
            changedOutput: {...account.session},
            equalOutput: {...account.session},
            memoizedCollection: createMemoizedSelector(selectReportSummaries),
            reports: account.reports,
            equalReports: {...account.reports},
            state: {revision: 0},
        };
    },
    beforeEach: async (context) => {
        context.state.revision++;

        // A new object each iteration whose selected fields differ, so the recompute path is real work.
        context.changedOutput = {...context.sameInput, email: `perf-${context.state.revision}@expensify.com`, accountID: context.state.revision};

        // A new object each iteration whose selected fields are unchanged, the deep-equal path.
        context.equalOutput = {...context.sameInput, authToken: `token-${context.state.revision}`};

        // A new collection object with the same members: the selector re-runs and its output deep-equals the last one.
        context.equalReports = {...context.reports};
    },
    run: async (context, params) => {
        let calls = 0;

        for (let index = 0; index < CALLS_PER_PATH; index++) {
            context.memoized(context.sameInput);
            calls++;
        }

        for (let index = 0; index < CALLS_PER_PATH; index++) {
            context.memoized(context.changedOutput);
            context.memoized(context.sameInput);
            calls += 2;
        }

        for (let index = 0; index < CALLS_PER_PATH; index++) {
            context.memoized(context.equalOutput);
            context.memoized(context.sameInput);
            calls += 2;
        }

        for (let index = 0; index < COLLECTION_CALLS_PER_PATH; index++) {
            context.memoizedCollection(context.equalReports);
            context.memoizedCollection(context.reports);
            calls += 2;
        }

        return {callsPerPath: params.callsPerPath, calls};
    },
});

runScenarios([selectorHitAndMiss], {requiresOnyxModules: ['createMemoizedSelector']});
