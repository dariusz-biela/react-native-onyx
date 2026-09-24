import React from 'react';
import {render} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import {
    KEYS,
    SelectorProbe,
    SelectorProbeList,
    committedValues,
    createRecorder,
    createRecorders,
    entriesOf,
    initContractOnyx,
    isRecord,
    lastCommit,
    readField,
    renderCounts,
    settle,
    write,
} from './SelectorHarness';

initContractOnyx();

const HOOK_COUNT = 5;

type Summary = {name: unknown; count: unknown};

let summarySelectorCalls = 0;

/** A module-level selector that allocates a fresh object on every call, like most App selectors. */
function summarySelector(value: unknown): Summary {
    summarySelectorCalls++;
    return {name: readField(value, 'name'), count: readField(value, 'count')};
}

let namesSelectorCalls = 0;

/** A module-level projection of every member of a collection, shaped like `reportsSelector` in the App. */
function namesSelector(collection: unknown): Record<string, unknown> {
    namesSelectorCalls++;
    const names: Record<string, unknown> = {};
    for (const [key, member] of entriesOf(collection)) {
        if (isRecord(member)) {
            names[key] = member.name;
        }
    }
    return names;
}

beforeEach(async () => {
    await Onyx.clear();
    summarySelectorCalls = 0;
    namesSelectorCalls = 0;
});

