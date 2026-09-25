import ONYXKEYS from '@app/ONYXKEYS';

import type {Connection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type ReuseContext = {
    connections: Connection[];
};

const CONNECT_COUNT = 100;

/**
 * With `reuseConnection: false` every call gets its own connection ID (a fresh guid suffix), so each one
 * builds its own connection metadata and its own `OnyxUtils.subscribeToKey` subscription. The default,
 * measured by `api/connect-disconnect/churn`, collapses repeat connects on a live connection into one
 * subscription and an extra callback entry.
 */
const connectWithoutReuse = defineScenario({
    id: 'subscriptions/reuseConnection/false',
    title: 'one hundred connectWithoutView calls with reuseConnection false on one warm key, each one a separate subscription',
    realUsage: [
        {file: 'src/libs/Network/SequentialQueue.ts', line: 646, note: 'the only reuseConnection: false site in src/, opting out to avoid extra callback calls'},
        {file: 'src/libs/actions/PersistedRequests.ts', line: 60, note: 'the existing connection on the same key that site is avoiding'},
    ],
    scale: (profile) => ({connects: CONNECT_COUNT, storeKeys: storeKeyCount(profile)}),
    setup: async (): Promise<ReuseContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {connections: []};
    },
    run: async (context, params) => {
        const connections: Connection[] = [];

        for (let index = 0; index < CONNECT_COUNT; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: ONYXKEYS.PERSISTED_REQUESTS,
                    reuseConnection: false,
                    callback: () => {},
                }),
            );
        }

        context.connections = connections;

        return {connectsMade: params.connects};
    },
    afterEach: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }

        context.connections = [];
    },
});

runScenarios([connectWithoutReuse]);
