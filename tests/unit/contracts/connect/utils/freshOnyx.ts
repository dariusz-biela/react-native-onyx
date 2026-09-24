import type OnyxDefault from '../../../../../lib';
import type OnyxCache from '../../../../../lib/OnyxCache';
import type OnyxConnectionManager from '../../../../../lib/OnyxConnectionManager';
import type OnyxUtilsDefault from '../../../../../lib/OnyxUtils';
import type StorageMock from '../../../../../lib/storage';
import type {InitOptions} from '../../../../../lib/types';
import waitForPromisesToResolve from '../../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN: 'plain',
    PLAIN_2: 'plain2',
    // Not a collection member: no collection key 'nvp_' is registered.
    WITH_UNDERSCORE: 'nvp_plain',
    WITH_DEFAULT: 'withDefault',
    RAM_ONLY: 'ramOnly',
    COLLECTION: {
        REPORT: 'report_',
        // Prefix-collides with REPORT: its members also start with 'report_'.
        REPORT_NESTED: 'report_nested_',
        // Shares the 'report' prefix without the underscore boundary.
        REPORT_ACTIONS: 'reportActions_',
        EMPTY: 'empty_',
    },
} as const;

type OnyxModules = {
    Onyx: typeof OnyxDefault;
    cache: typeof OnyxCache;
    storage: typeof StorageMock;
    connectionManager: typeof OnyxConnectionManager;
    OnyxUtils: typeof OnyxUtilsDefault;
};

type StartOptions = Omit<InitOptions, 'keys'> & {
    storedValues?: Record<string, unknown>;
};

/** Returns Onyx modules from a fresh module registry so no state leaks between tests. */
function loadFreshOnyx(): OnyxModules {
    jest.resetModules();

    return {
        Onyx: require('../../../../../lib').default,
        cache: require('../../../../../lib/OnyxCache').default,
        storage: require('../../../../../lib/storage').default,
        connectionManager: require('../../../../../lib/OnyxConnectionManager').default,
        OnyxUtils: require('../../../../../lib/OnyxUtils').default,
    };
}

/** Seeds the storage mock before calling init, so seeded values are what a real boot would hydrate. */
async function seedStorage(modules: OnyxModules, storedValues: Record<string, unknown>): Promise<void> {
    const pairs = Object.entries(storedValues);
    if (pairs.length > 0) {
        await modules.storage.multiSet(pairs);
    }
}

function initOnyx(modules: OnyxModules, {storedValues: _storedValues, ...initOptions}: StartOptions = {}): void {
    modules.Onyx.init({
        keys: KEYS,
        ramOnlyKeys: [KEYS.RAM_ONLY],
        ...initOptions,
    });
}

/** Loads fresh Onyx modules, seeds storage, runs init and waits until init has resolved. */
async function startOnyx(options: StartOptions = {}): Promise<OnyxModules> {
    const modules = loadFreshOnyx();
    await seedStorage(modules, options.storedValues ?? {});
    initOnyx(modules, options);
    await waitForPromisesToResolve();
    return modules;
}

export {KEYS, loadFreshOnyx, seedStorage, initOnyx, startOnyx};
export type {OnyxModules, StartOptions};

// Jest collects every file under tests/unit as a suite, so this helper checks itself only when run as the suite.
if (expect.getState().testPath === __filename) {
    describe('startOnyx', () => {
        it('gives every call its own Onyx state', async () => {
            const first = await startOnyx({storedValues: {[KEYS.PLAIN]: 'first'}});
            await first.Onyx.set(KEYS.PLAIN_2, 'written in first');
            const second = await startOnyx();

            expect(second.Onyx).not.toBe(first.Onyx);
            expect(second.cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(second.cache.get(KEYS.PLAIN_2)).toBeUndefined();
            expect(await second.storage.getItem(KEYS.PLAIN)).toBeNull();
        });
    });
}
