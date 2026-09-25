import {deepEqual} from 'fast-equals';
import type {OnyxKey} from '../../../../lib/types';
import type {SharedProvider, SyncBus, Tab} from './syncHarness';
import {KEYS, SYNC_ONYX, announcedKeys, createSyncBus, openTab, readShared, resetSharedStorage, settle} from './syncHarness';

const MAX_PAYLOAD = 1_000_000;

let provider: SharedProvider;
let bus: SyncBus;
let tab: Tab;

beforeEach(async () => {
    provider = resetSharedStorage();
    bus = createSyncBus();
    tab = await openTab({ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.COLLECTION.RAM_ONLY], initialKeyStates: {[KEYS.OTHER]: 'default'}});
    bus.drain();
});

afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
});

function jsonArrayLength(keys: string[]): number {
    return JSON.stringify(keys).length;
}

/** Keys of one character repeated, sized so the JSON array of all of them is exactly `targetLength` long. */
function keysWithJsonLength(targetLength: number, count: number): string[] {
    const overhead = jsonArrayLength(Array.from({length: count}, () => ''));
    const payload = targetLength - overhead;
    const base = Math.floor(payload / count);
    const keys = Array.from({length: count}, (unused, index) => `${String.fromCharCode(97 + index)}${'k'.repeat(base - 1)}`);
    keys[count - 1] += 'k'.repeat(payload - base * count);
    expect(jsonArrayLength(keys)).toBe(targetLength);
    return keys;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): OnyxKey[] {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter((key) => !deepEqual(before[key], after[key])).sort();
}

async function announcedBy(write: () => Promise<unknown>): Promise<{announced: OnyxKey[]; changed: OnyxKey[]; payloads: string[]}> {
    const before = readShared();
    await write();
    await settle();
    const payloads = bus.drain();
    return {announced: [...new Set(announcedKeys(payloads))].sort(), changed: changedKeys(before, readShared()), payloads};
}

