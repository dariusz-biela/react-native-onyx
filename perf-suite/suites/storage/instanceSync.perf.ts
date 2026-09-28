import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxKey} from 'react-native-onyx';
import type {StorageKeyValuePair} from 'react-native-onyx/dist/storage/providers/types';

import InstanceSyncWeb from 'react-native-onyx/dist/storage/InstanceSync/index.web.js';
import provider from 'react-native-onyx/dist/storage/providers/IDBKeyValProvider';

import type {HeavyAccount} from '../../fixtures/account';
import type {IDBModel} from '../../harness/idbModel';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import {buildCollectionMemberKeys} from '../../fixtures/keys';
import installIDBModel from '../../harness/idbModel';
import captureInstanceSyncHandler from '../../harness/instanceSync';
import {QUICK_MEASURE} from '../../harness/measure';
import {waitForOnyx} from '../../harness/onyx';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type RaiseEventsContext = {
    memberKeys: OnyxKey[];
    storeKeys: OnyxKey[];
};

/**
 * The sending side of the cross-tab sync on web, paid by every storage write even with one tab open: the
 * key list goes through `JSON.stringify` and a `localStorage` setItem and removeItem pair. Jest resolves
 * the native variant (a no-op), so the web one is loaded through its explicit path, the recipe
 * `internals/OnyxMerge/apply-web` uses. jsdom's `localStorage` is not a browser's, so read the row for the
 * Onyx share of the cost.
 */
const raiseSyncEvents = defineScenario({
    id: 'storage/instance-sync/raise-events',
    title: 'the web InstanceSync events of one write: multiSet of U member keys, one setItem, and the removeItems of every stored key that a sign-out clear raises',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 128, note: 'a Pusher update, whose storage writes raise the multiSet event'},
        {file: 'src/libs/actions/SignInRedirect.ts', line: 104, note: 'the sign-out clear, which raises every removed key in one batch'},
    ],
    scale: (profile) => ({members: profile.updateBatchKeys, storeKeys: storeKeyCount(profile)}),
    setup: async (params): Promise<RaiseEventsContext> => {
        const account = getHeavyAccount();
        const memberKeys = account.reportIDs.slice(0, params.members).map((reportID): OnyxKey => `${ONYXKEYS.COLLECTION.REPORT}${reportID}`);

        return {memberKeys, storeKeys: buildCollectionMemberKeys(params.storeKeys)};
    },
    run: async (context, params) => {
        InstanceSyncWeb.multiSet(context.memberKeys);
        InstanceSyncWeb.setItem(ONYXKEYS.SESSION);
        InstanceSyncWeb.removeItems(context.storeKeys);

        return {members: params.members, storeKeys: params.storeKeys};
    },
});

type StorageListener = (event: StorageEvent) => void;

/**
 * Runs the web `InstanceSync.init` with `addEventListener` stubbed, so its `storage` listener is kept instead of
 * registered: a listener left on the shared jsdom window would fire again for every later row and every arm.
 */
function captureStorageListener(register: () => void): StorageListener {
    let captured: EventListenerOrEventListenerObject | undefined;
    const addEventListener = jest.spyOn(globalThis, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (type === 'storage' && listener) {
            captured = listener;
        }
    });

    try {
        register();
    } finally {
        addEventListener.mockRestore();
    }

    const listener = captured;
    if (!listener) {
        throw new Error('captureStorageListener: InstanceSync.init registered no storage listener');
    }

    return (event) => (typeof listener === 'function' ? listener(event) : listener.handleEvent(event));
}

type ReceiveContext = {
    model: IDBModel;
    listener: StorageListener;
    state: {revision: number; settle: (() => void) | undefined; settled: Promise<void>};
    keys: OnyxKey[];
};

/** What another tab's write left in IndexedDB: U report members and the personal details list, all changed. */
function buildRemotePairs(account: HeavyAccount, members: number, revision: number): StorageKeyValuePair[] {
    const pairs = account.reportIDs.slice(0, members).map((reportID): StorageKeyValuePair => {
        const key: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}` = `${ONYXKEYS.COLLECTION.REPORT}${reportID}`;
        return [key, {...account.reports[key], lastMessageText: `remote ${revision}`}];
    });

    pairs.push([ONYXKEYS.PERSONAL_DETAILS_LIST, {...account.personalDetails}]);

    return pairs;
}

const receiveSyncEvent = defineScenario({
    id: 'storage/instance-sync/receive',
    title: 'the receiving side of the web cross-tab sync: one SYNC_ONYX event for U report members and the personal details list, read back from IndexedDB (modelled) before Onyx applies them, with no subscribers',
    realUsage: [
        {file: 'src/setup/index.ts', line: 45, note: 'Onyx.init without shouldSyncMultipleInstances, so web syncs every tab by default'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 128, note: 'a Pusher update another tab applies and this tab receives through the sync'},
    ],
    scale: (profile) => ({members: profile.updateBatchKeys, personalDetails: profile.personalDetails}),
    measure: QUICK_MEASURE,
    setup: async (): Promise<ReceiveContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const applyRemoteWrite = await captureInstanceSyncHandler();
        const state: ReceiveContext['state'] = {revision: 0, settle: undefined, settled: Promise.resolve()};
        const listener = captureStorageListener(() =>
            InstanceSyncWeb.init((pairs) => {
                applyRemoteWrite(pairs);
                state.settle?.();
            }, provider),
        );

        return {model: installIDBModel(), listener, state, keys: []};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;

        const pairs = buildRemotePairs(getHeavyAccount(), params.members, context.state.revision);
        context.model.seed(pairs);
        context.keys = pairs.map(([key]) => key);
        context.state.settled = new Promise((resolve) => {
            context.state.settle = resolve;
        });
        context.model.resetCounters();
    },
    run: async (context) => {
        context.listener(new StorageEvent('storage', {key: 'SYNC_ONYX', newValue: JSON.stringify(context.keys)}));
        await context.state.settled;
        await waitForOnyx();

        return {keys: context.keys.length, reads: context.model.counters.reads};
    },
    teardown: async (context) => {
        context.model.uninstall();
    },
});

runScenarios([raiseSyncEvents, receiveSyncEvent]);
