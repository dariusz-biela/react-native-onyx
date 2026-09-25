/**
 * Contracts of `OnyxUtils.mergeAndMarkChanges`, which folds a queue of merge changes into one batched change
 * for storage. It keeps nulls (storage uses them to delete) and marks objects that replace a nulled object, so
 * the native merge path and the grouped member path of `Onyx.update` can apply the batch in one step. The batch
 * merged with `mergeChanges` must give the same value as merging the changes one by one.
 */
import cloneDeep from 'lodash/cloneDeep';

import OnyxUtils from '../../../../lib/OnyxUtils';
import utils from '../../../../lib/utils';
import {createRng, deepFreeze, findForbiddenLeaf, generateBatch, generatePatch, isNativeCacheSafeBatch} from '../merge/helpers/model';
import {collectPlainObjects, isCompatible, readPath} from './helpers';

const MARK = utils.ONYX_INTERNALS__REPLACE_OBJECT_MARK;

/** What `OnyxMerge.applyMerge` (native) caches: the marked batch merged into the value, which a top-level null discards. */
function mergeThroughBatch(changes: unknown[], existing: unknown): unknown {
    const base = changes.includes(null) ? undefined : existing;
    const batch = OnyxUtils.mergeAndMarkChanges(changes).result;
    return OnyxUtils.mergeChanges([batch], base).result;
}

