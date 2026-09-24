import React from 'react';
import {render} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import {
    KEYS,
    SelectorProbe,
    SelectorProbeList,
    committedValues,
    createRecorder,
    createRecorders,
    initContractOnyx,
    lastCommit,
    readField,
    renderCounts,
    settle,
    write,
} from './SelectorHarness';

initContractOnyx();

const HOOK_COUNT = 5;

let nameSelectorCalls = 0;

const selectName: UseOnyxSelector<OnyxKey, unknown> = (value) => {
    nameSelectorCalls++;
    return readField(value, 'name');
};

type RowView = {title: unknown; meta: {tags: unknown}};

/** One module-level selector reused by every row, returning a nested object like the row selectors in the App. */
const selectRowView: UseOnyxSelector<OnyxKey, RowView> = (row) => ({title: readField(row, 'title'), meta: {tags: readField(row, 'tags')}});

const item = (id: number) => `${KEYS.COLLECTION.ITEM}${id}`;

function statusesOf(values: Array<[unknown, {status: string}]>): Array<[unknown, string]> {
    return values.map(([value, metadata]) => [value, metadata.status]);
}

beforeEach(async () => {
    await Onyx.clear();
    nameSelectorCalls = 0;
});

describe('useOnyx selector results shared between hooks', () => {
    it('calls the selector at most once per hook when K hooks mount on cached data', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a'});
        const recorders = createRecorders<unknown>(HOOK_COUNT);

        render(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={selectName}
                recorders={recorders}
            />,
        );
        await settle();

        expect(nameSelectorCalls).toBeGreaterThanOrEqual(1);
        expect(nameSelectorCalls).toBeLessThanOrEqual(HOOK_COUNT);
        expect(renderCounts(recorders)).toEqual(Array.from({length: HOOK_COUNT}, () => 1));
    });

    it('ends loaded when a hook mounts during a pending merge next to a sharer that has already loaded', async () => {
        await Onyx.set(KEYS.PLAIN, {count: 1});
        const loaded = createRecorder<unknown>();
        render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={selectName}
                recorder={loaded}
            />,
        );
        await settle();

        const pendingMerge = Onyx.merge(KEYS.PLAIN, {count: 2});
        const late = createRecorder<unknown>();
        render(
            <SelectorProbe
                onyxKey={KEYS.PLAIN}
                selector={selectName}
                recorder={late}
            />,
        );
        await write(() => pendingMerge);

        expect(statusesOf([lastCommit(late)])).toEqual([[undefined, 'loaded']]);
        expect(statusesOf([lastCommit(loaded)])).toEqual([[undefined, 'loaded']]);
    });

    it('never commits the value from before pending merges to a hook that mounts while they are queued', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'zero'});
        Onyx.merge(KEYS.PLAIN, {name: 'first'});
        Onyx.merge(KEYS.PLAIN, {name: 'second'});
        const recorders = createRecorders<unknown>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={selectName}
                recorders={recorders}
            />,
        );
        await settle();

        for (const recorder of recorders) {
            expect(committedValues(recorder)).not.toContain('zero');
            expect(statusesOf([lastCommit(recorder)])).toEqual([['second', 'loaded']]);
        }
    });

    it('never commits a stale selected value when a hook switches to a key whose previous consumers have all unmounted', async () => {
        await Onyx.multiSet({[KEYS.PLAIN]: {name: 'plain'}, [KEYS.OTHER]: {name: 'other-1'}});
        const earlier = createRecorder<unknown>();
        const {unmount} = render(
            <SelectorProbe
                onyxKey={KEYS.OTHER}
                selector={selectName}
                recorder={earlier}
            />,
        );
        await settle();
        unmount();
        await write(() => Onyx.merge(KEYS.OTHER, {name: 'other-2'}));

        const switching = createRecorder<unknown>();
        const {rerender} = render(
            <SelectorProbe
                key={switching.id}
                onyxKey={KEYS.PLAIN}
                selector={selectName}
                recorder={switching}
            />,
        );
        await settle();
        rerender(
            <SelectorProbe
                key={switching.id}
                onyxKey={KEYS.OTHER}
                selector={selectName}
                recorder={switching}
            />,
        );
        await settle();

        expect(committedValues(switching)).not.toContain('other-1');
        expect(lastCommit(switching)[0]).toBe('other-2');
    });

    it('keeps the result of a row whose output is deep equal when one selector is shared by rows on different member keys', async () => {
        await Onyx.mergeCollection(KEYS.COLLECTION.ITEM, {
            [item(1)]: {title: 'one', tags: ['a'], extra: 0},
            [item(2)]: {title: 'two', tags: ['b'], extra: 0},
            [item(3)]: {title: 'three', tags: ['c'], extra: 0},
        });
        const recorders = createRecorders<RowView>(3);
        render(
            <>
                {recorders.map((recorder, index) => (
                    <SelectorProbe
                        key={recorder.id}
                        onyxKey={item(index + 1)}
                        selector={selectRowView}
                        recorder={recorder}
                    />
                ))}
            </>,
        );
        await settle();
        const resultsBefore = recorders.map((recorder) => lastCommit(recorder));
        const rendersBefore = renderCounts(recorders);

        await write(() => Onyx.merge(item(1), {title: 'uno'}));
        await write(() => Onyx.merge(item(2), {extra: 1}));
        await write(() => Onyx.merge(item(3), {extra: 1}));

        expect(lastCommit(recorders[0])[0]).toEqual({title: 'uno', meta: {tags: ['a']}});
        expect(recorders[0].renders.length - rendersBefore[0]).toBe(1);
        expect(lastCommit(recorders[1])).toBe(resultsBefore[1]);
        expect(lastCommit(recorders[2])).toBe(resultsBefore[2]);
        expect(renderCounts(recorders).slice(1)).toEqual(rendersBefore.slice(1));
    });

    describe('current behaviour (suspected bug)', () => {
        it('stays loading forever when a lone hook mounts during a merge that leaves its selected output undefined', async () => {
            await Onyx.set(KEYS.PLAIN, {count: 1});
            const pendingMerge = Onyx.merge(KEYS.PLAIN, {count: 2});
            const recorder = createRecorder<unknown>();
            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectName}
                    recorder={recorder}
                />,
            );
            await write(() => pendingMerge);
            await write(() => Onyx.merge(KEYS.PLAIN, {count: 3}));

            expect(statusesOf(recorder.commits)).toEqual([[undefined, 'loading']]);
        });
    });
});
