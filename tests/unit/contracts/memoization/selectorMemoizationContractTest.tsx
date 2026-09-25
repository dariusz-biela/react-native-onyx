import React from 'react';
import {render} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import {
    ErrorBoundary,
    KEYS,
    SelectorProbe,
    SelectorProbeList,
    committedValues,
    createRecorder,
    createRecorders,
    entriesOf,
    initContractOnyx,
    lastCommit,
    readField,
    renderCounts,
    settle,
    write,
} from '../useOnyxSelector/SelectorHarness';

initContractOnyx();

const HOOK_COUNT = 4;

type Identity = {id: unknown};

function recordOutputs<TOutput>(selector: (value: unknown) => TOutput): {selector: UseOnyxSelector<OnyxKey, TOutput>; outputs: TOutput[]; inputs: unknown[]} {
    const outputs: TOutput[] = [];
    const inputs: unknown[] = [];
    return {
        outputs,
        inputs,
        selector: (value) => {
            inputs.push(value);
            const output = selector(value);
            outputs.push(output);
            return output;
        },
    };
}

const selectIdentity = (value: unknown): Identity => ({id: readField(value, 'id')});

beforeEach(async () => {
    await Onyx.clear();
});

describe('useOnyx selector memoization', () => {
    describe('output identity', () => {
        it('commits the exact reference the selector produced on mount and when the output changes', async () => {
            await Onyx.set(KEYS.PLAIN, {id: 1, name: 'a'});
            const {selector, outputs} = recordOutputs(selectIdentity);
            const recorder = createRecorder<Identity>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selector}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(outputs).toHaveLength(1);
            expect(lastCommit(recorder)[0]).toBe(outputs[0]);

            await write(() => Onyx.merge(KEYS.PLAIN, {id: 2}));

            expect(outputs).toHaveLength(2);
            expect(lastCommit(recorder)[0]).toBe(outputs[1]);
        });

        it('passes a sub-object of the stored value through by reference, so it stays identical to the raw value', async () => {
            await Onyx.set(KEYS.PLAIN, {tags: ['x']});
            const raw = createRecorder<unknown>();
            const selected = createRecorder<unknown>();
            const selectTags: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'tags');
            render(
                <>
                    <SelectorProbe
                        onyxKey={KEYS.PLAIN}
                        recorder={raw}
                    />
                    <SelectorProbe
                        onyxKey={KEYS.PLAIN}
                        selector={selectTags}
                        recorder={selected}
                    />
                </>,
            );
            await settle();

            expect(lastCommit(selected)[0]).toEqual(['x']);
            expect(lastCommit(selected)[0]).toBe(readField(lastCommit(raw)[0], 'tags'));

            await write(() => Onyx.merge(KEYS.PLAIN, {tags: ['y']}));

            expect(lastCommit(selected)[0]).toEqual(['y']);
            expect(lastCommit(selected)[0]).toBe(readField(lastCommit(raw)[0], 'tags'));
        });

        it('keeps the most recent distinct output, not the first one, when a later output is deep equal to it', async () => {
            await Onyx.set(KEYS.PLAIN, {id: 1, name: 'a'});
            const recorder = createRecorder<Identity>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectIdentity}
                    recorder={recorder}
                />,
            );
            await settle();

            await write(() => Onyx.merge(KEYS.PLAIN, {id: 2}));
            const rendersAfterChange = recorder.renders.length;
            await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));

            expect(committedValues(recorder)).toEqual([{id: 1}, {id: 2}]);
            const [first, second] = recorder.commits;
            expect(second[0]).not.toBe(first[0]);
            expect(lastCommit(recorder)).toBe(second);
            expect(recorder.renders).toHaveLength(rendersAfterChange);
        });

        it('keeps the reference of a collection projection across many writes whose outputs are all deep equal', async () => {
            await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {
                [`${KEYS.COLLECTION.ITEM}1`]: {title: 'one', extra: 0},
                [`${KEYS.COLLECTION.ITEM}2`]: {title: 'two', extra: 0},
            });
            const selectTitles: UseOnyxSelector<OnyxKey, unknown[]> = (collection) => entriesOf(collection).map(([key, member]) => ({key, title: readField(member, 'title')}));
            const recorder = createRecorder<unknown[]>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.COLLECTION.ITEM}
                    selector={selectTitles}
                    recorder={recorder}
                />,
            );
            await settle();
            const resultBefore = lastCommit(recorder);
            const rendersBefore = recorder.renders.length;

            for (let extra = 1; extra <= 20; extra++) {
                await write(() => Onyx.merge(`${KEYS.COLLECTION.ITEM}${(extra % 2) + 1}`, {extra}));
            }

            expect(lastCommit(recorder)).toBe(resultBefore);
            expect(recorder.commits).toHaveLength(1);
            expect(recorder.renders).toHaveLength(rendersBefore);
        });

        it('compares nested outputs by content regardless of key order', async () => {
            await Onyx.set(KEYS.PLAIN, {order: 0});
            const selectShape: UseOnyxSelector<OnyxKey, unknown> = (value) =>
                readField(value, 'order') === 0 ? {a: 1, nested: {list: [1, 2], flag: true}} : {nested: {flag: true, list: [1, 2]}, a: 1};
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectShape}
                    recorder={recorder}
                />,
            );
            await settle();
            const resultBefore = lastCommit(recorder);

            await write(() => Onyx.merge(KEYS.PLAIN, {order: 1}));

            expect(lastCommit(recorder)).toBe(resultBefore);
            expect(recorder.commits).toHaveLength(1);
        });

        it('treats NaN as equal to NaN and 0 as equal to -0 in the output', async () => {
            await Onyx.set(KEYS.PLAIN, {negative: false});
            const selectNumbers: UseOnyxSelector<OnyxKey, unknown> = (value) => ({value: Number.NaN, zero: readField(value, 'negative') === true ? -0 : 0});
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectNumbers}
                    recorder={recorder}
                />,
            );
            await settle();
            const resultBefore = lastCommit(recorder);

            await write(() => Onyx.merge(KEYS.PLAIN, {negative: true}));

            expect(lastCommit(recorder)).toBe(resultBefore);
            expect(recorder.commits).toHaveLength(1);
        });
    });

    describe('what counts as a changed output', () => {
        it.each([
            ['a property set to undefined versus a missing property', {a: 1, b: undefined}, {a: 1}],
            ['an array versus an object with the same indexes', ['a'], {0: 'a'}],
            ['a number versus the same digits as a string', {a: 1}, {a: '1'}],
            ['a change deep inside a nested array', {list: [{id: 1, tags: ['a']}]}, {list: [{id: 1, tags: ['b']}]}],
            ['arrays of different length', [1, 2], [1, 2, 3]],
            ['an empty object versus an empty array', {}, []],
            ['false versus 0', false, 0],
            ['an empty string versus undefined', '', undefined],
        ])('commits the new output for %s', async (_description, firstOutput: unknown, secondOutput: unknown) => {
            await Onyx.set(KEYS.PLAIN, {first: true});
            const selectOutput: UseOnyxSelector<OnyxKey, unknown> = (value) => (readField(value, 'first') === true ? firstOutput : secondOutput);
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectOutput}
                    recorder={recorder}
                />,
            );
            await settle();

            await write(() => Onyx.merge(KEYS.PLAIN, {first: false}));

            expect(recorder.commits).toHaveLength(2);
            expect(recorder.commits[0][0]).toBe(firstOutput);
            expect(recorder.commits[1][0]).toBe(secondOutput);
        });

        it('commits every output of a changing sequence in order, each under a new reference', async () => {
            await Onyx.set(KEYS.PLAIN, {value: 0});
            const selectParity: UseOnyxSelector<OnyxKey, {parity: number}> = (value) => ({parity: Number(readField(value, 'value')) % 2});
            const recorder = createRecorder<{parity: number}>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectParity}
                    recorder={recorder}
                />,
            );
            await settle();

            for (let value = 1; value <= 5; value++) {
                await write(() => Onyx.merge(KEYS.PLAIN, {value}));
            }

            const values = committedValues(recorder);
            expect(values.map((output) => output?.parity)).toEqual([0, 1, 0, 1, 0, 1]);
            for (let index = 1; index < values.length; index++) {
                expect(values[index]).not.toBe(values[index - 1]);
            }
        });
    });

    describe('selector calls', () => {
        it('does not call the selector again on a parent re-render after a write that produced a deep-equal output', async () => {
            await Onyx.set(KEYS.PLAIN, {id: 1, name: 'a'});
            const {selector, outputs} = recordOutputs(selectIdentity);
            const recorder = createRecorder<Identity>();
            const {rerender} = render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selector}
                    recorder={recorder}
                />,
            );
            await settle();
            await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));
            const callsAfterWrite = outputs.length;
            const rendersBefore = recorder.renders.length;

            rerender(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selector}
                    recorder={recorder}
                />,
            );

            expect(recorder.renders).toHaveLength(rendersBefore + 1);
            expect(callsAfterWrite).toBe(2);
            expect(outputs).toHaveLength(callsAfterWrite);
            expect(lastCommit(recorder)[0]).toBe(outputs[0]);
        });

        it('does not call the selector again on a parent re-render after a write that changed the output', async () => {
            await Onyx.set(KEYS.PLAIN, {id: 1, name: 'a'});
            const {selector, outputs} = recordOutputs(selectIdentity);
            const recorder = createRecorder<Identity>();
            const {rerender} = render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selector}
                    recorder={recorder}
                />,
            );
            await settle();
            await write(() => Onyx.merge(KEYS.PLAIN, {id: 2}));
            const changed = lastCommit(recorder)[0];
            const rendersBefore = recorder.renders.length;

            rerender(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selector}
                    recorder={recorder}
                />,
            );

            expect(recorder.renders).toHaveLength(rendersBefore + 1);
            expect(outputs).toHaveLength(2);
            expect(lastCommit(recorder)[0]).toBe(changed);
            expect(changed).toEqual({id: 2});
        });

        it.each([
            ['zero', 0],
            ['an empty string', ''],
            ['false', false],
        ])('does not call the selector again on a parent re-render over a stored %s', async (_description, stored: unknown) => {
            await Onyx.set(KEYS.PLAIN, stored);
            const {selector, outputs} = recordOutputs((value) => ({value}));
            const recorder = createRecorder<unknown>();
            const {rerender} = render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selector}
                    recorder={recorder}
                />,
            );
            await settle();
            const resultBefore = lastCommit(recorder);
            const rendersBefore = recorder.renders.length;

            rerender(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selector}
                    recorder={recorder}
                />,
            );

            expect(recorder.renders).toHaveLength(rendersBefore + 1);
            expect(outputs).toEqual([{value: stored}]);
            expect(lastCommit(recorder)).toBe(resultBefore);
        });

        it('passes the stored value to the selector by reference', async () => {
            await Onyx.set(KEYS.PLAIN, {id: 1, name: 'a'});
            const {selector, inputs} = recordOutputs(selectIdentity);
            const raw = createRecorder<unknown>();
            const selected = createRecorder<Identity>();
            render(
                <>
                    <SelectorProbe
                        onyxKey={KEYS.PLAIN}
                        recorder={raw}
                    />
                    <SelectorProbe
                        onyxKey={KEYS.PLAIN}
                        selector={selector}
                        recorder={selected}
                    />
                </>,
            );
            await settle();

            expect(inputs).toHaveLength(1);
            expect(inputs[0]).toBe(lastCommit(raw)[0]);
        });
    });

    describe('errors', () => {
        it('runs the selector again for the same stored value in a fresh mount after it threw', async () => {
            await Onyx.set(KEYS.PLAIN, {name: 'a'});
            let shouldThrow = true;
            let calls = 0;
            const selectName: UseOnyxSelector<OnyxKey, unknown> = (value) => {
                calls++;
                if (shouldThrow) {
                    throw new Error('broken');
                }
                return readField(value, 'name');
            };
            const errors: unknown[] = [];
            const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            const failing = createRecorder<unknown>();
            const {unmount} = render(
                <ErrorBoundary onError={(error) => errors.push(error)}>
                    <SelectorProbe
                        onyxKey={KEYS.PLAIN}
                        selector={selectName}
                        recorder={failing}
                    />
                </ErrorBoundary>,
            );
            await settle();
            unmount();
            consoleError.mockRestore();
            const callsBeforeRemount = calls;

            shouldThrow = false;
            const recovered = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectName}
                    recorder={recovered}
                />,
            );
            await settle();

            expect(errors).toHaveLength(1);
            expect(failing.commits).toEqual([]);
            expect(calls - callsBeforeRemount).toBe(1);
            expect(committedValues(recovered)).toEqual(['a']);
        });
    });

    describe('raw values without a selector', () => {
        it('compares raw values by reference, so a multiSet that rewrites a key with deep-equal content commits a new reference', async () => {
            await Onyx.set(KEYS.PLAIN, {a: 1, nested: {b: 1}});
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    recorder={recorder}
                />,
            );
            await settle();

            await write(() => Onyx.multiSet({[KEYS.PLAIN]: {a: 1, nested: {b: 1}}}));

            expect(recorder.renders).toHaveLength(2);
            expect(committedValues(recorder)).toEqual([
                {a: 1, nested: {b: 1}},
                {a: 1, nested: {b: 1}},
            ]);
            expect(recorder.commits[1][0]).not.toBe(recorder.commits[0][0]);
        });
    });

    describe('current behaviour (#834 change)', () => {
        // On main K hooks with the same key and selector shared one cached result, so the selector ran once and every hook got the same references.
        it('runs the selector once per hook and gives each of K hooks with the same key and selector its own result reference', async () => {
            await Onyx.set(KEYS.PLAIN, {id: 1, name: 'a'});
            const {selector, outputs} = recordOutputs(selectIdentity);
            const recorders = createRecorders<Identity>(HOOK_COUNT);
            render(
                <SelectorProbeList
                    onyxKey={KEYS.PLAIN}
                    selector={selector}
                    recorders={recorders}
                />,
            );
            await settle();

            expect(outputs).toHaveLength(HOOK_COUNT);
            expect(renderCounts(recorders)).toEqual(Array.from({length: HOOK_COUNT}, () => 1));
            const values = recorders.map((recorder) => lastCommit(recorder)[0]);
            expect(new Set(values).size).toBe(HOOK_COUNT);
            expect(new Set(recorders.map((recorder) => lastCommit(recorder))).size).toBe(HOOK_COUNT);
            for (const value of values) {
                expect(value).toEqual({id: 1});
            }
        });
    });
});
