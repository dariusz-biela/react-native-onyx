import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxKey, OnyxValue} from 'react-native-onyx';

import Storage from 'react-native-onyx/dist/storage';

import type {HeavyAccount} from '../../fixtures/account';
import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import mountLoadedApp from '../../harness/loadedApp';
import {initOnyxForPerf, waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type OnStorageKeysChanged = Parameters<NonNullable<typeof Storage.keepInstancesSync>>[0];
type RemotePair = [OnyxKey, OnyxValue<OnyxKey>];

type InstanceSyncContext = {
    account: HeavyAccount;
    app: LoadedApp;
    applyRemoteWrite: OnStorageKeysChanged;
    pairs: RemotePair[];
    state: {revision: number};
};

/**
 * On web the App leaves `shouldSyncMultipleInstances` at its default, which is on wherever `localStorage`
 * exists, so every write another tab makes is applied here again: `Onyx.init` hands the storage layer a
 * handler that puts the changed pairs into the cache and notifies every subscriber, one `keysChanged` per
 * collection. The handler is a closure inside `Onyx.init`, so `setup` runs the App's init once more with the
 * storage layer's `keepInstancesSync` swapped for a function that keeps it.
 */
async function captureInstanceSyncHandler(): Promise<OnStorageKeysChanged> {
    let captured: OnStorageKeysChanged | undefined;

    Storage.keepInstancesSync = (handler) => {
        captured = handler;
    };

    try {
        initOnyxForPerf();
        await waitForOnyx();
    } finally {
        // The mock storage's own `keepInstancesSync` is a bare `jest.fn()`, so a fresh one restores it. Reading
        // the original back would not: in a hot-swap run it comes out of the shim as a late-bound wrapper that
        // calls whatever the property holds, and put back it would call itself on the next init.
        Storage.keepInstancesSync = jest.fn();
    }

    if (!captured) {
        throw new Error('subscriptions/instance-sync: Onyx.init did not register an instance sync handler; is localStorage missing from the environment?');
    }

    return captured;
}

/** What another tab's write of U report members plus two plain keys delivers: the stored values, not patches. */
function buildRemotePairs(account: HeavyAccount, members: number, revision: number): RemotePair[] {
    const pairs: RemotePair[] = account.reportIDs.slice(0, members).map((reportID): RemotePair => {
        const key: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}` = `${ONYXKEYS.COLLECTION.REPORT}${reportID}`;
        return [key, {...account.reports[key], lastMessageText: `remote ${revision}`}];
    });

    pairs.push([ONYXKEYS.SESSION, {...account.session, authToken: `remote-token-${revision}`}]);
    pairs.push([ONYXKEYS.NETWORK, {isOffline: false, timeSkew: revision}]);

    return pairs;
}

const applyRemoteBatch = defineScenario({
    id: 'subscriptions/instance-sync/apply-remote-batch',
    title: 'the instance sync handler applying another tab write of U report members and two plain keys on a loaded app, timed until every subscriber has settled',
    realUsage: [
        {file: 'src/setup/index.ts', line: 45, note: 'Onyx.init without shouldSyncMultipleInstances, so web syncs every tab by default'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 128, note: 'a Pusher update another tab applies and this tab receives through the sync'},
    ],
    scale: (profile) => ({members: profile.updateBatchKeys, reports: profile.reports, moduleListeners: profile.moduleListeners, hookComponents: profile.hookComponents}),
    measure: {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30},
    setup: async (params): Promise<InstanceSyncContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const applyRemoteWrite = await captureInstanceSyncHandler();
        const app = await mountLoadedApp({moduleListeners: params.moduleListeners, hookComponents: params.hookComponents});

        return {account, app, applyRemoteWrite, pairs: [], state: {revision: 0}};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;
        context.pairs = buildRemotePairs(context.account, params.members, context.state.revision);
        context.app.resetCounters();
    },
    run: async (context, params) => {
        await actAsync(async () => {
            context.applyRemoteWrite(context.pairs);
            await waitForOnyx();
        });

        return {...context.app.getCounters(), members: params.members, pairs: context.pairs.length};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([applyRemoteBatch]);
