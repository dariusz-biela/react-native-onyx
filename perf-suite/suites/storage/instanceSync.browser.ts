import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxKey} from 'react-native-onyx';
import type {StorageKeyValuePair} from 'react-native-onyx/dist/storage/providers/types';

import Onyx from 'react-native-onyx';

import type {HeavyAccount} from '../../fixtures/account';

import {readIDBCounters, resetIDBCounters, whenIDBIdle} from '../../browser/page/idbCounters';
import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {QUICK_MEASURE} from '../../harness/measureOptions';
import {waitForOnyx} from '../../harness/onyx';
import defineScenario from '../../harness/scenario';

type ReportKey = `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;

type ReceiveContext = {
    database: IDBDatabase;
    state: {revision: number; onSeen: (() => void) | undefined};
    keys: OnyxKey[];
};

/** The object store `IDBKeyValProvider` keeps every Onyx key in. */
const DB_NAME = 'OnyxDB';
const STORE_NAME = 'keyvaluepairs';

function remoteMessage(revision: number): string {
    return `remote ${revision}`;
}

/** What another tab's write left in IndexedDB: U report members and the personal details list, all changed. */
function buildRemotePairs(account: HeavyAccount, members: number, revision: number): StorageKeyValuePair[] {
    const pairs = account.reportIDs.slice(0, members).map((reportID): StorageKeyValuePair => {
        const key: ReportKey = `${ONYXKEYS.COLLECTION.REPORT}${reportID}`;
        return [key, {...account.reports[key], lastMessageText: remoteMessage(revision)}];
    });

    pairs.push([ONYXKEYS.PERSONAL_DETAILS_LIST, {...account.personalDetails}]);

    return pairs;
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Writes the pairs the way the other tab's Onyx would, on a connection of this row's own. */
function writeAsOtherTab(database: IDBDatabase, pairs: readonly StorageKeyValuePair[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        for (const [key, value] of pairs) {
            store.put(value, key);
        }

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * The receiving side of the cross-tab sync on web, in headless Chromium on its own IndexedDB (see
 * `browser/runner.ts`). The App leaves `shouldSyncMultipleInstances` at its default, on wherever `localStorage`
 * exists, so `Onyx.init` registers the real `storage` listener of `InstanceSync/index.web`. Each iteration
 * writes the other tab's values straight into IndexedDB, untimed, then dispatches the `storage` event the
 * other tab's `localStorage` write would raise. The timed region is the listener's coalescing timer, the
 * `multiGet` back out of IndexedDB and Onyx applying the pairs, until a connection on the last report member
 * sees the new value.
 */
const receiveSyncEvent = defineScenario({
    id: 'storage/web/instance-sync-receive',
    title: 'the receiving side of the web cross-tab sync in Chromium: one SYNC_ONYX storage event for U report members and the personal details list, read back from IndexedDB before Onyx applies them, one subscriber',
    realUsage: [
        {file: 'src/setup/index.ts', line: 45, note: 'Onyx.init without shouldSyncMultipleInstances, so web syncs every tab by default'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 128, note: 'a Pusher update another tab applies and this tab receives through the sync'},
    ],
    scale: (profile) => ({members: profile.updateBatchKeys, personalDetails: profile.personalDetails}),
    measure: QUICK_MEASURE,
    setup: async (params): Promise<ReceiveContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);
        await whenIDBIdle();

        const probeKey: ReportKey = `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[params.members - 1]}`;
        const state: ReceiveContext['state'] = {revision: 0, onSeen: undefined};

        Onyx.connect({
            key: probeKey,
            callback: (report) => {
                if (report?.lastMessageText === remoteMessage(state.revision)) {
                    state.onSeen?.();
                }
            },
        });
        await waitForOnyx();

        return {database: await openDatabase(), state, keys: []};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;

        const pairs = buildRemotePairs(getHeavyAccount(), params.members, context.state.revision);
        await writeAsOtherTab(context.database, pairs);
        context.keys = pairs.map(([key]) => key);
        resetIDBCounters();
    },
    run: async (context) => {
        const seen = new Promise<void>((resolve) => {
            context.state.onSeen = resolve;
        });

        window.dispatchEvent(new StorageEvent('storage', {key: 'SYNC_ONYX', newValue: JSON.stringify(context.keys)}));
        await seen;
        await waitForOnyx();

        const {reads, readTransactions} = readIDBCounters();
        return {keys: context.keys.length, reads, readTransactions};
    },
    teardown: async (context) => {
        context.database.close();
    },
});

export default [receiveSyncEvent];
