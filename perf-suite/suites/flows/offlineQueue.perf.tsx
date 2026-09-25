import ONYXKEYS from '@app/ONYXKEYS';
import type {Request} from '@app/types';

import type {Connection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The offline queue is one array under `PERSISTED_REQUESTS`, rewritten whole with `Onyx.set` on every
 * enqueue, dequeue and conflict resolution. After an hour offline it holds hundreds of requests, each
 * carrying its optimistic, success and failure data, so one more message costs a set of the entire
 * queue plus the listeners the queue itself keeps on that key. The timed region is one enqueue at a
 * queue length of R, with the loaded app mounted and the queue's own subscribers attached.
 */
type OfflineQueueContext = {
    app: LoadedApp;
    connections: Connection[];
    queue: Request<typeof ONYXKEYS.COLLECTION.REPORT>[];
    state: {revision: number; queueCallbacks: number};
};

type QueuedRequest = Request<typeof ONYXKEYS.COLLECTION.REPORT>;

function buildRequest(index: number, revision: number): QueuedRequest {
    const reportID = String((index % 50) + 1);
    const reportKey: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}` = `${ONYXKEYS.COLLECTION.REPORT}${reportID}`;
    const text = `offline message ${revision}-${index}`;

    return {
        command: 'AddComment',
        data: {reportID, reportActionID: `offline-${revision}-${index}`, reportComment: text, clientCreatedTime: `2026-09-17 12:00:${String(index % 60).padStart(2, '0')}.000`},
        initiatedOffline: true,
        optimisticData: [{onyxMethod: Onyx.METHOD.MERGE, key: reportKey, value: {lastMessageText: text, lastVisibleActionCreated: '2026-09-17 12:00:00.000'}}],
        successData: [{onyxMethod: Onyx.METHOD.MERGE, key: reportKey, value: {pendingFields: null}}],
        failureData: [{onyxMethod: Onyx.METHOD.MERGE, key: reportKey, value: {errorFields: {addComment: {error: 'failed'}}}}],
    };
}

function buildQueue(length: number, revision: number): QueuedRequest[] {
    const queue: QueuedRequest[] = [];
    for (let index = 0; index < length; index++) {
        queue.push(buildRequest(index, revision));
    }
    return queue;
}

const offlineQueueEnqueue = defineScenario({
    id: 'flows/offline-queue/enqueue',
    title: 'one Onyx.set of the persisted request queue with R requests already in it, the queue listeners and the loaded app mounted',
    realUsage: [
        {file: 'src/libs/actions/PersistedRequests.ts', line: 88, note: 'save() rewrites the whole queue with Onyx.set on every enqueue'},
        {file: 'src/libs/actions/PersistedRequests.ts', line: 61, note: 'the module listener the queue keeps on its own key'},
        {file: 'src/libs/Network/SequentialQueue.ts', line: 643, note: 'the second module listener on the same key'},
        {file: 'src/hooks/useInFlightRequests.ts', line: 101, note: 'a hook reading the queue through a selector'},
    ],
    scale: (profile) => ({queuedRequests: profile.updateBatchKeys * 5, moduleListeners: profile.moduleListeners, hookComponents: profile.hookComponents}),
    measure: {warmupIterations: 4, minIterations: 10, maxIterations: 30, timeBudgetMs: 5000},
    setup: async (params): Promise<OfflineQueueContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const app = await mountLoadedApp({
            moduleListeners: params.moduleListeners,
            hookComponents: params.hookComponents,
            extraKeys: [ONYXKEYS.PERSISTED_REQUESTS],
        });

        const state = {revision: 0, queueCallbacks: 0};
        const connections = [0, 1].map(() =>
            Onyx.connectWithoutView({
                key: ONYXKEYS.PERSISTED_REQUESTS,
                callback: () => {
                    state.queueCallbacks++;
                },
            }),
        );
        await waitForOnyx();

        return {app, connections, queue: [], state};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;
        context.queue = buildQueue(params.queuedRequests, context.state.revision);

        await Onyx.set(ONYXKEYS.PERSISTED_REQUESTS, context.queue);
        await waitForOnyx();

        context.app.resetCounters();
        context.state.queueCallbacks = 0;
    },
    run: async (context, params) => {
        const nextQueue = [...context.queue, buildRequest(params.queuedRequests, context.state.revision)];

        await actAsync(async () => {
            await Onyx.set(ONYXKEYS.PERSISTED_REQUESTS, nextQueue);
            await waitForOnyx();
        });

        return {...context.app.getCounters(), queuedRequests: params.queuedRequests, queueCallbacks: context.state.queueCallbacks};
    },
    teardown: async (context) => {
        for (const connection of context.connections) {
            Onyx.disconnect(connection);
        }
        await context.app.unmount();
    },
});

runScenarios([offlineQueueEnqueue]);
