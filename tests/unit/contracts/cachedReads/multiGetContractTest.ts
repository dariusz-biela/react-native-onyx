import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {KEYS, SKIPPABLE_ID, countStorageReadsOf, holdNextGetItem, holdNextMultiGet, keysReadFromStorage, makeCold, startOnyx} from './harness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const REPORT_3 = `${KEYS.COLLECTION.REPORT}3`;
const NESTED_1 = `${KEYS.COLLECTION.REPORT_NESTED}1`;
const RAM_MEMBER = `${KEYS.COLLECTION.RAM_ONLY}1`;
const SKIPPED_REPORT = `${KEYS.COLLECTION.REPORT}${SKIPPABLE_ID}`;

describe('OnyxUtils.multiGet', () => {
    it('serves warm keys from the cache by reference without reading storage', async () => {
        const {OnyxUtils, cache, storage} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [KEYS.PLAIN]: 'plain'}});

        const result = await OnyxUtils.multiGet([REPORT_1, REPORT_2, KEYS.PLAIN]);

        expect(Object.fromEntries(result)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [KEYS.PLAIN]: 'plain'});
        expect(result.get(REPORT_1)).toBe(cache.get(REPORT_1));
        expect(result.get(REPORT_2)).toBe(cache.get(REPORT_2));
        expect(keysReadFromStorage(storage)).toEqual([]);
    });

    it('resolves an empty map for no keys without reading storage', async () => {
        const {OnyxUtils, storage} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});

        const result = await OnyxUtils.multiGet([]);

        expect(result.size).toBe(0);
        expect(keysReadFromStorage(storage)).toEqual([]);
    });

    it('reads only the cold keys from storage, returns every value, and fills the cache with them', async () => {
        const modules = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [REPORT_3]: {id: 3}}});
        const {OnyxUtils, cache, storage} = modules;
        makeCold(modules, REPORT_2);
        makeCold(modules, REPORT_3);

        const result = await OnyxUtils.multiGet([REPORT_1, REPORT_2, REPORT_3]);

        expect(Object.fromEntries(result)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [REPORT_3]: {id: 3}});
        expect(cache.get(REPORT_2)).toEqual({id: 2});
        expect(cache.get(REPORT_3)).toEqual({id: 3});
        expect(countStorageReadsOf(storage, REPORT_1)).toBe(0);
        expect(countStorageReadsOf(storage, REPORT_2)).toBeLessThanOrEqual(1);
        expect(countStorageReadsOf(storage, REPORT_3)).toBeLessThanOrEqual(1);
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [REPORT_3]: {id: 3}});
    });

    it('does not read storage a second time for keys a previous multiGet filled', async () => {
        const modules = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
        const {OnyxUtils, storage} = modules;
        makeCold(modules, REPORT_1);
        makeCold(modules, REPORT_2);
        await OnyxUtils.multiGet([REPORT_1, REPORT_2]);
        storage.getItem.mockClear();
        storage.multiGet.mockClear();

        const second = await OnyxUtils.multiGet([REPORT_1, REPORT_2]);
        const third = await OnyxUtils.multiGet([REPORT_1, REPORT_2]);

        expect(keysReadFromStorage(storage)).toEqual([]);
        expect(Object.fromEntries(second)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        expect(third.get(REPORT_1)).toBe(second.get(REPORT_1));
        expect(third.get(REPORT_2)).toBe(second.get(REPORT_2));
        expect(second.get(REPORT_1)).toBe(OnyxUtils.tryGetCachedValue(REPORT_1));
    });

    it('returns a nullish value for keys storage never had and remembers the miss for later reads', async () => {
        const {OnyxUtils, storage} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});

        const result = await OnyxUtils.multiGet([REPORT_1, REPORT_2]);

        expect(result.get(REPORT_1)).toEqual({id: 1});
        expect(result.get(REPORT_2) ?? undefined).toBeUndefined();
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});
        storage.getItem.mockClear();
        storage.multiGet.mockClear();

        expect((await OnyxUtils.multiGet([REPORT_2])).get(REPORT_2) ?? undefined).toBeUndefined();
        await expect(OnyxUtils.get(REPORT_2)).resolves.toBeUndefined();
        expect(keysReadFromStorage(storage)).toEqual([]);
    });

    it('keeps cached falsy values without asking storage', async () => {
        const {Onyx, OnyxUtils, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});
        await Onyx.multiSet({[KEYS.FALSY]: 0, [KEYS.PLAIN_2]: ''});
        await storage.multiSet([
            [KEYS.FALSY, 'stale'],
            [KEYS.PLAIN_2, 'stale'],
        ]);
        storage.multiGet.mockClear();
        storage.getItem.mockClear();

        const result = await OnyxUtils.multiGet([KEYS.FALSY, KEYS.PLAIN_2]);

        expect(result.get(KEYS.FALSY)).toBe(0);
        expect(result.get(KEYS.PLAIN_2)).toBe('');
        expect(keysReadFromStorage(storage)).toEqual([]);
    });

    it('waits for a get() already in flight instead of reading the key again, and returns its value', async () => {
        const modules = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
        const {OnyxUtils, storage} = modules;
        makeCold(modules, REPORT_1);
        makeCold(modules, REPORT_2);
        const release = holdNextGetItem(storage);

        const single = OnyxUtils.get(REPORT_1);
        await waitForPromisesToResolve();
        const multi = OnyxUtils.multiGet([REPORT_1, REPORT_2]);
        await waitForPromisesToResolve();
        release();

        const [singleValue, multiResult] = await Promise.all([single, multi]);
        expect(singleValue).toEqual({id: 1});
        expect(multiResult.get(REPORT_1)).toBe(singleValue);
        expect(multiResult.get(REPORT_2)).toEqual({id: 2});
        expect(countStorageReadsOf(storage, REPORT_1)).toBe(1);
    });

    it('prefers a set that lands while the storage read is in flight, and does not resurrect dropped fields', async () => {
        const modules = await startOnyx({storedValues: {[REPORT_1]: {stale: true, dropped: 'field'}, [REPORT_2]: {id: 2}}});
        const {Onyx, OnyxUtils, cache, storage} = modules;
        makeCold(modules, REPORT_1);
        makeCold(modules, REPORT_2);
        const release = holdNextMultiGet(storage);

        const read = OnyxUtils.multiGet([REPORT_1, REPORT_2]);
        await waitForPromisesToResolve();
        await Onyx.set(REPORT_1, {fresh: true});
        release();
        const result = await read;

        expect(result.get(REPORT_1)).toEqual({fresh: true});
        expect(result.get(REPORT_2)).toEqual({id: 2});
        expect(cache.get(REPORT_1)).toEqual({fresh: true});
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {fresh: true}, [REPORT_2]: {id: 2}});
    });

    it('never reads storage for RAM-only keys and only returns them when they are in memory', async () => {
        const {Onyx, OnyxUtils, storage} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
        await storage.multiSet([
            [KEYS.RAM_ONLY, 'stale persisted'],
            [RAM_MEMBER, {stale: true}],
        ]);
        storage.multiGet.mockClear();

        const beforeWrite = await OnyxUtils.multiGet([KEYS.RAM_ONLY, RAM_MEMBER, REPORT_1]);

        expect(beforeWrite.get(KEYS.RAM_ONLY)).toBeUndefined();
        expect(beforeWrite.get(RAM_MEMBER)).toBeUndefined();
        expect(beforeWrite.get(REPORT_1)).toEqual({id: 1});
        expect(keysReadFromStorage(storage)).toEqual([]);

        await Onyx.set(RAM_MEMBER, {inMemory: true});
        const afterWrite = await OnyxUtils.multiGet([KEYS.RAM_ONLY, RAM_MEMBER]);

        expect(afterWrite.get(RAM_MEMBER)).toEqual({inMemory: true});
        expect(afterWrite.get(KEYS.RAM_ONLY)).toBeUndefined();
        expect(keysReadFromStorage(storage)).toEqual([]);
    });

    it('leaves skippable members out of the result and out of the cache', async () => {
        const {OnyxUtils, cache, storage} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
        await storage.setItem(SKIPPED_REPORT, {id: 'skipped'});

        const result = await OnyxUtils.multiGet([SKIPPED_REPORT, REPORT_1]);

        expect(result.get(SKIPPED_REPORT)).toBeUndefined();
        expect(result.get(REPORT_1)).toEqual({id: 1});
        expect(cache.get(SKIPPED_REPORT)).toBeUndefined();
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});
    });

    it('fills prefix-colliding collections into their own collection only', async () => {
        const modules = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [NESTED_1]: {id: 'nested'}}});
        const {OnyxUtils} = modules;
        makeCold(modules, REPORT_1);
        makeCold(modules, NESTED_1);

        await OnyxUtils.multiGet([REPORT_1, NESTED_1]);

        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT_NESTED)).toEqual({[NESTED_1]: {id: 'nested'}});
    });

    it('delivers cold members to a collection subscriber that connects after they went cold', async () => {
        const modules = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [NESTED_1]: {id: 'nested'}}});
        const {Onyx} = modules;
        makeCold(modules, REPORT_1);
        makeCold(modules, REPORT_2);
        const callback = jest.fn();

        Onyx.connect({key: KEYS.COLLECTION.REPORT, callback});
        await waitForPromisesToResolve();

        expect(callback).toHaveBeenCalled();
        expect(callback.mock.calls.at(-1)).toEqual([{[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}, KEYS.COLLECTION.REPORT]);
    });

    it('reads the members of a store another instance wrote after an empty boot', async () => {
        const {Onyx, storage} = await startOnyx();
        await storage.multiSet([
            [REPORT_1, {id: 1}],
            [NESTED_1, {id: 'nested'}],
            [KEYS.RAM_ONLY, 'stale'],
        ]);
        const reportCallback = jest.fn();
        const nestedCallback = jest.fn();

        Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: reportCallback});
        Onyx.connect({key: KEYS.COLLECTION.REPORT_NESTED, callback: nestedCallback});
        await waitForPromisesToResolve();

        expect(reportCallback.mock.calls.at(-1)).toEqual([{[REPORT_1]: {id: 1}}, KEYS.COLLECTION.REPORT]);
        expect(nestedCallback.mock.calls.at(-1)).toEqual([{[NESTED_1]: {id: 'nested'}}, KEYS.COLLECTION.REPORT_NESTED]);
    });
});

