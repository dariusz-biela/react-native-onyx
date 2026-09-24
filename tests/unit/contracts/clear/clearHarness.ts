import type * as ReactTestingLibrary from '@testing-library/react-native/pure';
import type OnyxModule from '../../../../lib/Onyx';
import type OnyxCacheModule from '../../../../lib/OnyxCache';
import type OnyxUtilsModule from '../../../../lib/OnyxUtils';
import type StorageMockModule from '../../../../lib/storage/__mocks__';
import type {InitOptions, OnyxKey, OnyxValue} from '../../../../lib/types';
import type useOnyxModule from '../../../../lib/useOnyx';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    SESSION: 'session',
    IS_OFFLINE: 'isOffline',
    PREFERRED_LOCALE: 'preferredLocale',
    PLAIN: 'plain',
    PLAIN_EXTENDED: 'plainExtended',
    UNDERSCORE_KEY: 'nvp_priority',
    RAM_ONLY: 'ramOnly',
    RAM_ONLY_DEFAULT: 'ramOnlyDefault',
    COLLECTION: {
        REPORT: 'report_',
        REPORT_ACTIONS: 'reportActions_',
        TEST: 'test_',
        TEST_LEVEL: 'test_level_',
        RAM_ONLY_COLLECTION: 'ramOnlyCollection_',
        DEFAULTED: 'defaulted_',
    },
} as const;

const DEFAULT_MEMBER_KEY = `${KEYS.COLLECTION.DEFAULTED}1`;

/** A populated store touching every kind of key the clear logic treats differently. */
function createAccount() {
    return {
        [KEYS.SESSION]: {loading: true, authToken: 'token', nested: {depth: 2}},
        [KEYS.IS_OFFLINE]: true,
        [KEYS.PREFERRED_LOCALE]: 'fr',
        [KEYS.PLAIN]: {value: 'plain'},
        [KEYS.PLAIN_EXTENDED]: 'extended',
        [KEYS.UNDERSCORE_KEY]: 'high',
        [KEYS.RAM_ONLY]: 'ram value',
        [KEYS.RAM_ONLY_DEFAULT]: 'ram changed',
        [`${KEYS.COLLECTION.REPORT}1`]: {reportID: '1'},
        [`${KEYS.COLLECTION.REPORT}2`]: {reportID: '2'},
        [`${KEYS.COLLECTION.REPORT_ACTIONS}1`]: {actionID: 'a1'},
        [`${KEYS.COLLECTION.TEST}1`]: {id: 'test 1'},
        [`${KEYS.COLLECTION.TEST_LEVEL}1`]: {id: 'test level 1'},
        [`${KEYS.COLLECTION.RAM_ONLY_COLLECTION}1`]: {id: 'ram member'},
        [DEFAULT_MEMBER_KEY]: {name: 'changed member'},
        [`${KEYS.COLLECTION.DEFAULTED}2`]: {name: 'second member'},
    };
}

type Account = ReturnType<typeof createAccount>;

function createInitialKeyStates() {
    return {
        [KEYS.SESSION]: {loading: false, nested: {depth: 1}},
        [KEYS.IS_OFFLINE]: false,
        [KEYS.PREFERRED_LOCALE]: 'en',
        [KEYS.RAM_ONLY_DEFAULT]: 'ramDefault',
        [DEFAULT_MEMBER_KEY]: {name: 'default member'},
    };
}

type InitialKeyStates = ReturnType<typeof createInitialKeyStates>;

type OnyxModules = {
    Onyx: typeof OnyxModule;
    OnyxUtils: typeof OnyxUtilsModule;
    cache: typeof OnyxCacheModule;
    StorageMock: typeof StorageMockModule;
    useOnyx: typeof useOnyxModule;
    rtl: typeof ReactTestingLibrary;
    initialKeyStates: InitialKeyStates;
};

type LoadOptions = {
    /** Values written to the mocked storage before `Onyx.init()` runs, as if left by a previous session. */
    storageSeed?: Record<OnyxKey, unknown>;
    /** Overrides for `Onyx.init()`; `initialKeyStates` replaces the default set entirely. */
    initOptions?: Partial<InitOptions>;
};

