/**
 * Loads Onyx the way a browser tab runs it: the real storage facade, the web InstanceSync and one storage provider
 * shared by every tab. Jest otherwise resolves the native no-op InstanceSync and mocks the facade, so nothing below
 * the public API would raise or apply a cross-tab event.
 */
import React from 'react';
import type OnyxDefault from '../../../../lib';
import type {useOnyx as useOnyxHook} from '../../../../lib';
import type * as LoggerModule from '../../../../lib/Logger';
import type OnyxCacheDefault from '../../../../lib/OnyxCache';
import type OnyxUtilsDefault from '../../../../lib/OnyxUtils';
import type StorageFacadeDefault from '../../../../lib/storage';
import type InstanceSyncWebDefault from '../../../../lib/storage/InstanceSync/index.web';
import type MemoryOnlyProviderDefault from '../../../../lib/storage/providers/MemoryOnlyProvider';
import type {OnStorageKeysChanged} from '../../../../lib/storage/providers/types';
import type {InitOptions, OnyxKey, OnyxUpdate} from '../../../../lib/types';

import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const SYNC_ONYX = 'SYNC_ONYX';

const KEYS = {
    PLAIN: 'plain',
    OTHER: 'other',
    OBJECT: 'object',
    NVP: 'nvp_test',
    RAM_ONLY: 'ramOnly',
    COLLECTION: {
        TEST: 'test_',
        TEST_LEVEL: 'test_level_',
        RAM_ONLY: 'ramCollection_',
    },
} as const;

type SharedProvider = typeof MemoryOnlyProviderDefault;

type StorageListener = (event: StorageEvent) => void;

type Tab = {
    Onyx: typeof OnyxDefault;
    useOnyx: typeof useOnyxHook;
    OnyxUtils: typeof OnyxUtilsDefault;
    cache: typeof OnyxCacheDefault;
    storage: typeof StorageFacadeDefault;
    InstanceSync: typeof InstanceSyncWebDefault;
    Logger: typeof LoggerModule;
    /** The `storage` listener this tab's InstanceSync registered, which a browser calls for writes made by other tabs. */
    receive: StorageListener;
    /** The handler Onyx.init gave the storage layer, called with the stored pairs of another tab's write. */
    applyRemote: OnStorageKeysChanged;
};

type Recorder = {
    values: unknown[];
    keys: unknown[];
};

/** The provider every tab loaded next will read and write, like the IndexedDB database a browser shares between tabs. */
let sharedProvider: SharedProvider | undefined;
const capturedListeners: StorageListener[] = [];

function createSharedProvider(): SharedProvider {
    let provider: SharedProvider | undefined;
    jest.isolateModules(() => {
        const providerModule: {default: SharedProvider} = jest.requireActual('../../../../lib/storage/providers/MemoryOnlyProvider');
        provider = providerModule.default;
    });
    if (!provider) {
        throw new Error('MemoryOnlyProvider did not load');
    }
    return provider;
}

function getSharedProvider(): SharedProvider {
    if (!sharedProvider) {
        throw new Error('Call resetSharedStorage() before loading a tab');
    }
    return sharedProvider;
}

/** Starts a new "browser profile": an empty shared storage and no tabs. */
function resetSharedStorage(): SharedProvider {
    sharedProvider = createSharedProvider();
    capturedListeners.length = 0;
    return sharedProvider;
}

function platformModule() {
    return {__esModule: true, default: getSharedProvider()};
}

function toListener(listener: EventListenerOrEventListenerObject): StorageListener {
    return (event) => {
        if (typeof listener === 'function') {
            listener(event);
            return;
        }
        listener.handleEvent(event);
    };
}

/** Keeps `storage` listeners away from jsdom so only the harness decides which tab hears which event. */
function interceptStorageListeners(): jest.SpyInstance {
    const originalAddEventListener = window.addEventListener.bind(window);
    return jest.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (type === 'storage' && listener) {
            capturedListeners.push(toListener(listener));
            return;
        }
        if (listener) {
            originalAddEventListener(type, listener, options);
        }
    });
}

