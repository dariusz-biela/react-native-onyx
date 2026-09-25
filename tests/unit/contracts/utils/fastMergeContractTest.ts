/**
 * Contract tests for `utils.fastMerge`, the deep merge under every `Onyx.merge`, the cache merge, the
 * storage `mergeItem`/`multiMerge` and the batching of queued merges. Each describe pins one rule callers
 * rely on: which sources replace instead of merge, how null and undefined behave per option, the key order
 * of the result, which references are reused, and the replace-null patches the mark mode produces.
 */
import type {FastMergeOptions} from '../../../../lib/utils';
import type {PlainObject} from './helpers/values';

import utils from '../../../../lib/utils';
import {REPLACE_OBJECT_MARK, deepFreeze, isMergeable} from './helpers/values';

const CACHE_OPTIONS: FastMergeOptions = {shouldRemoveNestedNulls: true, objectRemovalMode: 'replace'};
const MARK_OPTIONS: FastMergeOptions = {objectRemovalMode: 'mark'};

const ALL_OPTIONS: Array<[string, FastMergeOptions | undefined]> = [
    ['no options', undefined],
    ['remove nulls', {shouldRemoveNestedNulls: true}],
    ['mark', MARK_OPTIONS],
    ['mark and remove nulls', {shouldRemoveNestedNulls: true, objectRemovalMode: 'mark'}],
    ['replace', {objectRemovalMode: 'replace'}],
    ['replace and remove nulls', CACHE_OPTIONS],
];

function objectOf(value: unknown): PlainObject {
    if (!isMergeable(value)) {
        throw new Error(`Expected a mergeable object, got ${String(value)}`);
    }
    return value;
}

function merge(target: unknown, source: unknown, options?: FastMergeOptions): unknown {
    return utils.fastMerge<unknown>(deepFreeze(target), deepFreeze(source), options).result;
}

class Point {
    x: number;

    y: number | null;

    constructor(x: number, y: number | null) {
        this.x = x;
        this.y = y;
    }

    get sum(): number {
        return this.x + (this.y ?? 0);
    }
}

