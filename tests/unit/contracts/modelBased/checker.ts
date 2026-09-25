import {isEqual} from 'lodash';

import type {State} from '../update/harness';
import type {FreshOnyx, Observers} from './harness';
import type {Op} from './model';

import {DEFAULT_VALUE, ONYX_KEYS, isRunningAsSuite} from '../update/harness';
import {normalize, readCache, readStorage} from './harness';
import {describeOp, isSilentChildRemoval, project, touches} from './model';

type ObserverState = {view: unknown; stale: boolean; seen: number};
type Tracker = {connections: Map<string, ObserverState>; hooks: Map<string, ObserverState>};

type ObserverKind = 'connect' | 'hook';

type StepContext = {
    label: string;
    op: Op;
    before: State;
    after: State;
    /** Tells whether the operation must not notify a key subscriber whose value it leaves unchanged. */
    isSilentWhenUnchanged: (op: Op) => boolean;
};

/** At most one notification per subscriber for a single write; a batch may notify once per entry plus one. */
function deliveryBound(op: Op): number {
    return op.kind === 'update' ? op.updates.length + 1 : 1;
}

/** Storage may miss a default that was never written, since init keeps defaults in the cache only. */
function expectStorageMatches(label: string, onyx: FreshOnyx, model: State): void {
    const stored = readStorage(onyx);
    const expected: State = {...model};
    const defaultKey = ONYX_KEYS.WITH_DEFAULT;
    if (!(defaultKey in stored) && isEqual(expected[defaultKey], DEFAULT_VALUE)) {
        delete expected[defaultKey];
    }
    expect({label, storage: stored}).toEqual({label, storage: expected});
}

function expectStoreMatches(label: string, onyx: FreshOnyx, model: State): void {
    expect({label, cache: readCache(onyx)}).toEqual({label, cache: model});
    expectStorageMatches(label, onyx, model);
}

function startTracking(label: string, observers: Observers, model: State): Tracker {
    const tracker: Tracker = {connections: new Map(), hooks: new Map()};
    for (const {target, calls} of observers.connections) {
        const view = normalize(target, calls.at(-1));
        expect({label, target, initialDeliveries: Math.min(calls.length, 1), view}).toEqual({
            label,
            target,
            initialDeliveries: calls.length,
            view: normalize(target, project(model, target)),
        });
        tracker.connections.set(target, {view, stale: false, seen: calls.length});
    }
    for (const {target, renders} of observers.hooks) {
        const last = renders.at(-1);
        expect({label, target, status: last?.status, value: normalize(target, last?.value)}).toEqual({label, target, status: 'loaded', value: normalize(target, project(model, target))});
        tracker.hooks.set(target, {view: normalize(target, last?.value), stale: false, seen: renders.length});
    }
    return tracker;
}

/**
 * Checks one observer after a step. A changed value must reach it, an untouched one must not, and the view must equal
 * the model unless a parent setCollection silently removed the child member it shows (pinned as a suspected bug).
 */
function checkObserver(context: StepContext, target: string, state: ObserverState, received: unknown[], kind: ObserverKind): ObserverState {
    const {label, op, before, after, isSilentWhenUnchanged} = context;
    const where = `${label} ${kind} ${target} after ${describeOp(op)}`;
    const expected = normalize(target, project(after, target));
    const changed = !isEqual(normalize(target, project(before, target)), expected);
    const silentRemoval = isSilentChildRemoval(op, target, before, after);

    if (!touches(op, target)) {
        expect({where, untouchedNotifications: received.length}).toEqual({where, untouchedNotifications: 0});
    }
    if (kind === 'connect') {
        expect({where, withinBound: received.length <= deliveryBound(op)}).toEqual({where, withinBound: true});
        if (op.kind !== 'update') {
            for (const value of received) {
                expect({where, delivered: value}).toEqual({where, delivered: expected});
            }
        }
    }
    if (!changed && !COLLECTION_TARGETS.includes(target) && isSilentWhenUnchanged(op)) {
        expect({where, unchangedNotifications: received.length}).toEqual({where, unchangedNotifications: 0});
    }
    // A stale view that already shows the new value needs no notification.
    if (changed && !silentRemoval && !isEqual(state.view, expected)) {
        expect({where, notified: received.length > 0}).toEqual({where, notified: true});
    }

    const view = received.length > 0 ? received.at(-1) : state.view;
    const mayStayStale = received.length === 0 && (silentRemoval || state.stale);
    if (!mayStayStale) {
        expect({where, view}).toEqual({where, view: expected});
    }
    return {view, stale: !isEqual(view, expected), seen: state.seen + received.length};
}

