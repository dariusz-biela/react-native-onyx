import ONYXKEYS from '@app/ONYXKEYS';
import type {Pages, ReportAction, ReportActions} from '@app/types';

import type {Connection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';
import createRandomReportAction from '@app/collections/reportActions';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import {withDeterministicRandom} from '../../fixtures/random';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type MergeContext = {
    reportKey: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;
    connections: Connection[];
    state: {callbacks: number; revision: number};
};

type RevisionContext = {
    state: {revision: number};
};

type ReportActionsPageContext = RevisionContext & {
    reportActionsKey: `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}`;
    /** The 50 actions the measured page rewrites, with ids fixed so the target report keeps a stable size. */
    pageActions: ReportAction[];
    nextPage: ReportActions;
};

type TypingContext = RevisionContext & {
    typingKey: `${typeof ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${string}`;
};

type PendingActionContext = RevisionContext & {
    actionsKey: `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}`;
    reportActionID: string;
};

type PagesContext = RevisionContext & {
    pagesKey: `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS_PAGES}${string}`;
    nextPages: Pages;
};

const PAGE_SIZE = 50;
const TYPING_BURST_SIZE = 20;

const mergeSingleKey = defineScenario({
    id: 'api/merge/single-field-report',
    title: 'Onyx.merge of two fields into one report while N module listeners watch the report collection',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1542, note: 'clearAvatarErrors merges into one report key'},
        {file: 'src/libs/actions/Report/index.ts', line: 521, note: 'Onyx.connect on the whole report collection, the allReports cache'},
    ],
    scale: (profile) => ({reports: profile.reports, moduleListeners: profile.moduleListeners}),
    setup: async (params): Promise<MergeContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const state = {callbacks: 0, revision: 0};
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

        return {
            reportKey: `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[0]}`,
            connections,
            state,
        };
    },
    beforeEach: async (context) => {
        context.state.callbacks = 0;
        context.state.revision++;
    },
    run: async (context) => {
        await Onyx.merge(context.reportKey, {
            lastMessageText: `revision ${context.state.revision}`,
            errorFields: {avatar: null},
        });

        return {listenerCallbacks: context.state.callbacks};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
    },
});