describe('current behaviour (suspected bug)', () => {
    it('multiGet brings back a key that was removed while its storage read was in flight', async () => {
        const modules = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
        const {Onyx, OnyxUtils, storage} = modules;
        makeCold(modules, REPORT_1);
        const release = holdNextMultiGet(storage);

        const read = OnyxUtils.multiGet([REPORT_1]);
        await waitForPromisesToResolve();
        await Onyx.set(REPORT_1, {id: 'fresh'});
        await Onyx.set(REPORT_1, null);
        release();
        await read;

        await expect(storage.getItem(REPORT_1)).resolves.toBeNull();
        // Expected: {report_2} only, since report_1 was removed after the read started.
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        expect(OnyxUtils.tryGetCachedValue(REPORT_1)).toEqual({id: 1});
    });

    it('get brings back a key that was removed while its storage read was in flight', async () => {
        const modules = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
        const {Onyx, OnyxUtils, storage} = modules;
        makeCold(modules, REPORT_1);
        const release = holdNextGetItem(storage);

        const read = OnyxUtils.get(REPORT_1);
        await waitForPromisesToResolve();
        await Onyx.set(REPORT_1, {id: 'fresh'});
        await Onyx.set(REPORT_1, null);
        release();

        // Expected: nullish, since report_1 was removed after the read started.
        await expect(read).resolves.toEqual({id: 1});
        await expect(storage.getItem(REPORT_1)).resolves.toBeNull();
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
    });

    it('multiGet marks a storage-missing key as known-empty while get of the same key does not', async () => {
        const {OnyxUtils, storage} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});

        await OnyxUtils.multiGet([REPORT_2]);
        await OnyxUtils.get(REPORT_3);
        storage.getItem.mockClear();
        storage.multiGet.mockClear();
        await OnyxUtils.get(REPORT_2);
        await OnyxUtils.get(REPORT_3);

        expect(keysReadFromStorage(storage)).toEqual([REPORT_3]);
    });
});