describe('InstanceSync raise side', () => {
    describe('storage facade events', () => {
        it.each([
            ['setItem', () => tab.storage.setItem<string>(KEYS.PLAIN, 'value')],
            ['mergeItem', () => tab.storage.mergeItem(KEYS.OBJECT, {a: 1})],
            ['removeItem', () => tab.storage.removeItem(KEYS.PLAIN)],
        ])('%s announces its key as the raw single-key payload', async (name, write) => {
            await write();
            await settle();

            expect(bus.drain()).toEqual([name === 'mergeItem' ? KEYS.OBJECT : KEYS.PLAIN]);
        });

        it.each([
            [
                'multiSet',
                () =>
                    tab.storage.multiSet([
                        ['test_1', 1],
                        ['test_2', 2],
                        [KEYS.PLAIN, 'p'],
                    ]),
            ],
            [
                'multiMerge',
                () =>
                    tab.storage.multiMerge([
                        ['test_1', {a: 1}],
                        ['test_2', {a: 2}],
                        [KEYS.PLAIN, {a: 3}],
                    ]),
            ],
            ['removeItems', () => tab.storage.removeItems(['test_1', 'test_2', KEYS.PLAIN])],
        ])('%s announces every key of the batch in one JSON-array payload', async (name, write) => {
            await write();
            await settle();

            const payloads = bus.drain();
            expect(payloads).toHaveLength(1);
            const parsed: unknown = JSON.parse(payloads[0]);
            expect(Array.isArray(parsed)).toBe(true);
            expect(announcedKeys(payloads).sort()).toEqual(['plain', 'test_1', 'test_2']);
        });

        it.each([
            ['multiSet', () => tab.storage.multiSet([])],
            ['multiMerge', () => tab.storage.multiMerge([])],
            ['removeItems', () => tab.storage.removeItems([])],
        ])('%s with no keys raises no event', async (name, write) => {
            await write();
            await settle();

            expect(bus.drain()).toEqual([]);
        });

        it('raises the event only after the provider holds the written value', async () => {
            const storedWhenRaised: Array<Record<string, unknown>> = [];
            bus.setItem.mockImplementation((key: string) => {
                if (key !== SYNC_ONYX) {
                    return;
                }
                storedWhenRaised.push(readShared());
            });

            await tab.storage.setItem<string>(KEYS.PLAIN, 'first');
            await tab.storage.multiSet([
                ['test_1', 1],
                ['test_2', 2],
            ]);
            await tab.storage.mergeItem(KEYS.OBJECT, {a: 1});
            await tab.storage.removeItem(KEYS.PLAIN);
            await settle();

            expect(storedWhenRaised).toEqual([
                {[KEYS.PLAIN]: 'first'},
                {[KEYS.PLAIN]: 'first', test_1: 1, test_2: 2},
                {[KEYS.PLAIN]: 'first', test_1: 1, test_2: 2, [KEYS.OBJECT]: {a: 1}},
                {test_1: 1, test_2: 2, [KEYS.OBJECT]: {a: 1}},
            ]);
        });

        it.each([
            ['setItem', 'setItem', () => tab.storage.setItem<string>(KEYS.PLAIN, 'value')],
            ['mergeItem', 'mergeItem', () => tab.storage.mergeItem(KEYS.OBJECT, {a: 1})],
            ['removeItem', 'removeItem', () => tab.storage.removeItem(KEYS.PLAIN)],
            ['multiSet', 'multiSet', () => tab.storage.multiSet([['test_1', 1]])],
            ['multiMerge', 'multiMerge', () => tab.storage.multiMerge([['test_1', {a: 1}]])],
            ['removeItems', 'removeItems', () => tab.storage.removeItems(['test_1'])],
        ] as const)('%s waits for a slow provider write before raising its event', async (name, method, write) => {
            let finishWrite: (() => void) | undefined;
            const gate = new Promise<void>((resolve) => {
                finishWrite = resolve;
            });
            const original = provider[method].bind(provider);
            jest.spyOn(provider, method).mockImplementation((...args) => gate.then(() => Reflect.apply(original, provider, args)));

            const pending = write();
            await settle();
            expect(bus.drain()).toEqual([]);

            finishWrite?.();
            await pending;
            expect(bus.drain()).toHaveLength(1);
        });

        it('resolves the write only after its event was raised', async () => {
            await tab.storage.setItem<string>(KEYS.PLAIN, 'value');

            expect(bus.drain()).toEqual([KEYS.PLAIN]);
        });

        it('removes the SYNC_ONYX entry right after writing it so the next identical payload fires again', async () => {
            await tab.storage.setItem<string>(KEYS.PLAIN, 'a');
            await tab.storage.setItem<string>(KEYS.PLAIN, 'b');
            await settle();

            expect(bus.log()).toEqual([{type: 'set', value: KEYS.PLAIN}, {type: 'remove'}, {type: 'set', value: KEYS.PLAIN}, {type: 'remove'}]);
            expect(localStorage.getItem(SYNC_ONYX)).toBeNull();
        });

        it('clear reads the keys before clearing and announces them once storage is empty', async () => {
            await tab.storage.multiSet([
                [KEYS.PLAIN, 'p'],
                ['test_1', 1],
            ]);
            bus.drain();
            const storedWhenRaised: Array<Record<string, unknown>> = [];
            bus.setItem.mockImplementation((key: string) => {
                if (key !== SYNC_ONYX) {
                    return;
                }
                storedWhenRaised.push(readShared());
            });

            await tab.storage.clear();
            await settle();

            const payloads = bus.drain();
            expect(announcedKeys(payloads).sort()).toEqual([KEYS.PLAIN, 'test_1']);
            expect(storedWhenRaised).toEqual(payloads.map(() => ({})));
        });

        it('clear on empty storage raises no event', async () => {
            await tab.storage.clear();
            await settle();

            expect(bus.drain()).toEqual([]);
            expect(readShared()).toEqual({});
        });

        it('announces keys whose names need JSON escaping so the receiver reads them back unchanged', async () => {
            const keys = ['test_"quoted"', 'test_back\\slash', 'test_[1,2]', 'test_ünï', 'test_\n'];
            await tab.storage.multiSet(keys.map((key): [string, number] => [key, 1]));
            await settle();

            expect(announcedKeys(bus.drain())).toEqual(keys);
        });

        it('announces a single key verbatim even when it parses as a JSON scalar', async () => {
            await tab.storage.setItem<string>('42', 1);
            await tab.storage.mergeItem('null', {a: 1});
            await settle();

            expect(bus.drain()).toEqual(['42', 'null']);
        });
    });

    describe('payload size', () => {
        it('keeps a batch whose JSON stays under the limit in one event', async () => {
            const keys = keysWithJsonLength(MAX_PAYLOAD - 1, 3);
            tab.InstanceSync.multiSet(keys);

            const payloads = bus.drain();
            expect(payloads).toHaveLength(1);
            expect(announcedKeys(payloads)).toEqual(keys);
        });

        it.each([
            ['two keys', MAX_PAYLOAD + 1, 2],
            ['many keys', MAX_PAYLOAD + 50, 40],
            ['three times the limit with many keys', 3 * MAX_PAYLOAD, 3000],
        ])('splits a batch that would exceed the limit (%s) into ordered payloads within the limit', async (name, targetLength, count) => {
            const keys = keysWithJsonLength(targetLength, count);
            tab.InstanceSync.removeItems(keys);

            const payloads = bus.drain();
            expect(payloads.length).toBeGreaterThan(1);
            for (const payload of payloads) {
                expect(payload.length).toBeLessThanOrEqual(MAX_PAYLOAD);
                expect(announcedKeys([payload]).length).toBeGreaterThan(0);
            }
            expect(announcedKeys(payloads)).toEqual(keys);
        });

        it('still sends a single key longer than the limit on its own', async () => {
            const huge = `test_${'x'.repeat(MAX_PAYLOAD)}`;
            tab.InstanceSync.multiSet(['test_1', huge, 'test_2']);

            expect(announcedKeys(bus.drain())).toEqual(['test_1', huge, 'test_2']);
        });
    });

    describe('failed event', () => {
        it('logs an alert, keeps the write and raises the next event', async () => {
            const logs: Array<{message: string; level: string}> = [];
            tab.Logger.registerLogger(({message, level}) => logs.push({message, level}));
            bus.setItem.mockImplementationOnce(() => {
                throw new DOMException('quota', 'QuotaExceededError');
            });

            await expect(tab.storage.setItem<string>(KEYS.PLAIN, 'kept')).resolves.toBeUndefined();
            expect(readShared()).toEqual({[KEYS.PLAIN]: 'kept'});
            expect(logs.filter((log) => log.level === 'alert' && log.message.includes('QuotaExceededError'))).toHaveLength(1);

            bus.drain();
            await tab.storage.setItem<string>(KEYS.OTHER, 'next');
            expect(bus.drain()).toEqual([KEYS.OTHER]);
        });

        it('does not reject a batch write when the event cannot be raised', async () => {
            bus.setItem.mockImplementation(() => {
                throw new Error('storage disabled');
            });

            await expect(tab.storage.multiSet([['test_1', 1]])).resolves.toBeUndefined();
            await expect(tab.storage.clear()).resolves.toBeUndefined();
            expect(readShared()).toEqual({});
        });
    });

    describe('without shouldSyncMultipleInstances', () => {
        it('raises no event for any write', async () => {
            resetSharedStorage();
            const quiet = await openTab({shouldSyncMultipleInstances: false});
            bus.drain();

            await quiet.Onyx.set(KEYS.PLAIN, 'p');
            await quiet.Onyx.merge(KEYS.OBJECT, {a: 1});
            await quiet.Onyx.multiSet({[KEYS.OTHER]: 'o', test_1: 1});
            await quiet.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_2: 2});
            await quiet.Onyx.set(KEYS.PLAIN, null);
            await quiet.storage.clear();
            await settle();

            expect(bus.drain()).toEqual([]);
            expect(readShared()).toEqual({});
        });
    });

    describe('public API writes', () => {
        it.each<[string, () => Promise<unknown>]>([
            ['set', () => tab.Onyx.set(KEYS.PLAIN, 'value')],
            ['set of an object', () => tab.Onyx.set(KEYS.OBJECT, {a: 1, b: {c: 2}})],
            ['merge', () => tab.Onyx.merge(KEYS.OBJECT, {a: 1})],
            ['multiSet', () => tab.Onyx.multiSet({[KEYS.PLAIN]: 'p', test_1: {id: 1}, test_level_1: {id: 2}})],
            ['mergeCollection', () => tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}, test_2: {id: 2}})],
            ['setCollection', () => tab.Onyx.setCollection(KEYS.COLLECTION.TEST, {test_3: {id: 3}})],
            [
                'update',
                () =>
                    tab.Onyx.update([
                        {onyxMethod: 'set', key: KEYS.PLAIN, value: 'u'},
                        {onyxMethod: 'merge', key: KEYS.OBJECT, value: {u: true}},
                        {onyxMethod: 'mergecollection', key: KEYS.COLLECTION.TEST, value: {test_1: {u: 1}, test_4: {u: 4}}},
                        {onyxMethod: 'multiset', key: '', value: {[KEYS.NVP]: 'n', test_level_2: {u: 2}}},
                    ]),
            ],
        ])('%s announces every key it changed in storage', async (name, write) => {
            await tab.Onyx.multiSet({test_1: {id: 0}, test_2: {id: 0}, [KEYS.OBJECT]: {z: 0}});
            await settle();
            bus.drain();

            const {announced, changed} = await announcedBy(write);

            expect(changed.length).toBeGreaterThan(0);
            expect(announced).toEqual(expect.arrayContaining(changed));
        });

        it('removing values with set null, merge null and setCollection announces the removed keys', async () => {
            await tab.Onyx.multiSet({[KEYS.PLAIN]: 'p', [KEYS.OBJECT]: {a: 1}, test_1: {id: 1}, test_2: {id: 2}});
            await settle();
            bus.drain();

            const removedPlain = await announcedBy(() => tab.Onyx.set(KEYS.PLAIN, null));
            expect(removedPlain.changed).toEqual([KEYS.PLAIN]);
            expect(removedPlain.announced).toEqual([KEYS.PLAIN]);

            const removedObject = await announcedBy(() => tab.Onyx.merge(KEYS.OBJECT, null));
            expect(removedObject.announced).toEqual(expect.arrayContaining(removedObject.changed));

            const replaced = await announcedBy(() => tab.Onyx.setCollection(KEYS.COLLECTION.TEST, {test_2: {id: 2}}));
            expect(replaced.changed).toEqual(['test_1']);
            expect(replaced.announced).toEqual(expect.arrayContaining(['test_1']));
        });

        it('Onyx.clear announces every removed key and the defaults it restores', async () => {
            await tab.Onyx.multiSet({[KEYS.PLAIN]: 'p', [KEYS.OTHER]: 'changed', test_1: {id: 1}, test_level_1: {id: 1}});
            await settle();
            bus.drain();

            const {announced, changed} = await announcedBy(() => tab.Onyx.clear());

            expect(changed).toEqual([KEYS.OTHER, KEYS.PLAIN, 'test_1', 'test_level_1']);
            expect(announced).toEqual(expect.arrayContaining(changed));
            expect(readShared()).toEqual({[KEYS.OTHER]: 'default'});
        });

        it('a set that leaves storage unchanged raises no event', async () => {
            await tab.Onyx.set(KEYS.PLAIN, 'same');
            await settle();
            bus.drain();

            const {payloads} = await announcedBy(() => tab.Onyx.set(KEYS.PLAIN, 'same'));

            expect(payloads).toEqual([]);
        });

        it('a multi-key write under the size limit reaches other tabs as few events, never one per key', async () => {
            const members = Object.fromEntries(Array.from({length: 50}, (unused, index) => [`test_${index}`, {id: index}]));

            const {payloads, announced} = await announcedBy(() => tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, members));

            expect(announced).toEqual(Object.keys(members).sort());
            expect(payloads.length).toBeLessThanOrEqual(2);
        });

        it('two writes to the same key raise one event each', async () => {
            const {payloads} = await announcedBy(async () => {
                await tab.Onyx.set(KEYS.PLAIN, 'one');
                await tab.Onyx.set(KEYS.PLAIN, 'two');
            });

            expect(announcedKeys(payloads)).toEqual([KEYS.PLAIN, KEYS.PLAIN]);
        });

        it('never announces RAM-only keys or members of RAM-only collections', async () => {
            const {payloads, announced} = await announcedBy(async () => {
                await tab.Onyx.set(KEYS.RAM_ONLY, 'ram');
                await tab.Onyx.merge(KEYS.RAM_ONLY, 'ram2');
                await tab.Onyx.multiSet({ramCollection_1: {id: 1}, [KEYS.PLAIN]: 'p'});
                await tab.Onyx.mergeCollection(KEYS.COLLECTION.RAM_ONLY, {ramCollection_2: {id: 2}});
                await tab.Onyx.set(KEYS.RAM_ONLY, null);
            });

            expect(payloads.length).toBeGreaterThan(0);
            expect(announced).toEqual([KEYS.PLAIN]);
            expect(readShared()).toEqual({[KEYS.PLAIN]: 'p'});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('sizes chunks by unescaped key length, so keys that need escaping can produce a payload over the limit', () => {
            const quoteKey = (index: number) => `test_${index}${'"'.repeat(400_000)}`;
            const keys = [quoteKey(1), quoteKey(2)];
            tab.InstanceSync.multiSet(keys);

            const payloads = bus.drain();
            expect(payloads).toHaveLength(1);
            expect(payloads[0].length).toBeGreaterThan(MAX_PAYLOAD);
            expect(announcedKeys(payloads)).toEqual(keys);
        });
    });
});
