import mockStorage from 'react-native-onyx/dist/storage/__mocks__';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * `Onyx.init` has already run once in this process (the app's `jest/setupAfterEnv.ts`, then
 * `initOnyxForPerf`), and its deferred init task can only resolve once. To measure a real cold init the
 * scenario throws the whole Onyx module graph away with `jest.resetModules()` and requires a fresh one,
 * which brings a fresh `OnyxCache` and a fresh, unresolved deferred init task.
 *
 * `harness/onyx.ts` is re-required through the same reset, so the fresh instance is initialised with the
 * app's real init options rather than a copy of them. The storage layer survives the reset: `jest/setup.ts`
 * mocks it with a factory that closes over one `StorageMock` instance, so every module generation shares
 * the same in-memory store and a fresh init really does read the pairs seeded below.
 *
 * Timed region: `Onyx.init(...)` plus the wait until `OnyxUtils.getDeferredInitTask()` resolves, which is
 * `Storage.getAll()`, the per-key filtering loop, `cache.hydrate`, the default key state merge and
 * `addEvictableKeysToRecentlyAccessedList`. Requiring the fresh modules happens in `beforeEach` and is untimed.
 */
type OnyxUtilsApi = typeof import('react-native-onyx/dist/OnyxUtils').default;
type OnyxCacheApi = typeof import('react-native-onyx/dist/OnyxCache').default;
type OnyxHarnessApi = typeof import('../../harness/onyx');
type StoredPairs = ReturnType<typeof mockStorage.getMockStore>;

type FreshOnyx = {
    initOnyxForPerf: () => void;
    onyxUtils: OnyxUtilsApi;
    onyxCache: OnyxCacheApi;
};

type InitContext = {
    storedPairs: StoredPairs;
    keyCount: number;
    fresh: FreshOnyx | undefined;
};

function loadFreshOnyx(): FreshOnyx {
    jest.resetModules();

    const onyxHarness: OnyxHarnessApi = require('../../harness/onyx');
    const onyxUtilsModule: {default: OnyxUtilsApi} = require('react-native-onyx/dist/OnyxUtils');
    const onyxCacheModule: {default: OnyxCacheApi} = require('react-native-onyx/dist/OnyxCache');

    return {initOnyxForPerf: onyxHarness.initOnyxForPerf, onyxUtils: onyxUtilsModule.default, onyxCache: onyxCacheModule.default};
}

async function runInit(context: InitContext): Promise<{keysInStorage: number; keysHydrated: number}> {
    const fresh = context.fresh;

    if (!fresh) {
        throw new Error('api/init: the fresh Onyx module graph was not loaded in beforeEach.');
    }

    fresh.initOnyxForPerf();
    await fresh.onyxUtils.getDeferredInitTask().promise;

    // What the fresh cache holds after init; it must cover `keysInStorage`, or the fresh graph read an empty store.
    return {keysInStorage: context.keyCount, keysHydrated: fresh.onyxCache.getAllKeys().size};
}

const bootCold = defineScenario({
    id: 'api/init/boot-cold',
    title: 'Onyx.init of a freshly required Onyx with a heavy account already in storage, timed until the deferred init task resolves',
    realUsage: [
        {file: 'src/setup/index.ts', line: 45, note: 'the single Onyx.init call of the app, with the options harness/onyx.ts mirrors'},
        {file: 'src/libs/actions/App.ts', line: 423, note: 'the first writes that wait behind the deferred init task'},
    ],
    scale: (profile) => ({reports: profile.reports, personalDetails: profile.personalDetails, transactions: profile.transactions}),
    // Each iteration re-executes the whole Onyx module graph, so the loop stays short.
    measure: {warmupIterations: 2, minIterations: 8, maxIterations: 15, timeBudgetMs: 5000},
    setup: async (): Promise<InitContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const storedPairs = {...mockStorage.getMockStore()};

        return {storedPairs, keyCount: Object.keys(storedPairs).length, fresh: undefined};
    },
    beforeEach: async (context) => {
        mockStorage.setMockStore({...context.storedPairs});
        context.fresh = loadFreshOnyx();
    },
    run: runInit,
});

const bootEmpty = defineScenario({
    id: 'api/init/boot-empty',
    title: 'Onyx.init of a freshly required Onyx with empty storage, timed until the deferred init task resolves',
    realUsage: [
        {file: 'src/setup/index.ts', line: 45, note: 'the same init call on a first launch, when storage holds nothing yet'},
        {file: 'src/libs/actions/SignInRedirect.ts', line: 104, note: 'the sign-out clear that leaves storage close to this state for the next boot'},
    ],
    scale: () => ({}),
    sizeIndependent: 'a first launch reads an empty storage at every scale; api/init/boot-cold is the same init over the account of the scale',
    measure: {warmupIterations: 2, minIterations: 8, maxIterations: 15, timeBudgetMs: 5000},
    setup: async (): Promise<InitContext> => ({storedPairs: {}, keyCount: 0, fresh: undefined}),
    beforeEach: async (context) => {
        mockStorage.setMockStore({});
        context.fresh = loadFreshOnyx();
    },
    run: runInit,
});

runScenarios([bootCold, bootEmpty]);