/**
 * Loads a fresh copy of every Onyx module (and React Testing Library, so hooks share one React instance)
 * and initializes Onyx, so no test depends on module state left by another test.
 */
let previousRtl: typeof ReactTestingLibrary | undefined;

async function loadOnyx({storageSeed, initOptions}: LoadOptions = {}): Promise<OnyxModules> {
    previousRtl?.cleanup();
    jest.resetModules();

    const StorageMock: typeof StorageMockModule = require('../../../../lib/storage').default;
    const Onyx: typeof OnyxModule = require('../../../../lib').default;
    const OnyxUtils: typeof OnyxUtilsModule = require('../../../../lib/OnyxUtils').default;
    const cache: typeof OnyxCacheModule = require('../../../../lib/OnyxCache').default;
    const useOnyx: typeof useOnyxModule = require('../../../../lib').useOnyx;
    // The pure entry point does not register global cleanup hooks, which cannot be added from inside a test.
    const rtl: typeof ReactTestingLibrary = require('@testing-library/react-native/pure');
    previousRtl = rtl;

    if (storageSeed) {
        StorageMock.setMockStore(storageSeed);
    }

    const initialKeyStates = createInitialKeyStates();
    Onyx.init({
        keys: KEYS,
        initialKeyStates,
        ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.RAM_ONLY_DEFAULT, KEYS.COLLECTION.RAM_ONLY_COLLECTION],
        ...initOptions,
    });
    await waitForPromisesToResolve();

    return {Onyx, OnyxUtils, cache, StorageMock, useOnyx, rtl, initialKeyStates};
}

/** Unmounts everything rendered by the most recently loaded React Testing Library instance. */
function cleanupRendered(): void {
    previousRtl?.cleanup();
    previousRtl = undefined;
}

/** Returns a plain copy of everything currently held by the mocked storage provider. */
function readStorage(StorageMock: typeof StorageMockModule): Record<string, unknown> {
    return {...StorageMock.getMockStore()};
}

type Delivery = {value: unknown; key: OnyxKey | undefined};

type Recorder = {
    deliveries: Delivery[];
    values: () => unknown[];
    last: () => unknown;
    reset: () => void;
    callback: (value: OnyxValue<OnyxKey> | undefined, key?: OnyxKey) => void;
};

/** Builds a connect callback that records every delivered value and key, in order. */
function createRecorder(onDeliver?: (value: unknown, key: OnyxKey | undefined) => void): Recorder {
    const deliveries: Delivery[] = [];
    return {
        deliveries,
        values: () => deliveries.map((delivery) => delivery.value),
        last: () => deliveries.at(-1)?.value,
        reset: () => {
            deliveries.length = 0;
        },
        callback: (value, key) => {
            deliveries.push({value, key});
            onDeliver?.(value, key);
        },
    };
}

/** Writes the whole account through the public API and returns the values that were written. */
async function seedAccount(Onyx: typeof OnyxModule): Promise<Account> {
    const account = createAccount();
    await Onyx.multiSet(account);
    await waitForPromisesToResolve();
    return account;
}

export {KEYS, DEFAULT_MEMBER_KEY, loadOnyx, readStorage, createRecorder, createAccount, seedAccount, cleanupRendered, waitForPromisesToResolve as flush};
export type {OnyxModules, Recorder, Account};

// Jest treats every file under tests/unit as a suite, so the harness checks its own isolation guarantee,
// but only when it runs as its own suite and not in every file that imports it.
const isOwnSuite = expect.getState().testPath?.endsWith('clearHarness.ts') ?? false;
(isOwnSuite ? describe : describe.skip)('clear contract harness', () => {
    it('gives every load a fresh cache and a storage holding only the seed and persisted defaults', async () => {
        const first = await loadOnyx({storageSeed: {[KEYS.PLAIN]: 'seeded'}});
        await first.Onyx.set(KEYS.PLAIN_EXTENDED, 'written');

        const second = await loadOnyx();

        expect(second.cache).not.toBe(first.cache);
        expect(second.cache.get(KEYS.PLAIN)).toBeUndefined();
        expect(second.cache.get(KEYS.PLAIN_EXTENDED)).toBeUndefined();
        expect(readStorage(second.StorageMock)).not.toHaveProperty(KEYS.PLAIN_EXTENDED);
    });
});
