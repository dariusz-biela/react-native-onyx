import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {KEYS, SKIPPABLE_ID, countStorageReadsOf, holdNextGetItem, keysReadFromStorage, makeCold, startOnyx} from './harness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const SKIPPED_REPORT = `${KEYS.COLLECTION.REPORT}${SKIPPABLE_ID}`;

describe('OnyxUtils.get', () => {
    describe('warm keys', () => {
        it('resolves the cached reference without reading storage', async () => {
            const {OnyxUtils, cache, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: {nested: {count: 1}}}});

            const value = await OnyxUtils.get(KEYS.PLAIN);

            expect(value).toEqual({nested: {count: 1}});
            expect(value).toBe(cache.get(KEYS.PLAIN));
            expect(keysReadFromStorage(storage)).toEqual([]);
        });

        it.each([
            ['zero', 0],
            ['empty string', ''],
            ['false', false],
            ['empty array', []],
            ['empty object', {}],
        ])('resolves a cached falsy value (%s) without reading storage', async (_name, falsyValue) => {
            const {Onyx, OnyxUtils, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});
            await Onyx.set(KEYS.FALSY, falsyValue);
            await storage.setItem(KEYS.FALSY, 'stale storage value');
            storage.getItem.mockClear();

            await expect(OnyxUtils.get(KEYS.FALSY)).resolves.toEqual(falsyValue);
            expect(keysReadFromStorage(storage)).toEqual([]);
        });

        it('resolves the latest written value, never a value captured by an earlier read', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'first'}});

            await expect(OnyxUtils.get(KEYS.PLAIN)).resolves.toBe('first');
            await Onyx.set(KEYS.PLAIN, 'second');
            await expect(OnyxUtils.get(KEYS.PLAIN)).resolves.toBe('second');
            await Onyx.merge(KEYS.PLAIN, 'third');
            await expect(OnyxUtils.get(KEYS.PLAIN)).resolves.toBe('third');
        });

        it('resolves a nullish value once the key was removed, and does not resurrect it from an earlier read', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 1}}});
            await OnyxUtils.get(KEYS.PLAIN);

            await Onyx.set(KEYS.PLAIN, null);

            expect((await OnyxUtils.get(KEYS.PLAIN)) ?? undefined).toBeUndefined();
        });

        it('resolves a collection member like any other key', async () => {
            const {OnyxUtils, cache} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});

            const value = await OnyxUtils.get(REPORT_1);

            expect(value).toEqual({id: 1});
            expect(value).toBe(cache.get(REPORT_1));
        });
    });

    describe('cold keys', () => {
        it('reads storage once, fills the cache, and serves the next read from the cache by the same reference', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 'cold'}}});
            const {OnyxUtils, cache, storage} = modules;
            makeCold(modules, KEYS.PLAIN);

            const first = await OnyxUtils.get(KEYS.PLAIN);

            expect(first).toEqual({id: 'cold'});
            expect(cache.get(KEYS.PLAIN)).toBe(first);
            expect(cache.hasCacheForKey(KEYS.PLAIN)).toBe(true);
            expect(countStorageReadsOf(storage, KEYS.PLAIN)).toBe(1);

            const second = await OnyxUtils.get(KEYS.PLAIN);
            expect(second).toBe(first);
            expect(countStorageReadsOf(storage, KEYS.PLAIN)).toBe(1);
        });

        it('reads a key that only exists in storage, as another instance leaves it, and indexes it', async () => {
            const {OnyxUtils, cache, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});
            await storage.setItem(KEYS.PLAIN_2, {fromOtherInstance: true});

            await expect(OnyxUtils.get(KEYS.PLAIN_2)).resolves.toEqual({fromOtherInstance: true});
            expect(cache.get(KEYS.PLAIN_2)).toEqual({fromOtherInstance: true});
            await expect(OnyxUtils.getAllKeys()).resolves.toContain(KEYS.PLAIN_2);
        });

        it('makes a cold collection member visible in its cached collection', async () => {
            const modules = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
            const {OnyxUtils} = modules;
            makeCold(modules, REPORT_2);
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});

            await OnyxUtils.get(REPORT_2);

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        });

        it('shares one storage read between concurrent reads of the same key, and resolves all of them with the same reference', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 'cold'}}});
            const {OnyxUtils, storage} = modules;
            makeCold(modules, KEYS.PLAIN);

            const results = await Promise.all([OnyxUtils.get(KEYS.PLAIN), OnyxUtils.get(KEYS.PLAIN), OnyxUtils.get(KEYS.PLAIN)]);

            expect(results[0]).toEqual({id: 'cold'});
            expect(results[1]).toBe(results[0]);
            expect(results[2]).toBe(results[0]);
            expect(countStorageReadsOf(storage, KEYS.PLAIN)).toBe(1);
        });

        it('joins a read that is still in flight instead of starting a second one', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: 'cold'}});
            const {OnyxUtils, storage} = modules;
            makeCold(modules, KEYS.PLAIN);
            const release = holdNextGetItem(storage);

            const first = OnyxUtils.get(KEYS.PLAIN);
            await waitForPromisesToResolve();
            const second = OnyxUtils.get(KEYS.PLAIN);
            release();

            await expect(Promise.all([first, second])).resolves.toEqual(['cold', 'cold']);
            expect(countStorageReadsOf(storage, KEYS.PLAIN)).toBe(1);
        });

        it('keeps concurrent reads of different cold keys apart', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: 'one', [KEYS.PLAIN_2]: 'two', [REPORT_1]: {id: 1}}});
            const {OnyxUtils} = modules;
            makeCold(modules, KEYS.PLAIN);
            makeCold(modules, KEYS.PLAIN_2);
            makeCold(modules, REPORT_1);

            await expect(Promise.all([OnyxUtils.get(KEYS.PLAIN_2), OnyxUtils.get(REPORT_1), OnyxUtils.get(KEYS.PLAIN)])).resolves.toEqual(['two', {id: 1}, 'one']);
        });

        it('reads storage again after a finished read when the key went cold again', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: 'first'}});
            const {OnyxUtils, storage} = modules;
            makeCold(modules, KEYS.PLAIN);
            await OnyxUtils.get(KEYS.PLAIN);

            await storage.setItem(KEYS.PLAIN, 'second');
            makeCold(modules, KEYS.PLAIN);

            await expect(OnyxUtils.get(KEYS.PLAIN)).resolves.toBe('second');
        });

        it('prefers a set that lands while the storage read is in flight over the stale stored value', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: {stale: true, dropped: 'field'}}});
            const {Onyx, OnyxUtils, cache, storage} = modules;
            makeCold(modules, KEYS.PLAIN);
            const release = holdNextGetItem(storage);

            const read = OnyxUtils.get(KEYS.PLAIN);
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, {fresh: true});
            release();

            await expect(read).resolves.toEqual({fresh: true});
            expect(cache.get(KEYS.PLAIN)).toEqual({fresh: true});
            await expect(OnyxUtils.get(KEYS.PLAIN)).resolves.toEqual({fresh: true});
        });

        it('applies a merge queued behind an in-flight read on top of the stored value, with no extra storage read', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: {a: 1, b: 1}}});
            const {Onyx, OnyxUtils, cache, storage} = modules;
            makeCold(modules, KEYS.PLAIN);
            const release = holdNextGetItem(storage);

            const read = OnyxUtils.get(KEYS.PLAIN);
            const merge = Onyx.merge(KEYS.PLAIN, {b: 2, c: 3});
            await waitForPromisesToResolve();
            release();
            const readValue = await read;
            await merge;

            expect([
                {a: 1, b: 1},
                {a: 1, b: 2, c: 3},
            ]).toContainEqual(readValue);
            expect(cache.get(KEYS.PLAIN)).toEqual({a: 1, b: 2, c: 3});
            await expect(OnyxUtils.get(KEYS.PLAIN)).resolves.toEqual({a: 1, b: 2, c: 3});
            expect(countStorageReadsOf(storage, KEYS.PLAIN)).toBeLessThanOrEqual(1);
        });

        it('drops the key when a null merge lands while the read is in flight', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 1}}});
            const {Onyx, OnyxUtils, cache, storage} = modules;
            makeCold(modules, KEYS.PLAIN);
            const release = holdNextGetItem(storage);

            const read = OnyxUtils.get(KEYS.PLAIN);
            const merge = Onyx.merge(KEYS.PLAIN, null);
            await waitForPromisesToResolve();
            release();
            await Promise.all([read, merge]);

            expect(cache.get(KEYS.PLAIN)).toBeUndefined();
            expect((await OnyxUtils.get(KEYS.PLAIN)) ?? undefined).toBeUndefined();
            await expect(storage.getItem(KEYS.PLAIN)).resolves.toBeNull();
        });

        it('resolves undefined without rejecting when storage fails, and reads storage again next time', async () => {
            const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: 'stored'}});
            const {OnyxUtils, cache, storage} = modules;
            makeCold(modules, KEYS.PLAIN);
            storage.getItem.mockImplementationOnce(() => Promise.reject(new Error('read failed')));

            await expect(OnyxUtils.get(KEYS.PLAIN)).resolves.toBeUndefined();
            expect(cache.get(KEYS.PLAIN)).toBeUndefined();

            await expect(OnyxUtils.get(KEYS.PLAIN)).resolves.toBe('stored');
            expect(cache.get(KEYS.PLAIN)).toBe('stored');
        });
    });

    describe('missing keys', () => {
        it('resolves a nullish value for a key storage never had', async () => {
            const {OnyxUtils, cache} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});

            const value = await OnyxUtils.get(KEYS.PLAIN_2);

            expect(value ?? undefined).toBeUndefined();
            expect(cache.get(KEYS.PLAIN_2)).toBeUndefined();
        });

        it('resolves undefined without reading storage for a key already known to be empty', async () => {
            const {Onyx, OnyxUtils, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});
            const callback = jest.fn();
            Onyx.connect({key: KEYS.PLAIN_2, callback});
            await waitForPromisesToResolve();
            storage.getItem.mockClear();

            await expect(OnyxUtils.get(KEYS.PLAIN_2)).resolves.toBeUndefined();
            expect(keysReadFromStorage(storage)).toEqual([]);
        });

        it('resolves a nullish value for a key that was deleted and removes it from storage', async () => {
            const {Onyx, OnyxUtils, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});

            await Onyx.merge(KEYS.PLAIN, null);

            expect((await OnyxUtils.get(KEYS.PLAIN)) ?? undefined).toBeUndefined();
            await expect(storage.getItem(KEYS.PLAIN)).resolves.toBeNull();
        });
    });

    describe('RAM-only keys', () => {
        it('never reads storage for a RAM-only key, even when storage holds a stale value', async () => {
            const {OnyxUtils, storage, cache} = await startOnyx({storedValues: {[KEYS.RAM_ONLY]: 'stale persisted'}});

            await expect(OnyxUtils.get(KEYS.RAM_ONLY)).resolves.toBeUndefined();
            await expect(OnyxUtils.get(KEYS.RAM_ONLY)).resolves.toBeUndefined();
            expect(keysReadFromStorage(storage)).toEqual([]);
            expect(cache.get(KEYS.RAM_ONLY)).toBeUndefined();
        });

        it('never reads storage for a member of a RAM-only collection', async () => {
            const {OnyxUtils, storage} = await startOnyx();
            const member = `${KEYS.COLLECTION.RAM_ONLY}1`;
            await storage.setItem(member, {stale: true});

            await expect(OnyxUtils.get(member)).resolves.toBeUndefined();
            expect(keysReadFromStorage(storage)).toEqual([]);
        });

        it('resolves the in-memory value of a RAM-only key once it was written', async () => {
            const {Onyx, OnyxUtils} = await startOnyx();
            await expect(OnyxUtils.get(KEYS.RAM_ONLY)).resolves.toBeUndefined();

            await Onyx.set(KEYS.RAM_ONLY, {inMemory: true});

            await expect(OnyxUtils.get(KEYS.RAM_ONLY)).resolves.toEqual({inMemory: true});
        });
    });

    describe('skippable collection members', () => {
        it('resolves undefined for a skippable member even when storage holds a value', async () => {
            const {OnyxUtils, cache, storage} = await startOnyx();
            await storage.setItem(SKIPPED_REPORT, {id: 'skipped'});

            await expect(OnyxUtils.get(SKIPPED_REPORT)).resolves.toBeUndefined();
            expect(cache.get(SKIPPED_REPORT)).toBeUndefined();
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).not.toHaveProperty(SKIPPED_REPORT, {id: 'skipped'});
        });

        it('still reads a member whose ID only contains the skippable ID', async () => {
            const {OnyxUtils, storage} = await startOnyx();
            const member = `${KEYS.COLLECTION.REPORT}${SKIPPABLE_ID}2`;
            await storage.setItem(member, {id: 'kept'});

            await expect(OnyxUtils.get(member)).resolves.toEqual({id: 'kept'});
        });

        it('still reads a plain key whose name ends with the skippable ID', async () => {
            const {OnyxUtils, storage} = await startOnyx();
            const plainKey = `plain_${SKIPPABLE_ID}`;
            await storage.setItem(plainKey, 'kept');

            await expect(OnyxUtils.get(plainKey)).resolves.toBe('kept');
        });
    });
});

