/**
 * Contract tests for what `useOnyx` renders when `Onyx.merge` runs, against both `OnyxMerge` variants:
 * the rendered values per commit, their order, reference identity with the cache, and no re-render when a
 * merge changes nothing the hook reads.
 */
import {act, renderHook} from '@testing-library/react-native';

import type {MergeVariant} from './helpers/mergeVariant';
import type {OnyxKey} from '../../../../lib';

import Onyx, {useOnyx} from '../../../../lib';
import cache from '../../../../lib/OnyxCache';
import onyxSnapshotCache from '../../../../lib/OnyxSnapshotCache';
import {KEYS, flush, initOnyxForMergeContracts} from './helpers/harness';
import {MERGE_VARIANTS, setMergeVariant} from './helpers/mergeVariant';

jest.mock('../../../../lib/OnyxMerge', () => require('./helpers/mergeVariant'));

const MEMBER_1 = `${KEYS.COLLECTION.TEST}1`;
const MEMBER_2 = `${KEYS.COLLECTION.TEST}2`;

function selectName(entry: unknown): string | undefined {
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string') {
        return undefined;
    }
    return entry.name;
}

/** Renders `useOnyx(key)` and records the value of every render once the hook has loaded. */
async function renderRecorded(key: OnyxKey) {
    const renders: unknown[] = [];
    const hook = renderHook(() => {
        const result = useOnyx(key);
        renders.push(result[0]);
        return result;
    });
    await act(() => flush());
    const loadedRenderCount = renders.length;
    return {hook, renders, rendersSinceLoad: () => renders.slice(loadedRenderCount)};
}

