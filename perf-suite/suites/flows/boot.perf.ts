import type {Connection} from 'react-native-onyx';

import mockStorage from 'react-native-onyx/dist/storage/__mocks__';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {distributeByWeight, MODULE_LISTENER_KEYS} from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * App boot: hydrate the store from disk, then let every module-level `Onyx.connectWithoutView` of the
 * booted app attach and receive its first value.
 *
 * The cold-init recipe is the one `suites/api/init.perf.ts` documents and it composes here unchanged:
 * `Onyx.init` can only resolve its deferred init task once per module instance, so the scenario throws the
 * whole Onyx module graph away with `jest.resetModules()` and requires a fresh one. The listeners have to
 * be attached through that *fresh* module too, which is why this file connects them by hand out of
 * `MODULE_LISTENER_KEYS` instead of calling `mountLoadedApp`: the helper closes over the stale module.
 *
 * Timed region: `Onyx.init(...)`, the wait until the deferred init task resolves, the M `connectWithoutView`
 * calls and the drain that lets their first callbacks run.
 */
type OnyxApi = typeof import('react-native-onyx').default;
type OnyxUtilsApi = typeof import('react-native-onyx/dist/OnyxUtils').default;
type OnyxCacheApi = typeof import('react-native-onyx/dist/OnyxCache').default;
type OnyxHarnessApi = typeof import('../../harness/onyx');
type StoredPairs = ReturnType<typeof mockStorage.getMockStore>;

type FreshOnyx = {
    initOnyxForPerf: () => void;
    onyxUtils: OnyxUtilsApi;
    onyxCache: OnyxCacheApi;
    onyx: OnyxApi;
};

type BootContext = {
    storedPairs: StoredPairs;
    keyCount: number;
    fresh: FreshOnyx | undefined;
    connections: Connection[];
};

function loadFreshOnyx(): FreshOnyx {
    jest.resetModules();

    const onyxHarness: OnyxHarnessApi = require('../../harness/onyx');
    const onyxUtilsModule: {default: OnyxUtilsApi} = require('react-native-onyx/dist/OnyxUtils');
    const onyxCacheModule: {default: OnyxCacheApi} = require('react-native-onyx/dist/OnyxCache');
    const onyxModule: {default: OnyxApi} = require('react-native-onyx');

    return {initOnyxForPerf: onyxHarness.initOnyxForPerf, onyxUtils: onyxUtilsModule.default, onyxCache: onyxCacheModule.default, onyx: onyxModule.default};
}

/** The M module listeners of a booted app, spread over the keys with the most call sites, through the fresh module. */
function connectModuleListeners(fresh: FreshOnyx, count: number, connections: Connection[], state: {callbacks: number}): void {
    const listenerCounts = distributeByWeight(
        count,
        MODULE_LISTENER_KEYS.map((entry) => entry.weight),
    );

    MODULE_LISTENER_KEYS.forEach(({key}, keyIndex) => {
        for (let index = 0; index < listenerCounts[keyIndex]; index++) {
            connections.push(
                fresh.onyx.connectWithoutView({
                    key,
                    callback: () => {
                        state.callbacks++;
                    },
                }),
            );
        }
    });
}

function requireFresh(context: BootContext): FreshOnyx {
    if (!context.fresh) {
        throw new Error('flows/boot: the fresh Onyx module graph was not loaded in beforeEach.');
    }

    return context.fresh;
}

async function setupBoot(): Promise<BootContext> {
    await seedOnyxWithAccount(getHeavyAccount());

    const storedPairs = {...mockStorage.getMockStore()};

    return {storedPairs, keyCount: Object.keys(storedPairs).length, fresh: undefined, connections: []};
}

async function beforeEachBoot(context: BootContext): Promise<void> {
    mockStorage.setMockStore({...context.storedPairs});
    context.fresh = loadFreshOnyx();
    context.connections = [];
}