describe('OnyxUtils.mergeAndMarkChanges', () => {
    describe('batched value', () => {
        it('merges the changes in order and keeps nested nulls for storage', () => {
            const {result, replaceNullPatches} = OnyxUtils.mergeAndMarkChanges([{a: 1, b: {x: 1}}, {a: 2, b: {x: null, y: 1}}, {c: null}]);

            expect(result).toStrictEqual({a: 2, b: {x: null, y: 1}, c: null});
            expect(replaceNullPatches).toStrictEqual([]);
        });

        it('keeps a null that follows an object at the same path', () => {
            expect(OnyxUtils.mergeAndMarkChanges([{a: {x: 1}}, {a: null}]).result).toStrictEqual({a: null});
        });

        it('overwrites a null with a primitive or an array without marking it', () => {
            expect(
                OnyxUtils.mergeAndMarkChanges([
                    {a: null, b: null},
                    {a: 5, b: [1]},
                ]),
            ).toStrictEqual({result: {a: 5, b: [1]}, replaceNullPatches: []});
        });

        it('returns the last change like mergeChanges when it is an array or no change is an object', () => {
            const last = [1];

            expect(OnyxUtils.mergeAndMarkChanges([{a: 1}, last]).result).toBe(last);
            expect(OnyxUtils.mergeAndMarkChanges([{a: null}, {a: {x: 1}}, last])).toStrictEqual({result: last, replaceNullPatches: []});
            expect(OnyxUtils.mergeAndMarkChanges(['a', 'b']).result).toBe('b');
            expect(OnyxUtils.mergeAndMarkChanges([]).result).toBeUndefined();
        });

        it('loses a leading top-level null, which callers read from the queue themselves', () => {
            expect(OnyxUtils.mergeAndMarkChanges([null, {a: 1}]).result).toStrictEqual({a: 1});
            expect(OnyxUtils.mergeAndMarkChanges([{a: 1}, null]).result).toBeNull();
        });

        it('marks against the existing value it is given', () => {
            expect(OnyxUtils.mergeAndMarkChanges([{a: {x: 1}}], {a: null, b: 1})).toStrictEqual({
                result: {a: {[MARK]: true, x: 1}, b: 1},
                replaceNullPatches: [[['a'], {x: 1}]],
            });
        });

        it('computes every call from its own arguments, even when the change list is reused', () => {
            const changes = [{a: {x: 1}}];

            expect(OnyxUtils.mergeAndMarkChanges(changes, {a: null}).replaceNullPatches).toStrictEqual([[['a'], {x: 1}]]);
            expect(OnyxUtils.mergeAndMarkChanges(changes)).toStrictEqual({result: {a: {x: 1}}, replaceNullPatches: []});
        });

        it('reads a change list that grew since the previous call', () => {
            const changes: Array<Record<string, unknown>> = [{a: null}];

            expect(OnyxUtils.mergeAndMarkChanges(changes).result).toStrictEqual({a: null});
            changes.push({a: {x: 1}});

            expect(OnyxUtils.mergeAndMarkChanges(changes)).toStrictEqual({result: {a: {[MARK]: true, x: 1}}, replaceNullPatches: [[['a'], {x: 1}]]});
        });
    });

    describe('replace marks and patches', () => {
        it('marks an object that follows a null at the same path and records a patch with its content', () => {
            expect(OnyxUtils.mergeAndMarkChanges([{a: null}, {a: {x: 1}}])).toStrictEqual({
                result: {a: {[MARK]: true, x: 1}},
                replaceNullPatches: [[['a'], {x: 1}]],
            });
        });

        it('records the full path of a deeper replaced object', () => {
            expect(OnyxUtils.mergeAndMarkChanges([{a: {b: {c: null}}}, {a: {b: {c: {d: 1}}}}])).toStrictEqual({
                result: {a: {b: {c: {[MARK]: true, d: 1}}}},
                replaceNullPatches: [[['a', 'b', 'c'], {d: 1}]],
            });
        });

        it('merges later changes into a marked object without recording another patch', () => {
            expect(OnyxUtils.mergeAndMarkChanges([{a: null}, {a: {x: 1}}, {a: {y: 2}}])).toStrictEqual({
                result: {a: {[MARK]: true, x: 1, y: 2}},
                replaceNullPatches: [[['a'], {x: 1}]],
            });
        });

        it('records one patch per null-to-object transition, in change order across paths', () => {
            const {result, replaceNullPatches} = OnyxUtils.mergeAndMarkChanges([{a: null, b: null}, {b: {y: 1}}, {a: {x: 1}}, {a: null}, {a: {x: 2}}]);

            expect(result).toStrictEqual({a: {[MARK]: true, x: 2}, b: {[MARK]: true, y: 1}});
            expect(replaceNullPatches).toStrictEqual([
                [['b'], {y: 1}],
                [['a'], {x: 1}],
                [['a'], {x: 2}],
            ]);
        });

        it('records a copy of the change object as the patch value, not the change object itself', () => {
            const replacement = {x: 1, nested: {y: 1}};

            const {result, replaceNullPatches} = OnyxUtils.mergeAndMarkChanges([{a: null}, {a: replacement}]);

            expect(replaceNullPatches).toStrictEqual([[['a'], {x: 1, nested: {y: 1}}]]);
            expect(replaceNullPatches[0][1]).not.toBe(replacement);
            expect(readPath(result, ['a'])).not.toBe(replacement);
        });

        it('points every patch at a marked object of the batch and never puts the mark into a patch value', () => {
            const {result, replaceNullPatches} = OnyxUtils.mergeAndMarkChanges([
                {a: null, n: {m: null}},
                {a: {x: 1}, n: {m: {k: {deep: 1}}}},
            ]);

            expect(replaceNullPatches).toHaveLength(2);
            for (const [path, value] of replaceNullPatches) {
                expect(readPath(result, [...path, MARK])).toBe(true);
                expect(readPath(value, [MARK])).toBeUndefined();
            }
        });
    });

    describe('inputs', () => {
        it('mutates neither the changes nor the existing value', () => {
            const existing = deepFreeze({a: null, b: {c: 1}});
            const changes = deepFreeze([{a: {x: 1}}, {b: null}, {b: {d: 1}}, {e: null}]);
            const existingCopy = cloneDeep(existing);
            const changesCopy = cloneDeep(changes);

            const {result} = OnyxUtils.mergeAndMarkChanges(changes, existing);

            expect(result).toStrictEqual({a: {[MARK]: true, x: 1}, b: {[MARK]: true, d: 1}, e: null});
            expect(existing).toStrictEqual(existingCopy);
            expect(changes).toStrictEqual(changesCopy);
        });

        it('never puts a plain object of a change into the batched value', () => {
            const changes = [{a: {b: {c: 1}}}, {d: null}, {d: {e: {f: 1}}}];
            const {result} = OnyxUtils.mergeAndMarkChanges(changes);
            const changeObjects = new Set<unknown>();
            for (const change of changes) {
                collectPlainObjects(change, changeObjects);
            }

            for (const object of collectPlainObjects(result)) {
                expect(changeObjects.has(object)).toBe(false);
            }
        });
    });

    describe('round trip through mergeChanges', () => {
        it.each<{name: string; existing: unknown; changes: unknown[]}>([
            {name: 'a nested replace', existing: {a: {y: 1}, b: 1}, changes: [{a: null}, {a: {x: 1}}]},
            {name: 'a nested removal', existing: {a: {y: 1}, b: 1}, changes: [{a: {x: 1}}, {a: null}]},
            {name: 'a replace followed by more merges', existing: {a: {y: 1}}, changes: [{a: null}, {a: {x: 1}}, {a: {z: 1}}]},
            {name: 'a deep replace', existing: {a: {b: {c: {old: 1}, keep: 1}}}, changes: [{a: {b: {c: null}}}, {a: {b: {c: {d: 1}}}}]},
            {name: 'a top-level null', existing: {old: 1}, changes: [null, {fresh: 1}]},
            {name: 'no existing value', existing: undefined, changes: [{a: 1, b: {c: 1}}, {b: {d: 1}}]},
        ])('gives the same value as merging the changes directly ($name)', ({existing, changes}) => {
            const direct = OnyxUtils.mergeChanges(changes, existing).result;
            const throughBatch = mergeThroughBatch(changes, existing);

            expect(throughBatch).toStrictEqual(direct);
            expect(findForbiddenLeaf(throughBatch)).toBeUndefined();
        });

        it('gives the same value for a queue of 20 report action changes (the queue flush hot path)', () => {
            const existing = deepFreeze(Object.fromEntries(Array.from({length: 100}, (_, index) => [String(index), {reportActionID: String(index), isOptimisticAction: false}])));
            const changes = Array.from({length: 20}, (_, index) => ({[String(index % 7)]: {isOptimisticAction: index % 2 === 0, lastModified: String(index)}}));

            const marked = OnyxUtils.mergeAndMarkChanges(changes);

            expect(marked.replaceNullPatches).toStrictEqual([]);
            expect(Object.keys(marked.result ?? {})).toHaveLength(7);
            expect(OnyxUtils.mergeChanges([marked.result], existing).result).toStrictEqual(OnyxUtils.mergeChanges(changes, existing).result);
        });

        const SEEDS = 400;

        it(`gives the same value over ${SEEDS} seeded batches that avoid the known native divergences`, () => {
            let checked = 0;
            for (let seed = 1; seed <= SEEDS; seed++) {
                const rng = createRng(seed);
                const existing: unknown = rng() < 0.3 ? undefined : deepFreeze(generatePatch(rng));
                const changes = deepFreeze(generateBatch(rng).filter((change) => change !== undefined && isCompatible(change, existing)));
                if (changes.length === 0 || !isNativeCacheSafeBatch(changes)) {
                    continue;
                }
                checked++;

                const label = `seed ${seed}`;
                expect({label, value: mergeThroughBatch(changes, existing)}).toStrictEqual({label, value: OnyxUtils.mergeChanges(changes, existing).result});
            }
            expect(checked).toBeGreaterThan(SEEDS * 0.6);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('keeps a nested null that arrives inside an object replacing a nulled one when the batch is merged', () => {
            const changes = [{a: null}, {a: {b: null, c: 1}}];

            expect(OnyxUtils.mergeChanges(changes, {a: {x: 1}}).result).toStrictEqual({a: {c: 1}});
            expect(mergeThroughBatch(changes, {a: {x: 1}})).toStrictEqual({a: {b: null, c: 1}});
        });

        it('leaks a nested replace mark into the merged value when a replaced object gets a nulled child replaced again', () => {
            const changes = [{a: null}, {a: {b: null}}, {a: {b: {x: 1}}}];

            expect(OnyxUtils.mergeAndMarkChanges(changes)).toStrictEqual({
                result: {a: {[MARK]: true, b: {[MARK]: true, x: 1}}},
                replaceNullPatches: [
                    [['a'], {b: null}],
                    [['a', 'b'], {x: 1}],
                ],
            });
            expect(OnyxUtils.mergeChanges(changes, {a: {b: {y: 1}, c: 1}}).result).toStrictEqual({a: {b: {x: 1}}});
            expect(mergeThroughBatch(changes, {a: {b: {y: 1}, c: 1}})).toStrictEqual({a: {b: {[MARK]: true, x: 1}}});
        });

        it('merges an object into the old value when a top-level primitive precedes it, where direct merging replaces it', () => {
            const changes = ['text', {a: 1}];

            expect(OnyxUtils.mergeChanges(changes, {old: 1}).result).toStrictEqual({a: 1});
            expect(mergeThroughBatch(changes, {old: 1})).toStrictEqual({old: 1, a: 1});
        });
    });
});