describe.each(MERGE_VARIANTS)('useOnyx with Onyx.merge (%s OnyxMerge)', (variant: MergeVariant) => {
    beforeAll(() => {
        setMergeVariant(variant);
        initOnyxForMergeContracts();
    });

    beforeEach(async () => {
        setMergeVariant(variant);
        await Onyx.clear();
        onyxSnapshotCache.clear();
        onyxSnapshotCache.clearSelectorIds();
    });

    it('renders the final value of a same-tick burst and only valid states on the way', async () => {
        await act(() => Onyx.set(KEYS.OBJECT, {count: 0}));
        const {hook, rendersSinceLoad} = await renderRecorded(KEYS.OBJECT);

        await act(async () => {
            const promises = Array.from({length: 20}, (_, index) => Onyx.merge(KEYS.OBJECT, {count: index + 1, [`field${index % 3}`]: index}));
            await Promise.all(promises);
        });

        const final = {count: 20, field0: 18, field1: 19, field2: 17};
        expect(hook.result.current[0]).toStrictEqual(final);
        expect(hook.result.current[0]).toBe(cache.get(KEYS.OBJECT));
        expect(rendersSinceLoad().length).toBeGreaterThanOrEqual(1);
        expect(rendersSinceLoad().length).toBeLessThanOrEqual(1);
        expect(rendersSinceLoad().every((value) => JSON.stringify(value) === JSON.stringify(final))).toBe(true);
    });

    it('renders every awaited draft keystroke once and in order', async () => {
        const {hook, rendersSinceLoad} = await renderRecorded(KEYS.STRING);
        const drafts = Array.from({length: 30}, (_, index) => 'a draft typed one key at a time...'.slice(0, index + 1));

        for (const draft of drafts) {
            await act(() => Onyx.merge(KEYS.STRING, draft));
        }

        expect(rendersSinceLoad()).toStrictEqual(drafts);
        expect(hook.result.current[0]).toBe(drafts.at(-1));
    });

    it('does not re-render when a merge changes nothing', async () => {
        await act(() => Onyx.set(KEYS.OBJECT, {a: 1, nested: {b: 1}}));
        const {hook, rendersSinceLoad} = await renderRecorded(KEYS.OBJECT);
        const renderedBefore = hook.result.current[0];

        await act(() => Onyx.merge(KEYS.OBJECT, {a: 1}));
        await act(() => Onyx.merge(KEYS.OBJECT, {nested: {b: 1}}));
        await act(() => Onyx.merge(KEYS.OBJECT, {missing: null}));

        expect(rendersSinceLoad()).toStrictEqual([]);
        expect(hook.result.current[0]).toBe(renderedBefore);
    });

    it('does not re-render for a merge into another key, including one that shares a prefix', async () => {
        await act(() => Onyx.set(KEYS.OBJECT, {a: 1}));
        const {rendersSinceLoad} = await renderRecorded(KEYS.OBJECT);

        await act(() => Onyx.merge(KEYS.OTHER_OBJECT, {a: 2}));
        await act(() => Onyx.merge(KEYS.PREFIX_TWIN, {a: 2}));
        await act(() => Onyx.merge(MEMBER_1, {a: 2}));

        expect(rendersSinceLoad()).toStrictEqual([]);
    });

    it('re-renders a selector only when the selected value changes', async () => {
        await act(() => Onyx.set(MEMBER_1, {name: 'first', other: 1}));
        const renders: unknown[] = [];
        const hook = renderHook(() => {
            const [name] = useOnyx(MEMBER_1, {selector: selectName});
            renders.push(name);
            return name;
        });
        await act(() => flush());
        const loaded = renders.length;
        expect(hook.result.current).toBe('first');

        await act(() => Onyx.merge(MEMBER_2, {name: 'second'}));
        await act(() => Onyx.merge(MEMBER_1, {other: 2}));
        expect(renders.slice(loaded)).toStrictEqual([]);

        await act(() => Onyx.merge(MEMBER_1, {name: 'renamed'}));
        expect(renders.slice(loaded)).toStrictEqual(['renamed']);
    });

    it('renders a new collection snapshot for a member merge and nothing for an unchanged one', async () => {
        await act(() => Onyx.merge(MEMBER_2, {b: 1}));
        const {hook, rendersSinceLoad} = await renderRecorded(KEYS.COLLECTION.TEST);
        const untouched = cache.get(MEMBER_2);

        await act(() => Onyx.merge(MEMBER_1, {a: 1}));
        expect(rendersSinceLoad()).toHaveLength(1);
        const collection = hook.result.current[0] as Record<string, unknown>;
        expect(collection).toStrictEqual({[MEMBER_1]: {a: 1}, [MEMBER_2]: {b: 1}});
        expect(collection[MEMBER_2]).toBe(untouched);

        await act(() => Onyx.merge(MEMBER_1, {a: 1}));
        expect(rendersSinceLoad()).toHaveLength(1);
    });

    it('renders undefined once a top-level null removes the key', async () => {
        await act(() => Onyx.set(KEYS.OBJECT, {a: 1}));
        const {hook, rendersSinceLoad} = await renderRecorded(KEYS.OBJECT);

        await act(async () => {
            Onyx.merge(KEYS.OBJECT, {b: 1});
            await Onyx.merge(KEYS.OBJECT, null);
        });

        expect(hook.result.current[0]).toBeUndefined();
        expect(hook.result.current[1].status).toBe('loaded');
        expect(rendersSinceLoad()).toStrictEqual([undefined]);
    });

    it('renders consecutive awaited merges in order and ends on the last one', async () => {
        await act(() => Onyx.set(KEYS.OBJECT, {step: 0}));
        const {hook, rendersSinceLoad} = await renderRecorded(KEYS.OBJECT);

        await act(async () => {
            await Onyx.merge(KEYS.OBJECT, {step: 1});
            await Onyx.merge(KEYS.OBJECT, {step: 2});
        });

        expect(hook.result.current[0]).toStrictEqual({step: 2});
        const steps = rendersSinceLoad().map((value) => (value as {step: number}).step);
        expect(steps.at(-1)).toBe(2);
        expect([...steps].sort()).toStrictEqual(steps);
        expect(steps.length).toBeLessThanOrEqual(2);
    });
});