async function afterEachBoot(context: BootContext): Promise<void> {
    const fresh = context.fresh;

    if (!fresh) {
        return;
    }

    for (const connection of context.connections) {
        fresh.onyx.disconnect(connection);
    }
}

const bootHydrateAndSubscribe = defineScenario({
    id: 'flows/boot/hydrate-and-first-subscribers',
    title: 'a cold Onyx.init over a stored heavy account followed by the M module listeners of a booted app, timed until every listener has had its first callback',
    realUsage: [
        {file: 'src/setup/index.ts', line: 45, note: 'the single Onyx.init of the app, with the options harness/onyx.ts mirrors'},
        {file: 'src/libs/Network/NetworkStore.ts', line: 44, note: 'one of the module-level connectWithoutView calls that run as soon as the bundle is evaluated'},
        {file: 'src/libs/ApiUtils.ts', line: 23, note: 'another boot-time module listener, on a key that is only in storage at that point'},
    ],
    scale: (profile) => ({reports: profile.reports, personalDetails: profile.personalDetails, moduleListeners: profile.moduleListeners}),
    // Every iteration re-executes the whole Onyx module graph and re-hydrates the store, so the loop stays short.
    measure: {warmupIterations: 2, minIterations: 6, maxIterations: 12, timeBudgetMs: 8000},
    setup: setupBoot,
    beforeEach: beforeEachBoot,
    run: async (context, params) => {
        const fresh = requireFresh(context);
        const state = {callbacks: 0};

        fresh.initOnyxForPerf();
        await fresh.onyxUtils.getDeferredInitTask().promise;

        connectModuleListeners(fresh, params.moduleListeners, context.connections, state);

        // Two drains rather than one: the first lets the connection callbacks scheduled on `nextTick` run,
        // the second catches anything those callbacks scheduled in turn.
        await waitForOnyx();
        await waitForOnyx();

        return {keysInStorage: context.keyCount, keysHydrated: fresh.onyxCache.getAllKeys().size, moduleListeners: context.connections.length, moduleCallbacks: state.callbacks};
    },
    afterEach: afterEachBoot,
});

/**
 * The order the App really boots in: the bundle evaluates every module-level `connectWithoutView` before
 * `src/setup/index.ts` calls `Onyx.init`, so the listeners wait on the deferred init task and are served
 * once hydration is done. `flows/boot/hydrate-and-first-subscribers` connects after init and misses that
 * path.
 */
const bootListenersBeforeInit = defineScenario({
    id: 'flows/boot/listeners-before-init',
    title: 'M module listeners connected on a fresh Onyx before a cold Onyx.init over the stored account, timed until init resolved and every listener has had its first callback',
    realUsage: [
        {file: 'src/libs/SessionUtils.ts', line: 73, note: 'a module-level connectWithoutView that runs when the bundle is evaluated, before init'},
        {file: 'src/libs/ApiUtils.ts', line: 23, note: 'another import-time listener on a key only storage holds at that point'},
        {file: 'src/setup/index.ts', line: 45, note: 'the Onyx.init those listeners wait for'},
    ],
    scale: (profile) => ({reports: profile.reports, personalDetails: profile.personalDetails, moduleListeners: profile.moduleListeners}),
    measure: {warmupIterations: 2, minIterations: 6, maxIterations: 12, timeBudgetMs: 8000},
    setup: setupBoot,
    beforeEach: beforeEachBoot,
    run: async (context, params) => {
        const fresh = requireFresh(context);
        const state = {callbacks: 0};

        connectModuleListeners(fresh, params.moduleListeners, context.connections, state);

        fresh.initOnyxForPerf();
        await fresh.onyxUtils.getDeferredInitTask().promise;

        await waitForOnyx();
        await waitForOnyx();

        return {keysInStorage: context.keyCount, keysHydrated: fresh.onyxCache.getAllKeys().size, moduleListeners: context.connections.length, moduleCallbacks: state.callbacks};
    },
    afterEach: afterEachBoot,
});

runScenarios([bootHydrateAndSubscribe, bootListenersBeforeInit]);