describe('OnyxUtils.tupleGet', () => {
    it('resolves one value per key in the order of the keys, mixing warm, cold and missing keys', async () => {
        const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm', [KEYS.PLAIN_2]: {id: 'cold'}, [REPORT_1]: {id: 1}}});
        const {OnyxUtils} = modules;
        makeCold(modules, KEYS.PLAIN_2);

        const [plain2, missing, plain, report] = await OnyxUtils.tupleGet([KEYS.PLAIN_2, 'missingKey', KEYS.PLAIN, REPORT_1] as const);

        expect(plain2).toEqual({id: 'cold'});
        expect(missing ?? undefined).toBeUndefined();
        expect(plain).toBe('warm');
        expect(report).toEqual({id: 1});
    });

    it('resolves an empty tuple for no keys', async () => {
        const {OnyxUtils} = await startOnyx();

        await expect(OnyxUtils.tupleGet([])).resolves.toEqual([]);
    });

    it('resolves the same reference for a repeated cold key with a single storage read', async () => {
        const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 'cold'}}});
        const {OnyxUtils, storage} = modules;
        makeCold(modules, KEYS.PLAIN);

        const [first, second] = await OnyxUtils.tupleGet([KEYS.PLAIN, KEYS.PLAIN] as const);

        expect(first).toEqual({id: 'cold'});
        expect(second).toBe(first);
        expect(countStorageReadsOf(storage, KEYS.PLAIN)).toBe(1);
    });

    it('returns cached references for warm keys', async () => {
        const {OnyxUtils, cache} = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 1}, [REPORT_1]: {id: 2}}});

        const [plain, report] = await OnyxUtils.tupleGet([KEYS.PLAIN, REPORT_1] as const);

        expect(plain).toBe(cache.get(KEYS.PLAIN));
        expect(report).toBe(cache.get(REPORT_1));
    });
});

