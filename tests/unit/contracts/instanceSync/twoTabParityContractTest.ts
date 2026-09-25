import type {OnyxKey} from '../../../../lib/types';
import type GenericCollection from '../../../utils/GenericCollection';
import type {Rng} from '../merge/helpers/model';
import {createRng, pick} from '../merge/helpers/model';
import type {SyncBus, Tab} from './syncHarness';
import {KEYS, announcedKeys, createSyncBus, deliver, openTab, readCache, readShared, record, resetSharedStorage, settle, toUpdate} from './syncHarness';

type Operation = {describe: string; run: (tab: Tab) => Promise<unknown>};

const PLAIN_KEYS = [KEYS.PLAIN, KEYS.OTHER, KEYS.OBJECT, KEYS.NVP];
const MEMBER_KEYS = ['test_1', 'test_2', 'test_3', 'test_level_1', 'test_level_2'];
const WATCHED_KEYS: OnyxKey[] = [...PLAIN_KEYS, ...MEMBER_KEYS, KEYS.COLLECTION.TEST, KEYS.COLLECTION.TEST_LEVEL];

let bus: SyncBus;

beforeEach(() => {
    resetSharedStorage();
    bus = createSyncBus();
});

afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
});

function randomValue(random: Rng): unknown {
    const roll = random();
    if (roll < 0.1) {
        return null;
    }
    if (roll < 0.3) {
        return Math.floor(random() * 3);
    }
    if (roll < 0.45) {
        return pick(random, ['a', 'b', '']);
    }
    return {id: Math.floor(random() * 4), flag: random() < 0.5, nested: random() < 0.5 ? {n: Math.floor(random() * 3)} : null};
}

function membersOf(random: Rng, collectionKey: string): GenericCollection {
    const members: GenericCollection = {};
    for (const key of MEMBER_KEYS) {
        if (key.startsWith(collectionKey) && !(collectionKey === KEYS.COLLECTION.TEST && key.startsWith(KEYS.COLLECTION.TEST_LEVEL)) && random() < 0.6) {
            members[key] = randomValue(random);
        }
    }
    return members;
}

function randomOperation(random: Rng): Operation {
    const collectionKey = pick(random, [KEYS.COLLECTION.TEST, KEYS.COLLECTION.TEST_LEVEL]);
    const kind = pick(random, ['set', 'merge', 'multiSet', 'mergeCollection', 'setCollection', 'update', 'clear']);
    switch (kind) {
        case 'set': {
            const key = pick(random, [...PLAIN_KEYS, ...MEMBER_KEYS]);
            const value = randomValue(random);
            return {describe: `set ${key} ${JSON.stringify(value)}`, run: (tab) => tab.Onyx.set(key, value)};
        }
        case 'merge': {
            const key = pick(random, [...PLAIN_KEYS, ...MEMBER_KEYS]);
            const value = randomValue(random);
            return {describe: `merge ${key} ${JSON.stringify(value)}`, run: (tab) => tab.Onyx.merge(key, value)};
        }
        case 'multiSet': {
            const data = Object.fromEntries([pick(random, PLAIN_KEYS), pick(random, MEMBER_KEYS)].map((key) => [key, randomValue(random)]));
            return {describe: `multiSet ${JSON.stringify(data)}`, run: (tab) => tab.Onyx.multiSet(data)};
        }
        case 'mergeCollection': {
            const members = membersOf(random, collectionKey);
            return {describe: `mergeCollection ${JSON.stringify(members)}`, run: (tab) => tab.Onyx.mergeCollection(collectionKey, members)};
        }
        case 'setCollection': {
            // setCollection on test_ also drops test_level_ members without telling the writer's subscribers, pinned below.
            const members = membersOf(random, KEYS.COLLECTION.TEST_LEVEL);
            return {describe: `setCollection ${JSON.stringify(members)}`, run: (tab) => tab.Onyx.setCollection(KEYS.COLLECTION.TEST_LEVEL, members)};
        }
        case 'update': {
            const key = pick(random, PLAIN_KEYS);
            const value = randomValue(random);
            // Onyx.update does not notify the writer when a mergecollection removes a member, pinned below.
            const members = Object.fromEntries(Object.entries(membersOf(random, collectionKey)).filter(([, member]) => member !== null));
            return {
                describe: `update ${key} ${JSON.stringify(value)} ${JSON.stringify(members)}`,
                run: (tab) =>
                    tab.Onyx.update([
                        {onyxMethod: 'merge', key, value},
                        {onyxMethod: 'mergecollection', key: collectionKey, value: members},
                    ]),
            };
        }
        default:
            return {describe: 'clear', run: (tab) => tab.Onyx.clear()};
    }
}