describe('utils.fastMerge contract', () => {
    describe('sources that replace instead of merge', () => {
        const replacingSources: Array<[string, unknown]> = [
            ['an array', [1, {a: null}]],
            ['an empty array', []],
            ['a Date', new Date(5)],
            ['a RegExp', /x/g],
            ['a string', 'text'],
            ['an empty string', ''],
            ['zero', 0],
            ['false', false],
            ['null', null],
            ['undefined', undefined],
        ];
        const targets: Array<[string, unknown]> = [
            ['an object', {a: 1, b: {c: null}}],
            ['an array', [1]],
            ['undefined', undefined],
            ['null', null],
        ];

        describe.each(ALL_OPTIONS)('with %s', (_optionsName, options) => {
            it.each(replacingSources)('returns %s source by reference over every target, with no patches', (_sourceName, source) => {
                for (const [, target] of targets) {
                    const merged = utils.fastMerge<unknown>(target, source, options);
                    expect(merged.result).toBe(source);
                    expect(merged.replaceNullPatches).toStrictEqual([]);
                }
            });
        });

        it('replaces nested arrays, dates and regular expressions by reference instead of merging into them', () => {
            const items = deepFreeze([{id: 2, gone: null}]);
            const date = new Date(10);
            const pattern = /y/;
            const result = objectOf(merge({items: [{id: 1, extra: true}], date: new Date(1), pattern: /x/, other: 1}, {items, date, pattern}, CACHE_OPTIONS));

            expect(result).toStrictEqual({items: [{id: 2, gone: null}], date: new Date(10), pattern: /y/, other: 1});
            expect(result.items).toBe(items);
            expect(result.date).toBe(date);
            expect(result.pattern).toBe(pattern);
        });

        it('keeps nulls inside arrays, even when nested nulls are removed', () => {
            const result = objectOf(merge({}, {list: [null, {a: null}], nested: {list: [null]}}, CACHE_OPTIONS));
            expect(result).toStrictEqual({list: [null, {a: null}], nested: {list: [null]}});
        });

        it('replaces an object with an array and an array with a fresh object', () => {
            expect(merge({a: {b: 1}}, {a: [2]}, CACHE_OPTIONS)).toStrictEqual({a: [2]});
            const source = {a: {b: 1}};
            const result = objectOf(merge({a: [2]}, source, CACHE_OPTIONS));
            expect(result).toStrictEqual({a: {b: 1}});
            expect(result.a).not.toBe(source.a);
        });
    });

    describe('object source over a target that is not an object', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
            ['a string', 'text'],
            ['a number', 7],
            ['an array', [1, 2]],
            ['a Date', new Date(1)],
        ])('over %s builds a deep copy of the source that shares no object with it', (_name, target) => {
            const list = [1];
            const source = {a: {b: {c: 1}}, list, empty: {}};
            const result = objectOf(merge(target, source));

            expect(result).toStrictEqual({a: {b: {c: 1}}, list: [1], empty: {}});
            expect(result).not.toBe(source);
            expect(result.a).not.toBe(source.a);
            expect(objectOf(result.a).b).not.toBe(source.a.b);
            expect(result.empty).not.toBe(source.empty);
            expect(result.list).toBe(list);
        });

        it('drops nested nulls and undefined of the source when nested nulls are removed, keeping emptied objects', () => {
            expect(merge(undefined, {a: null, b: undefined, c: {d: null}, e: {f: {g: undefined}}}, CACHE_OPTIONS)).toStrictEqual({c: {}, e: {f: {}}});
        });

        it('keeps nested nulls of the source when nested nulls are not removed, but still drops undefined', () => {
            expect(merge(undefined, {a: null, b: undefined, c: {d: null}})).toStrictEqual({a: null, c: {d: null}});
        });
    });

    describe('undefined', () => {
        it.each(ALL_OPTIONS)('an undefined source property never changes the target (%s)', (_name, options) => {
            const target = {a: 1, b: {c: 2}};
            expect(merge(target, {a: undefined, b: undefined, z: undefined}, options)).toBe(target);
            expect(merge(target, {b: {c: undefined}}, options)).toBe(target);
        });

        it.each(ALL_OPTIONS)('an undefined target property is dropped, so the result is a new object (%s)', (_name, options) => {
            const target = {a: undefined, b: 1};
            const result = merge(target, {b: 1}, options);
            expect(result).not.toBe(target);
            expect(result).toStrictEqual({b: 1});
        });
    });

    describe('null without nested null removal', () => {
        it('a source null overwrites the target value and a target null is kept', () => {
            expect(merge({a: 1, b: {c: 1}, d: null}, {a: null, b: null})).toStrictEqual({a: null, b: null, d: null});
        });

        it('a source null over a target null keeps the target reference', () => {
            const target = {a: null, b: 1};
            expect(merge(target, {a: null})).toBe(target);
        });

        it('an object over a target null builds a fresh object', () => {
            expect(merge({a: null}, {a: {b: null, c: 1}})).toStrictEqual({a: {b: null, c: 1}});
        });
    });

    describe('null with nested null removal', () => {
        it('a source null removes the property at any depth', () => {
            expect(merge({a: 1, b: {c: 1, d: {e: 1, f: 1}}}, {a: null, b: {d: {e: null}}}, CACHE_OPTIONS)).toStrictEqual({b: {c: 1, d: {f: 1}}});
        });

        it('a source null for a property the target does not have keeps the target reference', () => {
            const target = {a: 1, b: {c: 1}};
            expect(merge(target, {z: null, b: {y: null}}, CACHE_OPTIONS)).toBe(target);
        });

        it('drops every null of a target level the source visits, even under keys the source does not name', () => {
            const untouched = {x: null};
            const target = {a: untouched, b: null, c: {d: null, e: 1}};
            const result = objectOf(merge(target, {c: {e: 2}}, CACHE_OPTIONS));

            expect(result).toStrictEqual({a: {x: null}, c: {e: 2}});
            expect(result.a).toBe(untouched);
        });

        it('an object over a target null builds a fresh object without its nulls', () => {
            expect(merge({a: null}, {a: {b: null, c: 1}}, CACHE_OPTIONS)).toStrictEqual({a: {c: 1}});
        });

        it('keeps an object that became empty instead of removing it', () => {
            expect(merge({a: {b: 1}, c: 1}, {a: {b: null}}, CACHE_OPTIONS)).toStrictEqual({a: {}, c: 1});
        });

        it('a report patch that nulls a missing nested field creates an empty object for it', () => {
            const report = {reportID: '1', lastMessageText: 'old'};
            expect(merge(report, {lastMessageText: 'new', errorFields: {avatar: null}}, CACHE_OPTIONS)).toStrictEqual({reportID: '1', lastMessageText: 'new', errorFields: {}});
        });
    });

    describe('key order of the result', () => {
        it('keeps the target keys in their order, then appends new source keys in source order', () => {
            const result = merge({b: 1, a: 1, c: 1}, {d: 1, a: 2, e: 1});
            expect(Object.keys(objectOf(result))).toStrictEqual(['b', 'a', 'c', 'd', 'e']);
        });

        it('moves a target null that the source sets again to the end when nested nulls are removed', () => {
            expect(Object.keys(objectOf(merge({a: null, b: 1}, {a: 2}, CACHE_OPTIONS)))).toStrictEqual(['b', 'a']);
            expect(Object.keys(objectOf(merge({a: null, b: 1}, {a: 2})))).toStrictEqual(['a', 'b']);
        });

        it('keeps the order of nested keys the same way', () => {
            const result = objectOf(merge({n: {y: 1, x: 1}}, {n: {z: 1, x: 2}}));
            expect(Object.keys(objectOf(result.n))).toStrictEqual(['y', 'x', 'z']);
        });
    });

    describe('reference reuse', () => {
        it.each(ALL_OPTIONS)('returns the target when the source repeats its values, including the same nested references (%s)', (_name, options) => {
            const list = [1, 2];
            const date = new Date(3);
            const target = {a: 1, s: 'x', f: false, list, date, nested: {b: {c: 1}}};
            expect(merge(target, {a: 1, s: 'x', f: false, list, date, nested: target.nested}, options)).toBe(target);
            expect(merge(target, {nested: {b: {c: 1}}}, options)).toBe(target);
            expect(merge(target, {nested: {b: {}}}, options)).toBe(target);
            expect(merge(target, {}, options)).toBe(target);
        });

        it('reuses every unchanged subtree and rebuilds only the path to a change', () => {
            const unchangedSibling = {x: 1};
            const unchangedCousin = {y: 1};
            const target = {a: {b: {c: 1}, cousin: unchangedCousin}, sibling: unchangedSibling};
            const result = objectOf(merge(target, {a: {b: {c: 2}}}, CACHE_OPTIONS));
            const resultA = objectOf(result.a);

            expect(result).toStrictEqual({a: {b: {c: 2}, cousin: {y: 1}}, sibling: {x: 1}});
            expect(result).not.toBe(target);
            expect(resultA).not.toBe(target.a);
            expect(resultA.b).not.toBe(target.a.b);
            expect(resultA.cousin).toBe(unchangedCousin);
            expect(result.sibling).toBe(unchangedSibling);
        });

        it('never hands out a source object inside a new result', () => {
            const source = {a: {b: 1}, c: {d: {e: 1}}};
            const result = objectOf(merge({a: {b: 0}}, source, CACHE_OPTIONS));
            expect(result.a).not.toBe(source.a);
            expect(result.c).not.toBe(source.c);
            expect(objectOf(result.c).d).not.toBe(source.c.d);
        });

        it('keeps the report actions map when a pendingAction patch nulls fields the actions do not have', () => {
            const actions: PlainObject = {};
            const patch: PlainObject = {};
            for (let index = 0; index < 50; index++) {
                const action = {reportActionID: `${index}`, message: [{text: `m${index}`}], person: {name: 'n'}};
                actions[index] = action;
                patch[index] = {...action, pendingAction: null, isOptimisticAction: null};
            }
            expect(merge(actions, patch, {shouldRemoveNestedNulls: true})).toBe(actions);
        });

        it('rebuilds only the actions whose pendingAction a patch clears', () => {
            const actions: PlainObject = {};
            const patch: PlainObject = {};
            for (let index = 0; index < 10; index++) {
                const action = index % 2 === 0 ? {reportActionID: `${index}`, pendingAction: 'add'} : {reportActionID: `${index}`};
                actions[index] = action;
                patch[index] = {...action, pendingAction: null};
            }
            const result = objectOf(merge(actions, patch, {shouldRemoveNestedNulls: true}));

            for (let index = 0; index < 10; index++) {
                expect(result[index]).toStrictEqual({reportActionID: `${index}`});
                if (index % 2 === 0) {
                    expect(result[index]).not.toBe(actions[index]);
                } else {
                    expect(result[index]).toBe(actions[index]);
                }
            }
        });

        it('compares leaves with ===, so -0 over 0 keeps the target and its +0', () => {
            const target = {a: 0};
            const result = merge(target, {a: -0});
            expect(result).toBe(target);
            expect(Object.is(objectOf(result).a, 0)).toBe(true);
        });
    });

    describe('inputs are never written to', () => {
        it.each(ALL_OPTIONS)('merging into frozen inputs does not throw and leaves them equal to their snapshot (%s)', (_name, options) => {
            const target = deepFreeze({a: null, b: {c: 1, d: null}, e: [1], f: {g: {h: 1}}});
            const source = deepFreeze({a: {x: 1, y: null}, b: {c: null, i: {j: null}}, f: {g: {[REPLACE_OBJECT_MARK]: true, k: 1}}, e: [2]});
            const targetSnapshot = JSON.stringify(target);
            const sourceSnapshot = JSON.stringify(source);

            expect(() => utils.fastMerge<unknown>(target, source, options)).not.toThrow();
            expect(JSON.stringify(target)).toBe(targetSnapshot);
            expect(JSON.stringify(source)).toBe(sourceSnapshot);
        });
    });

    describe('options', () => {
        it('treats missing options like shouldRemoveNestedNulls false and objectRemovalMode none', () => {
            const target = {a: null, b: {c: 1}, m: null};
            const source = {b: {c: null}, m: {[REPLACE_OBJECT_MARK]: true, x: 1}};
            const expected = utils.fastMerge<unknown>(target, source, {shouldRemoveNestedNulls: false, objectRemovalMode: 'none'});

            expect(utils.fastMerge<unknown>(target, source).result).toStrictEqual(expected.result);
            expect(utils.fastMerge<unknown>(target, source, {}).result).toStrictEqual(expected.result);
            expect(utils.fastMerge<unknown>(target, source, {objectRemovalMode: 'none'}).result).toStrictEqual(expected.result);
            expect(expected.result).toStrictEqual({a: null, b: {c: null}, m: {[REPLACE_OBJECT_MARK]: true, x: 1}});
            expect(expected.replaceNullPatches).toStrictEqual([]);
        });
    });

    describe('mark mode (batching queued merges)', () => {
        it('marks an object written over a nested null and reports a patch with its full path', () => {
            const merged = utils.fastMerge<unknown>(deepFreeze({a: {b: null}, keep: 1}), deepFreeze({a: {b: {c: 1, d: null}}}), MARK_OPTIONS);

            expect(merged.result).toStrictEqual({a: {b: {[REPLACE_OBJECT_MARK]: true, c: 1, d: null}}, keep: 1});
            expect(Object.keys(objectOf(objectOf(objectOf(merged.result).a).b))).toStrictEqual([REPLACE_OBJECT_MARK, 'c', 'd']);
            expect(merged.replaceNullPatches).toStrictEqual([[['a', 'b'], {c: 1, d: null}]]);
        });

        it('reports patches in source key order, depth first', () => {
            const merged = utils.fastMerge<unknown>(deepFreeze({a: null, b: {c: null, d: null}}), deepFreeze({b: {d: {x: 1}, c: {y: 1}}, a: {z: 1}}), MARK_OPTIONS);
            expect(merged.replaceNullPatches).toStrictEqual([
                [['b', 'd'], {x: 1}],
                [['b', 'c'], {y: 1}],
                [['a'], {z: 1}],
            ]);
        });

        it('reports a single patch for a marked object, not one per nested object inside it', () => {
            const merged = utils.fastMerge<unknown>(deepFreeze({a: null}), deepFreeze({a: {b: {c: {d: 1}}}}), MARK_OPTIONS);
            expect(merged.replaceNullPatches).toStrictEqual([[['a'], {b: {c: {d: 1}}}]]);
            expect(merged.result).toStrictEqual({a: {[REPLACE_OBJECT_MARK]: true, b: {c: {d: 1}}}});
        });

        it('marks the same way when nested nulls are also removed', () => {
            const merged = utils.fastMerge<unknown>(deepFreeze({a: null, b: null}), deepFreeze({a: {c: null, d: 1}}), {shouldRemoveNestedNulls: true, objectRemovalMode: 'mark'});
            expect(merged.result).toStrictEqual({a: {[REPLACE_OBJECT_MARK]: true, d: 1}});
            expect(merged.replaceNullPatches).toStrictEqual([[['a'], {c: null, d: 1}]]);
        });

        it.each([
            ['a primitive', 1],
            ['an array', [1]],
            ['a Date', new Date(1)],
            ['null', null],
        ])('does not mark %s written over a null', (_name, value) => {
            const merged = utils.fastMerge<unknown>({a: null}, {a: value}, MARK_OPTIONS);
            expect(merged.result).toStrictEqual({a: value});
            expect(merged.replaceNullPatches).toStrictEqual([]);
        });

        it('does not mark an object written over a missing or undefined property, or over a null root', () => {
            expect(utils.fastMerge<unknown>({}, {a: {b: 1}}, MARK_OPTIONS)).toStrictEqual({result: {a: {b: 1}}, replaceNullPatches: []});
            expect(utils.fastMerge<unknown>({a: undefined}, {a: {b: 1}}, MARK_OPTIONS)).toStrictEqual({result: {a: {b: 1}}, replaceNullPatches: []});
            expect(utils.fastMerge<unknown>(null, {a: {b: 1}}, MARK_OPTIONS)).toStrictEqual({result: {a: {b: 1}}, replaceNullPatches: []});
        });

        it('starts every call with an empty patch list', () => {
            const first = utils.fastMerge<unknown>({a: null}, {a: {b: 1}}, MARK_OPTIONS);
            const second = utils.fastMerge<unknown>({c: null}, {c: {d: 1}}, MARK_OPTIONS);
            const third = utils.fastMerge<unknown>({e: 1}, {e: 2}, MARK_OPTIONS);

            expect(first.replaceNullPatches).toStrictEqual([[['a'], {b: 1}]]);
            expect(second.replaceNullPatches).toStrictEqual([[['c'], {d: 1}]]);
            expect(third.replaceNullPatches).toStrictEqual([]);
        });

        it('only marks in mark mode', () => {
            const nonMarkingOptions: Array<FastMergeOptions | undefined> = [undefined, {objectRemovalMode: 'replace'}, {shouldRemoveNestedNulls: true}];
            for (const options of nonMarkingOptions) {
                const merged = utils.fastMerge<unknown>({a: null}, {a: {b: 1}}, options);
                expect(merged).toStrictEqual({result: {a: {b: 1}}, replaceNullPatches: []});
            }
        });
    });

    describe('replace mode (applying batched merges)', () => {
        it('replaces the target subtree with a marked source object, without the mark', () => {
            const result = objectOf(merge({a: {old: 1, keep: {x: 1}}, b: 1}, {a: {[REPLACE_OBJECT_MARK]: true, fresh: 1}}, CACHE_OPTIONS));
            expect(result).toStrictEqual({a: {fresh: 1}, b: 1});
        });

        it('returns a new object for a marked source even when its content equals the target', () => {
            const target = {a: {x: 1}};
            const result = objectOf(merge(target, {a: {[REPLACE_OBJECT_MARK]: true, x: 1}}, CACHE_OPTIONS));
            expect(result).not.toBe(target);
            expect(result.a).not.toBe(target.a);
            expect(result).toStrictEqual({a: {x: 1}});
        });

        it('shares the nested objects of a marked source instead of copying them', () => {
            const inner = {y: 1};
            const result = objectOf(merge({}, {a: {[REPLACE_OBJECT_MARK]: true, inner}}, CACHE_OPTIONS));
            expect(objectOf(result.a).inner).toBe(inner);
        });

        it('merges a source whose mark is false as a plain object and keeps the mark key', () => {
            expect(merge({a: {x: 1}}, {a: {[REPLACE_OBJECT_MARK]: false, y: 1}}, CACHE_OPTIONS)).toStrictEqual({a: {x: 1, [REPLACE_OBJECT_MARK]: false, y: 1}});
        });

        it('keeps a mark on the root source as an ordinary key', () => {
            expect(merge({a: 1}, {[REPLACE_OBJECT_MARK]: true, b: 1}, CACHE_OPTIONS)).toStrictEqual({a: 1, [REPLACE_OBJECT_MARK]: true, b: 1});
        });

        it('merges marked objects like any other object outside replace mode', () => {
            expect(merge({a: {x: 1}}, {a: {[REPLACE_OBJECT_MARK]: true, y: 1}}, {shouldRemoveNestedNulls: true})).toStrictEqual({a: {x: 1, [REPLACE_OBJECT_MARK]: true, y: 1}});
        });

        it('turns a mark-mode batch into the value a sequential merge gives, when the batch has no later nulls', () => {
            const existing = deepFreeze({a: {old: 1}, b: {c: 1}, k: 1});
            const changes = deepFreeze([{a: null}, {a: {x: 1}}, {b: {d: 1}}]);
            let batch: unknown = {};
            for (const change of changes) {
                batch = utils.fastMerge<unknown>(batch, change, MARK_OPTIONS).result;
            }
            let sequential: unknown = existing;
            for (const change of changes) {
                sequential = utils.fastMerge<unknown>(sequential, change, CACHE_OPTIONS).result;
            }

            expect(utils.fastMerge<unknown>(existing, batch, CACHE_OPTIONS).result).toStrictEqual(sequential);
            expect(sequential).toStrictEqual({a: {x: 1}, b: {c: 1, d: 1}, k: 1});
        });
    });

    describe('objects that are not plain', () => {
        it('copies the own enumerable properties of a class instance source into a plain object', () => {
            const result = objectOf(merge(undefined, {point: new Point(1, null)}, CACHE_OPTIONS));
            expect(Object.getPrototypeOf(result.point)).toBe(Object.prototype);
            expect(result).toStrictEqual({point: {x: 1}});
        });

        it('keeps a class instance target when nothing changes, and turns it into a plain object when something does', () => {
            const point = new Point(1, 2);
            expect(merge(point, {x: 1})).toBe(point);
            const changed = objectOf(merge(point, {x: 5}));
            expect(changed).not.toBeInstanceOf(Point);
            expect(changed).toStrictEqual({x: 5, y: 2});
        });

        it('merges a Map as an object without own enumerable properties', () => {
            const result = objectOf(merge({m: {a: 1}}, {m: new Map([['b', 2]])}));
            expect(result).toStrictEqual({m: {a: 1}});
        });

        it('ignores symbol keys and non-enumerable properties of the source', () => {
            const symbol = Symbol('s');
            const source: PlainObject = {a: 1};
            Object.defineProperty(source, 'hidden', {value: 1, enumerable: false});
            Reflect.set(source, symbol, 1);
            const target = {a: 1};

            expect(merge(target, source)).toBe(target);
            expect(Reflect.ownKeys(objectOf(merge({}, source)))).toStrictEqual(['a']);
        });
    });

    describe('deep values', () => {
        it('merges a 300 level deep path and keeps the untouched sibling at every level', () => {
            const depth = 300;
            const siblings: PlainObject[] = [];
            let target: PlainObject = {leaf: 1};
            let source: PlainObject = {leaf: 2};
            for (let level = 0; level < depth; level++) {
                const sibling = {level};
                siblings.unshift(sibling);
                target = {next: target, sibling};
                source = {next: source};
            }

            let node = objectOf(merge(target, source, CACHE_OPTIONS));
            for (let level = 0; level < depth; level++) {
                expect(node.sibling).toBe(siblings[level]);
                node = objectOf(node.next);
            }
            expect(node).toStrictEqual({leaf: 2});
        });
    });
});

describe('current behaviour (suspected bug)', () => {
    it('keeps nested nulls inside a marked object in replace mode, although nested nulls are removed', () => {
        const result = merge({a: {old: 1}}, {a: {[REPLACE_OBJECT_MARK]: true, x: null, y: {z: null}, w: 1}}, CACHE_OPTIONS);
        expect(result).toStrictEqual({a: {x: null, y: {z: null}, w: 1}});
    });

    it('reports NaN over NaN as a change, so a no-op merge returns a new object', () => {
        const target = {a: Number.NaN};
        const result = merge(target, {a: Number.NaN});
        expect(result).not.toBe(target);
        expect(result).toStrictEqual({a: Number.NaN});
    });

    it('sets the prototype of the result from a "__proto__" key of a parsed source instead of copying it', () => {
        const source: unknown = JSON.parse('{"__proto__": {"injected": true}, "a": 1}');
        const result = objectOf(merge(undefined, source));
        expect(Object.keys(result)).toStrictEqual(['a']);
        expect(Reflect.get(result, 'injected')).toBe(true);
        expect(Object.hasOwn(Object.prototype, 'injected')).toBe(false);
    });
});
