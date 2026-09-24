import {act, renderHook} from '@testing-library/react-native';

import type GenericCollection from '../../../utils/GenericCollection';
import type {OnyxCollection} from '../../../../lib';

import Onyx, {useOnyx} from '../../../../lib';
import OnyxUtils from '../../../../lib/OnyxUtils';
import {KEYS, initOnyx, resetOnyx, settle} from './helpers';

const ROUTES = KEYS.COLLECTION.ROUTES;
const A = `${ROUTES}A`;
const B = `${ROUTES}B`;
const C = `${ROUTES}C`;
const D = `${ROUTES}D`;

type Route = {name: string};

const SEED: Record<string, Route> = {[A]: {name: 'A'}, [B]: {name: 'B'}, [C]: {name: 'C'}};

function countRoutes(collection: OnyxCollection<unknown>): number {
    return Object.keys(collection ?? {}).length;
}

describe('setCollection seen through useOnyx', () => {
    beforeAll(initOnyx);
    beforeEach(async () => {
        await resetOnyx();
        await Onyx.multiSet(SEED);
    });
    afterAll(resetOnyx);

    it('commits only valid collection states and ends on the new collection', async () => {
        const committed: unknown[] = [];
        const {result} = renderHook(() => {
            const [routes] = useOnyx(ROUTES);
            committed.push(routes);
            return routes;
        });
        await act(settle);
        committed.length = 0;

        await act(() => Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [D]: {name: 'D'}}));

        expect(result.current).toEqual({[A]: {name: 'A2'}, [D]: {name: 'D'}});
        expect(committed.length).toBeGreaterThanOrEqual(1);
        expect(committed.length).toBeLessThanOrEqual(1);
        for (const value of committed) {
            expect([SEED, {[A]: {name: 'A2'}, [D]: {name: 'D'}}]).toContainEqual(value);
        }
    });

    it('shows a removed member as undefined with a loaded status', async () => {
        const {result} = renderHook(() => useOnyx(B));
        await act(settle);
        expect(result.current[0]).toEqual({name: 'B'});

        await act(() => Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}}));

        expect(result.current[0]).toBeUndefined();
        expect(result.current[1].status).toBe('loaded');
    });

    it('does not re-render a member hook whose value keeps its reference', async () => {
        const valueA = OnyxUtils.tryGetCachedValue(A);
        let renders = 0;
        const {result} = renderHook(() => {
            renders++;
            return useOnyx(A);
        });
        await act(settle);
        const rendersBefore = renders;

        await act(() => Onyx.setCollection(ROUTES, {[A]: valueA, [D]: {name: 'D'}}));

        expect(renders).toBe(rendersBefore);
        expect(result.current[0]).toBe(valueA);
    });

    it('does not re-render the collection hook when every member keeps its reference', async () => {
        const current: GenericCollection = {};
        for (const key of Object.keys(SEED)) {
            current[key] = OnyxUtils.tryGetCachedValue(key);
        }
        let renders = 0;
        renderHook(() => {
            renders++;
            return useOnyx(ROUTES);
        });
        await act(settle);
        const rendersBefore = renders;

        await act(() => Onyx.setCollection(ROUTES, current));

        expect(renders).toBe(rendersBefore);
    });

    it('does not re-render a selector hook whose output stays equal', async () => {
        let renders = 0;
        const {result} = renderHook(() => {
            renders++;
            return useOnyx(ROUTES, {selector: countRoutes});
        });
        await act(settle);
        const rendersBefore = renders;

        await act(() => Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}, [B]: {name: 'B2'}, [D]: {name: 'D'}}));

        expect(result.current[0]).toBe(3);
        expect(renders).toBe(rendersBefore);
    });

    it('re-renders a selector hook whose output changes', async () => {
        const {result} = renderHook(() => useOnyx(ROUTES, {selector: countRoutes}));
        await act(settle);

        await act(() => Onyx.setCollection(ROUTES, {[A]: {name: 'A2'}}));

        expect(result.current[0]).toBe(1);
    });

    it('does not re-render hooks of members untouched by a grouped update', async () => {
        let renders = 0;
        const {result} = renderHook(() => {
            renders++;
            return useOnyx(C);
        });
        const {result: resultA} = renderHook(() => useOnyx(A));
        await act(settle);
        const rendersBefore = renders;

        await act(() =>
            Onyx.update([
                {onyxMethod: Onyx.METHOD.SET, key: A, value: {name: 'A2'}},
                {onyxMethod: Onyx.METHOD.SET, key: B, value: null},
            ]),
        );

        expect(renders).toBe(rendersBefore);
        expect(result.current[0]).toEqual({name: 'C'});
        expect(resultA.current[0]).toEqual({name: 'A2'});
    });
});
