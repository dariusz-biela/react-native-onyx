import CONST from '@app/CONST';
import ONYXKEYS from '@app/ONYXKEYS';
import type {Report, SearchResults} from '@app/types';

import type {OnyxUpdate} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import type {HeavyAccount} from './account';

/**
 * The three Onyx update shapes the app produces at runtime. Each one mirrors a real payload:
 *
 * - a server response batch, applied by `updateHandler(response.onyxData)` in
 *   `src/libs/actions/OnyxUpdates.ts:66`, fed from `response.onyxData` in
 *   `src/libs/Middleware/SaveResponseInOnyx.ts:28`;
 * - a Pusher burst, applied one update at a time in `src/libs/actions/OnyxUpdates.ts:108-120`
 *   (the Airship twin at line 128 calls `Onyx.update(update.data)` directly);
 * - an optimistic/success pair for sending a comment, built in
 *   `src/libs/actions/Report/index.ts:1053-1072` (optimisticData) and `:1088-1095` (successData).
 */
type ReportKey = typeof ONYXKEYS.COLLECTION.REPORT;
type ReportActionsKey = typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS;

type AccountUpdateKey = ReportKey | ReportActionsKey | typeof ONYXKEYS.PERSONAL_DETAILS_LIST;
type AccountUpdate = OnyxUpdate<AccountUpdateKey>;
type ReportUpdate = OnyxUpdate<ReportKey>;
type CommentUpdate = OnyxUpdate<ReportKey | ReportActionsKey>;

/**
 * An OpenApp-like response batch: the whole report collection and the personal details list arrive
 * as collection writes, the way the server sends them back on a cold boot.
 */
function buildOpenAppBatch(account: HeavyAccount): AccountUpdate[] {
    return [
        {
            onyxMethod: Onyx.METHOD.MERGE_COLLECTION,
            key: ONYXKEYS.COLLECTION.REPORT,
            value: account.reports,
        },
        {
            onyxMethod: Onyx.METHOD.MERGE_COLLECTION,
            key: ONYXKEYS.COLLECTION.REPORT_ACTIONS,
            value: account.reportActions,
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.PERSONAL_DETAILS_LIST,
            value: account.personalDetails,
        },
    ];
}

/**
 * A Pusher-like burst: many small merges landing on separate report keys, which is what a busy
 * workspace produces while the user is idle.
 */
function buildPusherBurst(account: HeavyAccount, keyCount: number, revision: number): ReportUpdate[] {
    const updates: ReportUpdate[] = [];

    for (let index = 0; index < keyCount; index++) {
        const reportID = account.reportIDs[index % account.reportIDs.length];
        const value: Partial<Report> = {
            lastMessageText: `burst ${revision}-${index}`,
            lastReadTime: `2026-09-14 12:00:${String(index % 60).padStart(2, '0')}.000`,
            lastActorAccountID: (index % 20) + 1,
        };

        updates.push({
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT}${reportID}`,
            value,
        });
    }

    return updates;
}

/**
 * The optimistic half of sending a comment: the report head fields plus the new report action,
 * as built in `src/libs/actions/Report/index.ts:1053-1072`.
 */
function buildSendCommentOptimistic(reportID: string, reportActionID: string, text: string): CommentUpdate[] {
    const created = `2026-09-14 12:00:00.000`;

    return [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT}${reportID}`,
            value: {
                lastVisibleActionCreated: created,
                lastMessageText: text,
                lastMessageHtml: text,
                lastActorAccountID: 1,
                lastReadTime: created,
                lastActionType: 'ADDCOMMENT',
            },
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`,
            value: {
                [reportActionID]: {
                    reportActionID,
                    actionName: 'ADDCOMMENT',
                    actorAccountID: 1,
                    created,
                    pendingAction: 'add',
                    isOptimisticAction: true,
                    message: [{type: 'COMMENT', html: text, text}],
                },
            },
        },
    ];
}

/**
 * The success half: clearing `pendingAction`/`isOptimisticAction` on the action that was just added,
 * as built in `src/libs/actions/Report/index.ts:1088-1095`.
 */
function buildSendCommentSuccess(reportID: string, reportActionID: string): CommentUpdate[] {
    return [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`,
            value: {
                [reportActionID]: {pendingAction: null, isOptimisticAction: null},
            },
        },
    ];
}