function loadModules(): Omit<Tab, 'receive' | 'applyRemote'> {
    jest.resetModules();
    // The fresh lib graph must share React with the renderer imported by the test file.
    jest.doMock('react', () => React);
    jest.doMock('../../../../lib/storage', () => jest.requireActual('../../../../lib/storage'));
    jest.doMock('../../../../lib/storage/InstanceSync', () => jest.requireActual('../../../../lib/storage/InstanceSync/index.web'));
    jest.doMock('../../../../lib/storage/platforms/index', platformModule);
    jest.doMock('../../../../lib/storage/platforms/index.native', platformModule);

    const onyxModule: {default: typeof OnyxDefault; useOnyx: typeof useOnyxHook} = require('../../../../lib');
    const onyxUtilsModule: {default: typeof OnyxUtilsDefault} = require('../../../../lib/OnyxUtils');
    const cacheModule: {default: typeof OnyxCacheDefault} = require('../../../../lib/OnyxCache');
    const storageModule: {default: typeof StorageFacadeDefault} = require('../../../../lib/storage');
    const instanceSyncModule: {default: typeof InstanceSyncWebDefault} = require('../../../../lib/storage/InstanceSync');
    const loggerModule: typeof LoggerModule = require('../../../../lib/Logger');

    return {
        Onyx: onyxModule.default,
        useOnyx: onyxModule.useOnyx,
        OnyxUtils: onyxUtilsModule.default,
        cache: cacheModule.default,
        storage: storageModule.default,
        InstanceSync: instanceSyncModule.default,
        Logger: loggerModule,
    };
}

function tabInitOptions(overrides: Partial<InitOptions> = {}): InitOptions {
    return {keys: KEYS, shouldSyncMultipleInstances: true, enableDevTools: false, ...overrides};
}

/** Opens a tab on the shared storage and waits for its Onyx.init to finish. */
async function openTab(overrides: Partial<InitOptions> = {}): Promise<Tab> {
    const modules = loadModules();
    const listenerSpy = interceptStorageListeners();
    const keepSpy = jest.spyOn(modules.storage, 'keepInstancesSync');
    const listenersBefore = capturedListeners.length;
    try {
        modules.Onyx.init(tabInitOptions(overrides));
    } finally {
        listenerSpy.mockRestore();
    }
    const receive = capturedListeners.at(-1);
    const applyRemote = keepSpy.mock.calls.at(-1)?.[0];
    keepSpy.mockRestore();
    await waitForPromisesToResolve();

    if (overrides.shouldSyncMultipleInstances === false) {
        if (capturedListeners.length !== listenersBefore || applyRemote) {
            throw new Error('Onyx.init registered instance sync although it was turned off');
        }
        const syncDisabled = () => {
            throw new Error('This tab does not sync with other instances');
        };
        return {...modules, receive: syncDisabled, applyRemote: syncDisabled};
    }

    if (!receive || !applyRemote || capturedListeners.length !== listenersBefore + 1) {
        throw new Error('Onyx.init did not register exactly one storage listener');
    }
    return {...modules, receive, applyRemote};
}

/** Every SYNC_ONYX value written to localStorage since the last drain, in write order. */
type SyncBus = {
    drain: () => string[];
    /** Every SYNC_ONYX localStorage write and removal since the bus was created, in call order. */
    log: () => Array<{type: 'set'; value: string} | {type: 'remove'}>;
    setItem: jest.SpyInstance;
    removeItem: jest.SpyInstance;
};

function createSyncBus(): SyncBus {
    const setItem = jest.spyOn(window.Storage.prototype, 'setItem');
    const removeItem = jest.spyOn(window.Storage.prototype, 'removeItem');
    let consumed = 0;

    function syncSetValues(): string[] {
        const values: string[] = [];
        for (const [key, value] of setItem.mock.calls) {
            if (key === SYNC_ONYX && typeof value === 'string') {
                values.push(value);
            }
        }
        return values;
    }

    return {
        setItem,
        removeItem,
        drain: () => {
            const values = syncSetValues();
            const fresh = values.slice(consumed);
            consumed = values.length;
            return fresh;
        },
        log: () => {
            const entries: Array<{order: number; entry: {type: 'set'; value: string} | {type: 'remove'}}> = [];
            for (const [index, [key, value]] of setItem.mock.calls.entries()) {
                if (key === SYNC_ONYX && typeof value === 'string') {
                    entries.push({order: setItem.mock.invocationCallOrder[index], entry: {type: 'set', value}});
                }
            }
            for (const [index, [key]] of removeItem.mock.calls.entries()) {
                if (key === SYNC_ONYX) {
                    entries.push({order: removeItem.mock.invocationCallOrder[index], entry: {type: 'remove'}});
                }
            }
            return entries.sort((a, b) => a.order - b.order).map(({entry}) => entry);
        },
    };
}

