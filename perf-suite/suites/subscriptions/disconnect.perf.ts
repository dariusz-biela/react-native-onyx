import ONYXKEYS from '@app/ONYXKEYS';

import type {Connection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type DisconnectContext = {
    connections: Connection[];
};

const WATCHED_KEYS = [ONYXKEYS.SESSION, ONYXKEYS.NETWORK, ONYXKEYS.ACCOUNT, ONYXKEYS.COLLECTION.REPORT, ONYXKEYS.PERSONAL_DETAILS_LIST, ONYXKEYS.COLLECTION.POLICY];

const disconnectAllListeners = defineScenario({
    id: 'subscriptions/disconnect/all',
    title: 'Onyx.disconnect of M live module listeners spread over six keys, one call after another',
    realUsage: [
        {file: 'src/libs/actions/OnyxDerived/index.ts', line: 53, note: 'the disconnect every derived value does right after its first callback'},
        {file: 'src/libs/Network/SequentialQueue.ts', line: 652, note: 'disconnect inside the callback of a one-shot connection'},
        {file: 'src/libs/actions/TransactionEdit.ts', line: 44, note: 'another disconnect-in-callback site, 32 in src/ in total'},
    ],
    scale: (profile) => ({moduleListeners: profile.moduleListeners}),
    setup: async (): Promise<DisconnectContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {connections: []};
    },
    beforeEach: async (context, params) => {
        const connections: Connection[] = [];

        for (let index = 0; index < params.moduleListeners; index++) {
            connections.push(
                Onyx.connectWithoutView({
                    key: WATCHED_KEYS[index % WATCHED_KEYS.length],
                    callback: () => {},
                    // Without this the manager would fold every listener on a key into one connection, and the
                    // measured disconnects would only be deleting callbacks out of a single map.
                    reuseConnection: false,
                }),
            );
        }

        context.connections = connections;
    },
    run: async (context, params) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }

        context.connections = [];

        return {disconnected: params.moduleListeners};
    },
});

runScenarios([disconnectAllListeners]);