const mergeReportActionsPage = defineScenario({
    id: 'api/merge/report-actions-batch',
    title: 'Onyx.merge of a 50-action page into a report actions member that already holds N actions',
    realUsage: [
        {file: 'src/libs/Middleware/Pagination.ts', line: 173, note: 'the pagination middleware appends its page to the response onyxData applied through Onyx.update'},
        {file: 'src/libs/actions/Report/index.ts', line: 2469, note: 'a report action merged into the report actions member key'},
    ],
    scale: (profile) => ({existingActions: profile.reportActionsPerActiveReport, pageActions: PAGE_SIZE}),
    setup: async (): Promise<ReportActionsPageContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportID = account.activeReportIDs[0];
        const pageActions = withDeterministicRandom(() => {
            const actions: ReportAction[] = [];
            for (let index = 0; index < PAGE_SIZE; index++) {
                actions.push({...createRandomReportAction(index + 1), reportActionID: `page-action-${index}`});
            }
            return actions;
        });

        return {state: {revision: 0}, reportActionsKey: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`, pageActions, nextPage: {}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        const page: ReportActions = {};
        for (const action of context.pageActions) {
            page[action.reportActionID] = {...action, lastModified: `2026-09-14 12:00:00.${String(context.state.revision).padStart(3, '0')}`};
        }

        context.nextPage = page;
    },
    run: async (context, params) => {
        await Onyx.merge(context.reportActionsKey, context.nextPage);

        return {actionsMerged: params.pageActions};
    },
});

const mergeSameKeyBurst = defineScenario({
    id: 'api/merge/same-key-burst',
    title: 'twenty Onyx.merge calls on one typing-indicator key in the same tick, timed until the merge queue has flushed all of them',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 654, note: 'broadcastUserIsTyping merges the typing status for the open report'},
        {file: 'src/libs/actions/Report/index.ts', line: 3326, note: 'draft comment merges on every composer keystroke, the other same-key burst'},
    ],
    scale: (profile) => ({merges: TYPING_BURST_SIZE, storeKeys: storeKeyCount(profile)}),
    setup: async (): Promise<TypingContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}, typingKey: `${ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${account.reportIDs[0]}`};
    },
    beforeEach: async (context) => {
        context.state.revision++;
    },
    run: async (context, params) => {
        const merges: Array<Promise<void>> = [];

        for (let index = 0; index < TYPING_BURST_SIZE; index++) {
            merges.push(Onyx.merge(context.typingKey, {[`user${index}`]: (context.state.revision + index) % 2 === 0}));
        }

        await Promise.all(merges);

        return {merges: params.merges};
    },
});

const mergeNestedNullRemoval = defineScenario({
    id: 'api/merge/nested-null-removal',
    title: 'Onyx.merge with a nested null clearing pendingAction of one action inside a report actions member of A actions, the success data of a sent comment',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1520, note: 'success data of a new action: {[reportActionID]: {pendingAction: null}} merged into the report actions member'},
        {file: 'src/libs/actions/Report/index.ts', line: 1085, note: 'addActions success data clearing pendingAction and isOptimisticAction the same way'},
    ],
    // fastMerge copies every action of the member and the change check compares the whole value, so the member size is the dimension.
    scale: (profile) => ({existingActions: profile.reportActionsPerActiveReport}),
    setup: async (): Promise<PendingActionContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const actionsKey: `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}` = `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${account.activeReportIDs[0]}`;
        const [reportActionID] = Object.keys(account.reportActions[actionsKey] ?? {});

        return {state: {revision: 0}, actionsKey, reportActionID};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        // Restore the field the measured merge removes, otherwise there is nothing left to take out.
        await Onyx.merge(context.actionsKey, {[context.reportActionID]: {pendingAction: context.state.revision % 2 === 0 ? 'add' : 'update'}});
    },
    run: async (context) => {
        await Onyx.merge(context.actionsKey, {[context.reportActionID]: {pendingAction: null}});
    },
});

const mergeArrayReplacesArray = defineScenario({
    id: 'api/merge/array-vs-object',
    title: 'Onyx.merge of a pages array onto a key that already holds an array, the replace branch of checkCompatibilityWithExistingValue',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 2109, note: 'the pruned pages array written back for a report'},
        {file: 'src/libs/Middleware/Pagination.ts', line: 153, note: 'the merged pages array the pagination middleware puts into the response onyxData'},
    ],
    // A pages array lists every loaded action ID of the report, so its length follows the member size.
    scale: (profile) => ({pages: 3, idsPerPage: Math.ceil(profile.reportActionsPerActiveReport / 3)}),
    setup: async (): Promise<PagesContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const pagesKey: `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS_PAGES}${string}` = `${ONYXKEYS.COLLECTION.REPORT_ACTIONS_PAGES}${account.activeReportIDs[0]}`;
        await Onyx.set(pagesKey, [['seed-1', 'seed-2', 'seed-3']]);

        return {state: {revision: 0}, pagesKey, nextPages: []};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;
        const revision = context.state.revision;
        context.nextPages = Array.from({length: params.pages}, (page, pageIndex) => Array.from({length: params.idsPerPage}, (id, idIndex) => `${revision}-${pageIndex}-${idIndex}`));
    },
    run: async (context, params) => {
        await Onyx.merge(context.pagesKey, context.nextPages);

        return {pagesWritten: params.pages};
    },
});

const mergeDeepPersonalDetails = defineScenario({
    id: 'api/merge/deep-personal-details',
    title: 'Onyx.merge of one entry into the personal details list with N entries',
    realUsage: [
        {file: 'src/libs/actions/PersonalDetails.ts', line: 127, note: 'updatePronouns merges one account entry into the list'},
        {file: 'src/libs/actions/Report/index.ts', line: 4938, note: 'removing personal details entries with one merge on the whole list'},
    ],
    scale: (profile) => ({personalDetails: profile.personalDetails}),
    setup: async (): Promise<RevisionContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
    },
    run: async (context, params) => {
        await Onyx.merge(ONYXKEYS.PERSONAL_DETAILS_LIST, {'1': {displayName: `revision ${context.state.revision}`, pronouns: `they ${context.state.revision}`}});

        return {entriesInList: params.personalDetails};
    },
});

runScenarios([mergeSingleKey, mergeReportActionsPage, mergeSameKeyBurst, mergeNestedNullRemoval, mergeArrayReplacesArray, mergeDeepPersonalDetails]);
