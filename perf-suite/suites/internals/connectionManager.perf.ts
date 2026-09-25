import ONYXKEYS from '@app/ONYXKEYS';

import type {Connection} from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import requireOnyxModule from '../../harness/optionalOnyxModule';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

// Removed by ONYX-PR#834, so the file is skipped on arms built from it (see runScenarios below).
const connectionManager = requireOnyxModule<typeof import('react-native-onyx/dist/OnyxConnectionManager')>('OnyxConnectionManager').default;

/**
 * `OnyxConnectionManager` sits between every subscriber and `OnyxUtils.subscribeToKey`: it generates
 * a connection id per configuration, reuses an existing connection for the same one and refreshes the
 * session id on `Onyx.clear()`, which forces every later subscriber to build a fresh connection.
 */
type ConnectionContext = {
    state: {callbacks: number; revision: number};
};

const CYCLES = 1000;

const connectDisconnectCycles = defineScenario({
    id: 'internals/OnyxConnectionManager/connect-disconnect',
    title: 'one thousand connect plus disconnect cycles on a warm key, then refreshSessionID with the module listeners and hooks of the scale live',
    realUsage: [
        {file: 'src/hooks/useOnyx.ts', line: 75, note: 'every hook mount and unmount is a connect and a disconnect through this manager'},
        {file: 'src/libs/actions/SignInRedirect.ts', line: 104, note: 'the sign-out clear, which refreshes the session id while every subscriber is still live'},
    ],
    // refreshSessionID walks every live connection: the module listeners and hooks of a booted app at the scale.
    scale: (profile) => ({cycles: CYCLES, liveConnections: profile.moduleListeners + profile.hookComponents}),
    setup: async (): Promise<ConnectionContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {callbacks: 0, revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.callbacks = 0;
        context.state.revision++;
    },
    run: async (context, params) => {
        for (let index = 0; index < CYCLES; index++) {
            const connection: Connection = connectionManager.connect({
                key: ONYXKEYS.SESSION,
                callback: () => {
                    context.state.callbacks++;
                },
            });
            connectionManager.disconnect(connection);
        }

        const live: Connection[] = [];
        for (let index = 0; index < params.liveConnections; index++) {
            live.push(
                connectionManager.connect({
                    key: `${ONYXKEYS.COLLECTION.REPORT}${index + 1}`,
                    callback: () => {
                        context.state.callbacks++;
                    },
                }),
            );
        }

        connectionManager.refreshSessionID();

        for (const connection of live) {
            connectionManager.disconnect(connection);
        }

        return {cycles: params.cycles, liveConnections: params.liveConnections, callbacks: context.state.callbacks};
    },
    teardown: async () => {
        connectionManager.disconnectAll();
    },
});

runScenarios([connectDisconnectCycles], {requiresOnyxModules: ['OnyxConnectionManager']});
