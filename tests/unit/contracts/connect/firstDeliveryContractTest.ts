import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {deliveredValues} from './utils/deliveries';
import {KEYS, initOnyx, loadFreshOnyx, seedStorage, startOnyx} from './utils/freshOnyx';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const REPORT_10 = `${KEYS.COLLECTION.REPORT}10`;
const NESTED_1 = `${KEYS.COLLECTION.REPORT_NESTED}1`;
const REPORT_ACTIONS_1 = `${KEYS.COLLECTION.REPORT_ACTIONS}1`;

describe('Onyx.connect first delivery', () => {
    describe('plain key', () => {
        it('delivers a warm value once with the value and the key', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {name: 'warm', nested: {count: 1}}}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith({name: 'warm', nested: {count: 1}}, KEYS.PLAIN);
        });

        it('connectWithoutView delivers exactly like connect', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'value', [KEYS.COLLECTION.REPORT + 1]: {id: 1}}});
            const plainCallback = jest.fn();
            const collectionCallback = jest.fn();
            const missingCallback = jest.fn();

            Onyx.connectWithoutView({key: KEYS.PLAIN, callback: plainCallback});
            Onyx.connectWithoutView({key: KEYS.COLLECTION.REPORT, callback: collectionCallback});
            Onyx.connectWithoutView({key: KEYS.PLAIN_2, callback: missingCallback});
            await waitForPromisesToResolve();

            expect(plainCallback.mock.calls).toEqual([['value', KEYS.PLAIN]]);
            expect(collectionCallback.mock.calls).toEqual([[{[REPORT_1]: {id: 1}}, KEYS.COLLECTION.REPORT]]);
            expect(missingCallback.mock.calls).toEqual([[undefined, undefined]]);
        });

        it('never fires the callback synchronously inside connect, so the returned connection is usable in the callback', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'value'}});
            const callback = jest.fn();

            const connection = Onyx.connect({key: KEYS.PLAIN, callback});

            expect(callback).not.toHaveBeenCalled();
            expect(connection).toEqual({id: expect.any(String), callbackID: expect.any(String)});

            await waitForPromisesToResolve();
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it('delivers the same reference that the cache holds, without cloning', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[KEYS.PLAIN]: {nested: {count: 1}}}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls[0][0]).toBe(cache.get(KEYS.PLAIN));
        });

        it('reads a cold value from storage when the key is indexed but its value was evicted, and caches it', async () => {
            const {Onyx, cache, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: {stale: true}}});
            cache.drop(KEYS.PLAIN);
            cache.addKey(KEYS.PLAIN);
            await storage.setItem(KEYS.PLAIN, {fromStorage: true});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{fromStorage: true}, KEYS.PLAIN]]);
            expect(cache.get(KEYS.PLAIN)).toEqual({fromStorage: true});
        });

        it('delivers the same cold value to concurrent connections on the same evicted key', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 'cold'}}});
            cache.drop(KEYS.PLAIN);
            cache.addKey(KEYS.PLAIN);
            const shared = jest.fn();
            const separate = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback: shared});
            Onyx.connect({key: KEYS.PLAIN, callback: separate, reuseConnection: false});
            await waitForPromisesToResolve();

            expect(shared.mock.calls).toEqual([[{id: 'cold'}, KEYS.PLAIN]]);
            expect(separate.mock.calls).toEqual([[{id: 'cold'}, KEYS.PLAIN]]);
        });

        it('delivers undefined for both arguments when the key does not exist anywhere', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[KEYS.PLAIN_2]: 'other'}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[undefined, undefined]]);
            expect(cache.hasCacheForKey(KEYS.PLAIN)).toBe(true);
            expect(cache.get(KEYS.PLAIN)).toBeUndefined();
        });

        it('delivers undefined with the key when storage holds null for the key', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: null}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[undefined, KEYS.PLAIN]]);
        });

        it.each([
            ['zero', 0],
            ['empty string', ''],
            ['false', false],
            ['empty object', {}],
            ['empty array', []],
        ])('delivers a falsy or empty stored value (%s) as is', async (_label, value) => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: value}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[value, KEYS.PLAIN]]);
        });

        it('treats a key with an underscore as a plain key when no matching collection is registered', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.WITH_UNDERSCORE]: 'underscored'}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.WITH_UNDERSCORE, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([['underscored', KEYS.WITH_UNDERSCORE]]);
        });

        it('delivers a default from initialKeyStates when storage has nothing', async () => {
            const {Onyx} = await startOnyx({initialKeyStates: {[KEYS.WITH_DEFAULT]: {isDefault: true}}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.WITH_DEFAULT, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{isDefault: true}, KEYS.WITH_DEFAULT]]);
        });

        it('delivers a RAM-only key value that was set in this session', async () => {
            const {Onyx} = await startOnyx();
            await Onyx.set(KEYS.RAM_ONLY, {inMemory: true});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.RAM_ONLY, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{inMemory: true}, KEYS.RAM_ONLY]]);
        });
    });

    describe('collection member key', () => {
        it('delivers only that member with its own key', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_10]: {id: 10}, [REPORT_2]: {id: 2}}});
            const callback = jest.fn();

            Onyx.connect({key: REPORT_1, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{id: 1}, REPORT_1]]);
        });

        it('delivers undefined for both arguments when the member does not exist', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const callback = jest.fn();

            Onyx.connect({key: `${KEYS.COLLECTION.REPORT}999`, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[undefined, undefined]]);
        });

        it('reads an evicted member from storage', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            cache.drop(REPORT_1);
            cache.addKey(REPORT_1);
            const callback = jest.fn();

            Onyx.connect({key: REPORT_1, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{id: 1}, REPORT_1]]);
        });

        it('delivers undefined for a member whose ID is configured as skippable', async () => {
            const {Onyx} = await startOnyx({
                storedValues: {[`${KEYS.COLLECTION.REPORT}skip`]: {id: 'skip'}, [REPORT_1]: {id: 1}},
                skippableCollectionMemberIDs: ['skip'],
            });
            const memberCallback = jest.fn();
            const collectionCallback = jest.fn();

            Onyx.connect({key: `${KEYS.COLLECTION.REPORT}skip`, callback: memberCallback});
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: collectionCallback});
            await waitForPromisesToResolve();

            expect(memberCallback.mock.calls).toEqual([[undefined, undefined]]);
            expect(collectionCallback.mock.calls).toEqual([[{[REPORT_1]: {id: 1}}, KEYS.COLLECTION.REPORT]]);
        });
    });

    describe('collection root key', () => {
        it('delivers the whole collection as one object with the collection key', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [REPORT_10]: {id: 10}}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback});
            await waitForPromisesToResolve();

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [REPORT_10]: {id: 10}}, KEYS.COLLECTION.REPORT);
        });

        it('excludes members of prefix-colliding collections and plain keys', async () => {
            const {Onyx} = await startOnyx({
                storedValues: {[REPORT_1]: {id: 1}, [NESTED_1]: {id: 'nested'}, [REPORT_ACTIONS_1]: {id: 'actions'}, [KEYS.PLAIN]: 'plain'},
            });
            const reportCallback = jest.fn();
            const nestedCallback = jest.fn();
            const actionsCallback = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: reportCallback});
            Onyx.connect({key: KEYS.COLLECTION.REPORT_NESTED, callback: nestedCallback});
            Onyx.connect({key: KEYS.COLLECTION.REPORT_ACTIONS, callback: actionsCallback});
            await waitForPromisesToResolve();

            expect(reportCallback.mock.calls).toEqual([[{[REPORT_1]: {id: 1}}, KEYS.COLLECTION.REPORT]]);
            expect(nestedCallback.mock.calls).toEqual([[{[NESTED_1]: {id: 'nested'}}, KEYS.COLLECTION.REPORT_NESTED]]);
            expect(actionsCallback.mock.calls).toEqual([[{[REPORT_ACTIONS_1]: {id: 'actions'}}, KEYS.COLLECTION.REPORT_ACTIONS]]);
        });

        it('delivers members by reference from the cache and a frozen collection object', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback});
            await waitForPromisesToResolve();

            const collection = callback.mock.calls[0][0];
            expect(collection[REPORT_1]).toBe(cache.get(REPORT_1));
            expect(collection[REPORT_2]).toBe(cache.get(REPORT_2));
            expect(Object.isFrozen(collection)).toBe(true);
        });

        it('includes evicted members after reading them from storage', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
            cache.drop(REPORT_1);
            cache.addKey(REPORT_1);
            const callback = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}, KEYS.COLLECTION.REPORT]]);
        });

        it('delivers a collection whose members are all stored as null as undefined', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: null}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[undefined, KEYS.COLLECTION.REPORT]]);
        });
    });

    describe('connections made before Onyx.init resolves', () => {
        it('wait for init and deliver the hydrated stored value once', async () => {
            const modules = loadFreshOnyx();
            await seedStorage(modules, {[KEYS.PLAIN]: {hydrated: true}, [REPORT_1]: {id: 1}});
            const plainCallback = jest.fn();
            const collectionCallback = jest.fn();
            const memberCallback = jest.fn();
            const missingCallback = jest.fn();

            modules.Onyx.connect({key: KEYS.PLAIN, callback: plainCallback});
            modules.Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: collectionCallback});
            modules.Onyx.connect({key: REPORT_1, callback: memberCallback});
            modules.Onyx.connect({key: KEYS.PLAIN_2, callback: missingCallback});
            await waitForPromisesToResolve();

            expect(plainCallback).not.toHaveBeenCalled();
            expect(collectionCallback).not.toHaveBeenCalled();

            initOnyx(modules);
            await waitForPromisesToResolve();

            expect(plainCallback.mock.calls).toEqual([[{hydrated: true}, KEYS.PLAIN]]);
            expect(collectionCallback.mock.calls).toEqual([[{[REPORT_1]: {id: 1}}, KEYS.COLLECTION.REPORT]]);
            expect(memberCallback.mock.calls).toEqual([[{id: 1}, REPORT_1]]);
            expect(missingCallback.mock.calls).toEqual([[undefined, undefined]]);
        });

        it('deliver an initialKeyStates default exactly once', async () => {
            const modules = loadFreshOnyx();
            const callback = jest.fn();

            modules.Onyx.connect({key: KEYS.WITH_DEFAULT, callback});
            initOnyx(modules, {initialKeyStates: {[KEYS.WITH_DEFAULT]: 'default'}});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([['default', KEYS.WITH_DEFAULT]]);
        });

        it('end on the value written right after init without delivering it out of order', async () => {
            const modules = loadFreshOnyx();
            await seedStorage(modules, {[KEYS.PLAIN]: 'stored'});
            const callback = jest.fn();

            modules.Onyx.connect({key: KEYS.PLAIN, callback});
            initOnyx(modules);
            const write = modules.Onyx.set(KEYS.PLAIN, 'written');
            await write;
            await waitForPromisesToResolve();

            const values = deliveredValues(callback);
            expect(values.at(-1)).toBe('written');
            expect(values.lastIndexOf('stored')).toBeLessThan(values.indexOf('written'));
            expect(values.filter((value) => value === 'written')).toHaveLength(1);
        });

        it('skip the stored value when an Onyx.update issued right after init replaces it', async () => {
            const modules = loadFreshOnyx();
            await seedStorage(modules, {[KEYS.PLAIN]: 'stored'});
            const callback = jest.fn();

            modules.Onyx.connect({key: KEYS.PLAIN, callback});
            initOnyx(modules);
            modules.Onyx.update([{onyxMethod: 'merge', key: KEYS.PLAIN, value: 'updated'}]);
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([['updated', KEYS.PLAIN]]);
        });
    });

    describe('connect while a write is in flight', () => {
        it('never delivers the old value after the new one', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'old'}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback});
            const write = Onyx.set(KEYS.PLAIN, 'new');
            await write;
            await waitForPromisesToResolve();

            const values = deliveredValues(callback);
            expect(values.at(-1)).toBe('new');
            expect(values.filter((value) => value === 'new')).toHaveLength(1);
            expect(values.lastIndexOf('old')).toBeLessThan(values.indexOf('new'));
        });

        it('delivers the final collection when a member is written right after connecting', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback});
            await Onyx.set(REPORT_2, {id: 2});
            await waitForPromisesToResolve();

            expect(callback.mock.calls.at(-1)).toEqual([{[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}, KEYS.COLLECTION.REPORT]);
            for (const [collection] of callback.mock.calls) {
                expect(collection[REPORT_1]).toEqual({id: 1});
            }
        });
    });

    describe('current behaviour (suspected bug)', () => {
        // The init code says the merge keeps user data from storage, yet an overlapping default property wins.
        it('lets an initialKeyStates default overwrite the same property of the stored value', async () => {
            const {Onyx} = await startOnyx({
                storedValues: {[KEYS.WITH_DEFAULT]: {stored: 1}},
                initialKeyStates: {[KEYS.WITH_DEFAULT]: {stored: 0, fromDefault: true}},
            });
            const callback = jest.fn();

            Onyx.connect({key: KEYS.WITH_DEFAULT, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{stored: 0, fromDefault: true}, KEYS.WITH_DEFAULT]]);
        });

        // The callback type promises a non-undefined collection, but an empty collection delivers undefined.
        it('delivers undefined instead of an empty object for a collection with no members', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'unrelated'}});
            const callback = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.EMPTY, callback});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[undefined, KEYS.COLLECTION.EMPTY]]);
        });

        // The update's keyChanged delivers first, then the pending first delivery repeats it with the "missing key" undefined key.
        it('delivers an Onyx.update set issued right after init twice, the second time without the key, when storage has no value', async () => {
            const modules = loadFreshOnyx();
            const callback = jest.fn();

            modules.Onyx.connect({key: KEYS.PLAIN, callback});
            initOnyx(modules);
            modules.Onyx.update([{onyxMethod: 'set', key: KEYS.PLAIN, value: 'updated'}]);
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([
                ['updated', KEYS.PLAIN],
                ['updated', undefined],
            ]);
        });
    });
});
