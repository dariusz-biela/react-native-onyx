import Onyx from 'react-native-onyx';

import type {HeavyAccount} from '../../fixtures/account';
import type {ReportUpdate} from '../../fixtures/updates';
import type {LoadedApp} from '../../harness/loadedApp';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildPusherBurst} from '../../fixtures/updates';
import mountLoadedApp from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync} from '../../harness/react';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * A Pusher burst while the user is idle on a loaded app. `applyPusherOnyxUpdates` chains one update per
 * event onto a promise, so the events are applied strictly one after another rather than as one batch, and
 * every one of them notifies the subscribers on its own. That sequencing is what the scenario reproduces:
 * `BURST_EVENTS` separate `Onyx.update` calls, each awaited, all inside one React `act`.
 */
type PusherContext = {
    account: HeavyAccount;
    app: LoadedApp;
    events: ReportUpdate[];
    state: {revision: number};
};

const BURST_EVENTS = 30;

const applyPusherBurst = defineScenario({
    id: 'flows/pusher/burst',
    title: 'thirty Pusher-shaped updates applied one after another on a loaded app, timed until the last subscriber and component has settled',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 108, note: 'applyPusherOnyxUpdates chains one update per event onto a single promise'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 128, note: 'the Airship twin, which calls Onyx.update(update.data) per event directly'},
        {file: 'src/libs/PusherUtils.ts', line: 27, note: 'triggerMultiEventHandler, the per-event handler that ends in an Onyx write'},
    ],
    scale: (profile) => ({
        events: BURST_EVENTS,
        reports: profile.reports,
        moduleListeners: profile.moduleListeners,
        hookComponents: profile.hookComponents,
    }),
    measure: {timeBudgetMs: 5000, minIterations: 10, maxIterations: 25},
    setup: async (params): Promise<PusherContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const app = await mountLoadedApp({moduleListeners: params.moduleListeners, hookComponents: params.hookComponents});

        return {account, app, events: [], state: {revision: 0}};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;
        context.events = buildPusherBurst(context.account, params.events, context.state.revision);
        context.app.resetCounters();
    },
    run: async (context, params) => {
        for (const event of context.events) {
            // One `act` per event, matching the promise chain in applyPusherOnyxUpdates: the events are
            // applied one after another and React commits between them, rather than being batched into one.
            // eslint-disable-next-line no-await-in-loop
            await actAsync(async () => {
                await Onyx.update([event]);
            });
        }

        await actAsync(async () => {
            await waitForOnyx();
        });

        const counters = context.app.getCounters();

        return {...counters, eventsApplied: params.events, moduleListeners: context.app.mounted.moduleListeners, hookComponents: context.app.mounted.hookComponents};
    },
    teardown: async (context) => {
        await context.app.unmount();
    },
});

runScenarios([applyPusherBurst]);
