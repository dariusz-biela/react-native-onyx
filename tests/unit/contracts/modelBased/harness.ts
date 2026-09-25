import {act, renderHook} from '@testing-library/react-native';
import React from 'react';

import type OnyxDefault from '../../../../lib';
import type {useOnyx as useOnyxHook} from '../../../../lib';
import type OnyxCacheDefault from '../../../../lib/OnyxCache';
import type {OnyxMergeCollectionInput} from '../../../../lib/types';
import type StorageMockDefault from '../../../../lib/storage/__mocks__';
import type {State} from '../update/harness';
import type {Op} from './model';

import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {DEFAULT_VALUE, ONYX_KEYS, SKIPPABLE_ID, deepClone, isRunningAsSuite, toUpdate} from '../update/harness';
import {COLLECTIONS, OBSERVED_KEYS} from './model';

type FreshOnyx = {
    Onyx: typeof OnyxDefault;
    useOnyx: typeof useOnyxHook;
    cache: typeof OnyxCacheDefault;
    storage: typeof StorageMockDefault;
};

type ConnectObserver = {target: string; calls: unknown[]};
type HookRender = {value: unknown; status: string};
type HookObserver = {target: string; renders: HookRender[]; unmount: () => void};
type Observers = {connections: ConnectObserver[]; hooks: HookObserver[]};

const OBSERVED_TARGETS: readonly string[] = [...OBSERVED_KEYS, ...COLLECTIONS];

/** Throws away the whole Onyx module graph, so every test and every re-init starts from an uninitialised Onyx. */
function loadFreshOnyx(): FreshOnyx {
    jest.resetModules();
    // The fresh lib graph must share React with the renderer imported above.
    jest.doMock('react', () => React);

    const onyxModule: {default: typeof OnyxDefault; useOnyx: typeof useOnyxHook} = require('../../../../lib');
    const cacheModule: {default: typeof OnyxCacheDefault} = require('../../../../lib/OnyxCache');
    const storageModule: {default: typeof StorageMockDefault} = require('../../../../lib/storage');

    return {Onyx: onyxModule.default, useOnyx: onyxModule.useOnyx, cache: cacheModule.default, storage: storageModule.default};
}