describe('current behaviour (suspected bug)', () => {
    it('get() of a key storage never had resolves null, not undefined, and re-reads storage on every call', async () => {
        const {OnyxUtils, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});

        await expect(OnyxUtils.get(KEYS.PLAIN_2)).resolves.toBeNull();
        await expect(OnyxUtils.get(KEYS.PLAIN_2)).resolves.toBeNull();

        // Storage returns null for a missing item, which get() treats as a value instead of caching the miss.
        expect(countStorageReadsOf(storage, KEYS.PLAIN_2)).toBe(2);
    });

    it('get() of a key storage never had adds that key to getAllKeys()', async () => {
        const {OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});

        await OnyxUtils.get(KEYS.PLAIN_2);

        await expect(OnyxUtils.getAllKeys()).resolves.toEqual(new Set([KEYS.PLAIN, KEYS.PLAIN_2]));
    });

    it('tupleGet() resolves null for a collection key instead of the collection its documentation promises, and indexes the collection key itself', async () => {
        const {OnyxUtils} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});

        const [collection] = await OnyxUtils.tupleGet([KEYS.COLLECTION.REPORT] as const);

        expect(collection).toBeNull();
        await expect(OnyxUtils.getAllKeys()).resolves.toContain(KEYS.COLLECTION.REPORT);
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});
    });
});
