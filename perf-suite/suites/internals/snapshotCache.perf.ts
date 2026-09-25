import ONYXKEYS from '@app/ONYXKEYS';
import type {Session} from '@app/types';
import {sessionEmailAndAccountIDSelector} from '@app/selectors';

import type {OnyxEntry, OnyxKey, OnyxValue} from 'react-native-onyx';
import type OnyxSnapshotCacheInstance from 'react-native-onyx/dist/OnyxSnapshotCache';
import type {ResultMetadata, UseOnyxResult} from 'react-native-onyx/dist/useOnyx';

import {getHeavyAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * `OnyxSnapshotCache` is the per-key result cache the baseline `useOnyx` reads on every `getSnapshot`.
 * The candidate's rewritten hook keeps its result on the slot instead and never touches this module,
 * so this scenario measures a live code path on one arm and a module nothing calls on the other,
 * which is exactly the comparison the catalog asks for.
 *
 * The module is loaded through a guarded `require` because an arm is free not to ship it. When it is
 * missing the scenario does no work and reports `skipped: 1` instead of failing the run: a scenario
 * that throws would take the whole suite file down with it.
 */
type SnapshotCache = typeof OnyxSnapshotCacheInstance;

type SnapshotCacheContext = {
    snapshotCache: SnapshotCache | undefined;
    cachedResult: UseOnyxResult<OnyxValue<OnyxKey>>;
    cacheKeys: string[];
    state: {revision: number};
};

const LOADED_METADATA: ResultMetadata = {status: 'loaded'};

/** The largest K of any profile; a scale uses the first K selectors. */
const MAX_CONSUMERS = 300;

/** Selectors handed to `registerConsumer`, each one a distinct identity the way separate call sites are. */
const SELECTORS: Array<(session: OnyxEntry<Session>) => unknown> = [];
for (let index = 0; index < MAX_CONSUMERS; index++) {
    SELECTORS.push((session: OnyxEntry<Session>) => ({...sessionEmailAndAccountIDSelector(session), index}));
}

function loadSnapshotCache(): SnapshotCache | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const module: {default: SnapshotCache} = require('react-native-onyx/dist/OnyxSnapshotCache');
        return module.default;
    } catch {
        return undefined;
    }
}

const registerAndInvalidate = defineScenario({
    id: 'internals/OnyxSnapshotCache/register-invalidate',
    title: 'register K consumers on the session key, invalidate it and read every cache entry back, the baseline useOnyx snapshot cache',
    realUsage: [
        {file: 'src/hooks/useOnyx.ts', line: 75, note: 'every hook registers a consumer here on mount and reads the cache on every getSnapshot'},
        {file: 'src/pages/inbox/sidebar/FABPopoverContent/menuItems/CreateReportMenuItem.tsx', line: 44, note: 'a selector call site, whose selector identity becomes part of the cache key'},
    ],
    // One consumer per hook on the key, so K of the scale.
    scale: (profile) => ({consumers: Math.min(MAX_CONSUMERS, profile.hookComponents)}),
    setup: async (): Promise<SnapshotCacheContext> => ({
        snapshotCache: loadSnapshotCache(),
        cachedResult: [getHeavyAccount().session, LOADED_METADATA],
        cacheKeys: [],
        state: {revision: 0},
    }),
    beforeEach: async (context) => {
        context.state.revision++;

        if (!context.snapshotCache) {
            return;
        }

        for (const cacheKey of context.cacheKeys) {
            context.snapshotCache.deregisterConsumer(ONYXKEYS.SESSION, cacheKey);
        }

        context.cacheKeys = [];
    },
    run: async (context, params) => {
        const {snapshotCache} = context;

        if (!snapshotCache) {
            return {consumers: params.consumers, skipped: 1, cached: 0};
        }

        const cacheKeys: string[] = [];

        for (const selector of SELECTORS.slice(0, params.consumers)) {
            const cacheKey = snapshotCache.registerConsumer(ONYXKEYS.SESSION, {selector});
            cacheKeys.push(cacheKey);
            snapshotCache.setCachedResult(ONYXKEYS.SESSION, cacheKey, context.cachedResult);
        }

        snapshotCache.invalidateForKey(ONYXKEYS.SESSION);

        let cached = 0;
        for (const cacheKey of cacheKeys) {
            if (snapshotCache.getCachedResult(ONYXKEYS.SESSION, cacheKey)) {
                cached++;
            }
        }

        context.cacheKeys = cacheKeys;

        return {consumers: params.consumers, skipped: 0, cached};
    },
    teardown: async (context) => {
        context.snapshotCache?.clear();
    },
});

runScenarios([registerAndInvalidate]);
