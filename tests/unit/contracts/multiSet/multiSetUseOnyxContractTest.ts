import {act, renderHook} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import onyxSnapshotCache from '../../../../lib/OnyxSnapshotCache';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const KEYS = {
    PLAIN_A: 'plainA',
    PLAIN_B: 'plainB',
    RAM_ONLY: 'ramOnlyKey',
    COLLECTION: {
        TEST: 'test_',
        TEST_LEVEL: 'test_level_',
        ROUTES: 'routes_',
    },
};

const SKIPPABLE_ID = 'skippable-id';

const member = (collectionKey: string, id: string | number) => `${collectionKey}${id}`;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

function valueAt(collection: unknown, key: string): unknown {
    return isRecord(collection) ? collection[key] : undefined;
}

function namesOf(collection: unknown): string[] {
    if (!isRecord(collection)) {
        return [];
    }
    return Object.values(collection)
        .map((item) => valueAt(item, 'name'))
        .filter((name): name is string => typeof name === 'string')
        .sort();
}

Onyx.init({
    keys: KEYS,
    ramOnlyKeys: [KEYS.RAM_ONLY],
    skippableCollectionMemberIDs: [SKIPPABLE_ID],
});

beforeEach(async () => {
    await Onyx.clear();
    onyxSnapshotCache.clear();
    onyxSnapshotCache.clearSelectorIds();
});

