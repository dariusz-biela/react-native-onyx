import type OnyxDefault from '../../../../lib';
import type OnyxKeysDefault from '../../../../lib/OnyxKeys';
import type StorageMock from '../../../../lib/storage/__mocks__';
import type {OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {COLLECTIONS, DEFAULT_RAM_ONLY_KEYS, PLAIN_KEYS} from './freshOnyxKeys';

type StoreModules = {
    Onyx: typeof OnyxDefault;
    OnyxKeys: typeof OnyxKeysDefault;
    storage: typeof StorageMock;
};

type CollectionRecorder = {
    values: Array<Record<string, unknown>>;
    last: () => Record<string, unknown> | undefined;
    reset: () => void;
};

/** Loads Onyx from a fresh module registry, seeds storage and waits for init, so the key maps start empty in every test. */
async function startOnyx(storedValues: Record<OnyxKey, unknown> = {}): Promise<StoreModules> {
    jest.resetModules();
    const modules: StoreModules = {
        Onyx: require('../../../../lib').default,
        OnyxKeys: require('../../../../lib/OnyxKeys').default,
        storage: require('../../../../lib/storage').default,
    };
    const pairs = Object.entries(storedValues);
    if (pairs.length > 0) {
        await modules.storage.multiSet(pairs);
    }
    modules.Onyx.init({keys: {...PLAIN_KEYS, COLLECTION: COLLECTIONS}, ramOnlyKeys: DEFAULT_RAM_ONLY_KEYS});
    await waitForPromisesToResolve();
    return modules;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordCollection(Onyx: typeof OnyxDefault, collectionKey: OnyxKey): CollectionRecorder {
    const values: Array<Record<string, unknown>> = [];
    Onyx.connect({
        key: collectionKey,
        callback: (value: unknown) => {
            values.push(isRecord(value) ? {...value} : {});
        },
    });
    return {
        values,
        last: () => values.at(-1),
        reset: () => {
            values.length = 0;
        },
    };
}

const COLLIDING_STORE = {
    report_1: {id: 'report'},
    report_reportActions_1: {id: 'report with a lookalike id'},
    reportActions_1: {id: 'actions'},
    reportActionsDrafts_1: {id: 'drafts'},
    test_1: {id: 'test'},
    test_levelX_1: {id: 'test with a lookalike id'},
    test_level_1: {id: 'level'},
    test_level_last_1: {id: 'last'},
    [PLAIN_KEYS.NVP_PRIORITY_MODE]: 'gsd',
};

const EXPECTED_COLLECTIONS: Record<OnyxKey, Record<string, unknown>> = {
    [COLLECTIONS.REPORT]: {report_1: {id: 'report'}, report_reportActions_1: {id: 'report with a lookalike id'}},
    [COLLECTIONS.REPORT_ACTIONS]: {reportActions_1: {id: 'actions'}},
    [COLLECTIONS.REPORT_ACTIONS_DRAFTS]: {reportActionsDrafts_1: {id: 'drafts'}},
    [COLLECTIONS.TEST]: {test_1: {id: 'test'}, test_levelX_1: {id: 'test with a lookalike id'}},
    [COLLECTIONS.TEST_LEVEL]: {test_level_1: {id: 'level'}},
    [COLLECTIONS.TEST_LEVEL_LAST]: {test_level_last_1: {id: 'last'}},
};

describe('OnyxKeys through the Onyx store', () => {
    describe('collection membership', () => {
        it('delivers every hydrated member to exactly its most specific collection', async () => {
            const {Onyx} = await startOnyx(COLLIDING_STORE);
            const recorders = Object.keys(EXPECTED_COLLECTIONS).map((collectionKey) => [collectionKey, recordCollection(Onyx, collectionKey)] as const);
            await waitForPromisesToResolve();

            for (const [collectionKey, recorder] of recorders) {
                expect(recorder.last()).toEqual(EXPECTED_COLLECTIONS[collectionKey]);
            }
        });

        it('delivers every member written after init to exactly its most specific collection', async () => {
            const {Onyx} = await startOnyx();
            await Onyx.multiSet(COLLIDING_STORE);
            const recorders = Object.keys(EXPECTED_COLLECTIONS).map((collectionKey) => [collectionKey, recordCollection(Onyx, collectionKey)] as const);
            await waitForPromisesToResolve();

            for (const [collectionKey, recorder] of recorders) {
                expect(recorder.last()).toEqual(EXPECTED_COLLECTIONS[collectionKey]);
            }
        });

        it('keeps a hydrated collection and members added to it later in one collection', async () => {
            const {Onyx} = await startOnyx({report_1: {id: 1}, reportActions_1: {id: 1}});
            await Onyx.set('report_2', {id: 2});
            await Onyx.set('reportActions_2', {id: 2});
            const reports = recordCollection(Onyx, COLLECTIONS.REPORT);
            const actions = recordCollection(Onyx, COLLECTIONS.REPORT_ACTIONS);
            await waitForPromisesToResolve();

            expect(reports.last()).toEqual({report_1: {id: 1}, report_2: {id: 2}});
            expect(actions.last()).toEqual({reportActions_1: {id: 1}, reportActions_2: {id: 2}});
        });

        it('drops a removed member from its collection and brings it back when it is written again', async () => {
            const {Onyx} = await startOnyx({test_level_1: {id: 1}, test_level_2: {id: 2}, test_1: {id: 1}});
            const level = recordCollection(Onyx, COLLECTIONS.TEST_LEVEL);
            const parent = recordCollection(Onyx, COLLECTIONS.TEST);
            await waitForPromisesToResolve();

            await Onyx.set('test_level_1', null);
            expect(level.last()).toEqual({test_level_2: {id: 2}});

            await Onyx.set('test_level_1', {id: 'again'});
            expect(level.last()).toEqual({test_level_1: {id: 'again'}, test_level_2: {id: 2}});
            expect(parent.last()).toEqual({test_1: {id: 1}});
        });

        it('rebuilds the membership from scratch after a clear', async () => {
            const {Onyx} = await startOnyx(COLLIDING_STORE);
            await Onyx.clear();
            await Onyx.multiSet({report_9: {id: 9}, reportActions_9: {id: 9}, test_level_9: {id: 9}});
            const recorders = Object.keys(EXPECTED_COLLECTIONS).map((collectionKey) => [collectionKey, recordCollection(Onyx, collectionKey)] as const);
            await waitForPromisesToResolve();

            const delivered = Object.fromEntries(recorders.map(([collectionKey, recorder]) => [collectionKey, recorder.last()]));
            expect(delivered).toEqual({
                [COLLECTIONS.REPORT]: {report_9: {id: 9}},
                [COLLECTIONS.REPORT_ACTIONS]: {reportActions_9: {id: 9}},
                [COLLECTIONS.REPORT_ACTIONS_DRAFTS]: {},
                [COLLECTIONS.TEST]: {},
                [COLLECTIONS.TEST_LEVEL]: {test_level_9: {id: 9}},
                [COLLECTIONS.TEST_LEVEL_LAST]: {},
            });
        });

        it('removes deleted members from the member index', async () => {
            const {Onyx, OnyxKeys} = await startOnyx({reportActions_1: {id: 1}, reportActions_2: {id: 2}, report_1: {id: 1}});

            await Onyx.set('reportActions_1', null);
            await Onyx.merge('report_1', null);

            expect([...(OnyxKeys.getMembersOfCollection(COLLECTIONS.REPORT_ACTIONS) ?? [])]).toEqual(['reportActions_2']);
            expect(OnyxKeys.getMembersOfCollection(COLLECTIONS.REPORT)?.size ?? 0).toBe(0);

            await Onyx.clear();

            expect(OnyxKeys.getMembersOfCollection(COLLECTIONS.REPORT_ACTIONS)?.size ?? 0).toBe(0);
        });

        it('indexes hydrated storage keys under their most specific collection', async () => {
            const {OnyxKeys} = await startOnyx(COLLIDING_STORE);

            const index = Object.fromEntries(Object.keys(EXPECTED_COLLECTIONS).map((collectionKey) => [collectionKey, [...(OnyxKeys.getMembersOfCollection(collectionKey) ?? [])].sort()]));
            expect(index).toEqual(Object.fromEntries(Object.entries(EXPECTED_COLLECTIONS).map(([collectionKey, members]) => [collectionKey, Object.keys(members).sort()])));
        });
    });

    describe('notification routing between colliding collections', () => {
        type Write = [string, (Onyx: typeof OnyxDefault) => Promise<void>, OnyxKey];
        const writes: Write[] = [
            ['set of a nested member', (Onyx) => Onyx.set('test_level_2', {id: 2}), COLLECTIONS.TEST_LEVEL],
            ['merge of a nested member', (Onyx) => Onyx.merge('test_level_1', {extra: true}), COLLECTIONS.TEST_LEVEL],
            ['mergeCollection of a nested collection', (Onyx) => Onyx.mergeCollection(COLLECTIONS.TEST_LEVEL, {test_level_3: {id: 3}}), COLLECTIONS.TEST_LEVEL],
            ['set of a deeply nested member', (Onyx) => Onyx.set('test_level_last_2', {id: 2}), COLLECTIONS.TEST_LEVEL_LAST],
            ['merge of a lookalike prefix member', (Onyx) => Onyx.merge('reportActions_1', {extra: true}), COLLECTIONS.REPORT_ACTIONS],
            ['set of a longer lookalike prefix member', (Onyx) => Onyx.set('reportActionsDrafts_2', {id: 2}), COLLECTIONS.REPORT_ACTIONS_DRAFTS],
            ['set of a member whose id looks like another collection', (Onyx) => Onyx.set('report_reportActions_2', {id: 2}), COLLECTIONS.REPORT],
            ['set of a parent member with a lookalike id', (Onyx) => Onyx.set('test_levelX_2', {id: 2}), COLLECTIONS.TEST],
            ['set of a plain key with an underscore', (Onyx) => Onyx.set(PLAIN_KEYS.NVP_PRIORITY_MODE, 'focus'), ''],
        ];

        it.each(writes)('notifies only the owning collection on a %s', async (_name, write, owner) => {
            const {Onyx} = await startOnyx(COLLIDING_STORE);
            const recorders = Object.keys(EXPECTED_COLLECTIONS).map((collectionKey) => [collectionKey, recordCollection(Onyx, collectionKey)] as const);
            await waitForPromisesToResolve();
            for (const [, recorder] of recorders) {
                recorder.reset();
            }

            await write(Onyx);
            await waitForPromisesToResolve();

            for (const [collectionKey, recorder] of recorders) {
                if (collectionKey === owner) {
                    expect(recorder.values.length).toBeGreaterThanOrEqual(1);
                    expect(Object.keys(recorder.last() ?? {}).every((key) => key.startsWith(owner))).toBe(true);
                } else {
                    expect(recorder.values).toEqual([]);
                }
            }
        });

        it('delivers a plain key with an underscore to its own subscriber', async () => {
            const {Onyx} = await startOnyx(COLLIDING_STORE);
            const values: unknown[] = [];
            Onyx.connect({key: PLAIN_KEYS.NVP_PRIORITY_MODE, callback: (value: unknown) => values.push(value)});
            await waitForPromisesToResolve();

            await Onyx.set(PLAIN_KEYS.NVP_PRIORITY_MODE, 'focus');

            expect(values).toEqual(['gsd', 'focus']);
        });
    });

    describe('RAM-only keys', () => {
        it('persists members of a nested collection that is not RAM-only while the RAM-only parent stays in memory', async () => {
            const {Onyx, storage} = await startOnyx();

            await Onyx.set('ramCollection_1', {id: 1});
            await Onyx.set('ramCollection_nested_1', {id: 'nested'});
            await Onyx.merge('ramCollection_2', {id: 2});
            await Onyx.merge('ramCollection_nested_2', {id: 'nested 2'});
            await Onyx.mergeCollection(COLLECTIONS.RAM_COLLECTION, {ramCollection_3: {id: 3}});
            await Onyx.mergeCollection(COLLECTIONS.RAM_COLLECTION_NESTED, {ramCollection_nested_3: {id: 'nested 3'}});
            await Onyx.set(PLAIN_KEYS.RAM_ONLY, 'memory');
            await Onyx.set('ramOnly_1', 'persisted');

            expect(storage.getMockStore()).toEqual({
                ramCollection_nested_1: {id: 'nested'},
                ramCollection_nested_2: {id: 'nested 2'},
                ramCollection_nested_3: {id: 'nested 3'},
                ramOnly_1: 'persisted',
            });
        });

        it('delivers the RAM-only members from memory', async () => {
            const {Onyx} = await startOnyx();
            const ram = recordCollection(Onyx, COLLECTIONS.RAM_COLLECTION);
            const nested = recordCollection(Onyx, COLLECTIONS.RAM_COLLECTION_NESTED);
            await waitForPromisesToResolve();

            await Onyx.multiSet({ramCollection_1: {id: 1}, ramCollection_nested_1: {id: 'nested'}});

            expect(ram.last()).toEqual({ramCollection_1: {id: 1}});
            expect(nested.last()).toEqual({ramCollection_nested_1: {id: 'nested'}});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('delivers a value stored under a nested collection key as a member of the parent collection', async () => {
            const {Onyx, OnyxKeys} = await startOnyx({[COLLECTIONS.TEST_LEVEL]: {stored: 'at the collection key'}, test_1: {id: 1}, test_level_1: {id: 1}});
            const parent = recordCollection(Onyx, COLLECTIONS.TEST);
            const level = recordCollection(Onyx, COLLECTIONS.TEST_LEVEL);
            await waitForPromisesToResolve();

            expect(parent.last()).toEqual({test_1: {id: 1}, [COLLECTIONS.TEST_LEVEL]: {stored: 'at the collection key'}});
            expect(level.last()).toEqual({test_level_1: {id: 1}});
            expect(OnyxKeys.getCollectionKey(COLLECTIONS.TEST_LEVEL)).toBe(COLLECTIONS.TEST);
        });
    });
});
