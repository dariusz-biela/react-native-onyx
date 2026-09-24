import {act, renderHook} from '@testing-library/react-native';

import type {OnyxCollection} from '../../../../lib';
import type GenericCollection from '../../../utils/GenericCollection';

import Onyx, {useOnyx} from '../../../../lib';
import onyxSnapshotCache from '../../../../lib/OnyxSnapshotCache';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const ONYX_KEYS = {
    COLLECTION: {
        REPORT: 'report_',
        POLICY: 'policy_',
    },
};

Onyx.init({keys: ONYX_KEYS});

type Report = {name?: string; count?: number; nested?: {x?: number; y?: number}};

const reportKey = (id: string) => `${ONYX_KEYS.COLLECTION.REPORT}${id}`;

function mergeReports(collection: GenericCollection): Promise<void> {
    return Onyx.mergeCollection(ONYX_KEYS.COLLECTION.REPORT, collection);
}

async function flush(): Promise<void> {
    await act(async () => waitForPromisesToResolve());
}

function toCollection(value: unknown): GenericCollection | undefined {
    return typeof value === 'object' && value !== null ? value : undefined;
}

function renderRecordedHook<T>(useValue: () => T) {
    const rendered: T[] = [];
    const hook = renderHook(() => {
        const value = useValue();
        rendered.push(value);
        return value;
    });
    return {rendered, hook};
}

beforeEach(async () => {
    await Onyx.clear();
    onyxSnapshotCache.clear();
    onyxSnapshotCache.clearSelectorIds();
});