function withoutRamOnly(snapshot: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== KEYS.RAM_ONLY && !key.startsWith(KEYS.COLLECTION.RAM_ONLY)));
}

/** The last value each subscriber received, with an empty collection read as no value. */
function lastValues(recorders: Map<OnyxKey, ReturnType<typeof record>>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, recorder] of recorders) {
        const last = recorder.values.at(-1) ?? undefined;
        result[key] = typeof last === 'object' && last !== null && Object.keys(last).length === 0 ? undefined : last;
    }
    return result;
}

/** What a subscriber of each watched key should have seen last, read from the tab's own cache. */
function valuesInCache(tab: Tab): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of WATCHED_KEYS) {
        if (key === KEYS.COLLECTION.TEST || key === KEYS.COLLECTION.TEST_LEVEL) {
            const collection = tab.OnyxUtils.getCachedCollection(key);
            result[key] = Object.keys(collection).length > 0 ? collection : undefined;
            continue;
        }
        result[key] = tab.cache.get(key) ?? undefined;
    }
    return result;
}

function recordAll(tab: Tab): Map<OnyxKey, ReturnType<typeof record>> {
    return new Map(WATCHED_KEYS.map((key) => [key, record(tab, key)]));
}

/** Runs the writes on `from`, then hands everything it announced to `to` in one delivery. */
async function writeAndSync(from: Tab, to: Tab, operations: Operation[]): Promise<{announced: OnyxKey[]}> {
    for (const operation of operations) {
        await operation.run(from);
    }
    await settle();
    const payloads = bus.drain();
    await deliver(to, payloads);
    return {announced: announcedKeys(payloads)};
}

async function expectTabsInSync(first: Tab, second: Tab, context: string): Promise<void> {
    await settle();
    const stored = readShared();
    const secondCache = withoutRamOnly(readCache(second, WATCHED_KEYS));
    expect({context, cache: secondCache}).toEqual({context, cache: withoutRamOnly(readCache(first, WATCHED_KEYS))});
    expect({context, cache: secondCache}).toEqual({context, cache: stored});
}

