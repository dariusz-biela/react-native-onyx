import ONYXKEYS from '@app/ONYXKEYS';
import type {Report, ReportActionsDrafts} from '@app/types';

import type {Collection} from 'react-native-onyx/dist/types';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type DraftsContext = {
    state: {revision: number};
};

type ReplaceContext = {
    state: {revision: number};
    nextReports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report>;
};

/** Every draft the measured `setCollection({})` has to remove, rewritten before each iteration. */
function buildDrafts(reportIDs: readonly string[], revision: number): Collection<typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS_DRAFTS, ReportActionsDrafts> {
    const drafts: Collection<typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS_DRAFTS, ReportActionsDrafts> = {};

    for (const reportID of reportIDs) {
        drafts[`${ONYXKEYS.COLLECTION.REPORT_ACTIONS_DRAFTS}${reportID}`] = {
            [`draft-${reportID}`]: {message: `draft ${revision} for ${reportID}`},
        };
    }

    return drafts;
}

const clearDrafts = defineScenario({
    id: 'api/setCollection/drafts-clear',
    title: 'Onyx.setCollection of an empty object over M report action drafts, the sign-out style collection wipe',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 3774, note: 'deleteAllReportActionsDrafts clears the whole drafts collection'},
        {file: 'src/libs/actions/Download.ts', line: 13, note: 'the same empty-object setCollection shape on another collection'},
    ],
    scale: (profile) => ({drafts: profile.reports}),
    measure: {timeBudgetMs: 4000, maxIterations: 30},
    setup: async (): Promise<DraftsContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}};
    },
    beforeEach: async (context) => {
        const account = getHeavyAccount();
        context.state.revision++;

        await Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT_ACTIONS_DRAFTS, buildDrafts(account.reportIDs, context.state.revision));
    },
    run: async (context, params) => {
        await Onyx.setCollection(ONYXKEYS.COLLECTION.REPORT_ACTIONS_DRAFTS, {});

        return {draftsRemoved: params.drafts};
    },
});

const replaceCollection = defineScenario({
    id: 'api/setCollection/replace',
    title: 'Onyx.setCollection replacing the N-member report collection with N different members',
    realUsage: [
        {file: 'src/libs/actions/ImportOnyxState.ts', line: 15, note: 'importOnyxCollectionState replaces every collection wholesale'},
        {file: 'src/libs/actions/Attachment/index.ts', line: 97, note: 'another setCollection that replaces a whole collection'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    measure: {timeBudgetMs: 5000, maxIterations: 25},
    setup: async (): Promise<ReplaceContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}, nextReports: {}};
    },
    beforeEach: async (context) => {
        const account = getHeavyAccount();
        context.state.revision++;

        // Odd and even revisions use disjoint id ranges, so every iteration removes N members and adds N others.
        const idOffset = context.state.revision % 2 === 0 ? 0 : account.reportIDs.length;
        const reports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report> = {};

        for (const [index, reportID] of account.reportIDs.entries()) {
            const source: Report = account.reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`];
            const replacementID = String(index + 1 + idOffset);
            reports[`${ONYXKEYS.COLLECTION.REPORT}${replacementID}`] = {...source, reportID: replacementID};
        }

        context.nextReports = reports;
    },
    run: async (context, params) => {
        await Onyx.setCollection(ONYXKEYS.COLLECTION.REPORT, context.nextReports);

        return {membersWritten: params.reports};
    },
});

runScenarios([clearDrafts, replaceCollection]);