const COLLECTION_TARGETS: readonly string[] = Object.values(ONYX_KEYS.COLLECTION);

type CheckObserver = (target: string, state: ObserverState, received: unknown[], kind: ObserverKind) => ObserverState;

function stateOf(states: Map<string, ObserverState>, target: string): ObserverState {
    const state = states.get(target);
    if (!state) {
        throw new Error(`${target} is not tracked`);
    }
    return state;
}

/** Hands every observer what it received since the last check and records the view it now shows. */
function checkObservers(label: string, observers: Observers, tracker: Tracker, check: CheckObserver): void {
    for (const {target, calls} of observers.connections) {
        const state = stateOf(tracker.connections, target);
        const received = calls.slice(state.seen).map((value) => normalize(target, value));
        tracker.connections.set(target, check(target, state, received, 'connect'));
    }
    for (const {target, renders} of observers.hooks) {
        const state = stateOf(tracker.hooks, target);
        const fresh = renders.slice(state.seen);
        for (const render of fresh) {
            expect({where: `${label} hook ${target}`, status: render.status}).toEqual({where: `${label} hook ${target}`, status: 'loaded'});
        }
        const next = check(
            target,
            state,
            fresh.map((render) => normalize(target, render.value)),
            'hook',
        );
        tracker.hooks.set(target, {...next, seen: renders.length});
    }
}

function checkStep(context: StepContext, onyx: FreshOnyx, observers: Observers, tracker: Tracker): void {
    expectStoreMatches(context.label, onyx, context.after);
    checkObservers(context.label, observers, tracker, (target, state, received, kind) => checkObserver(context, target, state, received, kind));
}

type BatchContext = {
    label: string;
    ops: readonly Op[];
    /** The model before the batch followed by the model after each operation. */
    states: readonly State[];
};

/**
 * Checks one observer after operations issued together. Intermediate values may be skipped, but the last view must be
 * the final model value, a target no operation names must stay silent, and the count stays within the summed bounds.
 */
function checkBatchObserver(context: BatchContext, target: string, state: ObserverState, received: unknown[], kind: ObserverKind): ObserverState {
    const {label, ops, states} = context;
    const where = `${label} ${kind} ${target} after ${ops.map(describeOp).join(' + ')}`;
    const expected = normalize(target, project(states[states.length - 1], target));
    const silentRemoval = ops.some((op, index) => isSilentChildRemoval(op, target, states[index], states[index + 1]));

    if (!ops.some((op) => touches(op, target))) {
        expect({where, untouchedNotifications: received.length}).toEqual({where, untouchedNotifications: 0});
    }
    if (kind === 'connect') {
        const bound = ops.reduce((sum, op) => sum + deliveryBound(op), 0);
        expect({where, withinBound: received.length <= bound}).toEqual({where, withinBound: true});
    }
    if (!silentRemoval && !state.stale && !isEqual(state.view, expected)) {
        expect({where, notified: received.length > 0}).toEqual({where, notified: true});
    }

    const view = received.length > 0 ? received.at(-1) : state.view;
    const mayStayStale = silentRemoval || (received.length === 0 && state.stale);
    if (!mayStayStale) {
        expect({where, view}).toEqual({where, view: expected});
    }
    return {view, stale: !isEqual(view, expected), seen: state.seen + received.length};
}

function checkBatch(context: BatchContext, onyx: FreshOnyx, observers: Observers, tracker: Tracker): void {
    expectStoreMatches(`${context.label} after ${context.ops.map(describeOp).join(' + ')}`, onyx, context.states[context.states.length - 1]);
    checkObservers(context.label, observers, tracker, (target, state, received, kind) => checkBatchObserver(context, target, state, received, kind));
}

export {expectStoreMatches, startTracking, checkStep, checkBatch, deliveryBound};
export type {Tracker, StepContext, BatchContext, ObserverKind};

if (isRunningAsSuite(__filename)) {
    describe('model-based checker', () => {
        it('allows one notification per single write and one per batch entry plus one', () => {
            expect(deliveryBound({kind: 'clear'})).toBe(1);
            expect(deliveryBound({kind: 'update', updates: []})).toBe(1);
        });
    });
}
