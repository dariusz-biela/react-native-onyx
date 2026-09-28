import type {OnyxCollection, OnyxEntry} from 'react-native-onyx';

import type {PersonalDetailsList, Report, Session} from './types';

type ReportSummary = {reportID: string | undefined; reportName: string | undefined; policyID: string | undefined};

/** Mirrors `sessionEmailAndAccountIDSelector` in Expensify/App `src/selectors/Session.ts`. */
const sessionEmailAndAccountIDSelector = (session: OnyxEntry<Session>) => ({email: session?.email, accountID: session?.accountID});

/** Mirrors `personalDetailsLoginSelector` in Expensify/App `src/selectors/PersonalDetails.ts`. */
const personalDetailsLoginSelector = (accountID: number | undefined) => (personalDetailsList: OnyxEntry<PersonalDetailsList>) =>
    accountID ? personalDetailsList?.[accountID]?.login : undefined;

/** Mirrors `reportsSelector` in `src/hooks/usePersonalDetailOptions.ts:66`: a projection of every report. */
function reportSummariesSelector(reports: OnyxCollection<Report>): Record<string, ReportSummary> {
    const summaries: Record<string, ReportSummary> = {};

    for (const [key, report] of Object.entries(reports ?? {})) {
        if (!report) {
            continue;
        }
        summaries[key] = {reportID: report.reportID, reportName: report.reportName, policyID: report.policyID};
    }

    return summaries;
}

export {personalDetailsLoginSelector, reportSummariesSelector, sessionEmailAndAccountIDSelector};
export type {ReportSummary};
