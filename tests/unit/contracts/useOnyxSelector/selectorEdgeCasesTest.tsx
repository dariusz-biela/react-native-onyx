import React from 'react';
import {render, renderHook} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import {
    DEFAULT_VALUE,
    KEYS,
    SelectorProbe,
    SelectorProbeList,
    committedValues,
    createRecorder,
    createRecorders,
    entriesOf,
    expectOrderedSubsequence,
    initContractOnyx,
    lastCommit,
    readField,
    settle,
    write,
} from './SelectorHarness';

initContractOnyx();

const HOOK_COUNT = 4;

const selectName: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'name');

const selectCount: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'count');

/** Sorted member names of a collection, a projection that allocates a new array on every call. */
const selectMemberNames: UseOnyxSelector<OnyxKey, string[]> = (collection) =>
    entriesOf(collection)
        .map(([, member]) => readField(member, 'name'))
        .filter((name): name is string => typeof name === 'string')
        .sort();

const item = (id: string) => `${KEYS.COLLECTION.ITEM}${id}`;

beforeEach(async () => {
    await Onyx.clear();
});

describe('useOnyx selector edge cases', () => {
    describe('selector input', () => {
        it('passes undefined for a missing key and reports loaded', async () => {
            const selector = jest.fn((value: unknown) => (value === undefined ? 'missing' : 'present'));
            const {result} = renderHook(() => useOnyx(KEYS.PLAIN, {selector}));
            await settle();

            expect(result.current[0]).toBe('missing');
            expect(result.current[1].status).toBe('loaded');
            for (const [input] of selector.mock.calls) {
                expect(input).toBeUndefined();
            }
        });

        it('passes an empty object for a collection without members while other keys exist', async () => {
            await Onyx.set(KEYS.PLAIN, {name: 'a'});
            const selector = jest.fn((value: unknown) => entriesOf(value).length);
            const {result} = renderHook(() => useOnyx(KEYS.COLLECTION.ITEM, {selector}));
            await settle();

            expect(result.current[0]).toBe(0);
            expect(result.current[1].status).toBe('loaded');
            const lastInput: unknown = selector.mock.calls.at(-1)?.[0];
            expect(lastInput === undefined || entriesOf(lastInput).length === 0).toBe(true);
        });

        it('passes the stored member values of a collection keyed by their full keys', async () => {
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {[item('1')]: {name: 'one'}, [item('2')]: {name: 'two'}});
            const selector = jest.fn((value: unknown) => entriesOf(value).map(([key]) => key));
            const {result} = renderHook(() => useOnyx(KEYS.COLLECTION.ITEM, {selector}));
            await settle();

            expect([...(result.current[0] ?? [])].sort()).toEqual([item('1'), item('2')]);
        });
    });

    describe('collections', () => {
        it('drops a member removed with null from the selected output', async () => {
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {[item('1')]: {name: 'one'}, [item('2')]: {name: 'two'}});
            const recorder = createRecorder<string[]>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.COLLECTION.ITEM}
                    selector={selectMemberNames}
                    recorder={recorder}
                />,
            );
            await settle();

            await write(() => Onyx.set(item('1'), null));

            expect(lastCommit(recorder)[0]).toEqual(['two']);
        });

        it('replaces the selected output when setCollection removes members', async () => {
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {[item('1')]: {name: 'one'}, [item('2')]: {name: 'two'}});
            const recorder = createRecorder<string[]>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.COLLECTION.ITEM}
                    selector={selectMemberNames}
                    recorder={recorder}
                />,
            );
            await settle();

            await write(() => Onyx.setCollection(KEYS.COLLECTION.ITEM, {[item('3')]: {name: 'three'}}));

            expect(committedValues(recorder)).toEqual([['one', 'two'], ['three']]);
        });

        it('delivers a mergeCollection that touches several members to K hooks with at most one re-render each', async () => {
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {[item('1')]: {name: 'one'}, [item('2')]: {name: 'two'}});
            const recorders = createRecorders<string[]>(HOOK_COUNT);
            render(
                <SelectorProbeList
                    onyxKey={KEYS.COLLECTION.ITEM}
                    selector={selectMemberNames}
                    recorders={recorders}
                />,
            );
            await settle();

            await write(() => Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {[item('1')]: {name: 'uno'}, [item('2')]: {name: 'dos'}, [item('3')]: {name: 'tres'}}));

            for (const recorder of recorders) {
                expect(committedValues(recorder)).toEqual([
                    ['one', 'two'],
                    ['dos', 'tres', 'uno'],
                ]);
                expect(recorder.renders).toHaveLength(2);
            }
        });

        it('delivers the final state of an Onyx.update batch over several keys', async () => {
            await Onyx.multiSet({[KEYS.PLAIN]: {name: 'a', count: 1}, [item('1')]: {name: 'one'}});
            const plain = createRecorder<unknown>();
            const collection = createRecorder<string[]>();
            render(
                <>
                    <SelectorProbe
                        onyxKey={KEYS.PLAIN}
                        selector={selectName}
                        recorder={plain}
                    />
                    <SelectorProbe
                        onyxKey={KEYS.COLLECTION.ITEM}
                        selector={selectMemberNames}
                        recorder={collection}
                    />
                </>,
            );
            await settle();

            await write(() =>
                Onyx.update([
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.PLAIN, value: {name: 'b'}},
                    {onyxMethod: Onyx.METHOD.MERGE, key: item('2'), value: {name: 'two'}},
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.PLAIN, value: {name: 'c'}},
                    {onyxMethod: Onyx.METHOD.MERGE, key: KEYS.PLAIN, value: {count: 5}},
                ]),
            );

            expectOrderedSubsequence(committedValues(plain), ['a', 'b', 'c']);
            expect(committedValues(collection)).toEqual([['one'], ['one', 'two']]);
        });
    });

    describe('clear and defaults', () => {
        it('re-runs the selector after Onyx.clear and shows the cleared state', async () => {
            await Onyx.set(KEYS.PLAIN, {name: 'a'});
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectName}
                    recorder={recorder}
                />,
            );
            await settle();

            await write(() => Onyx.clear());

            expect(committedValues(recorder)).toEqual(['a', undefined]);
            expect(lastCommit(recorder)[1].status).toBe('loaded');

            await write(() => Onyx.set(KEYS.PLAIN, {name: 'b'}));
            expect(committedValues(recorder)).toEqual(['a', undefined, 'b']);
        });

        it('shows the projected default value of a key with an initial state after Onyx.clear', async () => {
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.WITH_DEFAULT}
                    selector={selectName}
                    recorder={recorder}
                />,
            );
            await settle();
            expect(lastCommit(recorder)[0]).toBe(DEFAULT_VALUE.name);

            await write(() => Onyx.merge(KEYS.WITH_DEFAULT, {name: 'custom'}));
            await write(() => Onyx.clear());

            expect(committedValues(recorder)).toEqual([DEFAULT_VALUE.name, 'custom', DEFAULT_VALUE.name]);
        });

        it('empties a collection selection after Onyx.clear', async () => {
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {[item('1')]: {name: 'one'}});
            const recorder = createRecorder<string[]>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.COLLECTION.ITEM}
                    selector={selectMemberNames}
                    recorder={recorder}
                />,
            );
            await settle();

            await write(() => Onyx.clear());

            expect(lastCommit(recorder)[0]).toEqual([]);
        });
    });

    describe('loading', () => {
        it('gives K hooks mounted during pending merges the final merged projection', async () => {
            Onyx.merge(KEYS.PLAIN, {name: 'first', count: 1});
            Onyx.merge(KEYS.PLAIN, {name: 'second'});
            Onyx.merge(KEYS.PLAIN, {count: 3});
            const recorders = createRecorders<unknown>(HOOK_COUNT);
            render(
                <SelectorProbeList
                    onyxKey={KEYS.PLAIN}
                    selector={selectName}
                    recorders={recorders}
                />,
            );

            for (const recorder of recorders) {
                expect(lastCommit(recorder)[0]).toBeUndefined();
                expect(lastCommit(recorder)[1].status).toBe('loading');
            }

            await settle();

            for (const recorder of recorders) {
                expect(lastCommit(recorder)[0]).toBe('second');
                expect(lastCommit(recorder)[1].status).toBe('loaded');
                expect(committedValues(recorder).filter((value) => value === 'first')).toHaveLength(0);
            }
        });

        it('switches from an undefined selection to a defined one when the key is first written', async () => {
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectCount}
                    recorder={recorder}
                />,
            );
            await settle();

            await write(() => Onyx.set(KEYS.PLAIN, {count: 1}));

            expectOrderedSubsequence(committedValues(recorder), [undefined, 1]);
            expect(lastCommit(recorder)[1].status).toBe('loaded');
        });
    });

    describe('writes in one tick and during notifications', () => {
        it('walks through the merges of one tick in order, ends on the last one and renders at most once per merge', async () => {
            await Onyx.set(KEYS.PLAIN, {count: 0});
            const recorders = createRecorders<unknown>(HOOK_COUNT);
            render(
                <SelectorProbeList
                    onyxKey={KEYS.PLAIN}
                    selector={selectCount}
                    recorders={recorders}
                />,
            );
            await settle();

            await write(() => Promise.all([Onyx.merge(KEYS.PLAIN, {count: 1}), Onyx.merge(KEYS.PLAIN, {count: 2}), Onyx.merge(KEYS.PLAIN, {count: 3})]));

            for (const recorder of recorders) {
                expectOrderedSubsequence(committedValues(recorder), [0, 1, 2, 3]);
                expect(recorder.renders.length).toBeLessThanOrEqual(4);
            }
        });

        it('delivers interleaved writes to two keys in one tick to each key hook', async () => {
            await Onyx.multiSet({[KEYS.PLAIN]: {count: 0}, [KEYS.OTHER]: {count: 0}});
            const plain = createRecorder<unknown>();
            const other = createRecorder<unknown>();
            render(
                <>
                    <SelectorProbe
                        onyxKey={KEYS.PLAIN}
                        selector={selectCount}
                        recorder={plain}
                    />
                    <SelectorProbe
                        onyxKey={KEYS.OTHER}
                        selector={selectCount}
                        recorder={other}
                    />
                </>,
            );
            await settle();

            await write(() =>
                Promise.all([Onyx.merge(KEYS.PLAIN, {count: 1}), Onyx.merge(KEYS.OTHER, {count: 10}), Onyx.merge(KEYS.PLAIN, {count: 2}), Onyx.merge(KEYS.OTHER, {count: 20})]),
            );

            expectOrderedSubsequence(committedValues(plain), [0, 1, 2]);
            expectOrderedSubsequence(committedValues(other), [0, 10, 20]);
        });

        it('delivers a write made from inside an Onyx.connect callback to a selector hook on another key', async () => {
            await Onyx.multiSet({[KEYS.PLAIN]: {count: 0}, [KEYS.OTHER]: {count: 0}});
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.OTHER}
                    selector={selectCount}
                    recorder={recorder}
                />,
            );
            await settle();
            const connection = Onyx.connect({
                key: KEYS.PLAIN,
                callback: (value) => {
                    const count = readField(value, 'count');
                    if (typeof count === 'number' && count > 0) {
                        Onyx.merge(KEYS.OTHER, {count: count * 10});
                    }
                },
            });
            await settle();

            await write(() => Onyx.merge(KEYS.PLAIN, {count: 4}));
            await settle();
            Onyx.disconnect(connection);

            expect(committedValues(recorder)).toEqual([0, 40]);
        });

        it('keeps a selector hook correct when a component writes to the same key while mounting', async () => {
            await Onyx.set(KEYS.PLAIN, {count: 0});
            const recorder = createRecorder<unknown>();

            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectCount}
                    recorder={recorder}
                />,
            );
            const pendingMerge = Onyx.merge(KEYS.PLAIN, {count: 1});
            await write(() => pendingMerge);

            expectOrderedSubsequence(committedValues(recorder), [0, 1]);
        });
    });
});
