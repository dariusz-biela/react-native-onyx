/**
 * Types every Onyx call in the suite against the App's key set, the way Expensify/App does in
 * `src/types/modules/react-native-onyx.d.ts`. Keys the suite has no type for map to `unknown`.
 */
import type {ValueOf} from 'type-fest';

import type ONYXKEYS from './ONYXKEYS';
import type {Account, Pages, PersonalDetailsList, Policy, Report, ReportActions, ReportActionsDrafts, SearchResults, Session, Transaction} from './types';

type DeepValueOf<TObject> = TObject extends string ? TObject : TObject extends object ? {[TKey in keyof TObject]: DeepValueOf<TObject[TKey]>}[keyof TObject] : never;

type OnyxCollectionKey = ValueOf<(typeof ONYXKEYS)['COLLECTION']>;

type OnyxValueKey = DeepValueOf<Omit<typeof ONYXKEYS, 'COLLECTION'>>;

type KnownValues = {
    account: Account;
    personalDetailsList: PersonalDetailsList;
    session: Session;
    policy_: Policy;
    report_: Report;
    reportActions_: ReportActions;
    reportActionsDrafts_: ReportActionsDrafts;
    reportActionsPages_: Pages;
    snapshot_: SearchResults;
    transactions_: Transaction;
};

type OnyxValues = {
    [TKey in OnyxValueKey | OnyxCollectionKey]: TKey extends keyof KnownValues ? KnownValues[TKey] : unknown;
};

declare module 'react-native-onyx' {
    interface CustomTypeOptions {
        keys: OnyxValueKey;
        collectionKeys: OnyxCollectionKey;
        values: OnyxValues;
    }
}

export type {OnyxCollectionKey, OnyxValueKey, OnyxValues};
