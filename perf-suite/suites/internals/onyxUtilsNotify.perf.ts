import ONYXKEYS from '@app/ONYXKEYS';
import type {Report} from '@app/types';

import type {Connection, OnyxCollection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';
import OnyxUtils from 'react-native-onyx/dist/OnyxUtils';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The notification half of `OnyxUtils`: `keyChanged` for a single key and `keysChanged` for a
 * collection batch. Both are called directly here, with real subscribers registered through
 * `Onyx.connectWithoutView`, so the scan over the subscriber table is measured without the merge
 * queue and the storage write in front of it.
 */
type NotifyContext = {
    connections: Connection[];
    state: {callbacks: number; revision: number};
};

type KeysChangedContext = NotifyContext & {
    partialCollection: OnyxCollection<Report>;
    previousCollection: OnyxCollection<Report>;
};

const CHANGED_MEMBERS = 100;

// One notify call is a few microseconds, which is the same order as the harness's own async plumbing
// around the timed region. Both scenarios repeat the call so one sample is around a millisecond.
const KEY_NOTIFICATIONS_PER_SAMPLE = 100;
const COLLECTION_NOTIFICATIONS_PER_SAMPLE = 20;

function disconnectAll(context: NotifyContext): Promise<void> {
    for (const connection of context.connections) {
        Onyx.disconnect(connection);
    }

    return Promise.resolve();
}

const keyChangedScan = defineScenario({
    id: 'internals/OnyxUtils/keyChanged-scan',
    title: 'a hundred keyChanged calls for a key nobody watches while M subscribers are registered on other keys, the scan every write pays for',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1542, note: 'any write in a loaded app runs this scan over every live subscriber'},
        {file: 'src/libs/ApiUtils.ts', line: 23, note: 'Onyx.connectWithoutView on ACTIVE_SERVER, one of the 207 module listeners the scan walks'},
    ],
    scale: (profile) => ({moduleListeners: profile.moduleListeners, notificationsPerSample: KEY_NOTIFICATIONS_PER_SAMPLE}),
    // ONYX-PR#834 replaced keyChanged with OnyxSubscriptionManager notifications.
    requires: () => typeof OnyxUtils.keyChanged === 'function',
    setup: async (params): Promise<NotifyContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const state = {callbacks: 0, revision: 0};
        const connections: Connection[] = [];

        // Every listener watches a different report member, and the measured notification lands on a
        // key none of them watches, which is the common case in an app with many live subscribers.
        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[index % account.reportIDs.length]}`,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }

        return {connections, state};
    },
    beforeEach: async (context) => {
        context.state.callbacks = 0;
        context.state.revision++;
    },
    run: async (context, params) => {
        const value = context.state.revision % 2 === 0;

        for (let index = 0; index < KEY_NOTIFICATIONS_PER_SAMPLE; index++) {
            OnyxUtils.keyChanged(ONYXKEYS.IS_LOADING_APP, value);
        }

        return {moduleListeners: params.moduleListeners, notificationsPerSample: params.notificationsPerSample, listenerCallbacks: context.state.callbacks};
    },
    teardown: disconnectAll,
});

const keysChangedCollection = defineScenario({
    id: 'internals/OnyxUtils/keysChanged',
    title: 'twenty keysChanged calls for a batch of 100 report members while M subscribers watch the whole report collection',
    realUsage: [
        {file: 'src/libs/Middleware/SaveResponseInOnyx.ts', line: 27, note: 'the middleware that applies response.onyxData, whose collection merges end in keysChanged'},
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'a whole-collection report subscriber that keysChanged notifies once per batch'},
    ],
    scale: (profile) => ({moduleListeners: profile.moduleListeners, changedMembers: CHANGED_MEMBERS, notificationsPerSample: COLLECTION_NOTIFICATIONS_PER_SAMPLE}),
    // ONYX-PR#834 replaced keysChanged with OnyxSubscriptionManager notifications.
    requires: () => typeof OnyxUtils.keysChanged === 'function',
    setup: async (params): Promise<KeysChangedContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const state = {callbacks: 0, revision: 0};
        const connections: Connection[] = [];

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: ONYXKEYS.COLLECTION.REPORT,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }

        return {connections, state, partialCollection: {}, previousCollection: {}};
    },
    beforeEach: async (context) => {
        context.state.callbacks = 0;
        context.state.revision++;

        const account = getHeavyAccount();
        const partialCollection: OnyxCollection<Report> = {};
        const previousCollection: OnyxCollection<Report> = {};

        for (let index = 0; index < CHANGED_MEMBERS; index++) {
            const key: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}` = `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[index % account.reportIDs.length]}`;
            const report = account.reports[key];

            previousCollection[key] = report;
            partialCollection[key] = report ? {...report, lastMessageText: `revision ${context.state.revision}`} : undefined;
        }

        context.partialCollection = partialCollection;
        context.previousCollection = previousCollection;
    },
    run: async (context, params) => {
        // Nothing in the loop dirties the report collection, so every call reads the same clean collection
        // snapshot the single call used to read; only the subscriber notification is repeated.
        for (let index = 0; index < COLLECTION_NOTIFICATIONS_PER_SAMPLE; index++) {
            OnyxUtils.keysChanged(ONYXKEYS.COLLECTION.REPORT, context.partialCollection, context.previousCollection);
        }

        return {
            moduleListeners: params.moduleListeners,
            changedMembers: params.changedMembers,
            notificationsPerSample: params.notificationsPerSample,
            listenerCallbacks: context.state.callbacks,
        };
    },
    teardown: disconnectAll,
});

runScenarios([keyChangedScan, keysChangedCollection]);
