import {DEFAULT_MEMBER_KEY, KEYS, createAccount, flush, loadOnyx, readStorage, seedAccount} from './clearHarness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const REPORT_ACTION_1 = `${KEYS.COLLECTION.REPORT_ACTIONS}1`;
const TEST_1 = `${KEYS.COLLECTION.TEST}1`;
const TEST_LEVEL_1 = `${KEYS.COLLECTION.TEST_LEVEL}1`;
const RAM_MEMBER_1 = `${KEYS.COLLECTION.RAM_ONLY_COLLECTION}1`;
const DEFAULTED_2 = `${KEYS.COLLECTION.DEFAULTED}2`;

const DEFAULT_SESSION = {loading: false, nested: {depth: 1}};
const DEFAULT_MEMBER = {name: 'default member'};

/** Keys with an initial state that are persisted, and the value clear() must leave in storage for them. */
const PERSISTED_DEFAULTS = {
    [KEYS.SESSION]: DEFAULT_SESSION,
    [KEYS.IS_OFFLINE]: false,
    [KEYS.PREFERRED_LOCALE]: 'en',
    [DEFAULT_MEMBER_KEY]: DEFAULT_MEMBER,
};

describe('Onyx.clear store state contract', () => {
    describe('without keys to preserve', () => {
        it('resets keys with an initial state to it and removes every other key from the cache', async () => {
            const {Onyx, cache} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear();

            expect(cache.get(KEYS.SESSION)).toEqual(DEFAULT_SESSION);
            expect(cache.get(KEYS.IS_OFFLINE)).toBe(false);
            expect(cache.get(KEYS.PREFERRED_LOCALE)).toBe('en');
            expect(cache.get(KEYS.RAM_ONLY_DEFAULT)).toBe('ramDefault');
            expect(cache.get(DEFAULT_MEMBER_KEY)).toEqual(DEFAULT_MEMBER);
            for (const key of [KEYS.PLAIN, KEYS.PLAIN_EXTENDED, KEYS.UNDERSCORE_KEY, KEYS.RAM_ONLY, REPORT_1, REPORT_2, REPORT_ACTION_1, TEST_1, TEST_LEVEL_1, RAM_MEMBER_1, DEFAULTED_2]) {
                expect(cache.get(key)).toBeUndefined();
                expect(cache.hasCacheForKey(key)).toBe(false);
            }
        });

        it('leaves exactly the persisted initial states in storage', async () => {
            const {Onyx, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear();

            expect(readStorage(StorageMock)).toEqual(PERSISTED_DEFAULTS);
        });

        it('leaves only keys with an initial state in the key index', async () => {
            const {Onyx, OnyxUtils} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear();

            const keys = await OnyxUtils.getAllKeys();
            expect([...keys].sort()).toEqual([KEYS.SESSION, KEYS.IS_OFFLINE, KEYS.PREFERRED_LOCALE, KEYS.RAM_ONLY_DEFAULT, DEFAULT_MEMBER_KEY].sort());
        });

        it('restores an initial state whose key was removed with null before clear', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await Onyx.set(KEYS.SESSION, null);
            await Onyx.set(DEFAULT_MEMBER_KEY, null);
            expect(cache.get(KEYS.SESSION)).toBeUndefined();

            await Onyx.clear();

            expect(cache.get(KEYS.SESSION)).toEqual(DEFAULT_SESSION);
            expect(cache.get(DEFAULT_MEMBER_KEY)).toEqual(DEFAULT_MEMBER);
            expect(readStorage(StorageMock)[KEYS.SESSION]).toEqual(DEFAULT_SESSION);
            expect(readStorage(StorageMock)[DEFAULT_MEMBER_KEY]).toEqual(DEFAULT_MEMBER);
        });

        it('removes keys a previous session left in storage even though nothing read them', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx({
                storageSeed: {
                    [KEYS.PLAIN]: 'from last session',
                    [REPORT_1]: {reportID: 'old'},
                    [KEYS.SESSION]: {authToken: 'old token'},
                },
            });

            await Onyx.clear();

            expect(cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(cache.get(REPORT_1)).toBeUndefined();
            expect(cache.get(KEYS.SESSION)).toEqual(DEFAULT_SESSION);
            expect(readStorage(StorageMock)).toEqual(PERSISTED_DEFAULTS);
        });

        it('never persists RAM-only keys, even the ones reset to an initial state', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear();

            const storage = readStorage(StorageMock);
            expect(storage).not.toHaveProperty(KEYS.RAM_ONLY);
            expect(storage).not.toHaveProperty(KEYS.RAM_ONLY_DEFAULT);
            expect(storage).not.toHaveProperty(RAM_MEMBER_1);
            expect(cache.get(KEYS.RAM_ONLY)).toBeUndefined();
            expect(cache.get(RAM_MEMBER_1)).toBeUndefined();
            expect(cache.get(KEYS.RAM_ONLY_DEFAULT)).toBe('ramDefault');
        });

        it('empties collection snapshots, keeping only members that have an initial state', async () => {
            const {Onyx, OnyxUtils} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear();

            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.TEST)).toEqual({});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.TEST_LEVEL)).toEqual({});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.RAM_ONLY_COLLECTION)).toEqual({});
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.DEFAULTED)).toEqual({[DEFAULT_MEMBER_KEY]: DEFAULT_MEMBER});
            expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.REPORT)).toEqual({});
            expect(OnyxUtils.tryGetCachedValue(KEYS.COLLECTION.DEFAULTED)).toEqual({[DEFAULT_MEMBER_KEY]: DEFAULT_MEMBER});
        });

        it('shares one empty snapshot between all emptied collections', async () => {
            const {Onyx, OnyxUtils} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear();

            const emptyReports = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toBe(emptyReports);
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.TEST)).toBe(emptyReports);
        });

        it('resolves with undefined', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);

            await expect(Onyx.clear()).resolves.toBeUndefined();
        });

        it('clears an untouched store without errors, leaving the initial states', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();

            await Onyx.clear();

            expect(cache.get(KEYS.SESSION)).toEqual(DEFAULT_SESSION);
            expect(cache.get(KEYS.RAM_ONLY_DEFAULT)).toBe('ramDefault');
            const storage = readStorage(StorageMock);
            for (const [key, value] of Object.entries(storage)) {
                expect(PERSISTED_DEFAULTS).toHaveProperty([key], value);
            }
        });

        it('is idempotent when called again on a cleared store', async () => {
            const {Onyx, cache, StorageMock, OnyxUtils} = await loadOnyx();
            await seedAccount(Onyx);
            await Onyx.clear();
            const sessionAfterFirstClear = cache.get(KEYS.SESSION);
            const keysAfterFirstClear = [...(await OnyxUtils.getAllKeys())].sort();

            await Onyx.clear();

            expect(cache.get(KEYS.SESSION)).toBe(sessionAfterFirstClear);
            expect([...(await OnyxUtils.getAllKeys())].sort()).toEqual(keysAfterFirstClear);
            expect(readStorage(StorageMock)).toEqual(PERSISTED_DEFAULTS);
        });

        it('lets two clears started in the same tick both resolve to the same cleared state', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Promise.all([Onyx.clear(), Onyx.clear()]);

            expect(cache.get(KEYS.PLAIN)).toBeUndefined();
            expect(cache.get(REPORT_1)).toBeUndefined();
            expect(cache.get(KEYS.SESSION)).toEqual(DEFAULT_SESSION);
            expect(readStorage(StorageMock)).toEqual(PERSISTED_DEFAULTS);
        });

        it('never lets later writes change the initial states it restores', async () => {
            const {Onyx, cache, initialKeyStates} = await loadOnyx();
            await Onyx.clear();

            await Onyx.merge(KEYS.SESSION, {loading: true, nested: {depth: 5, extra: true}});
            await Onyx.merge(DEFAULT_MEMBER_KEY, {name: 'renamed'});
            await Onyx.clear();

            expect(cache.get(KEYS.SESSION)).toEqual(DEFAULT_SESSION);
            expect(cache.get(DEFAULT_MEMBER_KEY)).toEqual(DEFAULT_MEMBER);
            expect(initialKeyStates[KEYS.SESSION]).toEqual(DEFAULT_SESSION);
            expect(initialKeyStates[DEFAULT_MEMBER_KEY]).toEqual(DEFAULT_MEMBER);
        });

        it('forgets keys it had read as missing from storage', async () => {
            const {Onyx, cache} = await loadOnyx();
            Onyx.connect({key: 'neverWritten', callback: jest.fn()});
            await flush();
            expect(cache.hasCacheForKey('neverWritten')).toBe(true);

            await Onyx.clear();

            expect(cache.hasCacheForKey('neverWritten')).toBe(false);
        });

        it('removes keys that reached storage without Onyx while its key index was empty', async () => {
            const {Onyx, StorageMock} = await loadOnyx({initOptions: {initialKeyStates: {}}});
            await StorageMock.setItem(KEYS.PLAIN, 'written by another tab');

            await Onyx.clear();

            expect(readStorage(StorageMock)).toEqual({});
        });

        it('removes everything when Onyx has no initial states', async () => {
            const {Onyx, cache, OnyxUtils, StorageMock} = await loadOnyx({initOptions: {initialKeyStates: {}}});
            await seedAccount(Onyx);

            await Onyx.clear();

            expect(readStorage(StorageMock)).toEqual({});
            expect((await OnyxUtils.getAllKeys()).size).toBe(0);
            expect(cache.get(KEYS.SESSION)).toBeUndefined();
            expect(cache.get(REPORT_1)).toBeUndefined();
        });
    });

    describe('with keys to preserve', () => {
        it('keeps a preserved plain key with the same reference in cache and its value in storage', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            const account = await seedAccount(Onyx);
            const plainBefore = cache.get(KEYS.PLAIN);

            await Onyx.clear([KEYS.PLAIN]);

            expect(cache.get(KEYS.PLAIN)).toBe(plainBefore);
            expect(readStorage(StorageMock)).toEqual({...PERSISTED_DEFAULTS, [KEYS.PLAIN]: account[KEYS.PLAIN]});
        });

        it('keeps a preserved key with an initial state at its current value instead of resetting it', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            const account = await seedAccount(Onyx);

            await Onyx.clear([KEYS.SESSION, KEYS.PREFERRED_LOCALE]);

            expect(cache.get(KEYS.SESSION)).toEqual(account[KEYS.SESSION]);
            expect(cache.get(KEYS.PREFERRED_LOCALE)).toBe('fr');
            expect(readStorage(StorageMock)).toEqual({
                ...PERSISTED_DEFAULTS,
                [KEYS.SESSION]: account[KEYS.SESSION],
                [KEYS.PREFERRED_LOCALE]: 'fr',
            });
        });

        it('keeps a removed preserved key with an initial state removed', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await Onyx.set(KEYS.PREFERRED_LOCALE, 'fr');
            await Onyx.set(KEYS.PREFERRED_LOCALE, null);

            await Onyx.clear([KEYS.PREFERRED_LOCALE]);

            expect(cache.get(KEYS.PREFERRED_LOCALE)).toBeUndefined();
            expect(readStorage(StorageMock)).not.toHaveProperty(KEYS.PREFERRED_LOCALE);
        });

        it('keeps every member of a preserved collection, with the same snapshot reference', async () => {
            const {Onyx, cache, OnyxUtils, StorageMock} = await loadOnyx();
            const account = await seedAccount(Onyx);
            const reportsBefore = OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT);

            await Onyx.clear([KEYS.COLLECTION.REPORT]);

            expect(cache.get(REPORT_1)).toEqual(account[REPORT_1]);
            expect(cache.get(REPORT_2)).toEqual(account[REPORT_2]);
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toBe(reportsBefore);
            expect(readStorage(StorageMock)).toEqual({...PERSISTED_DEFAULTS, [REPORT_1]: account[REPORT_1], [REPORT_2]: account[REPORT_2]});
        });

        it('does not preserve a collection whose name only starts with the preserved collection name', async () => {
            const {Onyx, cache} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear([KEYS.COLLECTION.REPORT]);

            expect(cache.get(REPORT_ACTION_1)).toBeUndefined();
        });

        it('does not preserve a plain key whose name only starts with the preserved key', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear([KEYS.PLAIN]);

            expect(cache.get(KEYS.PLAIN_EXTENDED)).toBeUndefined();
            expect(readStorage(StorageMock)).not.toHaveProperty(KEYS.PLAIN_EXTENDED);
        });

        it('preserves the members of a nested collection when its parent collection prefix is preserved', async () => {
            const {Onyx, cache} = await loadOnyx();
            const account = await seedAccount(Onyx);

            await Onyx.clear([KEYS.COLLECTION.TEST]);

            expect(cache.get(TEST_1)).toEqual(account[TEST_1]);
            expect(cache.get(TEST_LEVEL_1)).toEqual(account[TEST_LEVEL_1]);
        });

        it('does not preserve the parent collection when only the nested collection is preserved', async () => {
            const {Onyx, cache} = await loadOnyx();
            const account = await seedAccount(Onyx);

            await Onyx.clear([KEYS.COLLECTION.TEST_LEVEL]);

            expect(cache.get(TEST_1)).toBeUndefined();
            expect(cache.get(TEST_LEVEL_1)).toEqual(account[TEST_LEVEL_1]);
        });

        it('keeps only the preserved member of a collection', async () => {
            const {Onyx, cache, OnyxUtils, StorageMock} = await loadOnyx();
            const account = await seedAccount(Onyx);

            await Onyx.clear([REPORT_2]);

            expect(cache.get(REPORT_1)).toBeUndefined();
            expect(cache.get(REPORT_2)).toEqual(account[REPORT_2]);
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_2]: account[REPORT_2]});
            expect(readStorage(StorageMock)).toEqual({...PERSISTED_DEFAULTS, [REPORT_2]: account[REPORT_2]});
        });

        it('keeps the members with an initial state of a preserved collection at their current values in cache and storage', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            const account = await seedAccount(Onyx);

            await Onyx.clear([KEYS.COLLECTION.DEFAULTED]);

            expect(cache.get(DEFAULT_MEMBER_KEY)).toEqual(account[DEFAULT_MEMBER_KEY]);
            expect(cache.get(DEFAULTED_2)).toEqual(account[DEFAULTED_2]);
            expect(readStorage(StorageMock)).toEqual({
                ...PERSISTED_DEFAULTS,
                [DEFAULT_MEMBER_KEY]: account[DEFAULT_MEMBER_KEY],
                [DEFAULTED_2]: account[DEFAULTED_2],
            });
        });

        it('keeps a preserved member with an initial state at its current value while its siblings are cleared', async () => {
            const {Onyx, cache, OnyxUtils} = await loadOnyx();
            const account = await seedAccount(Onyx);

            await Onyx.clear([DEFAULT_MEMBER_KEY]);

            expect(cache.get(DEFAULT_MEMBER_KEY)).toEqual(account[DEFAULT_MEMBER_KEY]);
            expect(cache.get(DEFAULTED_2)).toBeUndefined();
            expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.DEFAULTED)).toEqual({[DEFAULT_MEMBER_KEY]: account[DEFAULT_MEMBER_KEY]});
        });

        it('keeps preserved RAM-only keys in cache without persisting them', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear([KEYS.RAM_ONLY, KEYS.RAM_ONLY_DEFAULT, KEYS.COLLECTION.RAM_ONLY_COLLECTION]);

            expect(cache.get(KEYS.RAM_ONLY)).toBe('ram value');
            expect(cache.get(KEYS.RAM_ONLY_DEFAULT)).toBe('ram changed');
            expect(cache.get(RAM_MEMBER_1)).toEqual({id: 'ram member'});
            expect(readStorage(StorageMock)).toEqual(PERSISTED_DEFAULTS);
        });

        it('ignores preserved keys that hold no value', async () => {
            const {Onyx, cache, OnyxUtils, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);

            await Onyx.clear(['unknownKey', `${KEYS.COLLECTION.REPORT}999`]);

            expect(cache.get('unknownKey')).toBeUndefined();
            expect((await OnyxUtils.getAllKeys()).has('unknownKey')).toBe(false);
            expect(readStorage(StorageMock)).toEqual(PERSISTED_DEFAULTS);
        });

        it('applies a sign-out style preserve list to every key kind at once', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            const account = createAccount();
            await seedAccount(Onyx);

            await Onyx.clear([KEYS.PREFERRED_LOCALE, KEYS.IS_OFFLINE, KEYS.COLLECTION.REPORT_ACTIONS, KEYS.UNDERSCORE_KEY, KEYS.RAM_ONLY]);
            await flush();

            expect(readStorage(StorageMock)).toEqual({
                [KEYS.SESSION]: DEFAULT_SESSION,
                [DEFAULT_MEMBER_KEY]: DEFAULT_MEMBER,
                [KEYS.PREFERRED_LOCALE]: 'fr',
                [KEYS.IS_OFFLINE]: true,
                [REPORT_ACTION_1]: account[REPORT_ACTION_1],
                [KEYS.UNDERSCORE_KEY]: 'high',
            });
            expect(cache.get(KEYS.RAM_ONLY)).toBe('ram value');
            expect(cache.get(KEYS.RAM_ONLY_DEFAULT)).toBe('ramDefault');
            expect(cache.get(REPORT_1)).toBeUndefined();
            expect(cache.get(KEYS.PLAIN)).toBeUndefined();
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('leaves stale storage entries of RAM-only keys in place', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx({
                storageSeed: {[KEYS.RAM_ONLY]: 'stale from before the key became RAM-only', [RAM_MEMBER_1]: {id: 'stale member'}},
            });

            await Onyx.clear();

            expect(cache.get(KEYS.RAM_ONLY)).toBeUndefined();
            expect(readStorage(StorageMock)).toEqual({
                ...PERSISTED_DEFAULTS,
                [KEYS.RAM_ONLY]: 'stale from before the key became RAM-only',
                [RAM_MEMBER_1]: {id: 'stale member'},
            });
        });
    });
});