describe('Onyx.multiSet contract with useOnyx', () => {
    it('renders the new values of several plain keys set in one call', async () => {
        const {result} = renderHook(() => [useOnyx(KEYS.PLAIN_A)[0], useOnyx(KEYS.PLAIN_B)[0], useOnyx(KEYS.RAM_ONLY)[0]]);
        await act(async () => waitForPromisesToResolve());

        await act(async () => Onyx.multiSet({[KEYS.PLAIN_A]: 'a', [KEYS.PLAIN_B]: {b: 1}, [KEYS.RAM_ONLY]: 'ram'}));

        expect(result.current).toEqual(['a', {b: 1}, 'ram']);
    });

    it('never renders a partially applied batch of collection members and renders at most once per batch', async () => {
        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}}));
        const renders: unknown[] = [];
        const {result} = renderHook(() => {
            const [collection] = useOnyx(KEYS.COLLECTION.TEST);
            renders.push(collection);
            return collection;
        });
        await act(async () => waitForPromisesToResolve());
        const rendersBefore = renders.length;

        await act(async () =>
            Onyx.multiSet({
                [member(KEYS.COLLECTION.TEST, 2)]: {id: 2},
                [member(KEYS.COLLECTION.TEST, 3)]: {id: 3},
                [KEYS.PLAIN_A]: 'a',
                [member(KEYS.COLLECTION.TEST, 1)]: {id: 11},
            }),
        );

        const expected = {
            [member(KEYS.COLLECTION.TEST, 1)]: {id: 11},
            [member(KEYS.COLLECTION.TEST, 2)]: {id: 2},
            [member(KEYS.COLLECTION.TEST, 3)]: {id: 3},
        };
        const newRenders = renders.slice(rendersBefore);
        expect(newRenders.length).toBeGreaterThanOrEqual(1);
        expect(newRenders.length).toBeLessThanOrEqual(1);
        for (const rendered of newRenders) {
            expect(rendered).toEqual(expected);
        }
        expect(result.current).toEqual(expected);
    });

    it('does not re-render a member hook whose value reference did not change, and re-renders a changed one', async () => {
        const unchanged = {id: 1};
        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: unchanged, [member(KEYS.COLLECTION.TEST, 2)]: {id: 2}}));
        let unchangedRenders = 0;
        let changedRenders = 0;
        const unchangedHook = renderHook(() => {
            unchangedRenders++;
            return useOnyx(member(KEYS.COLLECTION.TEST, 1))[0];
        });
        const changedHook = renderHook(() => {
            changedRenders++;
            return useOnyx(member(KEYS.COLLECTION.TEST, 2))[0];
        });
        await act(async () => waitForPromisesToResolve());
        const unchangedBefore = unchangedRenders;
        const changedBefore = changedRenders;
        const unchangedValueBefore = unchangedHook.result.current;

        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: unchanged, [member(KEYS.COLLECTION.TEST, 2)]: {id: 22}}));

        expect(unchangedRenders).toBe(unchangedBefore);
        expect(unchangedHook.result.current).toBe(unchangedValueBefore);
        expect(changedRenders).toBeGreaterThan(changedBefore);
        expect(changedHook.result.current).toEqual({id: 22});
    });

    it('keeps the collection hook result reference when the batch changes nothing in that collection', async () => {
        const v1 = {id: 1};
        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: v1}));
        const {result} = renderHook(() => useOnyx(KEYS.COLLECTION.TEST)[0]);
        await act(async () => waitForPromisesToResolve());
        const before = result.current;

        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: v1, [member(KEYS.COLLECTION.ROUTES, 1)]: {id: 1}, [member(KEYS.COLLECTION.TEST_LEVEL, 1)]: {id: 1}}));

        expect(result.current).toBe(before);
    });

    it('keeps untouched member references inside a changed collection hook result', async () => {
        const untouched = {id: 2};
        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1}, [member(KEYS.COLLECTION.TEST, 2)]: untouched}));
        const {result} = renderHook(() => useOnyx(KEYS.COLLECTION.TEST)[0]);
        await act(async () => waitForPromisesToResolve());
        const before = result.current;

        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 11}}));

        expect(result.current).not.toBe(before);
        expect(valueAt(result.current, member(KEYS.COLLECTION.TEST, 2))).toBe(untouched);
        expect(valueAt(result.current, member(KEYS.COLLECTION.TEST, 1))).toEqual({id: 11});
    });

    it('renders undefined for removed keys and omits removed members from the collection', async () => {
        await act(async () => Onyx.multiSet({[KEYS.PLAIN_A]: 'a', [member(KEYS.COLLECTION.TEST, 1)]: {id: 1}, [member(KEYS.COLLECTION.TEST, 2)]: {id: 2}}));
        const {result} = renderHook(() => ({
            plain: useOnyx(KEYS.PLAIN_A)[0],
            removedMember: useOnyx(member(KEYS.COLLECTION.TEST, 1))[0],
            collection: useOnyx(KEYS.COLLECTION.TEST)[0],
        }));
        await act(async () => waitForPromisesToResolve());

        await act(async () => Onyx.multiSet({[KEYS.PLAIN_A]: null, [member(KEYS.COLLECTION.TEST, 1)]: null}));

        expect(result.current.plain).toBeUndefined();
        expect(result.current.removedMember).toBeUndefined();
        expect(result.current.collection).toEqual({[member(KEYS.COLLECTION.TEST, 2)]: {id: 2}});
        expect(Object.keys(result.current.collection ?? {})).toEqual([member(KEYS.COLLECTION.TEST, 2)]);
    });

    it('feeds the whole batch to a collection selector and re-renders with the selected result', async () => {
        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1, name: 'one'}}));
        const {result} = renderHook(() =>
            useOnyx(KEYS.COLLECTION.TEST, {
                selector: namesOf,
            }),
        );
        await act(async () => waitForPromisesToResolve());
        expect(result.current[0]).toEqual(['one']);

        await act(async () =>
            Onyx.multiSet({
                [member(KEYS.COLLECTION.TEST, 2)]: {id: 2, name: 'two'},
                [member(KEYS.COLLECTION.TEST, 1)]: null,
                [member(KEYS.COLLECTION.TEST, 3)]: {id: 3, name: 'three'},
                [member(KEYS.COLLECTION.TEST, SKIPPABLE_ID)]: {id: 4, name: 'skipped'},
            }),
        );

        expect(result.current[0]).toEqual(['three', 'two']);
    });

    it('does not re-render a selector hook when the batch leaves its selected result deep-equal', async () => {
        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1, name: 'one'}}));
        let renders = 0;
        const {result} = renderHook(() => {
            renders++;
            return useOnyx(KEYS.COLLECTION.TEST, {selector: (collection: unknown) => (isRecord(collection) ? Object.keys(collection).length : 0)})[0];
        });
        await act(async () => waitForPromisesToResolve());
        const rendersBefore = renders;

        await act(async () => Onyx.multiSet({[member(KEYS.COLLECTION.TEST, 1)]: {id: 1, name: 'renamed'}}));

        expect(result.current).toBe(1);
        expect(renders).toBe(rendersBefore);
    });

    it('renders the final value of interleaved writes in one tick', async () => {
        const {result} = renderHook(() => ({plain: useOnyx(KEYS.PLAIN_A)[0], collection: useOnyx(KEYS.COLLECTION.TEST)[0]}));
        await act(async () => waitForPromisesToResolve());

        await act(async () => {
            Onyx.multiSet({[KEYS.PLAIN_A]: 1, [member(KEYS.COLLECTION.TEST, 1)]: {id: 1}});
            Onyx.set(KEYS.PLAIN_A, 2);
            Onyx.multiSet({[KEYS.PLAIN_A]: 3, [member(KEYS.COLLECTION.TEST, 1)]: null, [member(KEYS.COLLECTION.TEST, 2)]: {id: 2}});
            await waitForPromisesToResolve();
        });

        expect(result.current.plain).toBe(3);
        expect(result.current.collection).toEqual({[member(KEYS.COLLECTION.TEST, 2)]: {id: 2}});
    });
});