/** Boots a fresh Onyx over the given storage contents with the same options the update contract uses. */
async function bootOnyx(stored: State): Promise<FreshOnyx> {
    const onyx = loadFreshOnyx();
    onyx.storage.setMockStore(deepClone(stored));
    onyx.Onyx.init({
        keys: ONYX_KEYS,
        initialKeyStates: {[ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE},
        ramOnlyKeys: [ONYX_KEYS.RAM_ONLY_KEY, ONYX_KEYS.COLLECTION.RAM],
        skippableCollectionMemberIDs: [SKIPPABLE_ID],
        shouldSyncMultipleInstances: false,
    });
    await waitForPromisesToResolve();
    return onyx;
}

function readCache(onyx: FreshOnyx): State {
    const state: State = {};
    for (const key of onyx.cache.getAllKeys()) {
        const value = onyx.cache.get(key);
        if (value !== undefined && value !== null) {
            state[key] = value;
        }
    }
    return state;
}

function readStorage(onyx: FreshOnyx): State {
    const state: State = {};
    for (const [key, value] of Object.entries(onyx.storage.getMockStore())) {
        if (value !== undefined && value !== null) {
            state[key] = deepClone(value);
        }
    }
    return state;
}

function isCollectionTarget(target: string): boolean {
    return COLLECTIONS.includes(target);
}

/** Collections compare as member maps, so an empty collection delivered as undefined and as {} are the same view. */
function normalize(target: string, value: unknown): unknown {
    if (isCollectionTarget(target)) {
        return value ?? {};
    }
    return value ?? undefined;
}

function connectObservers(onyx: FreshOnyx): ConnectObserver[] {
    return OBSERVED_TARGETS.map((target) => {
        const calls: unknown[] = [];
        onyx.Onyx.connectWithoutView({
            key: target,
            callback: (value) => {
                calls.push(deepClone(value));
            },
        });
        return {target, calls};
    });
}

function mountHooks(onyx: FreshOnyx): HookObserver[] {
    return OBSERVED_TARGETS.map((target) => {
        const renders: HookRender[] = [];
        const {unmount} = renderHook(() => {
            const [value, metadata] = onyx.useOnyx(target);
            renders.push({value: deepClone(value), status: metadata.status});
        });
        return {target, renders, unmount};
    });
}

async function observe(onyx: FreshOnyx): Promise<Observers> {
    const connections = connectObservers(onyx);
    const hooks = mountHooks(onyx);
    await act(async () => waitForPromisesToResolve());
    return {connections, hooks};
}

function unmountAll(observers: Observers): void {
    for (const hook of observers.hooks) {
        hook.unmount();
    }
}

/** mergeCollection takes no undefined members; the generator never produces one. */
function isMergeCollectionInput(data: Record<string, unknown>): data is OnyxMergeCollectionInput<string> {
    return Object.values(data).every((value) => value !== undefined);
}

/** Issues one operation without awaiting it. */
function issue(onyx: FreshOnyx, op: Op): Promise<void> {
    switch (op.kind) {
        case 'set':
            return onyx.Onyx.set(op.key, op.value);
        case 'merge':
            return onyx.Onyx.merge(op.key, op.value);
        case 'multiSet':
            return onyx.Onyx.multiSet(op.data);
        case 'mergeCollection':
            if (!isMergeCollectionInput(op.data)) {
                throw new Error(`mergeCollection data holds an undefined member: ${JSON.stringify(op.data)}`);
            }
            return onyx.Onyx.mergeCollection(op.collectionKey, op.data);
        case 'setCollection':
            return onyx.Onyx.setCollection(op.collectionKey, op.data);
        case 'update':
            return onyx.Onyx.update(op.updates.map(toUpdate));
        default:
            return onyx.Onyx.clear();
    }
}

/** Runs the operations in one tick without awaiting in between, then waits until everything has settled. */
async function runTogether(onyx: FreshOnyx, ops: readonly Op[]): Promise<void> {
    await act(async () => {
        await Promise.all(ops.map((op) => issue(onyx, op)));
        await waitForPromisesToResolve();
    });
}

async function runAwaited(onyx: FreshOnyx, op: Op): Promise<void> {
    await runTogether(onyx, [op]);
}

/** Reads every observed target through a fresh subscriber, the read path a new screen uses. */
async function readThroughConnections(onyx: FreshOnyx): Promise<Record<string, unknown>> {
    const views: Record<string, unknown> = {};
    for (const target of OBSERVED_TARGETS) {
        let received: unknown;
        const connection = onyx.Onyx.connectWithoutView({
            key: target,
            callback: (value) => {
                received = value;
            },
        });
        await waitForPromisesToResolve();
        onyx.Onyx.disconnect(connection);
        views[target] = normalize(target, received);
    }
    return views;
}

function findConnection(observers: Observers, target: string): ConnectObserver {
    const found = observers.connections.find((observer) => observer.target === target);
    if (!found) {
        throw new Error(`No connection observes ${target}`);
    }
    return found;
}

function findHook(observers: Observers, target: string): HookObserver {
    const found = observers.hooks.find((observer) => observer.target === target);
    if (!found) {
        throw new Error(`No hook observes ${target}`);
    }
    return found;
}

/** Counts what each observer of a target receives after this point. */
function markTarget(observers: Observers, target: string): () => {connect: unknown[]; hook: unknown[]} {
    const connection = findConnection(observers, target);
    const hook = findHook(observers, target);
    const connectSeen = connection.calls.length;
    const hookSeen = hook.renders.length;
    return () => ({connect: connection.calls.slice(connectSeen), hook: hook.renders.slice(hookSeen).map((render) => render.value)});
}

export {
    OBSERVED_TARGETS,
    loadFreshOnyx,
    bootOnyx,
    readCache,
    readStorage,
    normalize,
    isCollectionTarget,
    observe,
    unmountAll,
    issue,
    runAwaited,
    runTogether,
    readThroughConnections,
    findConnection,
    findHook,
    markTarget,
};
export type {FreshOnyx, ConnectObserver, HookObserver, HookRender, Observers};

if (isRunningAsSuite(__filename)) {
    describe('model-based harness', () => {
        it('boots every Onyx instance from the storage it is given', async () => {
            const first = await bootOnyx({[ONYX_KEYS.TEST_KEY]: {a: 1}});
            await runAwaited(first, {kind: 'set', key: ONYX_KEYS.OTHER_KEY, value: 'written'});
            const second = await bootOnyx(readStorage(first));

            expect(readCache(second)).toEqual({[ONYX_KEYS.TEST_KEY]: {a: 1}, [ONYX_KEYS.OTHER_KEY]: 'written', [ONYX_KEYS.WITH_DEFAULT]: DEFAULT_VALUE});
            expect(second.Onyx).not.toBe(first.Onyx);
        });
    });
}
