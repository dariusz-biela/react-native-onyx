import 'fake-indexeddb/auto';

import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxKey} from 'react-native-onyx';
import type {StorageKeyValuePair} from 'react-native-onyx/dist/storage/providers/types';

import provider from 'react-native-onyx/dist/storage/providers/IDBKeyValProvider';

import type {HeavyAccount} from '../../fixtures/account';

import {getHeavyAccount} from '../../fixtures/account';
import {getActiveArm} from '../../harness/hotswap';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The web storage provider, `IDBKeyValProvider`, driven directly against `fake-indexeddb`. The app's
 * Jest setup mocks `react-native-onyx/dist/storage` (the facade) with the in-memory provider, so these
 * rows import the real provider module underneath it, which the mock does not touch.
 *
 * What this measures and what it does not: `fake-indexeddb` runs `structuredClone` on every put and get,
 * the same serialization a browser does on the renderer's main thread before the value crosses to the
 * IndexedDB backend, so the numbers here are the main-thread part of a web storage operation. The backend
 * (LevelDB, IPC, disk) is not reproduced, and the SQLite provider needs a native module, so nothing here
 * says anything about native. `multiMerge` and `mergeItem` cannot run on `fake-indexeddb` at all: the
 * provider reads inside the transaction and writes in a promise continuation, which real engines keep
 * inside the transaction's active window and `fake-indexeddb` does not (`TransactionInactiveError`), so
 * the web merge path is covered by `internals/OnyxMerge/apply-web` plus `storage/idb/setItem-*` instead.
 */
