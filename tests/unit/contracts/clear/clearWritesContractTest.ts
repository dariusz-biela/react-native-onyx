import {DEFAULT_MEMBER_KEY, KEYS, createRecorder, flush, loadOnyx, readStorage, seedAccount} from './clearHarness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const REPORT_3 = `${KEYS.COLLECTION.REPORT}3`;

const DEFAULT_SESSION = {loading: false, nested: {depth: 1}};

describe('Onyx.clear with interleaved writes', () => {
    describe('writes issued before clear in the same tick', () => {
        it('are wiped for set, multiSet, setCollection and a merge onto a cached key', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            Onyx.set(KEYS.PLAIN, 'set before clear');
            Onyx.merge(KEYS.PLAIN_EXTENDED, 'merged before clear');
            Onyx.multiSet({[KEYS.UNDERSCORE_KEY]: 'multiSet before clear'});
            Onyx.setCollection(KEYS.COLLECTION.REPORT_ACTIONS, {[`${KEYS.COLLECTION.REPORT_ACTIONS}9`]: {actionID: 'a9'}});
            await Onyx.clear();
            await flush();

            for (const key of [KEYS.PLAIN, KEYS.PLAIN_EXTENDED, KEYS.UNDERSCORE_KEY, `${KEYS.COLLECTION.REPORT_ACTIONS}1`, `${KEYS.COLLECTION.REPORT_ACTIONS}9`]) {
                expect(cache.get(key)).toBeUndefined();
                expect(readStorage(StorageMock)).not.toHaveProperty(key);
            }
        });

        it('are replaced by the initial state for a key that has one', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();

            Onyx.set(KEYS.SESSION, {authToken: 'fresh'});
            Onyx.merge(KEYS.PREFERRED_LOCALE, 'de');
            await Onyx.clear();
            await flush();

            expect(cache.get(KEYS.SESSION)).toEqual(DEFAULT_SESSION);
            expect(cache.get(KEYS.PREFERRED_LOCALE)).toBe('en');
            expect(readStorage(StorageMock)[KEYS.SESSION]).toEqual(DEFAULT_SESSION);
            expect(readStorage(StorageMock)[KEYS.PREFERRED_LOCALE]).toBe('en');
        });

        it('are kept for a preserved key', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();

            Onyx.set(KEYS.PLAIN, 'kept');
            await Onyx.clear([KEYS.PLAIN]);
            await flush();

            expect(cache.get(KEYS.PLAIN)).toBe('kept');
            expect(readStorage(StorageMock)[KEYS.PLAIN]).toBe('kept');
        });

        it('leave subscribers with the cleared value as their last delivery', async () => {
            const {Onyx} = await loadOnyx();
            const plain = createRecorder();
            const reports = createRecorder();
            Onyx.connect({key: KEYS.PLAIN, callback: plain.callback});
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: reports.callback});
            await flush();

            Onyx.set(KEYS.PLAIN, 'short lived');
            Onyx.set(REPORT_1, {reportID: 'short lived'});
            await Onyx.clear();
            await flush();

            expect(plain.last()).toBeUndefined();
            expect(reports.last() ?? {}).toEqual({});
        });
    });

    describe('writes issued after clear resolved', () => {
        it('persist in cache and storage', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear();
            await Onyx.set(KEYS.PLAIN, 'next session');
            await Onyx.merge(KEYS.SESSION, {authToken: 'next token'});
            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {reportID: 'next'}});

            expect(cache.get(KEYS.PLAIN)).toBe('next session');
            expect(cache.get(KEYS.SESSION)).toEqual({...DEFAULT_SESSION, authToken: 'next token'});
            expect(cache.get(REPORT_1)).toEqual({reportID: 'next'});
            const storage = readStorage(StorageMock);
            expect(storage[KEYS.PLAIN]).toBe('next session');
            expect(storage[KEYS.SESSION]).toEqual({...DEFAULT_SESSION, authToken: 'next token'});
            expect(storage[REPORT_1]).toEqual({reportID: 'next'});
        });

        it('persist when chained on the clear promise', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear().then(() => Onyx.set(KEYS.PLAIN, 'chained'));

            expect(cache.get(KEYS.PLAIN)).toBe('chained');
            expect(readStorage(StorageMock)[KEYS.PLAIN]).toBe('chained');
        });

        it('are removed again by the next clear', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await Onyx.clear();
            await Onyx.set(KEYS.PLAIN, 'second session');
            await Onyx.set(REPORT_2, {reportID: 'second session'});

            await Onyx.clear();

            expect(cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(cache.get(REPORT_2)).toBeUndefined();
            expect(readStorage(StorageMock)).not.toHaveProperty(KEYS.PLAIN);
            expect(readStorage(StorageMock)).not.toHaveProperty(REPORT_2);
        });
    });

    describe('writes issued from inside a clear notification', () => {
        it('persist in cache and storage and reach collection subscribers', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);
            let wrote = false;
            const writer = createRecorder((value) => {
                if (value !== undefined || wrote) {
                    return;
                }
                wrote = true;
                Onyx.set(KEYS.PLAIN_EXTENDED, 'written during clear');
                Onyx.set(REPORT_3, {reportID: 'written during clear'});
            });
            Onyx.connect({key: KEYS.PLAIN, callback: writer.callback});
            const reports = createRecorder();
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: reports.callback});
            await flush();

            await Onyx.clear();
            await flush();

            expect(wrote).toBe(true);
            expect(cache.get(KEYS.PLAIN_EXTENDED)).toBe('written during clear');
            expect(cache.get(REPORT_3)).toEqual({reportID: 'written during clear'});
            expect(readStorage(StorageMock)[KEYS.PLAIN_EXTENDED]).toBe('written during clear');
            expect(readStorage(StorageMock)[REPORT_3]).toEqual({reportID: 'written during clear'});
            expect(reports.last()).toEqual({[REPORT_3]: {reportID: 'written during clear'}});
            for (const snapshot of reports.values().slice(1)) {
                expect(snapshot).not.toHaveProperty(REPORT_1);
            }
        });
    });

    describe('concurrent clears', () => {
        it('apply the union of their effects when their preserve lists differ', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Promise.all([Onyx.clear([KEYS.PLAIN]), Onyx.clear([REPORT_1])]);

            expect(cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(cache.get(REPORT_1)).toBeUndefined();
            expect(readStorage(StorageMock)).not.toHaveProperty(KEYS.PLAIN);
            expect(readStorage(StorageMock)).not.toHaveProperty(REPORT_1);
        });

        it('resolve in the order they were called', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const order: string[] = [];

            await Promise.all([Onyx.clear().then(() => order.push('first')), Onyx.clear().then(() => order.push('second'))]);

            expect(order).toEqual(['first', 'second']);
        });
    });

    describe('Onyx.update with a clear-like payload', () => {
        it('writes after clear resolve against the initial states', async () => {
            const {Onyx, cache} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear();
            await Onyx.update([
                {onyxMethod: 'merge', key: KEYS.SESSION, value: {authToken: 'via update'}},
                {onyxMethod: 'merge', key: DEFAULT_MEMBER_KEY, value: {extra: true}},
            ]);

            expect(cache.get(KEYS.SESSION)).toEqual({...DEFAULT_SESSION, authToken: 'via update'});
            expect(cache.get(DEFAULT_MEMBER_KEY)).toEqual({name: 'default member', extra: true});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('lets merges issued before clear in the same tick on keys absent from the cache survive the clear', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            Onyx.merge(KEYS.PLAIN_EXTENDED, 'merged onto a cached key');
            Onyx.merge('uncachedKey', {first: 1});
            Onyx.merge('uncachedKey', {second: 2});
            Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {title: 'merged'}, [REPORT_3]: {reportID: '3'}});
            Onyx.update([{onyxMethod: 'merge', key: 'updatedKey', value: {updated: true}}]);
            await Onyx.clear();
            await flush();

            expect(cache.get(KEYS.PLAIN_EXTENDED)).toBeUndefined();
            const storage = readStorage(StorageMock);
            // Merges that resolve after the clear pass land on the cleared store.
            expect(cache.get('uncachedKey')).toEqual({first: 1, second: 2});
            expect(storage.uncachedKey).toEqual({first: 1, second: 2});
            expect(cache.get(REPORT_1)).toEqual({title: 'merged'});
            expect(cache.get(REPORT_3)).toEqual({reportID: '3'});
            expect(storage[REPORT_3]).toEqual({reportID: '3'});
            expect(cache.get('updatedKey')).toEqual({updated: true});
            expect(storage.updatedKey).toEqual({updated: true});
        });

        it('delivers the stale cleared value after a write made from an earlier clear notification', async () => {
            const {Onyx, cache} = await loadOnyx();
            await seedAccount(Onyx);
            let wrote = false;
            const writer = createRecorder((value) => {
                if (value !== undefined || wrote) {
                    return;
                }
                wrote = true;
                Onyx.set(KEYS.PLAIN_EXTENDED, 'written during clear');
            });
            Onyx.connect({key: KEYS.PLAIN, callback: writer.callback});
            const extended = createRecorder();
            Onyx.connect({key: KEYS.PLAIN_EXTENDED, callback: extended.callback});
            await flush();
            extended.reset();

            await Onyx.clear();
            await flush();

            expect(cache.get(KEYS.PLAIN_EXTENDED)).toBe('written during clear');
            expect(extended.values()).toEqual(['written during clear', undefined]);
        });

        it('wipes a set issued synchronously right after clear() was called', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            const clearing = Onyx.clear();
            Onyx.set(KEYS.PLAIN, 'written after clear was called');
            await clearing;
            await flush();

            expect(cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(readStorage(StorageMock)).not.toHaveProperty(KEYS.PLAIN);
        });
    });
});