describe('useOnyx with one module-level selector shared by K hooks', () => {
    it('delivers the same selected value to every hook on mount', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1, extra: 'x'});
        const recorders = createRecorders<Summary>(HOOK_COUNT);

        render(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorders={recorders}
            />,
        );
        await settle();

        for (const recorder of recorders) {
            expect(committedValues(recorder)).toEqual([{name: 'a', count: 1}]);
            expect(lastCommit(recorder)[1].status).toBe('loaded');
        }
    });

    it('re-renders every hook exactly once when the selected value changes', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        const recorders = createRecorders<Summary>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorders={recorders}
            />,
        );
        await settle();
        const rendersBefore = renderCounts(recorders);
        const callsBefore = summarySelectorCalls;

        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));

        for (const [index, recorder] of recorders.entries()) {
            expect(recorder.renders.length - rendersBefore[index]).toBe(1);
            expect(lastCommit(recorder)[0]).toEqual({name: 'a', count: 2});
        }
        const calls = summarySelectorCalls - callsBefore;
        expect(calls).toBeGreaterThanOrEqual(1);
        expect(calls).toBeLessThanOrEqual(HOOK_COUNT);
    });

    it('does not re-render any hook and keeps every result reference when a field outside the selector changes', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1, extra: 'x'});
        const recorders = createRecorders<Summary>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorders={recorders}
            />,
        );
        await settle();
        const resultsBefore = recorders.map((recorder) => lastCommit(recorder));
        const rendersBefore = renderCounts(recorders);
        const callsBefore = summarySelectorCalls;

        await write(() => Onyx.merge(KEYS.PLAIN, {extra: 'y'}));
        await write(() => Onyx.set(KEYS.PLAIN, {name: 'a', count: 1, extra: 'z'}));

        expect(renderCounts(recorders)).toEqual(rendersBefore);
        for (const [index, recorder] of recorders.entries()) {
            expect(lastCommit(recorder)).toBe(resultsBefore[index]);
        }
        expect(summarySelectorCalls - callsBefore).toBeLessThanOrEqual(2 * HOOK_COUNT);
    });

    it('does not re-render and does not call the selector when the parent re-renders without a data change', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        const recorders = createRecorders<Summary>(HOOK_COUNT);
        const tree = (
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorders={recorders}
            />
        );
        const {rerender} = render(tree);
        await settle();
        const resultsBefore = recorders.map((recorder) => lastCommit(recorder));
        const callsBefore = summarySelectorCalls;

        rerender(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorders={recorders}
            />,
        );

        for (const [index, recorder] of recorders.entries()) {
            expect(lastCommit(recorder)).toBe(resultsBefore[index]);
        }
        expect(summarySelectorCalls - callsBefore).toBe(0);
    });

    it('delivers every change of a sequence to every hook, in order, ending on the final value', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 0});
        const recorders = createRecorders<Summary>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorders={recorders}
            />,
        );
        await settle();

        for (let count = 1; count <= 4; count++) {
            await write(() => Onyx.merge(KEYS.PLAIN, {count}));
        }

        for (const recorder of recorders) {
            expect(committedValues(recorder)).toEqual([0, 1, 2, 3, 4].map((count) => ({name: 'a', count})));
        }
    });

    it('gives a hook that mounts after a change the latest selected value, not an earlier shared result', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        const early = createRecorder<Summary>();
        const late = createRecorder<Summary>();
        const {rerender} = render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorder={early}
            />,
        );
        await settle();

        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));
        rerender(
            <>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={summarySelector}
                    recorder={early}
                />
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={summarySelector}
                    recorder={late}
                />
            </>,
        );
        await settle();

        expect(committedValues(late)).toEqual([{name: 'a', count: 2}]);
        expect(lastCommit(late)[1].status).toBe('loaded');
    });

    it('gives a hook that remounts after every sharer unmounted and the data changed the new value', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        const first = createRecorder<Summary>();
        const {unmount} = render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorder={first}
            />,
        );
        await settle();
        unmount();

        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));
        const second = createRecorder<Summary>();
        render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorder={second}
            />,
        );
        await settle();

        expect(committedValues(second)).toEqual([{name: 'a', count: 2}]);
    });

    it('keeps updating the remaining hooks after the first sharer unmounts', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        const recorders = createRecorders<Summary>(3);
        const {rerender} = render(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorders={recorders}
            />,
        );
        await settle();

        rerender(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={summarySelector}
                recorders={recorders.slice(1)}
            />,
        );
        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));
        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));

        for (const recorder of recorders.slice(1)) {
            expect(committedValues(recorder)).toEqual([
                {name: 'a', count: 1},
                {name: 'a', count: 2},
                {name: 'b', count: 2},
            ]);
        }
        expect(committedValues(recorders[0])).toEqual([{name: 'a', count: 1}]);
    });

    it('keeps results of the same selector on different keys apart', async () => {
        await Onyx.multiSet({[KEYS.PLAIN]: {name: 'plain', count: 1}, [KEYS.OTHER]: {name: 'other', count: 1}});
        const plain = createRecorder<Summary>();
        const other = createRecorder<Summary>();
        render(
            <>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={summarySelector}
                    recorder={plain}
                />
                <SelectorProbe
                    onyxKey={KEYS.OTHER}
                    selector={summarySelector}
                    recorder={other}
                />
            </>,
        );
        await settle();
        const otherResult = lastCommit(other);
        const otherRenders = other.renders.length;

        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));

        expect(lastCommit(plain)[0]).toEqual({name: 'plain', count: 2});
        expect(lastCommit(other)).toBe(otherResult);
        expect(other.renders).toHaveLength(otherRenders);
    });

    it('keeps results of the same selector on prefix-colliding member keys apart', async () => {
        const shortKey = `${KEYS.COLLECTION.ITEM}1`;
        const longKey = `${KEYS.COLLECTION.ITEM}11`;
        await Onyx.multiSet({[shortKey]: {name: 'one', count: 1}, [longKey]: {name: 'eleven', count: 11}});
        const short = createRecorder<Summary>();
        const long = createRecorder<Summary>();
        render(
            <>
                <SelectorProbe
                    onyxKey={shortKey}
                    selector={summarySelector}
                    recorder={short}
                />
                <SelectorProbe
                    onyxKey={longKey}
                    selector={summarySelector}
                    recorder={long}
                />
            </>,
        );
        await settle();
        const longResult = lastCommit(long);

        await write(() => Onyx.merge(shortKey, {count: 2}));

        expect(committedValues(short)).toEqual([
            {name: 'one', count: 1},
            {name: 'one', count: 2},
        ]);
        expect(lastCommit(long)).toBe(longResult);
        expect(committedValues(long)).toEqual([{name: 'eleven', count: 11}]);

        await write(() => Onyx.merge(longKey, {count: 12}));

        expect(lastCommit(short)[0]).toEqual({name: 'one', count: 2});
        expect(lastCommit(long)[0]).toEqual({name: 'eleven', count: 12});
    });
});

