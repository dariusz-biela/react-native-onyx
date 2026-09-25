import type {SharedProvider, SyncBus, Tab} from './syncHarness';
import {KEYS, createSyncBus, deliver, openTab, readShared, record, resetSharedStorage, settle, spyOnSharedWrites, storageEvent} from './syncHarness';

let provider: SharedProvider;
let bus: SyncBus;
let writer: Tab;
let reader: Tab;

beforeEach(async () => {
    provider = resetSharedStorage();
    bus = createSyncBus();
    writer = await openTab();
    reader = await openTab();
    bus.drain();
});

afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
});

describe('InstanceSync receive side', () => {
    it('applies another tab write to the cache and subscribers of this tab', async () => {
        const plain = record(reader, KEYS.PLAIN);
        const member = record(reader, 'test_1');
        const collection = record(reader, KEYS.COLLECTION.TEST);
        await settle();

        await writer.Onyx.set(KEYS.PLAIN, 'remote');
        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}, test_2: {id: 2}});
        await deliver(reader, bus.drain());

        expect(reader.cache.get(KEYS.PLAIN)).toBe('remote');
        expect(plain.values.at(-1)).toBe('remote');
        expect(plain.keys.at(-1)).toBe(KEYS.PLAIN);
        expect(member.values.at(-1)).toEqual({id: 1});
        expect(collection.values.at(-1)).toEqual({test_1: {id: 1}, test_2: {id: 2}});
    });

    it('reads the values when the batch is flushed, not when the event arrived', async () => {
        await provider.setItem<string>(KEYS.PLAIN, 'announced');
        reader.receive(storageEvent(KEYS.PLAIN));
        provider.setItem<string>(KEYS.PLAIN, 'newer');
        await settle();

        expect(reader.cache.get(KEYS.PLAIN)).toBe('newer');
    });

    it('does not apply anything before the current task yields', async () => {
        await provider.setItem<string>(KEYS.PLAIN, 'stored');
        reader.receive(storageEvent(KEYS.PLAIN));

        expect(reader.cache.get(KEYS.PLAIN)).toBeUndefined();
        await settle();
        expect(reader.cache.get(KEYS.PLAIN)).toBe('stored');
    });

    it('coalesces events that arrive in the same task into one batch', async () => {
        const collection = record(reader, KEYS.COLLECTION.TEST);
        await settle();
        const before = collection.values.length;

        await provider.multiSet([
            ['test_1', {id: 1}],
            ['test_2', {id: 2}],
            ['test_3', {id: 3}],
        ]);
        reader.receive(storageEvent('test_1'));
        reader.receive(storageEvent('test_2'));
        reader.receive(storageEvent(JSON.stringify(['test_3', 'test_1'])));
        await settle();

        expect(collection.values.length - before).toBe(1);
        expect(collection.values.at(-1)).toEqual({test_1: {id: 1}, test_2: {id: 2}, test_3: {id: 3}});
    });

    it('starts a new batch for events that arrive after a flush', async () => {
        const plain = record(reader, KEYS.PLAIN);
        await settle();

        await writer.Onyx.set(KEYS.PLAIN, 'first');
        await deliver(reader, bus.drain());
        await writer.Onyx.set(KEYS.PLAIN, 'second');
        await deliver(reader, bus.drain());

        expect(plain.values.slice(-2)).toEqual(['first', 'second']);
    });

    it.each([
        ['another localStorage key', storageEvent(KEYS.PLAIN, 'someOtherKey')],
        ['a localStorage.clear()', storageEvent(null, null)],
        ['the SYNC_ONYX removal', storageEvent(null)],
        ['an empty payload', storageEvent('')],
    ])('ignores %s', async (name, event) => {
        await provider.setItem<string>(KEYS.PLAIN, 'stored');
        const plain = record(reader, KEYS.PLAIN);
        await settle();
        const before = plain.values.length;
        reader.cache.drop(KEYS.PLAIN);

        reader.receive(event);
        await settle();

        expect(reader.cache.get(KEYS.PLAIN)).toBeUndefined();
        expect(plain.values).toHaveLength(before);
    });

    it('does not read the empty key for an empty payload', async () => {
        await provider.setItem<string>('', 'stored under the empty key');

        reader.receive(storageEvent(''));
        await settle();

        expect(reader.cache.get('')).toBeUndefined();
    });

    it('treats a payload that is not a JSON array as one raw key', async () => {
        await provider.multiSet([
            ['42', 'number-like'],
            ['{broken', 'not json'],
        ]);

        reader.receive(storageEvent('42'));
        reader.receive(storageEvent('{broken'));
        await settle();

        expect(reader.cache.get('42')).toBe('number-like');
        expect(reader.cache.get('{broken')).toBe('not json');
    });

    it('never writes to storage or raises an event of its own while applying', async () => {
        record(reader, KEYS.PLAIN);
        record(reader, KEYS.COLLECTION.TEST);
        await settle();
        await writer.Onyx.set(KEYS.PLAIN, 'p');
        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}});
        await writer.Onyx.set(KEYS.PLAIN, null);
        await settle();
        const payloads = bus.drain();
        const stored = readShared();
        const writes = spyOnSharedWrites();

        await deliver(reader, payloads);

        expect(writes.count()).toBe(0);
        expect(bus.drain()).toEqual([]);
        expect(readShared()).toEqual(stored);
    });

    it('drops a key another tab removed', async () => {
        await writer.Onyx.multiSet({[KEYS.PLAIN]: 'p', test_1: {id: 1}});
        await deliver(reader, bus.drain());
        const member = record(reader, 'test_1');
        const collection = record(reader, KEYS.COLLECTION.TEST);
        await settle();

        await writer.Onyx.set('test_1', null);
        await writer.Onyx.set(KEYS.PLAIN, null);
        await settle();
        await deliver(reader, bus.drain());

        expect(reader.cache.get(KEYS.PLAIN) ?? undefined).toBeUndefined();
        expect(reader.cache.get('test_1') ?? undefined).toBeUndefined();
        expect(member.values.at(-1)).toBeUndefined();
        expect(collection.values.at(-1)).toEqual({});
    });

    it('brings the other tab up to date after Onyx.clear', async () => {
        await writer.Onyx.multiSet({[KEYS.PLAIN]: 'p', test_1: {id: 1}, test_level_1: {id: 2}});
        await deliver(reader, bus.drain());
        const collection = record(reader, KEYS.COLLECTION.TEST);
        const levelCollection = record(reader, KEYS.COLLECTION.TEST_LEVEL);
        const plain = record(reader, KEYS.PLAIN);
        await settle();

        await writer.Onyx.clear();
        await deliver(reader, bus.drain());

        expect(plain.values.at(-1) ?? undefined).toBeUndefined();
        expect(collection.values.at(-1)).toEqual({});
        expect(levelCollection.values.at(-1)).toEqual({});
        expect(reader.cache.get('test_1') ?? undefined).toBeUndefined();
    });
});
