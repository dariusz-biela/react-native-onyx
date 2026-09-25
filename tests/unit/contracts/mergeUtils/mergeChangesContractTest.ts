/**
 * Contracts of `OnyxUtils.mergeChanges`, the function that folds a queue of merge changes into the value a key
 * holds. `Onyx.merge` (web variant) and `Onyx.update` call it for the value they cache and broadcast, so the
 * result, its references and the inputs it must leave untouched are all observable by subscribers.
 */
import cloneDeep from 'lodash/cloneDeep';

import OnyxUtils from '../../../../lib/OnyxUtils';
import utils from '../../../../lib/utils';
import {createRng, deepFreeze, findForbiddenLeaf, generateBatch, generatePatch} from '../merge/helpers/model';
import {collectPlainObjects, isCompatible, modelMergeChanges, readPath} from './helpers';

const MARK = utils.ONYX_INTERNALS__REPLACE_OBJECT_MARK;

type ReportAction = {reportActionID: string; message: {text: string}; isOptimisticAction?: boolean; lastModified?: string};

function buildReportActions(count: number): Record<string, ReportAction> {
    const actions: Record<string, ReportAction> = {};
    for (let index = 0; index < count; index++) {
        const reportActionID = String(1000 + index);
        actions[reportActionID] = {reportActionID, message: {text: `message ${index}`}, isOptimisticAction: false};
    }
    return actions;
}

