import {KEYS, loadFreshOnyx, makeCold, startOnyx} from './harness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const NESTED_1 = `${KEYS.COLLECTION.REPORT_NESTED}1`;

// getState is the store read useOnyx and connect use; on main this was OnyxUtils.tryGetCachedValue.
describe('onyxSubscriptionManager.getState', () => {
    it('returns a cached plain value by reference without reading storage', async () => {
        const {cache, storage, subscriptions} = await startOnyx({storedValues: {[KEYS.PLAIN]: {nested: true}}});

        const value = subscriptions.getState(KEYS.PLAIN);

        expect(value).toEqual({nested: true});
        expect(value).toBe(cache.get(KEYS.PLAIN));
        expect(storage.getItem).not.toHaveBeenCalled();
    });

    it.each([0, '', false])('returns the cached falsy value %p', async (falsy) => {
        const {Onyx, subscriptions} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});
        await Onyx.set(KEYS.FALSY, falsy);

        expect(subscriptions.getState(KEYS.FALSY)).toBe(falsy);
    });

    it('returns undefined for a key that is not cached, without reading storage', async () => {
        const modules = await startOnyx({storedValues: {[KEYS.PLAIN]: 'stored', [KEYS.PLAIN_2]: 'other'}});
        makeCold(modules, KEYS.PLAIN);

        expect(modules.subscriptions.getState(KEYS.PLAIN)).toBeUndefined();
        expect(modules.subscriptions.getState('neverWritten')).toBeUndefined();
        expect(modules.storage.getItem).not.toHaveBeenCalled();
        expect(modules.storage.multiGet).not.toHaveBeenCalled();
    });

    it('returns undefined for a removed key', async () => {
        const {Onyx, subscriptions} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'stored', [KEYS.PLAIN_2]: 'other'}});

        await Onyx.set(KEYS.PLAIN, null);

        expect(subscriptions.getState(KEYS.PLAIN)).toBeUndefined();
    });

    it('returns a collection member by reference', async () => {
        const {cache, subscriptions} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});

        expect(subscriptions.getState(REPORT_1)).toBe(cache.get(REPORT_1));
        expect(subscriptions.getState(REPORT_2)).toBeUndefined();
    });

    it('returns the same collection object as getCachedCollection, stable across calls', async () => {
        const {OnyxUtils, subscriptions} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [NESTED_1]: {id: 'n'}}});

        const value = subscriptions.getState(KEYS.COLLECTION.REPORT);

        expect(value).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        expect(value).toBe(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT));
        expect(subscriptions.getState(KEYS.COLLECTION.REPORT)).toBe(value);
    });

    it('returns an updated collection after a member write', async () => {
        const {Onyx, subscriptions} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
        const before = subscriptions.getState(KEYS.COLLECTION.REPORT);

        await Onyx.merge(REPORT_2, {id: 2});

        const after = subscriptions.getState(KEYS.COLLECTION.REPORT);
        expect(after).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
        expect(after).not.toBe(before);
    });

    it('returns a stable empty object for a collection without members once any key exists', async () => {
        const {subscriptions} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'plain'}});

        const empty = subscriptions.getState(KEYS.COLLECTION.EMPTY);

        expect(empty).toEqual({});
        expect(subscriptions.getState(KEYS.COLLECTION.EMPTY)).toBe(empty);
    });

    it('returns an empty object once the last member of a collection is removed', async () => {
        const {Onyx, subscriptions} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [KEYS.PLAIN]: 'plain'}});

        await Onyx.set(REPORT_1, null);

        expect(subscriptions.getState(KEYS.COLLECTION.REPORT)).toEqual({});
    });

    it('returns an empty object for a collection once the last key of a loaded store is removed', async () => {
        const {Onyx, OnyxUtils, subscriptions} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
        expect(subscriptions.getState(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});

        await Onyx.set(REPORT_1, null);

        expect(subscriptions.getState(KEYS.COLLECTION.REPORT)).toEqual({});
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({});
    });

    it('returns undefined for a collection before init seeds it', () => {
        const {subscriptions} = loadFreshOnyx();

        expect(subscriptions.getState(KEYS.COLLECTION.REPORT)).toBeUndefined();
    });

    it('returns the collection as soon as a member is written into an empty store', async () => {
        const {Onyx, subscriptions} = await startOnyx();

        await Onyx.set(REPORT_1, {id: 1});

        expect(subscriptions.getState(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});
        expect(subscriptions.getState(KEYS.COLLECTION.EMPTY)).toEqual({});
    });
});

describe('current behaviour (#834 change)', () => {
    it('returns an empty object for a collection while the store has no keys at all', async () => {
        const {subscriptions} = await startOnyx();

        // main returned undefined here until the first key of any kind existed.
        expect(subscriptions.getState(KEYS.COLLECTION.REPORT)).toEqual({});
        expect(subscriptions.getState(KEYS.COLLECTION.EMPTY)).toEqual({});
    });
});