/** Parses SYNC_ONYX payloads into the keys they announce, accepting both the JSON-array and the raw-key format. */
function announcedKeys(payloads: string[]): OnyxKey[] {
    return payloads.flatMap((payload) => {
        try {
            const parsed: unknown = JSON.parse(payload);
            if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === 'string')) {
                return parsed;
            }
        } catch {
            // A raw key that is not JSON is the single-key format.
        }
        return [payload];
    });
}

function storageEvent(newValue: string | null, key: string | null = SYNC_ONYX): StorageEvent {
    return new StorageEvent('storage', {key, newValue});
}

/** Lets the receiving tab's coalescing timer fire and its storage read resolve. */
async function settle(): Promise<void> {
    await waitForPromisesToResolve();
    await waitForPromisesToResolve();
}

/** Hands the payloads to a tab the way the browser would, then waits until the tab applied them. */
async function deliver(tab: Tab, payloads: string[]): Promise<void> {
    for (const payload of payloads) {
        tab.receive(storageEvent(payload));
    }
    await settle();
}

function record(tab: Tab, key: OnyxKey): Recorder {
    const values: unknown[] = [];
    const keys: unknown[] = [];
    tab.Onyx.connect({
        key,
        callback: (value, callbackKey) => {
            values.push(value);
            keys.push(callbackKey);
        },
    });
    return {values, keys};
}

/** Every key the tab's cache holds a value for among its known keys, the shared storage keys and `extraKeys`. */
function readCache(tab: Tab, extraKeys: Iterable<OnyxKey> = []): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const keys = new Set([...tab.cache.getAllKeys(), ...Object.keys(getSharedProvider().store), ...extraKeys]);
    for (const key of keys) {
        const value = tab.cache.get(key);
        if (value !== undefined && value !== null) {
            result[key] = value;
        }
    }
    return result;
}

function readShared(): Record<string, unknown> {
    return {...getSharedProvider().store};
}

type WriteSpies = {count: () => number};

/** Counts every write the shared storage receives from now on, whichever tab makes it. */
function spyOnSharedWrites(): WriteSpies {
    const provider = getSharedProvider();
    const spies = [
        jest.spyOn(provider, 'setItem'),
        jest.spyOn(provider, 'multiSet'),
        jest.spyOn(provider, 'mergeItem'),
        jest.spyOn(provider, 'multiMerge'),
        jest.spyOn(provider, 'removeItem'),
        jest.spyOn(provider, 'removeItems'),
        jest.spyOn(provider, 'clear'),
    ];
    return {count: () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0)};
}

function isUpdate(entry: unknown): entry is OnyxUpdate<OnyxKey> {
    return typeof entry === 'object' && entry !== null && 'onyxMethod' in entry && typeof entry.onyxMethod === 'string';
}

/** Types an update entry the static collection types cannot express, such as a null collection member. */
function toUpdate(entry: {onyxMethod: string; key: string; value?: unknown}): OnyxUpdate<OnyxKey> {
    if (!isUpdate(entry)) {
        throw new Error(`Not an Onyx update: ${JSON.stringify(entry)}`);
    }
    return entry;
}

export {KEYS, SYNC_ONYX, announcedKeys, createSyncBus, deliver, openTab, readCache, readShared, record, resetSharedStorage, settle, spyOnSharedWrites, storageEvent, toUpdate};
export type {Recorder, SharedProvider, SyncBus, Tab, WriteSpies};

// Jest treats every file under tests/unit as a suite, so the harness checks its own wiring,
// but only when it runs as its own suite and not in every file that imports it.
const isOwnSuite = expect.getState().testPath?.endsWith('syncHarness.ts') ?? false;
(isOwnSuite ? describe : describe.skip)('instance sync harness', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('wires two tabs to one storage through the web InstanceSync', async () => {
        resetSharedStorage();
        const bus = createSyncBus();
        const writer = await openTab();
        const reader = await openTab();

        expect(writer.cache).not.toBe(reader.cache);
        expect(writer.InstanceSync.shouldBeUsed).toBe(true);

        await writer.Onyx.set(KEYS.PLAIN, 'written');
        await settle();
        expect(readShared()).toEqual({[KEYS.PLAIN]: 'written'});

        await deliver(reader, bus.drain());
        expect(reader.cache.get(KEYS.PLAIN)).toBe('written');
    });
});