describe('Onyx.mergeCollection contract through useOnyx', () => {
    it('re-renders a collection hook once per changing call with the merged collection', async () => {
        await mergeReports({[reportKey('1')]: {name: 'a'}, [reportKey('2')]: {name: 'b'}});
        const {rendered, hook} = renderRecordedHook(() => useOnyx(ONYX_KEYS.COLLECTION.REPORT)[0]);
        await flush();
        const rendersBefore = rendered.length;

        await act(async () => mergeReports({[reportKey('1')]: {count: 1}, [reportKey('3')]: {name: 'c'}}));
        await flush();

        const expected = {[reportKey('1')]: {name: 'a', count: 1}, [reportKey('2')]: {name: 'b'}, [reportKey('3')]: {name: 'c'}};
        expect(hook.result.current).toEqual(expected);
        expect(rendered.length - rendersBefore).toBeGreaterThanOrEqual(1);
        expect(rendered.length - rendersBefore).toBeLessThanOrEqual(1);
    });

    it('renders only valid in-order collection values across several calls', async () => {
        const {rendered, hook} = renderRecordedHook(() => useOnyx(ONYX_KEYS.COLLECTION.REPORT)[0]);
        await flush();
        const rendersBefore = rendered.length;

        await act(async () => mergeReports({[reportKey('1')]: {count: 1}}));
        await act(async () => mergeReports({[reportKey('1')]: {count: 2}, [reportKey('2')]: {count: 1}}));
        await act(async () => mergeReports({[reportKey('1')]: null}));
        await flush();

        const states: Array<OnyxCollection<Report>> = [{[reportKey('1')]: {count: 1}}, {[reportKey('1')]: {count: 2}, [reportKey('2')]: {count: 1}}, {[reportKey('2')]: {count: 1}}];
        const seen = rendered.slice(rendersBefore);
        let lastIndex = -1;
        for (const value of seen) {
            const index = states.findIndex((state) => JSON.stringify(state) === JSON.stringify(value));
            expect(index).toBeGreaterThanOrEqual(0);
            expect(index).toBeGreaterThanOrEqual(lastIndex);
            lastIndex = index;
        }
        expect(hook.result.current).toEqual(states[2]);
        expect(seen.length).toBeLessThanOrEqual(3);
    });

    it('does not re-render a collection hook when the call changes nothing', async () => {
        await mergeReports({[reportKey('1')]: {name: 'a', nested: {x: 1}}});
        const {rendered, hook} = renderRecordedHook(() => useOnyx(ONYX_KEYS.COLLECTION.REPORT)[0]);
        await flush();
        const rendersBefore = rendered.length;
        const before = hook.result.current;

        await act(async () => mergeReports({[reportKey('1')]: {name: 'a', nested: {x: 1}}}));
        await flush();

        expect(rendered.length).toBe(rendersBefore);
        expect(hook.result.current).toBe(before);
    });

    it('keeps references of unchanged members across commits', async () => {
        await mergeReports({[reportKey('1')]: {name: 'a'}, [reportKey('2')]: {name: 'b', nested: {x: 1}}});
        const {hook} = renderRecordedHook(() => useOnyx(ONYX_KEYS.COLLECTION.REPORT)[0]);
        await flush();
        const before = hook.result.current;

        await act(async () => mergeReports({[reportKey('1')]: {name: 'changed'}}));
        await flush();

        const after = hook.result.current;
        expect(after).not.toBe(before);
        expect(toCollection(after)?.[reportKey('2')]).toBe(toCollection(before)?.[reportKey('2')]);
        expect(toCollection(after)?.[reportKey('1')]).toEqual({name: 'changed'});
    });

    it('does not re-render a member hook whose member is untouched or unchanged', async () => {
        await mergeReports({[reportKey('1')]: {name: 'a'}, [reportKey('2')]: {name: 'b'}});
        const untouched = renderRecordedHook(() => useOnyx(reportKey('2'))[0]);
        const unchanged = renderRecordedHook(() => useOnyx(reportKey('1'))[0]);
        await flush();
        const untouchedBefore = untouched.rendered.length;
        const unchangedBefore = unchanged.rendered.length;

        await act(async () => mergeReports({[reportKey('1')]: {name: 'a'}, [reportKey('3')]: {name: 'c'}}));
        await flush();

        expect(untouched.rendered.length).toBe(untouchedBefore);
        expect(unchanged.rendered.length).toBe(unchangedBefore);
    });

    it('re-renders a changed member hook with the merged value and a removed one with undefined', async () => {
        await mergeReports({[reportKey('1')]: {name: 'a', nested: {x: 1}}, [reportKey('2')]: {name: 'b'}});
        const changed = renderRecordedHook(() => useOnyx(reportKey('1'))[0]);
        const removed = renderRecordedHook(() => useOnyx(reportKey('2'))[0]);
        await flush();
        const changedBefore = changed.rendered.length;

        await act(async () => mergeReports({[reportKey('1')]: {nested: {y: 2}}, [reportKey('2')]: null}));
        await flush();

        expect(changed.hook.result.current).toEqual({name: 'a', nested: {x: 1, y: 2}});
        expect(changed.rendered.length - changedBefore).toBeGreaterThanOrEqual(1);
        expect(changed.rendered.length - changedBefore).toBeLessThanOrEqual(1);
        expect(removed.hook.result.current).toBeUndefined();
    });

    it('does not re-render a collection selector hook when the selected result is unchanged', async () => {
        await mergeReports({[reportKey('1')]: {name: 'a', count: 1}, [reportKey('2')]: {name: 'b', count: 1}});
        const selectNames = (reports: unknown) =>
            Object.values(toCollection(reports) ?? {})
                .map((report) => report?.name)
                .join(',');
        const {rendered, hook} = renderRecordedHook(() => useOnyx(ONYX_KEYS.COLLECTION.REPORT, {selector: selectNames})[0]);
        await flush();
        const rendersBefore = rendered.length;

        await act(async () => mergeReports({[reportKey('1')]: {count: 2}}));
        await flush();

        expect(hook.result.current).toBe('a,b');
        expect(rendered.length).toBe(rendersBefore);

        await act(async () => mergeReports({[reportKey('2')]: {name: 'renamed'}}));
        await flush();

        expect(hook.result.current).toBe('a,renamed');
        expect(rendered.length - rendersBefore).toBeGreaterThanOrEqual(1);
    });

    it('does not re-render a hook on another collection', async () => {
        const {rendered} = renderRecordedHook(() => useOnyx(ONYX_KEYS.COLLECTION.POLICY)[0]);
        await flush();
        const rendersBefore = rendered.length;

        await act(async () => mergeReports({[reportKey('1')]: {name: 'a'}}));
        await flush();

        expect(rendered.length).toBe(rendersBefore);
    });
});
