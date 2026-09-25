/**
 * Loose copies of the Expensify/App Onyx value types the fixtures and suites read and write. Only the fields
 * the suite touches are listed. Onyx itself never looks at a value's shape, so a missing field changes no
 * measurement, only what the type checker accepts.
 */
import type {OnyxKey, OnyxUpdate} from 'react-native-onyx';

type PendingAction = 'add' | 'update' | 'delete' | null;

type Errors = Record<string, string | null>;

type OfflineFeedback = {
    pendingAction?: PendingAction;
    pendingFields?: Record<string, PendingAction | undefined> | null;
    errors?: Errors | null;
    errorFields?: Record<string, Errors | null> | null;
};

type Participant = {
    notificationPreference?: string;
    role?: string;
};

type Report = OfflineFeedback & {
    reportID?: string;
    reportName?: string;
    type?: string;
    chatType?: string;
    currency?: string;
    ownerAccountID?: number;
    managerID?: number;
    policyID?: string;
    parentReportID?: string;
    parentReportActionID?: string;
    isPinned?: boolean;
    isOwnPolicyExpenseChat?: boolean;
    isWaitingOnBankAccount?: boolean;
    participants?: Record<string, Participant>;
    lastReadTime?: string;
    lastVisibleActionCreated?: string;
    lastMessageText?: string;
    lastMessageHtml?: string;
    lastActionType?: string;
    lastActorAccountID?: number;
    total?: number;
    stateNum?: number;
    statusNum?: number;
    hasOutstandingChildRequest?: boolean;
};

type Message = {
    type?: string;
    html?: string;
    text?: string;
    style?: string;
    isEdited?: boolean;
    isDeletedParentAction?: boolean;
    whisperedTo?: unknown;
};

type ReportAction = OfflineFeedback & {
    reportActionID: string;
    actionName?: string;
    actorAccountID?: number;
    person?: Message[];
    created: string;
    message?: Message[];
    originalMessage?: Record<string, unknown>;
    avatar?: string;
    automatic?: boolean;
    shouldShow?: boolean;
    lastModified?: string;
    delegateAccountID?: number;
    isAttachmentOnly?: boolean;
    childReportID?: string;
    reportID?: string;
    isOptimisticAction?: boolean;
};

type ReportActions = Record<string, ReportAction>;

type ReportActionsDraft = string | {message: string};

type ReportActionsDrafts = Record<string, ReportActionsDraft>;

type Transaction = OfflineFeedback & {
    transactionID: string;
    reportID?: string;
    amount?: number;
    originalAmount?: number;
    modifiedAmount?: number | string;
    currency?: string;
    originalCurrency?: string;
    modifiedCurrency?: string;
    merchant?: string;
    modifiedMerchant?: string;
    created: string;
    modifiedCreated?: string;
    bank?: string;
    cardID?: number;
    cardName?: string;
    cardNumber?: string;
    billable?: boolean;
    reimbursable?: boolean;
    category?: string;
    tag?: string;
    comment?: {comment?: string} & Record<string, unknown>;
    managedCard?: boolean;
    parentTransactionID?: string;
    status?: string;
    receipt?: {filename?: string; source?: string};
    hasEReceipt?: boolean;
    iouRequestType?: string;
};

type Policy = OfflineFeedback & {
    id?: string;
    name?: string;
    type?: string;
    role?: string;
    owner?: string;
    ownerAccountID?: number;
    outputCurrency?: string;
    avatarURL?: string;
    autoReporting?: boolean;
    autoReportingFrequency?: string;
    autoReportingOffset?: number;
    harvesting?: {enabled?: boolean};
    preventSelfApproval?: boolean;
    isFromFullPolicy?: boolean;
    lastModified?: string;
    customUnits?: Record<string, unknown>;
    approvalMode?: string;
};

type PersonalDetails = OfflineFeedback & {
    accountID?: number;
    login?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    avatar?: string;
    pronouns?: string;
    avatarStyle?: {color?: string};
};

type PersonalDetailsList = Record<string, PersonalDetails | null>;

type Session = {
    email?: string;
    accountID?: number;
    authToken?: string;
    encryptedAuthToken?: string;
    loading?: boolean;
    creationDate?: number;
};

type Account = OfflineFeedback & {
    isLoading?: boolean;
    success?: string;
    primaryLogin?: string;
    validated?: boolean;
    requiresTwoFactorAuth?: boolean;
};

type SearchResultsInfo = {
    offset?: number;
    type?: string;
    hash?: number;
    hasMoreResults?: boolean;
    hasResults?: boolean;
    isLoading?: boolean;
    sortBy?: string;
    sortOrder?: string;
};

type SearchResults = {
    search?: SearchResultsInfo;
    data?: Record<string, unknown>;
    isLoading?: boolean;
    errors?: Errors;
};

type Pages = string[][];

/** Mirrors `Request` in Expensify/App `src/types/onyx/Request.ts`, without its conflict resolver. */
type Request<TKey extends OnyxKey> = {
    command: string;
    data?: Record<string, unknown>;
    initiatedOffline?: boolean;
    requestIndex?: number;
    optimisticData?: Array<OnyxUpdate<TKey>>;
    successData?: Array<OnyxUpdate<TKey>>;
    failureData?: Array<OnyxUpdate<TKey>>;
    finallyData?: Array<OnyxUpdate<TKey>>;
};

export type {
    Account,
    Errors,
    Message,
    OfflineFeedback,
    Pages,
    PendingAction,
    PersonalDetails,
    PersonalDetailsList,
    Policy,
    Report,
    ReportAction,
    ReportActions,
    ReportActionsDraft,
    ReportActionsDrafts,
    Request,
    SearchResults,
    SearchResultsInfo,
    Session,
    Transaction,
};
