import CONST from '@app/CONST';
import ONYXKEYS from '@app/ONYXKEYS';

import Onyx from 'react-native-onyx';
import onyxSubscriptionManager from 'react-native-onyx/dist/OnyxSubscriptionManager';

// The legacy connection layer exists only in arms built before ONYX-PR#834; the store registry exists in every arm.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacyConnectionManager: {default: {disconnectAll: () => void}} | undefined = (() => {
    try {
        return require('react-native-onyx/dist/OnyxConnectionManager') as {default: {disconnectAll: () => void}};
    } catch {
        return undefined;
    }
})();

/**
 * Initialises Onyx with the same options the app passes in `src/setup/index.ts:47-100`, so every
 * scenario measures the key configuration the app actually runs: the same evictable collections,
 * the same initial key states, the same skippable member ids and the same RAM-only key list.
 * `enableDevTools` stays off, exactly as in a production build.
 */
function initOnyxForPerf(): void {
    Onyx.init({
        keys: ONYXKEYS,
        evictableKeys: [
            ONYXKEYS.COLLECTION.REPORT_ACTIONS,
            ONYXKEYS.COLLECTION.SNAPSHOT,
            ONYXKEYS.COLLECTION.REPORT_ACTIONS_DRAFTS,
            ONYXKEYS.COLLECTION.REPORT_ACTIONS_PAGES,
            ONYXKEYS.COLLECTION.REPORT_ACTIONS_REACTIONS,
        ],
        initialKeyStates: {
            [ONYXKEYS.SESSION]: {loading: false},
            [ONYXKEYS.ACCOUNT]: CONST.DEFAULT_ACCOUNT_DATA,
            [ONYXKEYS.RAM_ONLY_IS_SIDEBAR_LOADED]: false,
            [ONYXKEYS.MODAL]: {
                isVisible: false,
                willAlertModalBecomeVisible: false,
            },
            [ONYXKEYS.RAM_ONLY_IS_PRODUCT_MARKETING_WINDOW_COVERED]: false,
            [ONYXKEYS.SUPPORTAL_PERMISSION_DENIED]: null,
            [ONYXKEYS.IS_OPEN_APP_FAILURE_MODAL_OPEN]: false,
            [ONYXKEYS.RECENT_SEARCHES]: {},
        },
        skippableCollectionMemberIDs: [...CONST.SKIPPABLE_COLLECTION_MEMBER_IDS],
        snapshotMergeKeys: ['pendingAction', 'pendingFields'],
        ramOnlyKeys: [
            ONYXKEYS.RAM_ONLY_ARE_TRANSLATIONS_LOADING,
            ONYXKEYS.RAM_ONLY_MOBILE_SELECTION_MODE,
            ONYXKEYS.RAM_ONLY_IS_SIDEBAR_LOADED,
            ONYXKEYS.RAM_ONLY_IS_PRODUCT_MARKETING_WINDOW_COVERED,
            ONYXKEYS.DERIVED.RAM_ONLY_SORTED_REPORT_ACTIONS,
            ONYXKEYS.RAM_ONLY_IS_CHECKING_PUBLIC_ROOM,
            ONYXKEYS.RAM_ONLY_UPDATE_AVAILABLE,
            ONYXKEYS.RAM_ONLY_UPDATE_REQUIRED,
            ONYXKEYS.RAM_ONLY_IS_SEARCHING_FOR_REPORTS,
            ONYXKEYS.RAM_ONLY_IS_SEARCHING_FOR_USERS,
            ONYXKEYS.RAM_ONLY_IS_AUTHENTICATING_WITH_SHORT_LIVED_TOKEN,
            ONYXKEYS.RAM_ONLY_WALLET_ONFIDO,
            ONYXKEYS.RAM_ONLY_HAS_FRESH_WALLET_DATA,
            ONYXKEYS.RAM_ONLY_IS_LOADING_SEARCH_FILTERS_CATEGORY_DATA,
            ONYXKEYS.COLLECTION.RAM_ONLY_REPORT_LOADING_STATE,
            ONYXKEYS.COLLECTION.RAM_ONLY_COMPANY_CARDS_LOADING_STATE,
            ONYXKEYS.RAM_ONLY_MERCHANT_RULE_SUGGESTION,
            ONYXKEYS.COLLECTION.RAM_ONLY_EXPENSIFY_CARD_LOADING_STATE,
            ONYXKEYS.RAM_ONLY_PLAID_LINK_TOKEN,
            ONYXKEYS.RAM_ONLY_MERGE_HR_LINK_TOKEN,
            ONYXKEYS.COLLECTION.RAM_ONLY_ISSUE_NEW_EXPENSIFY_CARD,
            ONYXKEYS.RAM_ONLY_DOMAIN_MEMBERS_SELECTED_FOR_MOVE,
            ONYXKEYS.RAM_ONLY_HAS_DISMISSED_CONCIERGE_NOTIFICATION_BANNER,
            ONYXKEYS.RAM_ONLY_CORPAY_PAY_MODAL,
        ],
    });
}

/**
 * Drains everything Onyx can defer a notification onto: the microtask queue, `process.nextTick`
 * (which Onyx uses to batch subscriber callbacks) and one macrotask turn. Same intent as
 * `tests/utils/waitForBatchedUpdates.ts`, minus its fake-timer branch, because the suite runs on
 * real timers.
 */
function waitForOnyx(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(() => {
            process.nextTick(() => {
                setTimeout(resolve, 0);
            });
        });
    });
}

/** Clears every key and drops every subscription, so the next scenario starts from a cold store. */
async function resetOnyx(): Promise<void> {
    legacyConnectionManager?.default.disconnectAll();
    onyxSubscriptionManager.clearAll();
    await Onyx.clear();
    await waitForOnyx();
}

export {initOnyxForPerf, resetOnyx, waitForOnyx};