type ReportKey = `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;

// Per arm: in a hot-swap run each arm has its own provider module behind the shared import.
const initializedArms = new Set<string | undefined>();

function initProvider(): void {
    const arm = getActiveArm();

    if (initializedArms.has(arm)) {
        return;
    }
    provider.init();
    initializedArms.add(arm);
}

function buildReportPairs(account: HeavyAccount): StorageKeyValuePair[] {
    const pairs: StorageKeyValuePair[] = [];
    for (const reportID of account.reportIDs) {
        const key: ReportKey = `${ONYXKEYS.COLLECTION.REPORT}${reportID}`;
        pairs.push([key, account.reports[key]]);
    }
    return pairs;
}

/** Everything `seedOnyxWithAccount` writes, as the flat key/value list the storage layer sees. */
function buildAccountPairs(account: HeavyAccount): StorageKeyValuePair[] {
    const pairs: StorageKeyValuePair[] = buildReportPairs(account);

    for (const [key, value] of Object.entries(account.reportActions)) {
        const memberKey: `${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}` = `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${key.slice(ONYXKEYS.COLLECTION.REPORT_ACTIONS.length)}`;
        pairs.push([memberKey, value]);
    }
    for (const [key, value] of Object.entries(account.policies)) {
        const memberKey: `${typeof ONYXKEYS.COLLECTION.POLICY}${string}` = `${ONYXKEYS.COLLECTION.POLICY}${key.slice(ONYXKEYS.COLLECTION.POLICY.length)}`;
        pairs.push([memberKey, value]);
    }
    for (const [key, value] of Object.entries(account.transactions)) {
        const memberKey: `${typeof ONYXKEYS.COLLECTION.TRANSACTION}${string}` = `${ONYXKEYS.COLLECTION.TRANSACTION}${key.slice(ONYXKEYS.COLLECTION.TRANSACTION.length)}`;
        pairs.push([memberKey, value]);
    }

    pairs.push([ONYXKEYS.PERSONAL_DETAILS_LIST, account.personalDetails]);
    pairs.push([ONYXKEYS.SESSION, account.session]);
    pairs.push([ONYXKEYS.ACCOUNT, account.account]);

    return pairs;
}

type PairsContext = {pairs: StorageKeyValuePair[]};

const multiSetReports = defineScenario({
    id: 'storage/idb/multiSet-reports',
    title: 'IDBKeyValProvider.multiSet of N report members in one transaction',
    realUsage: [
        {file: 'src/libs/actions/App.ts', line: 423, note: 'Onyx.multiSet, which lands in Storage.multiSet'},
        {file: 'src/libs/actions/ImportOnyxState.ts', line: 22, note: 'a whole imported state written through multiSet'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    setup: async (): Promise<PairsContext> => {
        initProvider();
        await provider.clear();
        return {pairs: buildReportPairs(getHeavyAccount())};
    },
    run: async (context, params) => {
        await provider.multiSet(context.pairs);
        return {pairs: params.reports};
    },
    teardown: async () => {
        await provider.clear();
    },
});

const setItemPersonalDetails = defineScenario({
    id: 'storage/idb/setItem-personal-details',
    title: 'IDBKeyValProvider.setItem of the whole personal details list with N entries, what every web merge of one person ends in',
    realUsage: [
        {file: 'src/libs/actions/PersonalDetails.ts', line: 127, note: 'a personal details merge; on web OnyxMerge stores the whole merged list with setItem'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'OpenApp and ReconnectApp merges of the list take the same path'},
    ],
    scale: (profile) => ({personalDetails: profile.personalDetails}),
    setup: async (): Promise<Record<string, never>> => {
        initProvider();
        await provider.clear();
        return {};
    },
    run: async (context, params) => {
        await provider.setItem(ONYXKEYS.PERSONAL_DETAILS_LIST, getHeavyAccount().personalDetails);
        return {entries: params.personalDetails};
    },
    teardown: async () => {
        await provider.clear();
    },
});

const getAllBoot = defineScenario({
    id: 'storage/idb/getAll-boot',
    title: 'IDBKeyValProvider.getAll over the whole stored account, the eager cache load Onyx.init performs at boot',
    realUsage: [{file: 'src/setup/index.ts', line: 45, note: 'Onyx.init, whose initializeWithDefaultKeyStates reads every stored key with Storage.getAll'}],
    scale: (profile) => ({reports: profile.reports, activeReports: profile.activeReports, personalDetails: profile.personalDetails}),
    measure: {warmupIterations: 3, minIterations: 10, maxIterations: 30, timeBudgetMs: 5000},
    setup: async (): Promise<PairsContext> => {
        initProvider();
        await provider.clear();
        const pairs = buildAccountPairs(getHeavyAccount());
        await provider.multiSet(pairs);
        return {pairs};
    },
    run: async (context) => {
        const rows = await provider.getAll();
        return {storedKeys: context.pairs.length, rowsRead: rows.length};
    },
    teardown: async () => {
        await provider.clear();
    },
});

type MultiGetContext = {keys: OnyxKey[]};

const MULTI_GET_MEMBERS = 100;

const multiGetMembers = defineScenario({
    id: 'storage/idb/multiGet-report-members',
    title: 'IDBKeyValProvider.multiGet of 100 report member keys out of a stored account',
    realUsage: [{file: 'src/setup/index.ts', line: 45, note: 'Onyx.init; OnyxUtils.multiGet is how a cold collection read reaches storage'}],
    scale: (profile) => ({reports: profile.reports, keys: Math.min(MULTI_GET_MEMBERS, profile.reports)}),
    setup: async (params): Promise<MultiGetContext> => {
        initProvider();
        await provider.clear();
        const account = getHeavyAccount();
        await provider.multiSet(buildAccountPairs(account));

        const keys: OnyxKey[] = [];
        const step = Math.max(1, Math.floor(account.reportIDs.length / params.keys));
        for (let index = 0; index < params.keys; index++) {
            const key: ReportKey = `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[index * step]}`;
            keys.push(key);
        }

        return {keys};
    },
    run: async (context, params) => {
        const rows = await provider.multiGet(context.keys);
        return {keys: params.keys, rowsRead: rows.length};
    },
    teardown: async () => {
        await provider.clear();
    },
});

type SignOutContext = {pairs: StorageKeyValuePair[]; keysToRemove: OnyxKey[]};

const removeItemsSignOut = defineScenario({
    id: 'storage/idb/removeItems-sign-out',
    title: 'IDBKeyValProvider.removeItems of every stored key but the preserved ones, the storage side of Onyx.clear on sign-out',
    realUsage: [{file: 'src/libs/actions/SignInRedirect.ts', line: 104, note: 'Onyx.clear(KEYS_TO_PRESERVE_ON_SIGN_OUT) on sign-out'}],
    scale: (profile) => ({reports: profile.reports, activeReports: profile.activeReports}),
    // The untimed reseed in beforeEach rewrites the whole account, which costs many times the removal itself.
    measure: {warmupIterations: 2, minIterations: 8, maxIterations: 16, timeBudgetMs: 6000},
    setup: async (): Promise<SignOutContext> => {
        initProvider();
        await provider.clear();
        const pairs = buildAccountPairs(getHeavyAccount());
        const preserved = new Set<OnyxKey>([ONYXKEYS.SESSION, ONYXKEYS.ACCOUNT]);
        const keysToRemove = pairs.map(([key]) => key).filter((key) => !preserved.has(key));
        return {pairs, keysToRemove};
    },
    beforeEach: async (context) => {
        await provider.multiSet(context.pairs);
    },
    run: async (context) => {
        await provider.removeItems(context.keysToRemove);
        return {keysRemoved: context.keysToRemove.length, keysPreserved: context.pairs.length - context.keysToRemove.length};
    },
    teardown: async () => {
        await provider.clear();
    },
});

runScenarios([multiSetReports, setItemPersonalDetails, getAllBoot, multiGetMembers, removeItemsSignOut]);