describe('OnyxUtils.mergeChanges', () => {
    describe('order of the change list', () => {
        it('applies changes in list order, so a later change wins at the same path', () => {
            const {result} = OnyxUtils.mergeChanges([{a: 1, b: {x: 1}}, {a: 2}, {b: {x: 3, y: 1}}], {a: 0, c: 1});

            expect(result).toStrictEqual({a: 2, b: {x: 3, y: 1}, c: 1});
        });

        it('deep merges every change into the existing value and keeps untouched properties', () => {
            const {result} = OnyxUtils.mergeChanges([{nested: {deep: {x: 2}}}, {nested: {other: 1}}], {nested: {deep: {x: 1, y: 1}, kept: true}, top: 'kept'});

            expect(result).toStrictEqual({nested: {deep: {x: 2, y: 1}, kept: true, other: 1}, top: 'kept'});
        });

        it('keeps the existing key order and appends new keys in the order the changes add them', () => {
            const {result} = OnyxUtils.mergeChanges([{z: 1}, {b: 2, y: 1}, {a: 3}], {a: 0, b: 0});

            expect(Object.keys(result ?? {})).toStrictEqual(['a', 'b', 'z', 'y']);
        });

        it('moves a key that a change removes and a later change adds back to the end', () => {
            const {result} = OnyxUtils.mergeChanges([{a: null}, {a: 1}], {a: 0, b: 1});

            expect(result).toStrictEqual({b: 1, a: 1});
            expect(Object.keys(result ?? {})).toStrictEqual(['b', 'a']);
        });

        it('computes every call from its own arguments, even when the change list is reused', () => {
            const changes = [{a: 1}];

            expect(OnyxUtils.mergeChanges(changes, {b: 1}).result).toStrictEqual({a: 1, b: 1});
            expect(OnyxUtils.mergeChanges(changes, {c: 1}).result).toStrictEqual({a: 1, c: 1});
            expect(OnyxUtils.mergeChanges(changes).result).toStrictEqual({a: 1});
        });

        it('reads a change list that grew since the previous call with the same existing value', () => {
            const existing = {b: 1};
            const changes: Array<Record<string, unknown>> = [{a: 1}];

            expect(OnyxUtils.mergeChanges(changes, existing).result).toStrictEqual({a: 1, b: 1});
            changes.push({c: 1});

            expect(OnyxUtils.mergeChanges(changes, existing).result).toStrictEqual({a: 1, b: 1, c: 1});
        });
    });

    describe('values that are not objects', () => {
        it('returns the last change by reference when it is an array', () => {
            const last = [3, 4];
            const merged = OnyxUtils.mergeChanges([{a: 1}, [1, 2], last], {a: 0});

            expect(merged.result).toBe(last);
            expect(merged.replaceNullPatches).toStrictEqual([]);
        });

        it.each<{name: string; changes: unknown[]; expected: unknown}>([
            {name: 'primitives', changes: ['a', 0, 'b', 1], expected: 1},
            {name: 'a trailing null', changes: ['a', null], expected: null},
            {name: 'a single null', changes: [null], expected: null},
            {name: 'a trailing undefined', changes: ['a', undefined], expected: undefined},
            {name: 'a falsy primitive', changes: [1, false], expected: false},
        ])('returns the last change when no change is an object ($name)', ({changes, expected}) => {
            expect(OnyxUtils.mergeChanges(changes, {a: 1})).toStrictEqual({result: expected, replaceNullPatches: []});
        });

        it('returns undefined for an empty change list and ignores the existing value', () => {
            expect(OnyxUtils.mergeChanges([], {a: 1})).toStrictEqual({result: undefined, replaceNullPatches: []});
        });

        it.each([
            {name: 'a top-level null', breaker: null},
            {name: 'a primitive', breaker: 5},
            {name: 'an array', breaker: [1]},
        ])('starts again from an empty object after $name in the middle of the list', ({breaker}) => {
            const {result} = OnyxUtils.mergeChanges([{a: 1}, breaker, {b: 2}], {z: 1});

            expect(result).toStrictEqual({b: 2});
        });

        it.each([
            {name: 'null', last: null},
            {name: 'undefined', last: undefined},
            {name: 'a primitive', last: 'text'},
        ])('ends with the last change when an object list ends with $name', ({last}) => {
            expect(OnyxUtils.mergeChanges([{a: 1}, last], {z: 1}).result).toBe(last);
        });

        it.each([
            {name: 'no existing value', existing: undefined},
            {name: 'a primitive existing value', existing: 'text'},
            {name: 'a non-empty array existing value', existing: [1, 2]},
            {name: 'an empty array existing value', existing: []},
        ])('starts from an empty object when there is $name', ({existing}) => {
            expect(OnyxUtils.mergeChanges([{a: 1}], existing).result).toStrictEqual({a: 1});
        });

        it('replaces nested arrays, Dates and primitives with the value of the change', () => {
            const date = new Date(0);
            const {result} = OnyxUtils.mergeChanges([{list: [4], when: date, text: {nowObject: true}, obj: 'nowText'}], {
                list: [1, 2, 3],
                when: {was: 'object'},
                text: 'was text',
                obj: {was: 'object'},
            });

            expect(result).toStrictEqual({list: [4], when: date, text: {nowObject: true}, obj: 'nowText'});
        });
    });

    describe('null and undefined', () => {
        it('removes properties set to null at any depth', () => {
            const {result} = OnyxUtils.mergeChanges([{a: null, b: {c: null, d: {e: null}}}], {a: 1, b: {c: 1, d: {e: 1, f: 1}, g: 1}});

            expect(result).toStrictEqual({b: {d: {f: 1}, g: 1}});
        });

        it('removes a property set in one change and nulled in a later one', () => {
            expect(OnyxUtils.mergeChanges([{a: {x: 1}}, {a: null}], {a: {y: 1}, b: 1}).result).toStrictEqual({b: 1});
        });

        it('replaces a nested object when a change nulls it and a later change sets it again', () => {
            expect(OnyxUtils.mergeChanges([{a: null}, {a: {x: 1}}], {a: {y: 1}}).result).toStrictEqual({a: {x: 1}});
        });

        it('removes nulls from a value created without an existing value, keeping emptied objects', () => {
            expect(OnyxUtils.mergeChanges([{a: 1, b: null, c: {d: null}}]).result).toStrictEqual({a: 1, c: {}});
        });

        it('ignores undefined properties of a change', () => {
            expect(OnyxUtils.mergeChanges([{a: undefined, b: {c: undefined}}], {a: 1, b: {c: 1}}).result).toStrictEqual({a: 1, b: {c: 1}});
        });

        it('drops existing nulls and undefined at the levels a change touches and keeps them at untouched levels', () => {
            const untouched = {f: null};
            const {result} = OnyxUtils.mergeChanges([{c: {g: 1}}], {a: null, b: undefined, c: {d: null}, e: untouched});

            expect(result).toStrictEqual({c: {g: 1}, e: {f: null}});
            expect(readPath(result, ['e'])).toBe(untouched);
        });

        it('drops an existing undefined property even when the change restates everything else', () => {
            const existing = {a: undefined, b: 1};
            const {result} = OnyxUtils.mergeChanges([{b: 1}], existing);

            expect(result).toStrictEqual({b: 1});
            expect(Object.keys(result ?? {})).toStrictEqual(['b']);
        });

        it('keeps falsy primitives', () => {
            expect(OnyxUtils.mergeChanges([{a: 0, b: false, c: ''}], {a: 1, b: true, c: 'x'}).result).toStrictEqual({a: 0, b: false, c: ''});
        });
    });

    describe('replace marks', () => {
        it('replaces a marked nested object wholesale and removes the mark', () => {
            const {result} = OnyxUtils.mergeChanges([{a: {[MARK]: true, x: 1}}], {a: {y: 1, z: {deep: 1}}, b: 1});

            expect(result).toStrictEqual({a: {x: 1}, b: 1});
        });

        it('uses a marked object as is when the existing value has nothing at that path', () => {
            expect(OnyxUtils.mergeChanges([{a: {b: {[MARK]: true, x: 1}}}], {c: 1}).result).toStrictEqual({a: {b: {x: 1}}, c: 1});
        });

        it('never returns replace-null patches, even for marked changes', () => {
            expect(OnyxUtils.mergeChanges([{a: null}, {a: {[MARK]: true, x: 1}}], {a: {y: 1}}).replaceNullPatches).toStrictEqual([]);
        });

        it.each([
            {name: 'frozen', freeze: true},
            {name: 'mutable', freeze: false},
        ])('strips the mark from a copy and leaves the $name marked change as it was', ({freeze}) => {
            const change = {a: {[MARK]: true, x: 1}};
            const marked = freeze ? deepFreeze(change) : change;

            const {result} = OnyxUtils.mergeChanges([marked], {a: {y: 1}});

            expect(result).toStrictEqual({a: {x: 1}});
            expect(readPath(result, ['a'])).not.toBe(marked.a);
            expect(marked).toStrictEqual({a: {[MARK]: true, x: 1}});
        });
    });

    describe('references', () => {
        it.each<{name: string; changes: unknown[]}>([
            {name: 'an empty change', changes: [{}]},
            {name: 'a change restating equal values', changes: [{a: 1, b: {c: 1}}]},
            {name: 'a change nulling a missing property', changes: [{missing: null}]},
            {name: 'a change with only undefined properties', changes: [{a: undefined}]},
            {name: 'several unchanged changes', changes: [{a: 1}, {b: {c: 1}}, {}]},
        ])('returns the existing reference when nothing changes ($name)', ({changes}) => {
            const existing = {a: 1, b: {c: 1}};

            expect(OnyxUtils.mergeChanges(changes, existing).result).toBe(existing);
        });

        it('keeps the references of untouched nested objects and gives changed paths new references', () => {
            const existing = {changed: {inner: {x: 1}, kept: {y: 1}}, untouched: {z: 1}};
            const {result} = OnyxUtils.mergeChanges([{changed: {inner: {x: 2}}}], existing);

            expect(result).not.toBe(existing);
            expect(readPath(result, ['untouched'])).toBe(existing.untouched);
            expect(readPath(result, ['changed'])).not.toBe(existing.changed);
            expect(readPath(result, ['changed', 'kept'])).toBe(existing.changed.kept);
            expect(readPath(result, ['changed', 'inner'])).not.toBe(existing.changed.inner);
        });

        it('keeps the references of every untouched report action and the order of the actions (the queue flush hot path)', () => {
            const existing = deepFreeze(buildReportActions(200));
            const ids = Object.keys(existing);
            const touched = new Set(ids.slice(0, 5));
            const changes = Array.from({length: 20}, (_, index) => ({
                [ids[index % 5]]: {isOptimisticAction: index % 2 === 0, lastModified: `2026-09-14 12:00:${String(index).padStart(2, '0')}.000`},
            }));

            const {result} = OnyxUtils.mergeChanges(changes, existing);

            expect(Object.keys(result ?? {})).toStrictEqual(ids);
            for (const id of ids) {
                if (touched.has(id)) {
                    expect(result?.[id]).not.toBe(existing[id]);
                    expect(readPath(result, [id, 'message'])).toBe(existing[id].message);
                } else {
                    expect(result?.[id]).toBe(existing[id]);
                }
            }
            expect(result?.[ids[1]]).toStrictEqual({...existing[ids[1]], isOptimisticAction: true, lastModified: '2026-09-14 12:00:16.000'});
            expect(result?.[ids[4]]).toStrictEqual({...existing[ids[4]], isOptimisticAction: false, lastModified: '2026-09-14 12:00:19.000'});
        });

        it('returns the existing reference when a queue of changes restates the report actions', () => {
            const existing = deepFreeze(buildReportActions(50));
            const changes = Object.keys(existing).map((id) => ({[id]: {isOptimisticAction: false, message: {text: existing[id].message.text}}}));

            expect(OnyxUtils.mergeChanges(changes, existing).result).toBe(existing);
        });

        it('never puts a plain object of a change into the result, so later edits of a change cannot reach the cache', () => {
            const change = {a: {b: {c: 1}}, d: {}};
            const {result} = OnyxUtils.mergeChanges([change]);
            const changeObjects = collectPlainObjects(change);

            for (const object of collectPlainObjects(result)) {
                expect(changeObjects.has(object)).toBe(false);
            }
        });

        it('mutates neither the changes nor the existing value', () => {
            const existing = deepFreeze({a: {b: 1, c: null}, d: [1], e: 1});
            const changes = deepFreeze([{a: {b: 2}}, {a: null}, {a: {x: 1}, d: [2]}, {e: null, f: {g: null}}]);
            const existingCopy = cloneDeep(existing);
            const changesCopy = cloneDeep(changes);

            const {result} = OnyxUtils.mergeChanges(changes, existing);

            expect(result).toStrictEqual({a: {x: 1}, d: [2], f: {}});
            expect(existing).toStrictEqual(existingCopy);
            expect(changes).toStrictEqual(changesCopy);
        });
    });

    describe('against the independent model', () => {
        const SEEDS = 400;

        it(`matches the model, leaves the inputs intact and never aliases a change object over ${SEEDS} seeded batches`, () => {
            let checked = 0;
            for (let seed = 1; seed <= SEEDS; seed++) {
                const rng = createRng(seed);
                const existing: unknown = rng() < 0.3 ? undefined : deepFreeze(generatePatch(rng));
                const changes = deepFreeze(generateBatch(rng).filter((change) => isCompatible(change, existing)));
                if (changes.length === 0) {
                    continue;
                }
                checked++;

                const label = `seed ${seed}`;
                const {result, replaceNullPatches} = OnyxUtils.mergeChanges(changes, existing);

                expect({label, result}).toStrictEqual({label, result: modelMergeChanges(changes, existing)});
                expect({label, replaceNullPatches}).toStrictEqual({label, replaceNullPatches: []});

                const changeObjects = new Set<unknown>();
                for (const change of changes) {
                    collectPlainObjects(change, changeObjects);
                }
                const aliased = [...collectPlainObjects(result)].filter((object) => changeObjects.has(object));
                expect({label, aliased}).toStrictEqual({label, aliased: []});

                if (changes.every((change) => change !== null && typeof change === 'object' && !Array.isArray(change))) {
                    const touchesExisting = existing !== undefined;
                    const forbidden = touchesExisting ? undefined : findForbiddenLeaf(result);
                    expect({label, forbidden}).toStrictEqual({label, forbidden: undefined});
                }
            }
            expect(checked).toBeGreaterThan(SEEDS * 0.8);
        });
    });
});