/**
 * The four payloads the `flows/` suite needs on top of the three above. Anchors verified on 2026-09-16:
 *
 * - a ReconnectApp delta: the reports that changed while the client was offline come back as one
 *   `MERGE_COLLECTION` plus a handful of report-action merges, requested in
 *   `src/libs/actions/App.ts:461` (`reconnectApp`) through `getOnyxDataForOpenOrReconnect` at `:309`,
 *   and applied by the same `updateHandler(response.onyxData)` at `src/libs/actions/OnyxUpdates.ts:67`;
 * - a report-actions page: `src/libs/Middleware/Pagination.ts:151` pushes the `SET` of the page list
 *   and `:171` the pagination-state `MERGE` onto the response, next to the page of actions the server
 *   returns for `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`;
 * - a search snapshot batch: `src/libs/actions/Search.ts:797` merges the search state into
 *   `${ONYXKEYS.COLLECTION.SNAPSHOT}${hash}`, and `:562` merges into that snapshot's `data`. The report
 *   merges that travel with it carry `pendingAction` and `pendingFields`, the two keys the app passes as
 *   `snapshotMergeKeys` (`src/setup/index.ts:72`), which is what lets `OnyxUtils.updateSnapshots` copy
 *   those fields into a snapshot row that does not have them yet;
 * - a personal-details patch for one user, as built by `src/libs/actions/PersonalDetails.ts:144`
 *   (`updateDisplayName` optimistic data) and `:127` (`setDisplayName`).
 */
type ReportActionsPageKey = ReportActionsKey | typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS_PAGES | typeof ONYXKEYS.COLLECTION.REPORT_PAGINATION_STATE;
type SearchSnapshotKey = typeof ONYXKEYS.COLLECTION.SNAPSHOT | ReportKey;

type ReconnectUpdate = OnyxUpdate<ReportKey | ReportActionsKey>;
type ReportActionsPageUpdate = OnyxUpdate<ReportActionsPageKey>;
type SearchSnapshotUpdate = OnyxUpdate<SearchSnapshotKey>;
type PersonalDetailsUpdate = OnyxUpdate<typeof ONYXKEYS.PERSONAL_DETAILS_LIST>;

/** The report actions that come back with a reconnect delta, one per report that saw activity. */
const RECONNECT_ACTION_REPORTS = 5;

/** The CONST members are read rather than inlined so `actionName` and the message `type` keep their literal types. */
function buildReportAction(reportActionID: string, text: string, created: string) {
    return {
        reportActionID,
        actionName: CONST.REPORT.ACTIONS.TYPE.ADD_COMMENT,
        actorAccountID: 1,
        created,
        message: [{type: CONST.REPORT.MESSAGE.TYPE.COMMENT, html: text, text}],
    };
}

/**
 * A ReconnectApp-shaped delta: `changedReports` report heads as one `MERGE_COLLECTION`, plus one new
 * report action on each of the first few active reports. That is the shape of a client coming back after
 * a short disconnect, where most reports only changed their LHN fields and a few actually got messages.
 */
function buildReconnectDelta(account: HeavyAccount, changedReports: number, revision: number): ReconnectUpdate[] {
    const reports: Record<string, Partial<Report>> = {};
    const created = `2026-09-14 12:${String(revision % 60).padStart(2, '0')}:00.000`;

    for (let index = 0; index < changedReports; index++) {
        const reportID = account.reportIDs[index % account.reportIDs.length];
        reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`] = {
            lastMessageText: `reconnect ${revision}-${index}`,
            lastVisibleActionCreated: created,
            lastReadTime: created,
            lastActorAccountID: (index % 20) + 1,
        };
    }

    const updates: ReconnectUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE_COLLECTION,
            key: ONYXKEYS.COLLECTION.REPORT,
            value: reports,
        },
    ];

    const actionReportIDs = account.activeReportIDs.slice(0, RECONNECT_ACTION_REPORTS);
    for (const reportID of actionReportIDs) {
        const reportActionID = `reconnect-${revision}-${reportID}`;
        updates.push({
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`,
            value: {[reportActionID]: buildReportAction(reportActionID, `reconnect ${revision}`, created)},
        });
    }

    return updates;
}

/**
 * The batch that lands when a report is opened: the page of actions merged into the report's actions
 * member key, the page id list set on `REPORT_ACTIONS_PAGES` and the pagination cursors merged into
 * `REPORT_PAGINATION_STATE`. The action ids are stable across revisions, so the target report keeps a
 * constant size while every iteration still writes new content.
 */
