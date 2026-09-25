/**
 * Shared setup for the contract tests of the merge helpers in `OnyxUtils` (`mergeChanges`, `mergeAndMarkChanges`,
 * `prepareKeyValuePairsForStorage` and `updateSnapshots`), plus a small independent model of `mergeChanges`.
 */
import type {Connection} from '../../../../lib/OnyxConnectionManager';
import type {OnyxKey} from '../../../../lib/types';

import Onyx from '../../../../lib';
import OnyxUtils from '../../../../lib/OnyxUtils';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {isPlainObject, mergeValue} from '../merge/helpers/model';

const KEYS = {
    TEST: 'test',
    OTHER: 'other',
    COLLECTION: {
        A: 'colA_',
        SNAPSHOT: 'snapshot_',
        // Members of this collection also start with `snapshot_`, so they collide with the snapshot prefix.
        SNAPSHOT_META: 'snapshot_meta_',
    },
} as const;

const SNAPSHOT_MERGE_KEYS = ['pendingAction', 'pendingFields'];

function initOnyx(): void {
    Onyx.init({keys: KEYS, snapshotMergeKeys: SNAPSHOT_MERGE_KEYS});
}

const openConnections: Connection[] = [];

async function resetOnyx(): Promise<void> {
    for (const connection of openConnections.splice(0)) {
        Onyx.disconnect(connection);
    }
    OnyxUtils.setSnapshotMergeKeys(new Set(SNAPSHOT_MERGE_KEYS));
    await Onyx.clear();
    await waitForPromisesToResolve();
    jest.clearAllMocks();
}

/** Subscribes to a key and records every value delivered after the initial one. */
async function recordAfterInitial(key: OnyxKey): Promise<unknown[]> {
    const values: unknown[] = [];
    let isInitialDelivered = false;
    openConnections.push(
        Onyx.connect({
            key,
            reuseConnection: false,
            callback: (value: unknown) => {
                if (!isInitialDelivered) {
                    return;
                }
                values.push(value);
            },
        }),
    );
    await waitForPromisesToResolve();
    isInitialDelivered = true;
    return values;
}

/** Whether a change may be applied to a value, mirroring the check `Onyx.merge` runs before it reaches `mergeChanges`. */
function isCompatible(change: unknown, existingValue: unknown): boolean {
    if (!existingValue || !change) {
        return true;
    }
    if (Array.isArray(existingValue) && existingValue.length === 0 && typeof change === 'object' && !Array.isArray(change)) {
        return true;
    }
    return Array.isArray(existingValue) === Array.isArray(change);
}

/** Independent model of `mergeChanges`: the last array or the last value wins unless some change is object-like. */
function modelMergeChanges(changes: unknown[], existingValue: unknown): unknown {
    const lastChange = changes.at(-1);
    if (Array.isArray(lastChange) || !changes.some((change) => typeof change === 'object' && change !== null)) {
        return lastChange;
    }

    let value: unknown = existingValue ?? {};
    for (const change of changes) {
        value = mergeValue(value, change);
    }
    return value;
}

/** Every plain object reachable from a value through plain objects only (arrays are not entered). */
function collectPlainObjects(value: unknown, found = new Set<unknown>()): Set<unknown> {
    if (!isPlainObject(value)) {
        return found;
    }
    found.add(value);
    for (const property of Object.values(value)) {
        collectPlainObjects(property, found);
    }
    return found;
}

/** Reads a nested property along a path of plain objects. */
function readPath(value: unknown, path: string[]): unknown {
    let current = value;
    for (const segment of path) {
        if (!isPlainObject(current)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

if (expect.getState().testPath === __filename) {
    describe('mergeUtils contract helpers', () => {
        it('models the last-change and object merge rules', () => {
            expect(modelMergeChanges([{a: 1}, [1]], {b: 1})).toStrictEqual([1]);
            expect(modelMergeChanges([1, 2], {b: 1})).toBe(2);
            expect(modelMergeChanges([{a: {x: null}}, {b: 1}], {a: {x: 1, y: 1}})).toStrictEqual({a: {y: 1}, b: 1});
        });

        it('judges compatibility like Onyx.merge', () => {
            expect(isCompatible([1], {a: 1})).toBe(false);
            expect(isCompatible({a: 1}, [])).toBe(true);
            expect(isCompatible({a: 1}, undefined)).toBe(true);
        });

        it('collects plain objects without entering arrays and reads paths', () => {
            const inner = {b: 1};
            expect([...collectPlainObjects({a: inner, list: [{c: 1}]})]).toHaveLength(2);
            expect(readPath({a: inner}, ['a', 'b'])).toBe(1);
            expect(readPath({a: 1}, ['a', 'b'])).toBeUndefined();
        });
    });
}

export {KEYS, SNAPSHOT_MERGE_KEYS, collectPlainObjects, initOnyx, isCompatible, modelMergeChanges, readPath, recordAfterInitial, resetOnyx};
