/**
 * Reference models of `utils.fastMerge` and `utils.removeNestedNullValues`, plus the checker that compares
 * which references a result shares with its inputs. The models return the target's own references exactly
 * where the merge must keep them, so a test can check value and sharing against one expected tree.
 *
 * Jest treats every file under `tests/unit` as a test file, so the self-test at the bottom only registers
 * when Jest runs this file directly.
 */
import {deepEqual} from 'fast-equals';

import type {PlainObject} from './values';

import {REPLACE_OBJECT_MARK, collectObjectNodes, isMergeable} from './values';

type ObjectRemovalMode = 'none' | 'mark' | 'replace';

type ModelOptions = {
    removeNulls: boolean;
    mode: ObjectRemovalMode;
};

type ModelPatch = [string[], unknown];

type ModelMergeResult = {
    value: unknown;
    patches: ModelPatch[];
};

type MergedNode = {
    value: unknown;
    keptTarget: boolean;
};

function withoutMark(value: PlainObject): PlainObject {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== REPLACE_OBJECT_MARK));
}

function mergeNode(target: unknown, source: PlainObject, options: ModelOptions, path: string[], patches: ModelPatch[]): MergedNode {
    const base = isMergeable(target) ? target : undefined;
    const isRemoved = (value: unknown) => value === undefined || (options.removeNulls && value === null);

    const keptFromTarget = Object.entries(base ?? {}).filter(([key, value]) => value !== undefined && !(options.removeNulls && (value === null || source[key] === null)));
    const result: PlainObject = Object.fromEntries(keptFromTarget);
    let keptTarget = base !== undefined && keptFromTarget.length === Object.keys(base).length;

    for (const [key, sourceProperty] of Object.entries(source)) {
        if (isRemoved(sourceProperty)) {
            continue;
        }

        if (!isMergeable(sourceProperty)) {
            keptTarget = keptTarget && Object.hasOwn(result, key) && result[key] === sourceProperty;
            result[key] = sourceProperty;
            continue;
        }

        const targetProperty = base?.[key];

        if (options.mode === 'replace' && sourceProperty[REPLACE_OBJECT_MARK]) {
            keptTarget = false;
            result[key] = withoutMark(sourceProperty);
            continue;
        }

        if (options.mode === 'mark' && targetProperty === null) {
            keptTarget = false;
            patches.push([[...path, key], {...sourceProperty}]);
            result[key] = mergeNode({[REPLACE_OBJECT_MARK]: true}, sourceProperty, options, [...path, key], patches).value;
            continue;
        }

        const merged = mergeNode(targetProperty, sourceProperty, options, [...path, key], patches);
        keptTarget = keptTarget && merged.keptTarget;
        result[key] = merged.value;
    }

    return keptTarget ? {value: base, keptTarget} : {value: result, keptTarget};
}

function modelFastMerge(target: unknown, source: unknown, options: ModelOptions): ModelMergeResult {
    const patches: ModelPatch[] = [];
    if (!isMergeable(source)) {
        return {value: source, patches};
    }
    return {value: mergeNode(target, source, options, [], patches).value, patches};
}

/** Deep removal of null and undefined properties from plain objects, keeping every untouched subtree by reference. */
function modelRemoveNestedNulls(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return value;
    }

    const entries: Array<[string, unknown]> = [];
    let isUnchanged = true;
    // eslint-disable-next-line no-restricted-syntax, guard-for-in
    for (const key in value) {
        const property: unknown = Reflect.get(value, key);
        if (property === null || property === undefined) {
            isUnchanged = false;
            continue;
        }
        const cleaned = modelRemoveNestedNulls(property);
        isUnchanged = isUnchanged && cleaned === property;
        entries.push([key, cleaned]);
    }

    return isUnchanged ? value : Object.fromEntries(entries);
}

type SharingInputs = {
    targetNodes: Set<object>;
    sourceNodes: Set<object>;
};

function sharingInputs(target: unknown, source: unknown): SharingInputs {
    return {targetNodes: collectObjectNodes(target), sourceNodes: collectObjectNodes(source)};
}

/**
 * Compares which references the actual result shares with the inputs against the expected tree:
 * - where the expected tree holds an input reference, the actual result must hold that same reference
 *   (an equal target reference is accepted in place of a source array or date, since that is only a
 *   skipped no-op);
 * - where the expected tree holds a fresh object, the actual result must not hold a source object, because
 *   that would let a later change to the caller's object leak into the stored value.
 */
function findSharingProblems(actual: unknown, expected: unknown, inputs: SharingInputs, path = '$'): string[] {
    if (typeof expected !== 'object' || expected === null) {
        return [];
    }

    if (inputs.targetNodes.has(expected) || inputs.sourceNodes.has(expected)) {
        if (actual === expected) {
            return [];
        }
        const isEqualTargetReuse = !isMergeable(expected) && typeof actual === 'object' && actual !== null && inputs.targetNodes.has(actual) && deepEqual(actual, expected);
        return isEqualTargetReuse ? [] : [`${path}: expected the input reference to be reused`];
    }

    if (typeof actual !== 'object' || actual === null) {
        return [];
    }

    if (isMergeable(actual) && inputs.sourceNodes.has(actual) && !inputs.targetNodes.has(actual)) {
        return [`${path}: the result aliases an object of the source`];
    }

    if (inputs.targetNodes.has(actual) || !isMergeable(expected)) {
        return [];
    }

    return Object.keys(expected).flatMap((key) => findSharingProblems(Reflect.get(actual, key), expected[key], inputs, `${path}.${key}`));
}

if (expect.getState().testPath === __filename) {
    describe('utils contract models', () => {
        it('keeps the target when a patch changes nothing', () => {
            const target = {a: 1, b: {c: 1}};
            expect(modelFastMerge(target, {b: {c: 1}}, {removeNulls: true, mode: 'none'}).value).toBe(target);
        });

        it('reports a fresh object that aliases the source', () => {
            const nested = {c: 1};
            const source = {b: nested};
            expect(findSharingProblems({b: nested}, {b: {c: 1}}, sharingInputs(undefined, source))).toStrictEqual(['$.b: the result aliases an object of the source']);
        });

        it('reports a copy where the input reference was expected', () => {
            const target = {a: {b: 1}};
            expect(findSharingProblems({a: {b: 1}}, target, sharingInputs(target, {}))).toStrictEqual(['$: expected the input reference to be reused']);
        });

        it('removes nested nulls and keeps untouched subtrees', () => {
            const kept = {x: 1};
            const result = modelRemoveNestedNulls({a: kept, b: {c: null}});
            expect(result).toStrictEqual({a: {x: 1}, b: {}});
            expect(isMergeable(result) && result.a).toBe(kept);
        });
    });
}

export type {ModelOptions, ModelPatch, ObjectRemovalMode, SharingInputs};
export {findSharingProblems, modelFastMerge, modelRemoveNestedNulls, sharingInputs};