function buildReportActionsPage(reportID: string, actionCount: number, revision: number): ReportActionsPageUpdate[] {
    const actions: Record<string, ReturnType<typeof buildReportAction>> = {};
    const pageIDs: string[] = new Array<string>(actionCount);

    for (let index = 0; index < actionCount; index++) {
        const reportActionID = `page-${index}`;
        const created = `2026-09-14 13:${String(index % 60).padStart(2, '0')}:00.000`;
        actions[reportActionID] = buildReportAction(reportActionID, `page ${revision}-${index}`, created);
        pageIDs[index] = reportActionID;
    }

    return [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`,
            value: actions,
        },
        {
            onyxMethod: Onyx.METHOD.SET,
            key: `${ONYXKEYS.COLLECTION.REPORT_ACTIONS_PAGES}${reportID}`,
            value: [pageIDs],
        },
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT_PAGINATION_STATE}${reportID}`,
            value: {newestFetchedReportActionID: pageIDs.at(0), oldestFetchedReportActionID: pageIDs.at(-1)},
        },
    ];
}

/**
 * The value a search response leaves at `${ONYXKEYS.COLLECTION.SNAPSHOT}${hash}`: a `search` block of
 * request metadata and a `data` block holding a copy of every Onyx row the result list shows, as declared
 * by `SearchResults` in `src/types/onyx/SearchResults.ts:351`. Only report rows are built here, because
 * those are the rows the search flow then updates.
 */
function buildSearchSnapshot(account: HeavyAccount, hash: number, rows: number): SearchResults {
    const data: SearchResults['data'] = {};

    for (let index = 0; index < rows; index++) {
        const reportID = account.reportIDs[index % account.reportIDs.length];
        const reportKey: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}` = `${ONYXKEYS.COLLECTION.REPORT}${reportID}`;
        const report = account.reports[reportKey];

        if (!report) {
            continue;
        }

        data[reportKey] = report;
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

/**
 * A search batch: the snapshot's own `search` state merge, then report merges carrying `pendingAction`
 * and `pendingFields`. Those two fields are absent from the snapshot rows, so only the `snapshotMergeKeys`
 * allow-list gets them copied across in `OnyxUtils.updateSnapshots`; without it the same batch would leave
 * the snapshot's rows untouched and the search list would not show the pending state.
 */
function buildSearchSnapshotUpdate(hash: number, reportIDs: readonly string[], changedRows: number, revision: number): SearchSnapshotUpdate[] {
    const updates: SearchSnapshotUpdate[] = [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.SNAPSHOT}${hash}`,
            value: {search: {isLoading: revision % 2 === 0, offset: revision}},
        },
    ];

    for (let index = 0; index < changedRows; index++) {
        const reportID = reportIDs[index % reportIDs.length];
        updates.push({
            onyxMethod: Onyx.METHOD.MERGE,
            key: `${ONYXKEYS.COLLECTION.REPORT}${reportID}`,
            value: {
                lastMessageText: `search ${revision}-${index}`,
                pendingAction: revision % 2 === 0 ? 'update' : null,
                pendingFields: {lastMessageText: revision % 2 === 0 ? 'update' : null},
            },
        });
    }

    return updates;
}

/** One user's display name changing, the patch behind every avatar and name update in the app. */
function buildPersonalDetailsPatch(accountID: number, revision: number): PersonalDetailsUpdate[] {
    return [
        {
            onyxMethod: Onyx.METHOD.MERGE,
            key: ONYXKEYS.PERSONAL_DETAILS_LIST,
            value: {
                [accountID]: {
                    firstName: `Perf${revision}`,
                    lastName: 'User',
                    displayName: `Perf${revision} User`,
                },
            },
        },
    ];
}

export {
    buildOpenAppBatch,
    buildPersonalDetailsPatch,
    buildPusherBurst,
    buildReconnectDelta,
    buildReportActionsPage,
    buildSearchSnapshot,
    buildSearchSnapshotUpdate,
    buildSendCommentOptimistic,
    buildSendCommentSuccess,
};
export type {
    AccountUpdate,
    AccountUpdateKey,
    CommentUpdate,
    PersonalDetailsUpdate,
    ReconnectUpdate,
    ReportActionsPageKey,
    ReportActionsPageUpdate,
    ReportUpdate,
    SearchSnapshotKey,
    SearchSnapshotUpdate,
};
