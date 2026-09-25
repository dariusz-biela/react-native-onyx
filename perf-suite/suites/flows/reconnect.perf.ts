import Onyx from 'react-native-onyx';

import type {HeavyAccount} from '../../fixtures/account';
import type {ReconnectUpdate} from '../../fixtures/updates';
import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildReconnectDelta} from '../../fixtures/updates';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * Coming back online: the client asks for everything that changed while it was away and applies one delta
 * onto a store that is already full. Unlike the OpenApp batch this never lands in an empty store, so every
 * member of the `MERGE_COLLECTION` goes through the merge path against an existing value.
 */
type ReconnectContext = {
    account: HeavyAccount;
    app: LoadedApp;
    delta: ReconnectUpdate[];
    state: {revision: number};
};

/** The catalog row is "200 reports changed", capped by the profile so the small scale stays small. */
const CHANGED_REPORTS = 200;

const applyReconnectDelta = defineScenario({
    id: 'flows/reconnect/apply-delta',
    title: 'Onyx.update of a ReconnectApp-shaped delta (a report collection merge plus a few report-action merges) onto a loaded store',
    realUsage: [
        {file: 'src/libs/actions/App.ts', line: 461, note: 'reconnectApp, the request whose response this delta is'},
        {file: 'src/libs/actions/App.ts', line: 309, note: 'getOnyxDataForOpenOrReconnect builds the request shared by OpenApp and ReconnectApp'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 67, note: 'updateHandler(response.onyxData) applies the delta through Onyx.update'},
    ],
    scale: (profile) => ({
        reports: profile.reports,
        changedReports: Math.min(CHANGED_REPORTS, profile.reports),
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {timeBudgetMs: 5000, minIterations: 10, maxIterations: 25},
    setup: async (params): Promise<ReconnectContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const app = await mountLoadedApp({moduleListeners: params.moduleListeners, hookComponents: params.hookComponents});

        return {account, app, delta: [], state: {revision: 0}};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;
        context.delta = buildReconnectDelta(context.account, params.changedReports, context.state.revision);
        context.app.resetCounters();
    },
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.update(context.delta);
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, reportsWritten: params.changedReports, moduleListeners: context.app.mounted.moduleListeners, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([applyReconnectDelta]);
