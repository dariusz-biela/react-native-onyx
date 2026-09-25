/**
 * Contracts of `OnyxUtils.prepareKeyValuePairsForStorage`, which turns a key-value map into the storage pairs
 * written by `multiSet`, `setCollection`, `mergeCollection` and `update`, plus the keys to remove.
 */
import cloneDeep from 'lodash/cloneDeep';

import type {MultiMergeReplaceNullPatches} from '../../../../lib/types';

import OnyxUtils from '../../../../lib/OnyxUtils';
import {deepFreeze} from '../merge/helpers/model';
import {readPath} from './helpers';

function sortedPairs(pairs: unknown[][]): unknown[][] {
    return [...pairs].sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

function pairValue(data: Record<string, unknown>, key: string, shouldRemoveNestedNulls?: boolean): unknown {
    return OnyxUtils.prepareKeyValuePairsForStorage(data, shouldRemoveNestedNulls).pairs.find(([pairKey]) => pairKey === key)?.[1];
}

describe('OnyxUtils.prepareKeyValuePairsForStorage', () => {
    describe('pairs and removals', () => {
        it('writes every defined value, removes top-level nulls and skips undefined values', () => {
            const {pairs, keysToRemove} = OnyxUtils.prepareKeyValuePairsForStorage({
                a: null,
                b: undefined,
                c: {x: null, y: [null, {z: null}]},
                d: 0,
                e: [null],
                f: '',
                g: false,
                h: null,
            });

            expect(sortedPairs(pairs)).toStrictEqual([
                ['c', {y: [null, {z: null}]}, undefined],
                ['d', 0, undefined],
                ['e', [null], undefined],
                ['f', '', undefined],
                ['g', false, undefined],
            ]);
            expect([...keysToRemove].sort()).toStrictEqual(['a', 'h']);
        });

        it('returns empty lists for empty data', () => {
            expect(OnyxUtils.prepareKeyValuePairsForStorage({})).toStrictEqual({pairs: [], keysToRemove: []});
        });

        it('removes a top-level null even when nested nulls are kept', () => {
            expect(OnyxUtils.prepareKeyValuePairsForStorage({a: null, b: {c: null}}, false)).toStrictEqual({pairs: [['b', {c: null}, undefined]], keysToRemove: ['a']});
        });

        it('reads the data on every call, so a reused and changed map gives fresh pairs', () => {
            const data: Record<string, unknown> = {a: 1};
            expect(OnyxUtils.prepareKeyValuePairsForStorage(data).pairs).toStrictEqual([['a', 1, undefined]]);

            data.a = null;
            data.b = {c: 1};

            expect(OnyxUtils.prepareKeyValuePairsForStorage(data)).toStrictEqual({pairs: [['b', {c: 1}, undefined]], keysToRemove: ['a']});
        });
    });

    describe('nested nulls', () => {
        it.each([
            {name: 'the flag is left out', flag: undefined},
            {name: 'the flag is true', flag: true},
        ])('strips nested null and undefined properties at every depth when $name', ({flag}) => {
            const value = {a: 1, b: null, c: undefined, d: {e: null, f: {g: undefined, h: {i: null, j: 2}}}};

            expect(pairValue({key: value}, 'key', flag)).toStrictEqual({a: 1, d: {f: {h: {j: 2}}}});
        });

        it('leaves an object that only held nulls as an empty object', () => {
            expect(pairValue({key: {b: null}}, 'key')).toStrictEqual({});
            expect(pairValue({key: {a: {b: null}}}, 'key')).toStrictEqual({a: {}});
        });

        it('keeps values with nested nulls by reference when the flag is false', () => {
            const value = {a: null, b: {c: null}};

            expect(pairValue({key: value}, 'key', false)).toBe(value);
        });

        it('does not look inside arrays', () => {
            const list = [null, {a: null}];
            const value = {list, nested: {list}};

            const prepared = pairValue({key: value, top: list}, 'key');

            expect(prepared).toBe(value);
            expect(pairValue({top: list}, 'top')).toBe(list);
        });

        it('keeps a clean value by reference', () => {
            const value = {a: 1, b: {c: [1], d: {e: 'x'}}, f: new Date(0)};

            expect(pairValue({key: value}, 'key')).toBe(value);
        });

        it('copies only the branches that held nulls and keeps the others by reference', () => {
            const untouched = {deep: {x: 1}};
            const list = [1, null];
            const value = {untouched, list, changed: {y: 1, z: null}};

            const prepared = pairValue({key: value}, 'key');

            expect(prepared).toStrictEqual({untouched, list, changed: {y: 1}});
            expect(prepared).not.toBe(value);
            expect(readPath(prepared, ['untouched'])).toBe(untouched);
            expect(readPath(prepared, ['list'])).toBe(list);
            expect(readPath(prepared, ['changed'])).not.toBe(value.changed);
        });

        it('mutates neither the data nor its values', () => {
            const data = deepFreeze({a: {b: null, c: {d: undefined, e: 1}}, f: null, g: [null]});
            const copy = cloneDeep(data);

            OnyxUtils.prepareKeyValuePairsForStorage(data);
            OnyxUtils.prepareKeyValuePairsForStorage(data, false);

            expect(data).toStrictEqual(copy);
        });
    });

    describe('replace-null patches', () => {
        it('attaches the patches of each key as the third element and leaves it undefined for keys without patches', () => {
            const patches: MultiMergeReplaceNullPatches = {a: [[['x'], {y: 1}]], gone: [[['z'], {}]]};

            const {pairs, keysToRemove} = OnyxUtils.prepareKeyValuePairsForStorage({a: {x: {y: 1}, w: null}, b: {c: 1}, gone: null}, false, patches);

            expect(sortedPairs(pairs)).toStrictEqual([
                ['a', {x: {y: 1}, w: null}, patches.a],
                ['b', {c: 1}, undefined],
            ]);
            expect(pairs.find(([key]) => key === 'a')?.[2]).toBe(patches.a);
            expect(keysToRemove).toStrictEqual(['gone']);
        });

        it('attaches patches when nested nulls are stripped too', () => {
            const patches: MultiMergeReplaceNullPatches = {a: [[['x'], {y: 1}]]};

            expect(OnyxUtils.prepareKeyValuePairsForStorage({a: {x: {y: 1}, w: null}}, true, patches).pairs).toStrictEqual([['a', {x: {y: 1}}, patches.a]]);
        });
    });

    describe('hot path', () => {
        it('prepares 300 report rows where every third one carries nulled error and pending fields', () => {
            const data = deepFreeze(
                Object.fromEntries(
                    Array.from({length: 300}, (_, index) => {
                        const base = {reportID: String(index), participants: {'1': {notificationPreference: 'always'}}, lastMessageText: `message ${index}`};
                        if (index % 3 !== 0) {
                            return [`report_${index}`, base];
                        }
                        return [`report_${index}`, {...base, errorFields: {avatar: null}, pendingFields: {avatar: null, name: 'update'}}];
                    }),
                ),
            );

            const {pairs, keysToRemove} = OnyxUtils.prepareKeyValuePairsForStorage(data, true);

            expect(keysToRemove).toStrictEqual([]);
            expect(pairs).toHaveLength(300);
            for (const [key, value] of pairs) {
                const input = data[key];
                const index = Number(key.replace('report_', ''));
                if (index % 3 !== 0) {
                    expect(value).toBe(input);
                    continue;
                }
                expect(value).toStrictEqual({...input, errorFields: {}, pendingFields: {name: 'update'}});
                expect(readPath(value, ['participants'])).toBe(input.participants);
            }
        });
    });
});
