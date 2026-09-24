import {act, renderHook} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import cache from '../../../../lib/OnyxCache';
import onyxSnapshotCache from '../../../../lib/OnyxSnapshotCache';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    TEST: 'test',
    OTHER: 'other',
    COLLECTION: {
        COLL: 'coll_',
        COLL_SUB: 'coll_sub_',
    },
};

type Profile = {name: string; age: number; tags?: string[]};

function isProfile(value: unknown): value is Profile {
    return value !== null && typeof value === 'object' && 'name' in value && 'age' in value;
}

function selectName(value: unknown): string | undefined {
    return isProfile(value) ? value.name : undefined;
}

function selectTags(value: unknown): {tags: string[] | undefined} {
    return {tags: isProfile(value) ? value.tags : undefined};
}

function memberOf(collection: unknown, key: string): unknown {
    return collection !== null && typeof collection === 'object' && key in collection ? Object.getOwnPropertyDescriptor(collection, key)?.value : undefined;
}

describe('Onyx.set contract through useOnyx', () => {
    beforeAll(() => {
        Onyx.init({keys: KEYS});
    });

    beforeEach(async () => {
        await Onyx.clear();
        onyxSnapshotCache.clear();
        onyxSnapshotCache.clearSelectorIds();
    });

    it('renders the written value, with the same reference the cache holds', async () => {
        const {result} = renderHook(() => useOnyx(KEYS.TEST));
        await act(async () => waitForPromisesToResolve());
        expect(result.current[0]).toBeUndefined();
        expect(result.current[1].status).toBe('loaded');

        await act(async () => Onyx.set(KEYS.TEST, {name: 'a', age: 1}));

        expect(result.current[0]).toEqual({name: 'a', age: 1});
        expect(result.current[0]).toBe(cache.get(KEYS.TEST));
        expect(result.current[1].status).toBe('loaded');
    });

    it('renders the value without nested nulls', async () => {
        const {result} = renderHook(() => useOnyx(KEYS.TEST));
        await act(async () => waitForPromisesToResolve());

        await act(async () => Onyx.set(KEYS.TEST, {name: 'a', age: null, nested: {x: null, y: 1}}));

        expect(result.current[0]).toStrictEqual({name: 'a', nested: {y: 1}});
    });

    it('does not re-render and keeps the rendered reference for a deep-equal write', async () => {
        await Onyx.set(KEYS.TEST, {name: 'a', age: 1});
        let renders = 0;
        const {result} = renderHook(() => {
            renders++;
            return useOnyx(KEYS.TEST);
        });
        await act(async () => waitForPromisesToResolve());
        const rendered = result.current[0];
        const rendersBefore = renders;

        await act(async () => Onyx.set(KEYS.TEST, {age: 1, name: 'a'}));
        await act(async () => waitForPromisesToResolve());

        expect(renders).toBe(rendersBefore);
        expect(result.current[0]).toBe(rendered);
    });

    it('re-renders exactly once for one changed write', async () => {
        await Onyx.set(KEYS.TEST, 'a');
        let renders = 0;
        const {result} = renderHook(() => {
            renders++;
            return useOnyx(KEYS.TEST);
        });
        await act(async () => waitForPromisesToResolve());
        const rendersBefore = renders;

        await act(async () => Onyx.set(KEYS.TEST, 'b'));
        await act(async () => waitForPromisesToResolve());

        expect(renders - rendersBefore).toBe(1);
        expect(result.current[0]).toBe('b');
    });

    it('renders undefined with a loaded status after a null write', async () => {
        await Onyx.set(KEYS.TEST, 'a');
        const {result} = renderHook(() => useOnyx(KEYS.TEST));
        await act(async () => waitForPromisesToResolve());
        expect(result.current[0]).toBe('a');

        await act(async () => Onyx.set(KEYS.TEST, null));

        expect(result.current[0]).toBeUndefined();
        expect(result.current[1].status).toBe('loaded');
    });

    it('does not re-render a hook bound to another key', async () => {
        let renders = 0;
        renderHook(() => {
            renders++;
            return useOnyx(KEYS.OTHER);
        });
        await act(async () => waitForPromisesToResolve());
        const rendersBefore = renders;

        await act(async () => Onyx.set(KEYS.TEST, 'value'));
        await act(async () => waitForPromisesToResolve());

        expect(renders).toBe(rendersBefore);
    });

    it('ends on the last value after interleaved writes in one act, batched into one render', async () => {
        const rendered: unknown[] = [];
        const {result} = renderHook(() => {
            const onyxResult = useOnyx(KEYS.TEST);
            rendered.push(onyxResult[0]);
            return onyxResult;
        });
        await act(async () => waitForPromisesToResolve());
        rendered.length = 0;

        await act(async () => {
            Onyx.set(KEYS.TEST, 'a');
            Onyx.set(KEYS.TEST, 'b');
            Onyx.set(KEYS.TEST, 'c');
            await waitForPromisesToResolve();
        });

        expect(result.current[0]).toBe('c');
        expect(rendered.at(-1)).toBe('c');
        expect(rendered.every((value) => value === 'a' || value === 'b' || value === 'c')).toBe(true);
        expect(rendered.length).toBeGreaterThanOrEqual(1);
        expect(rendered.length).toBeLessThanOrEqual(1);
    });

    describe('collections', () => {
        it('re-renders a collection hook with the new member and keeps other members by reference', async () => {
            const member1 = {name: 'one', age: 1};
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, member1);
            const {result} = renderHook(() => useOnyx(KEYS.COLLECTION.COLL));
            await act(async () => waitForPromisesToResolve());

            await act(async () => Onyx.set(`${KEYS.COLLECTION.COLL}2`, {name: 'two', age: 2}));

            expect(result.current[0]).toEqual({[`${KEYS.COLLECTION.COLL}1`]: member1, [`${KEYS.COLLECTION.COLL}2`]: {name: 'two', age: 2}});
            expect(memberOf(result.current[0], `${KEYS.COLLECTION.COLL}1`)).toBe(member1);
        });

        it('does not re-render a collection hook for a deep-equal member write', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {name: 'one', age: 1});
            let renders = 0;
            const {result} = renderHook(() => {
                renders++;
                return useOnyx(KEYS.COLLECTION.COLL);
            });
            await act(async () => waitForPromisesToResolve());
            const rendered = result.current[0];
            const rendersBefore = renders;

            await act(async () => Onyx.set(`${KEYS.COLLECTION.COLL}1`, {name: 'one', age: 1}));
            await act(async () => waitForPromisesToResolve());

            expect(renders).toBe(rendersBefore);
            expect(result.current[0]).toBe(rendered);
        });

        it('removes a member from the rendered collection on a null write', async () => {
            await Onyx.set(`${KEYS.COLLECTION.COLL}1`, {name: 'one', age: 1});
            await Onyx.set(`${KEYS.COLLECTION.COLL}2`, {name: 'two', age: 2});
            const {result} = renderHook(() => useOnyx(KEYS.COLLECTION.COLL));
            await act(async () => waitForPromisesToResolve());

            await act(async () => Onyx.set(`${KEYS.COLLECTION.COLL}1`, null));

            expect(result.current[0]).toEqual({[`${KEYS.COLLECTION.COLL}2`]: {name: 'two', age: 2}});
        });

        it('does not re-render a sibling member hook or a nested collection hook', async () => {
            let siblingRenders = 0;
            let nestedRenders = 0;
            renderHook(() => {
                siblingRenders++;
                return useOnyx(`${KEYS.COLLECTION.COLL}2`);
            });
            renderHook(() => {
                nestedRenders++;
                return useOnyx(KEYS.COLLECTION.COLL_SUB);
            });
            await act(async () => waitForPromisesToResolve());
            const siblingBefore = siblingRenders;
            const nestedBefore = nestedRenders;

            await act(async () => Onyx.set(`${KEYS.COLLECTION.COLL}1`, {name: 'one', age: 1}));
            await act(async () => waitForPromisesToResolve());

            expect(siblingRenders).toBe(siblingBefore);
            expect(nestedRenders).toBe(nestedBefore);
        });
    });

    describe('selectors', () => {
        it('re-renders only when the selected field changes', async () => {
            await Onyx.set(KEYS.TEST, {name: 'a', age: 1});
            let renders = 0;
            const {result} = renderHook(() => {
                renders++;
                return useOnyx(KEYS.TEST, {selector: selectName});
            });
            await act(async () => waitForPromisesToResolve());
            expect(result.current[0]).toBe('a');
            const rendersBefore = renders;

            await act(async () => Onyx.set(KEYS.TEST, {name: 'a', age: 2}));
            await act(async () => waitForPromisesToResolve());
            expect(renders).toBe(rendersBefore);

            await act(async () => Onyx.set(KEYS.TEST, {name: 'b', age: 2}));
            expect(result.current[0]).toBe('b');
            expect(renders).toBeGreaterThan(rendersBefore);
        });

        it('renders the selector output for a null write', async () => {
            await Onyx.set(KEYS.TEST, {name: 'a', age: 1});
            const {result} = renderHook(() => useOnyx(KEYS.TEST, {selector: (value: unknown) => selectName(value) ?? 'none'}));
            await act(async () => waitForPromisesToResolve());

            await act(async () => Onyx.set(KEYS.TEST, null));

            expect(result.current[0]).toBe('none');
        });

        it('keeps an object selector result stable when the selected part is deep-equal', async () => {
            await Onyx.set(KEYS.TEST, {name: 'a', age: 1, tags: ['x']});
            const {result} = renderHook(() => useOnyx(KEYS.TEST, {selector: selectTags}));
            await act(async () => waitForPromisesToResolve());
            const rendered = result.current[0];

            await act(async () => Onyx.set(KEYS.TEST, {name: 'b', age: 1, tags: ['x']}));
            await act(async () => waitForPromisesToResolve());

            expect(result.current[0]).toBe(rendered);

            await act(async () => Onyx.set(KEYS.TEST, {name: 'b', age: 1, tags: ['y']}));
            expect(result.current[0]).toEqual({tags: ['y']});
        });
    });
});