describe('useOnyx with one module-level selector over a whole collection shared by K hooks', () => {
    it('re-renders every hook exactly once when a projected field of one member changes', async () => {
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {
            [`${KEYS.COLLECTION.ITEM}1`]: {name: 'one', count: 1},
            [`${KEYS.COLLECTION.ITEM}2`]: {name: 'two', count: 2},
        });
        const recorders = createRecorders<Record<string, unknown>>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.COLLECTION.ITEM}
                selector={namesSelector}
                recorders={recorders}
            />,
        );
        await settle();
        const rendersBefore = renderCounts(recorders);
        const callsBefore = namesSelectorCalls;

        await write(() => Onyx.merge(`${KEYS.COLLECTION.ITEM}1`, {name: 'uno'}));

        for (const [index, recorder] of recorders.entries()) {
            expect(recorder.renders.length - rendersBefore[index]).toBe(1);
            expect(lastCommit(recorder)[0]).toEqual({[`${KEYS.COLLECTION.ITEM}1`]: 'uno', [`${KEYS.COLLECTION.ITEM}2`]: 'two'});
        }
        const calls = namesSelectorCalls - callsBefore;
        expect(calls).toBeGreaterThanOrEqual(1);
        expect(calls).toBeLessThanOrEqual(HOOK_COUNT);
    });

    it('does not re-render any hook when a member field outside the projection changes', async () => {
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {
            [`${KEYS.COLLECTION.ITEM}1`]: {name: 'one', count: 1},
            [`${KEYS.COLLECTION.ITEM}2`]: {name: 'two', count: 2},
        });
        const recorders = createRecorders<Record<string, unknown>>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.COLLECTION.ITEM}
                selector={namesSelector}
                recorders={recorders}
            />,
        );
        await settle();
        const resultsBefore = recorders.map((recorder) => lastCommit(recorder));
        const rendersBefore = renderCounts(recorders);

        await write(() => Onyx.merge(`${KEYS.COLLECTION.ITEM}1`, {count: 5}));
        await write(() => Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {[`${KEYS.COLLECTION.ITEM}2`]: {count: 6}}));

        expect(renderCounts(recorders)).toEqual(rendersBefore);
        for (const [index, recorder] of recorders.entries()) {
            expect(lastCommit(recorder)).toBe(resultsBefore[index]);
        }
    });

    it('re-renders every hook when a member is added and when one is removed', async () => {
        await Onyx.set(`${KEYS.COLLECTION.ITEM}1`, {name: 'one'});
        const recorders = createRecorders<Record<string, unknown>>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.COLLECTION.ITEM}
                selector={namesSelector}
                recorders={recorders}
            />,
        );
        await settle();

        await write(() => Onyx.set(`${KEYS.COLLECTION.ITEM}2`, {name: 'two'}));
        await write(() => Onyx.set(`${KEYS.COLLECTION.ITEM}1`, null));

        for (const recorder of recorders) {
            expect(committedValues(recorder)).toEqual([
                {[`${KEYS.COLLECTION.ITEM}1`]: 'one'},
                {[`${KEYS.COLLECTION.ITEM}1`]: 'one', [`${KEYS.COLLECTION.ITEM}2`]: 'two'},
                {[`${KEYS.COLLECTION.ITEM}2`]: 'two'},
            ]);
        }
    });

    it('does not re-render when a member of a collection that shares a name prefix changes', async () => {
        await Onyx.multiSet({[`${KEYS.COLLECTION.ITEM}1`]: {name: 'one'}, [`${KEYS.COLLECTION.ITEM_META}1`]: {name: 'meta'}});
        const recorder = createRecorder<Record<string, unknown>>();
        render(
            <SelectorProbe
                onyxKey={KEYS.COLLECTION.ITEM}
                selector={namesSelector}
                recorder={recorder}
            />,
        );
        await settle();
        const resultBefore = lastCommit(recorder);
        const rendersBefore = recorder.renders.length;

        await write(() => Onyx.merge(`${KEYS.COLLECTION.ITEM_META}1`, {name: 'meta2'}));
        await write(() => Onyx.set(`${KEYS.COLLECTION.ITEM_META}2`, {name: 'meta3'}));

        expect(resultBefore[0]).toEqual({[`${KEYS.COLLECTION.ITEM}1`]: 'one'});
        expect(lastCommit(recorder)).toBe(resultBefore);
        expect(recorder.renders).toHaveLength(rendersBefore);
    });
});
