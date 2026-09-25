import ONYXKEYS from '@app/ONYXKEYS';
import type {Account, PersonalDetailsList, Policy, Report, ReportAction, ReportActions, Session, Transaction} from '@app/types';

import type {OnyxMultiSetInput} from 'react-native-onyx';
import type {Collection} from 'react-native-onyx/dist/types';

import Onyx from 'react-native-onyx';
import createPersonalDetails from '@app/collections/personalDetails';
import createRandomPolicy from '@app/collections/policies';
import createRandomReportAction from '@app/collections/reportActions';
import {createRandomReport} from '@app/collections/reports';
import createRandomTransaction from '@app/collections/transaction';

import type {ScaleProfile} from '../harness/scale';

import {waitForOnyx} from '../harness/onyx';
import getScaleProfile from '../harness/scale';
import {withDeterministicRandom} from './random';

/** One deterministic heavy account: what a signed-in user's store looks like after a boot. */
type HeavyAccount = {
    reports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report>;
    reportActions: Collection<typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS, ReportActions>;
    policies: Collection<typeof ONYXKEYS.COLLECTION.POLICY, Policy>;
    transactions: Collection<typeof ONYXKEYS.COLLECTION.TRANSACTION, Transaction>;
    personalDetails: PersonalDetailsList;
    session: Session;
    account: Account;

    /** Every report id, in insertion order. */
    reportIDs: string[];

    /** The subset of `reportIDs` that also has a report-actions collection member. */
    activeReportIDs: string[];

    /**
     * The one report whose actions member is far larger than the others (Concierge, #announce): the largest
     * single key an account carries. It is the last report id, it is not in `activeReportIDs` so no existing
     * row's slice of that list changes, and its member sits in `reportActions` like every other one.
     */
    hotReportID: string;
};

const CURRENT_USER_ACCOUNT_ID = 1;
const CURRENT_USER_EMAIL = 'perf@expensify.com';

function buildHeavyAccount(profile: ScaleProfile): HeavyAccount {
    const reports: Collection<typeof ONYXKEYS.COLLECTION.REPORT, Report> = {};
    const reportActions: Collection<typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS, ReportActions> = {};
    const policies: Collection<typeof ONYXKEYS.COLLECTION.POLICY, Policy> = {};
    const transactions: Collection<typeof ONYXKEYS.COLLECTION.TRANSACTION, Transaction> = {};
    const personalDetails: PersonalDetailsList = {};
    const reportIDs: string[] = [];
    const activeReportIDs: string[] = [];

    for (let index = 0; index < profile.reports; index++) {
        const reportID = String(index + 1);
        reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`] = createRandomReport(index + 1);
        reportIDs.push(reportID);
    }

    for (let index = 0; index < profile.activeReports; index++) {
        const reportID = reportIDs[index];
        const actions: ReportActions = {};

        for (let actionIndex = 0; actionIndex < profile.reportActionsPerActiveReport; actionIndex++) {
            const action: ReportAction = createRandomReportAction(actionIndex + 1);
            actions[action.reportActionID] = action;
        }

        reportActions[`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`] = actions;
        activeReportIDs.push(reportID);
    }

    const hotReportID = reportIDs.at(-1) ?? '1';
    const hotActions: ReportActions = {};
    for (let actionIndex = 0; actionIndex < profile.hotReportActions; actionIndex++) {
        const action: ReportAction = {...createRandomReportAction(actionIndex + 1), reportActionID: `hot-${actionIndex + 1}`};
        hotActions[action.reportActionID] = action;
    }
    reportActions[`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${hotReportID}`] = hotActions;

    for (let index = 0; index < profile.policies; index++) {
        policies[`${ONYXKEYS.COLLECTION.POLICY}${index + 1}`] = createRandomPolicy(index + 1);
    }

    for (let index = 0; index < profile.transactions; index++) {
        transactions[`${ONYXKEYS.COLLECTION.TRANSACTION}${index + 1}`] = createRandomTransaction(index + 1);
    }

    for (let index = 0; index < profile.personalDetails; index++) {
        const accountID = index + 1;
        personalDetails[accountID] = createPersonalDetails(accountID);
    }

    return {
        reports,
        reportActions,
        policies,
        transactions,
        personalDetails,
        session: {accountID: CURRENT_USER_ACCOUNT_ID, email: CURRENT_USER_EMAIL, authToken: 'perf-auth-token', loading: false},
        account: {isLoading: false, requiresTwoFactorAuth: false, primaryLogin: CURRENT_USER_EMAIL},
        reportIDs,
        activeReportIDs,
        hotReportID,
    };
}

const cache = new Map<string, HeavyAccount>();

/**
 * How many keys `seedOnyxWithAccount` writes at a profile: the store every seeded scenario runs against.
 * A scenario whose own operation does not grow with the data still declares it, so the report shows that
 * its three scales ran against three store sizes.
 */
function storeKeyCount(profile: ScaleProfile): number {
    const hotReportActionsMember = 1;
    const plainKeys = 3;

    return profile.reports + profile.activeReports + hotReportActionsMember + profile.policies + profile.transactions + plainKeys;
}

/**
 * Built once per Jest file and profile, then shared by every scenario in that file. The profile comes
 * from ONYX_PERF_SCALE, so a scenario never has to thread it through by hand.
 */
function getHeavyAccount(): HeavyAccount {
    const profile = getScaleProfile();
    const cached = cache.get(profile.name);
    if (cached) {
        return cached;
    }

    const account = withDeterministicRandom(() => buildHeavyAccount(profile));
    cache.set(profile.name, account);

    return account;
}

const seedPairsByAccount = new WeakMap<HeavyAccount, OnyxMultiSetInput>();

function getSeedPairs(account: HeavyAccount): OnyxMultiSetInput {
    const cached = seedPairsByAccount.get(account);
    if (cached) {
        return cached;
    }

    const pairs: OnyxMultiSetInput = {
        ...account.reports,
        ...account.reportActions,
        ...account.policies,
        ...account.transactions,
        [ONYXKEYS.PERSONAL_DETAILS_LIST]: account.personalDetails,
        [ONYXKEYS.SESSION]: account.session,
        [ONYXKEYS.ACCOUNT]: account.account,
    };
    seedPairsByAccount.set(account, pairs);

    return pairs;
}

/**
 * Writes the whole account into a cleared Onyx and waits until every subscriber has settled. One
 * `multiSet` leaves the same keys and values as four `mergeCollection` calls and three `set` calls did,
 * in less than half the time (39 against 85 ms at the heavy scale), and every scenario setup and every
 * sign-out reseed pays it.
 */
async function seedOnyxWithAccount(account: HeavyAccount): Promise<void> {
    await Onyx.multiSet(getSeedPairs(account));
    await waitForOnyx();
}

export {CURRENT_USER_ACCOUNT_ID, CURRENT_USER_EMAIL, getHeavyAccount, seedOnyxWithAccount, storeKeyCount};
export type {HeavyAccount};
