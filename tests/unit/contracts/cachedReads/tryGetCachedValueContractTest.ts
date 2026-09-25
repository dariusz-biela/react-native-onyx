import {KEYS, makeCold, startOnyx} from './harness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const NESTED_1 = `${KEYS.COLLECTION.REPORT_NESTED}1`;

describe('OnyxUtils.tryGetCachedValue', () => {
    it('returns a cached plain value by reference without reading storage', async () => {
        const {OnyxUtils, cache, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: {nested: true}}});

        const value = OnyxUtils.tryGetCachedValue(KEYS.PLAIN);

        expect(value).toEqual({nested: true});
        expect(value).toBe(cache.get(KEYS.PLAIN));
        expect(storage.getItem).not.toHaveBeenCalled();
    });

    it.each([0, '', false])('returns the cached falsy value %p', async (falsy) => {
        const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});
        await Onyx.set(KEYS.FALSY, falsy);

        expect(OnyxUtils.tryGetCachedValue(KEYS.FALSY)).toBe(falsy);
    });

    it('returns undefined for a key that is not cached, without reading storage', async () => {
        const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: 'stored', [KEYS.PLAIN_2]: 'other'}});
        makeCold(modules, KEYS.PLAIN);

        expect(modules.OnyxUtils.tryGetCachedValue(KEYS.PLAIN)).toBeUndefined();
        expect(modules.OnyxUtils.tryGetCachedValue('neverWritten')).toBeUndefined();
        expect(modules.storage.getItem).not.toHaveBeenCalled();
        expect(modules.storage.multiGet).not.toHaveBeenCalled();
    });

    it('returns undefined for a removed key', async () => {
        const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'stored', [KEYS.PLAIN_2]: 'other'}});

        await Onyx.set(KEYS.PLAIN, null);

        expect(OnyxUtils.tryGetCachedValue(KEYS.PLAIN)).toBeUndefined();
    });

    it('returns a collection member by reference', async () => {
        const {OnyxUtils, cache} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});

        expect(OnyxUtils.tryGetCachedValue(REPORT_1)).toBe(cache.get(REPORT_1));
        expect(OnyxUtils.tryGetCachedValue(REPORT_2)).toBeUndefined();
    });

    it('returns the same collection object as getCachedCollection, stable across calls', async () => {
        const {OnyxUtils} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [NESTED_1]: {id: 'n'}}});

        const value = OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT);

        expect(value).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        expect(value).toBe(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT));
        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT)).toBe(value);
    });

    it('returns an updated collection after a member write', async () => {
        const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
        const before = OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT);

        await Onyx.merge(REPORT_2, {id: 2});

        const after = OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT);
        expect(after).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        expect(after).not.toBe(before);
    });

    it('returns a stable empty object for a collection without members once any key exists', async () => {
        const {OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'plain'}});

        const empty = OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.EMPTY);

        expect(empty).toEqual({});
        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.EMPTY)).toBe(empty);
    });

    it('returns an empty object once the last member of a collection is removed', async () => {
        const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [KEYS.PLAIN]: 'plain'}});

        await Onyx.set(REPORT_1, null);

        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT)).toEqual({});
    });

    it('returns undefined for a collection while the store has no keys at all', async () => {
        const {OnyxUtils} = await startOnyx();

        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT)).toBeUndefined();
        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.EMPTY)).toBeUndefined();
    });

    it('returns the collection as soon as a member is written into an empty store', async () => {
        const {Onyx, OnyxUtils} = await startOnyx();

        await Onyx.set(REPORT_1, {id: 1});

        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});
        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.EMPTY)).toEqual({});
    });
});

describe('current behaviour (suspected bug)', () => {
    it('returns undefined for a collection again once the last key of a loaded store is removed', async () => {
        const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});

        await Onyx.set(REPORT_1, null);

        // Expected: {}, the store is loaded and the collection is known to be empty.
        expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT)).toBeUndefined();
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({});
    });
});
