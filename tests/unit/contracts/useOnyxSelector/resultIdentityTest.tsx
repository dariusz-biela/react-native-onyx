import React from 'react';
import {render, renderHook} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import type {OnyxKey} from '../../../../lib';
import {KEYS, SelectorProbe, committedValues, createRecorder, entriesOf, initContractOnyx, isRecord, lastCommit, readField, settle, write} from './SelectorHarness';

initContractOnyx();

const MAX_RENDERS_WITHOUT_LOOP = 10;

beforeEach(async () => {
    await Onyx.clear();
});

describe('useOnyx selector result identity', () => {
    it('keeps the result and value references through several writes that leave the selected output deep equal', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', tags: ['x', 'y'], meta: {level: 1}, extra: 0});
        const selector: UseOnyxSelector<OnyxKey, {tags: unknown; meta: unknown}> = (value) => ({tags: readField(value, 'tags'), meta: readField(value, 'meta')});
        const recorder = createRecorder<{tags: unknown; meta: unknown}>();
        render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={selector}
                recorder={recorder}
            />,
        );
        await settle();
        const resultBefore = lastCommit(recorder);
        const rendersBefore = recorder.renders.length;

        await write(() => Onyx.merge(KEYS.PLAIN, {extra: 1}));
        await write(() => Onyx.set(KEYS.PLAIN, {name: 'a', tags: ['x', 'y'], meta: {level: 1}, extra: 2}));
        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));

        expect(recorder.renders).toHaveLength(rendersBefore);
        expect(lastCommit(recorder)).toBe(resultBefore);
    });

    it('keeps the value reference when the output is deep equal but holds new nested arrays and objects', async () => {
        await Onyx.set(KEYS.PLAIN, {tags: ['x'], meta: {level: 1}, extra: 0});
        const selector: UseOnyxSelector<OnyxKey, {tags: unknown[]; meta: {level: unknown}}> = (value) => {
            const tags = readField(value, 'tags');
            return {tags: Array.isArray(tags) ? [...tags] : [], meta: {level: readField(readField(value, 'meta'), 'level')}};
        };
        const recorder = createRecorder<{tags: unknown[]; meta: {level: unknown}}>();
        render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={selector}
                recorder={recorder}
            />,
        );
        await settle();
        const valueBefore = lastCommit(recorder)[0];
        const rendersBefore = recorder.renders.length;

        await write(() => Onyx.merge(KEYS.PLAIN, {extra: 1}));

        expect(lastCommit(recorder)[0]).toBe(valueBefore);
        expect(recorder.renders).toHaveLength(rendersBefore);
    });

    it('delivers a change that sits deep inside a nested output', async () => {
        await Onyx.set(KEYS.PLAIN, {meta: {inner: {level: 1}}, tags: ['x']});
        const selector: UseOnyxSelector<OnyxKey, {level: unknown; tags: unknown[]}> = (value) => {
            const tags = readField(value, 'tags');
            return {level: readField(readField(readField(value, 'meta'), 'inner'), 'level'), tags: Array.isArray(tags) ? [...tags] : []};
        };
        const recorder = createRecorder<{level: unknown; tags: unknown[]}>();
        render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={selector}
                recorder={recorder}
            />,
        );
        await settle();

        await write(() => Onyx.merge(KEYS.PLAIN, {meta: {inner: {level: 2}}}));
        await write(() => Onyx.set(KEYS.PLAIN, {meta: {inner: {level: 2}}, tags: ['x', 'z']}));

        expect(committedValues(recorder)).toEqual([
            {level: 1, tags: ['x']},
            {level: 2, tags: ['x']},
            {level: 2, tags: ['x', 'z']},
        ]);
    });

    it('delivers a new value reference when the selected output changes and back again', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a'});
        const selector: UseOnyxSelector<OnyxKey, {name: unknown}> = (value) => ({name: readField(value, 'name')});
        const recorder = createRecorder<{name: unknown}>();
        render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={selector}
                recorder={recorder}
            />,
        );
        await settle();

        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));
        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'a'}));

        expect(committedValues(recorder)).toEqual([{name: 'a'}, {name: 'b'}, {name: 'a'}]);
        const [first, second, third] = recorder.commits;
        expect(second[0]).not.toBe(first[0]);
        expect(third[0]).not.toBe(second[0]);
    });

    it('keeps unchanged member references inside a selected list when another member changes', async () => {
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {
            [`${KEYS.COLLECTION.ITEM}1`]: {name: 'one', listed: true},
            [`${KEYS.COLLECTION.ITEM}2`]: {name: 'two', listed: true},
            [`${KEYS.COLLECTION.ITEM}3`]: {name: 'three', listed: false},
        });
        const selector: UseOnyxSelector<OnyxKey, unknown[]> = (collection) =>
            entriesOf(collection)
                .filter(([, member]) => isRecord(member) && member.listed === true)
                .map(([, member]) => member);
        const recorder = createRecorder<unknown[]>();
        render(
            <SelectorProbe
                onyxKey={KEYS.COLLECTION.ITEM}
                selector={selector}
                recorder={recorder}
            />,
        );
        await settle();
        const [listBefore] = lastCommit(recorder);

        await write(() => Onyx.merge(`${KEYS.COLLECTION.ITEM}2`, {name: 'deux'}));

        const [listAfter] = lastCommit(recorder);
        expect(listAfter).toEqual([
            {name: 'one', listed: true},
            {name: 'deux', listed: true},
        ]);
        expect(listAfter?.[0]).toBe(listBefore?.[0]);
        expect(listAfter?.[1]).not.toBe(listBefore?.[1]);
    });

    it('returns falsy primitive outputs as they are and turns null into undefined', async () => {
        await Onyx.set(KEYS.PLAIN, {count: 0, label: '', enabled: false, missing: null});
        const zero = renderHook(() => useOnyx(KEYS.PLAIN, {selector: (value) => readField(value, 'count')}));
        const empty = renderHook(() => useOnyx(KEYS.PLAIN, {selector: (value) => readField(value, 'label')}));
        const falseValue = renderHook(() => useOnyx(KEYS.PLAIN, {selector: (value) => readField(value, 'enabled')}));
        const nullValue = renderHook(() => useOnyx(KEYS.PLAIN, {selector: () => null}));
        const undefinedValue = renderHook(() => useOnyx(KEYS.PLAIN, {selector: () => undefined}));
        await settle();

        expect(zero.result.current).toEqual([0, {status: 'loaded'}]);
        expect(empty.result.current).toEqual(['', {status: 'loaded'}]);
        expect(falseValue.result.current).toEqual([false, {status: 'loaded'}]);
        expect(nullValue.result.current).toEqual([undefined, {status: 'loaded'}]);
        expect(undefinedValue.result.current).toEqual([undefined, {status: 'loaded'}]);
    });

    it('re-renders when a primitive output changes between falsy values and to a truthy one', async () => {
        await Onyx.set(KEYS.PLAIN, {count: 0});
        const recorder = createRecorder<unknown>();
        render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={(value) => readField(value, 'count')}
                recorder={recorder}
            />,
        );
        await settle();

        await write(() => Onyx.merge(KEYS.PLAIN, {count: null}));
        await write(() => Onyx.merge(KEYS.PLAIN, {count: false}));
        await write(() => Onyx.merge(KEYS.PLAIN, {count: 1}));

        expect(committedValues(recorder)).toEqual([0, undefined, false, 1]);
    });

    it('settles without a render loop when the selector returns NaN', async () => {
        await Onyx.set(KEYS.PLAIN, {count: 1});
        let renders = 0;
        const {result} = renderHook(() => {
            renders++;
            return useOnyx(KEYS.PLAIN, {selector: () => Number.NaN});
        });
        await settle();
        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));

        expect(result.current[0]).toBeNaN();
        expect(renders).toBeLessThanOrEqual(MAX_RENDERS_WITHOUT_LOOP);
    });
});