describe('two tabs on one storage', () => {
    it.each<[string, Operation[]]>([
        ['set', [{describe: 'set', run: (tab) => tab.Onyx.set(KEYS.OBJECT, {a: 1, b: {c: 2}})}]],
        [
            'merge into an existing object',
            [
                {describe: 'set', run: (tab) => tab.Onyx.set(KEYS.OBJECT, {a: 1, b: {c: 2}})},
                {describe: 'merge', run: (tab) => tab.Onyx.merge(KEYS.OBJECT, {b: {d: 3}, a: null})},
            ],
        ],
        ['multiSet', [{describe: 'multiSet', run: (tab) => tab.Onyx.multiSet({[KEYS.PLAIN]: 'p', test_1: {id: 1}, test_level_1: {id: 2}})}]],
        ['mergeCollection', [{describe: 'mergeCollection', run: (tab) => tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}, test_2: {id: 2}})}]],
        [
            'setCollection that drops members',
            [
                {describe: 'mergeCollection', run: (tab) => tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}, test_2: {id: 2}})},
                {describe: 'setCollection', run: (tab) => tab.Onyx.setCollection(KEYS.COLLECTION.TEST, {test_3: {id: 3}})},
            ],
        ],
        [
            'update mixing every method',
            [
                {
                    describe: 'update',
                    run: (tab) =>
                        tab.Onyx.update([
                            {onyxMethod: 'set', key: KEYS.PLAIN, value: 'u'},
                            {onyxMethod: 'merge', key: KEYS.OBJECT, value: {u: 1}},
                            {onyxMethod: 'multiset', key: '', value: {[KEYS.NVP]: 'n', test_level_1: {id: 1}}},
                            {onyxMethod: 'mergecollection', key: KEYS.COLLECTION.TEST, value: {test_1: {id: 1}}},
                            {onyxMethod: 'setcollection', key: KEYS.COLLECTION.TEST_LEVEL, value: {test_level_1: {id: 1}, test_level_2: {id: 2}}},
                        ]),
                },
            ],
        ],
        [
            'removals',
            [
                {describe: 'multiSet', run: (tab) => tab.Onyx.multiSet({[KEYS.PLAIN]: 'p', [KEYS.OBJECT]: {a: 1}, test_1: {id: 1}})},
                {describe: 'set null', run: (tab) => tab.Onyx.set(KEYS.PLAIN, null)},
                {describe: 'merge null', run: (tab) => tab.Onyx.merge(KEYS.OBJECT, null)},
                {describe: 'member null', run: (tab) => tab.Onyx.set('test_1', null)},
            ],
        ],
        [
            'clear',
            [
                {describe: 'multiSet', run: (tab) => tab.Onyx.multiSet({[KEYS.PLAIN]: 'p', test_1: {id: 1}, test_level_1: {id: 2}})},
                {describe: 'clear', run: (tab) => tab.Onyx.clear()},
            ],
        ],
    ])('the other tab matches the writer after %s', async (name, operations) => {
        const writer = await openTab();
        const reader = await openTab();
        const writerSeen = recordAll(writer);
        const readerSeen = recordAll(reader);
        await settle();

        const before = readShared();
        const {announced} = await writeAndSync(writer, reader, operations);
        const after = readShared();

        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
        expect(announced).toEqual(expect.arrayContaining(changed));
        await expectTabsInSync(writer, reader, name);
        expect(lastValues(readerSeen)).toEqual(lastValues(writerSeen));
    });

    it('keeps both tabs in sync when they take turns writing', async () => {
        const first = await openTab();
        const second = await openTab();
        const firstSeen = recordAll(first);
        const secondSeen = recordAll(second);
        await settle();

        await writeAndSync(first, second, [{describe: 'merge', run: (tab) => tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1, by: 'first'}})}]);
        await writeAndSync(second, first, [{describe: 'merge', run: (tab) => tab.Onyx.merge('test_1', {by: 'second'})}]);
        await writeAndSync(first, second, [{describe: 'set', run: (tab) => tab.Onyx.set(KEYS.PLAIN, 'first')}]);
        await writeAndSync(second, first, [{describe: 'setCollection', run: (tab) => tab.Onyx.setCollection(KEYS.COLLECTION.TEST, {test_2: {id: 2}})}]);

        await expectTabsInSync(first, second, 'turns');
        expect(readShared()).toEqual({[KEYS.PLAIN]: 'first', test_2: {id: 2}});
        expect(lastValues(secondSeen)).toEqual(lastValues(firstSeen));
    });

    it('never forwards RAM-only values to the other tab', async () => {
        const writer = await openTab({ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.COLLECTION.RAM_ONLY]});
        const reader = await openTab({ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.COLLECTION.RAM_ONLY]});

        await writeAndSync(writer, reader, [
            {describe: 'ram', run: (tab) => tab.Onyx.set(KEYS.RAM_ONLY, 'ram')},
            {describe: 'ram member', run: (tab) => tab.Onyx.mergeCollection(KEYS.COLLECTION.RAM_ONLY, {ramCollection_1: {id: 1}})},
        ]);

        expect(reader.cache.get(KEYS.RAM_ONLY)).toBeUndefined();
        expect(reader.cache.get('ramCollection_1')).toBeUndefined();
        expect(writer.cache.get(KEYS.RAM_ONLY)).toBe('ram');
    });

    it('fans one write out to every other tab', async () => {
        const writer = await openTab();
        const readers = [await openTab(), await openTab()];

        await writer.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}});
        await settle();
        const payloads = bus.drain();
        for (const reader of readers) {
            await deliver(reader, payloads);
        }

        for (const reader of readers) {
            await expectTabsInSync(writer, reader, 'fan out');
        }
    });

    it.each([11, 29, 42, 1337, 2024, 7, 99, 314])('stays in sync through a seeded random sequence of writes (seed %i)', async (seed) => {
        const random = createRng(seed);
        const tabs = [await openTab(), await openTab()];
        const seen = tabs.map(recordAll);
        await settle();
        const history: string[] = [];

        for (let round = 0; round < 12; round++) {
            const writerIndex = random() < 0.5 ? 0 : 1;
            const operations = Array.from({length: 1 + Math.floor(random() * 3)}, () => randomOperation(random));
            history.push(`tab ${writerIndex}: ${operations.map((operation) => operation.describe).join(' | ')}`);

            const before = readShared();
            const {announced} = await writeAndSync(tabs[writerIndex], tabs[1 - writerIndex], operations);
            const after = readShared();
            const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));

            expect({history, missing: changed.filter((key) => !announced.includes(key))}).toEqual({history, missing: []});
            await expectTabsInSync(tabs[0], tabs[1], history.join('\n'));
            const receiver = 1 - writerIndex;
            expect({history, values: lastValues(seen[receiver])}).toEqual({history, values: valuesInCache(tabs[receiver])});
        }
    });

    describe('current behaviour (suspected bug)', () => {
        it('setCollection on a prefix collection leaves the writer tab subscribers stale while the other tab is told', async () => {
            const writer = await openTab();
            const reader = await openTab();
            await writeAndSync(writer, reader, [{describe: 'multiSet', run: (tab) => tab.Onyx.multiSet({test_3: {id: 3}, test_level_1: {id: 1}})}]);
            const writerMember = record(writer, 'test_level_1');
            const readerMember = record(reader, 'test_level_1');
            await settle();

            await writeAndSync(writer, reader, [{describe: 'setCollection', run: (tab) => tab.Onyx.setCollection(KEYS.COLLECTION.TEST, {test_1: 'b'})}]);

            expect(readShared()).toEqual({test_1: 'b'});
            expect(writer.cache.get('test_level_1')).toBeUndefined();
            expect(reader.cache.get('test_level_1') ?? undefined).toBeUndefined();
            expect(writerMember.values.at(-1)).toEqual({id: 1});
            expect(readerMember.values.at(-1)).toBeUndefined();
        });

        it('Onyx.update removing a member of a prefix-colliding collection leaves the writer tab subscribers stale while the other tab is told', async () => {
            const writer = await openTab();
            const reader = await openTab();
            await writeAndSync(writer, reader, [{describe: 'mergeCollection', run: (tab) => tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST_LEVEL, {test_level_2: {id: 2}})}]);
            const writerMember = record(writer, 'test_level_2');
            const readerMember = record(reader, 'test_level_2');
            await settle();

            await writeAndSync(writer, reader, [
                {
                    describe: 'update',
                    run: (tab) => tab.Onyx.update([toUpdate({onyxMethod: 'mergecollection', key: KEYS.COLLECTION.TEST_LEVEL, value: {test_level_1: {id: 1}, test_level_2: null}})]),
                },
            ]);

            expect(readShared()).toEqual({test_level_1: {id: 1}});
            expect(writer.cache.get('test_level_2')).toBeUndefined();
            expect(writerMember.values.at(-1)).toEqual({id: 2});
            expect(readerMember.values.at(-1)).toBeUndefined();
        });
    });
});
