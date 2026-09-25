import {act, renderHook} from '@testing-library/react-native';
import type {SyncBus, Tab} from './syncHarness';
import {KEYS, createSyncBus, deliver, openTab, resetSharedStorage, settle} from './syncHarness';

let bus: SyncBus;
let writer: Tab;
let reader: Tab;

beforeEach(async () => {
    resetSharedStorage();
    bus = createSyncBus();
    writer = await openTab();
    reader = await openTab();
    bus.drain();
});

afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
});

async function syncToReader(): Promise<void> {
    await settle();
    const payloads = bus.drain();
    await act(async () => {
        await deliver(reader, payloads);
    });
}

function renderCounted<T>(useValue: () => T) {
    let renders = 0;
    const hook = renderHook(() => {
        renders++;
        return useValue();
    });
    return {hook, renders: () => renders};
}

describe('useOnyx in the receiving tab', () => {
    it('renders the remote values of a plain key, a member and the collection', async () => {
        const {useOnyx} = reader;
        const plain = renderHook(() => useOnyx(KEYS.PLAIN));
        const member = renderHook(() => useOnyx('test_1'));
        const collection = renderHook(() => useOnyx(KEYS.COLLECTION.TEST));
        await act(settle);

        await writer.Onyx.set(KEYS.PLAIN, 'remote');
        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}, test_2: {id: 2}});
        await syncToReader();

        expect(plain.result.current[0]).toBe('remote');
        expect(member.result.current[0]).toEqual({id: 1});
        expect(collection.result.current[0]).toEqual({test_1: {id: 1}, test_2: {id: 2}});
        expect(collection.result.current[1].status).toBe('loaded');
    });

    it('re-renders a collection hook at most once for a remote batch of many members', async () => {
        const {useOnyx} = reader;
        const collection = renderCounted(() => useOnyx(KEYS.COLLECTION.TEST));
        await act(settle);
        const before = collection.renders();

        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST, Object.fromEntries(Array.from({length: 20}, (unused, index) => [`test_${index}`, {id: index}])));
        await syncToReader();

        expect(collection.renders() - before).toBeGreaterThanOrEqual(1);
        expect(collection.renders() - before).toBeLessThanOrEqual(1);
        expect(Object.keys(collection.hook.result.current[0] ?? {})).toHaveLength(20);
    });

    it('does not re-render a member hook the remote batch did not change', async () => {
        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}});
        await syncToReader();
        const {useOnyx} = reader;
        const member = renderCounted(() => useOnyx('test_1'));
        await act(settle);
        const before = member.renders();
        const value = member.hook.result.current[0];

        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_2: {id: 2}});
        await syncToReader();

        expect(member.renders()).toBe(before);
        expect(member.hook.result.current[0]).toBe(value);
    });

    it('renders undefined once another tab removes the value', async () => {
        await writer.Onyx.multiSet({[KEYS.PLAIN]: 'p', test_1: {id: 1}});
        await syncToReader();
        const {useOnyx} = reader;
        const plain = renderHook(() => useOnyx(KEYS.PLAIN));
        const member = renderHook(() => useOnyx('test_1'));
        const collection = renderHook(() => useOnyx(KEYS.COLLECTION.TEST));
        await act(settle);
        expect(plain.result.current[0]).toBe('p');

        await writer.Onyx.set(KEYS.PLAIN, null);
        await writer.Onyx.set('test_1', null);
        await syncToReader();

        expect(plain.result.current[0]).toBeUndefined();
        expect(member.result.current[0]).toBeUndefined();
        expect(collection.result.current[0] ?? {}).toEqual({});
    });

    it('renders a selector result derived from the remote value', async () => {
        const {useOnyx} = reader;
        const ids = renderHook(() => useOnyx(KEYS.COLLECTION.TEST, {selector: (items) => Object.keys(items ?? {}).sort()}));
        await act(settle);

        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_2: {id: 2}, test_1: {id: 1}});
        await syncToReader();

        expect(ids.result.current[0]).toEqual(['test_1', 'test_2']);
    });

    it('does not mix a prefix-colliding collection into the other collection hook', async () => {
        const {useOnyx} = reader;
        const test = renderCounted(() => useOnyx(KEYS.COLLECTION.TEST));
        const level = renderHook(() => useOnyx(KEYS.COLLECTION.TEST_LEVEL));
        await act(settle);
        const before = test.renders();

        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST_LEVEL, {test_level_1: {id: 1}});
        await syncToReader();

        expect(level.result.current[0]).toEqual({test_level_1: {id: 1}});
        expect(test.hook.result.current[0]).toBeUndefined();
        expect(test.renders()).toBe(before);
    });
});