describe('useOnyx with an inline selector that is a new function on every render', () => {
    it('settles without a render loop and keeps a flat object output reference across parent re-renders', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        let renders = 0;
        const {result, rerender} = renderHook(() => {
            renders++;
            return useOnyx(KEYS.PLAIN, {selector: (value) => ({name: readField(value, 'name')})});
        });
        await settle();
        const resultBefore = result.current;

        rerender(undefined);
        rerender(undefined);

        expect(result.current).toBe(resultBefore);
        expect(result.current[0]).toEqual({name: 'a'});
        expect(renders).toBeLessThanOrEqual(3);
    });

    it('keeps a flat array output reference across parent re-renders', async () => {
        await Onyx.set(KEYS.PLAIN, {first: 'a', second: 'b'});
        const {result, rerender} = renderHook(() => useOnyx(KEYS.PLAIN, {selector: (value) => [readField(value, 'first'), readField(value, 'second')]}));
        await settle();
        const valueBefore = result.current[0];

        rerender(undefined);

        expect(result.current[0]).toBe(valueBefore);
    });

    it('does not re-render when a field outside the selection changes and re-renders once when a selected field changes', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        let renders = 0;
        const {result} = renderHook(() => {
            renders++;
            return useOnyx(KEYS.PLAIN, {selector: (value) => ({name: readField(value, 'name')})});
        });
        await settle();
        const resultBefore = result.current;
        const rendersBefore = renders;

        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));

        expect(renders).toBe(rendersBefore);
        expect(result.current).toBe(resultBefore);

        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));

        expect(renders).toBe(rendersBefore + 1);
        expect(result.current[0]).toEqual({name: 'b'});
    });

    it('uses the latest closure of an inline selector on every render', async () => {
        await Onyx.set(KEYS.PLAIN, {a: 'first', b: 'second'});
        const {result, rerender} = renderHook((field: string) => useOnyx(KEYS.PLAIN, {selector: (value) => readField(value, field)}), {initialProps: 'a'});
        await settle();

        expect(result.current[0]).toBe('first');

        rerender('b');

        expect(result.current[0]).toBe('second');
    });

    it('settles without a render loop when many hooks use inline selectors on the same key and the data changes', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', nested: {level: 1}});
        let renders = 0;
        function InlineProbe() {
            renders++;
            useOnyx(KEYS.PLAIN, {selector: (value) => ({nested: readField(value, 'nested')})});
            return null;
        }
        render(
            <>
                <InlineProbe />
                <InlineProbe />
                <InlineProbe />
            </>,
        );
        await settle();
        const rendersAfterMount = renders;

        await write(() => Onyx.merge(KEYS.PLAIN, {nested: {level: 2}}));

        expect(renders - rendersAfterMount).toBe(3);
    });

    describe('current behaviour (suspected bug)', () => {
        // A deep-equal nested output is compared only shallowly after a new memoized wrapper is built for the new function, so identity is lost.
        it('returns a new value reference on every parent re-render when an inline selector returns a nested object', async () => {
            await Onyx.set(KEYS.PLAIN, {meta: {level: 1}});
            const {result, rerender} = renderHook(() => useOnyx(KEYS.PLAIN, {selector: (value) => ({meta: {level: readField(readField(value, 'meta'), 'level')}})}));
            await settle();
            const valueBefore = result.current[0];

            rerender(undefined);

            expect(result.current[0]).toEqual(valueBefore);
            expect(result.current[0]).not.toBe(valueBefore);
        });
    });
});
