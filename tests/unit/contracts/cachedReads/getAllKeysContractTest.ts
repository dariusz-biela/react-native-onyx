import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {KEYS, startOnyx} from './harness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const NESTED_1 = `${KEYS.COLLECTION.REPORT_NESTED}1`;
const ACTIONS_1 = `${KEYS.COLLECTION.REPORT_ACTIONS}1`;
const RAM_MEMBER = `${KEYS.COLLECTION.RAM_ONLY}1`;

describe('OnyxUtils.getAllKeys', () => {
    it('resolves every stored key after init without reading storage again', async () => {
        const {OnyxUtils, storage} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [NESTED_1]: {id: 'n'}, [ACTIONS_1]: {id: 'a'}, [KEYS.PLAIN]: 'plain'}});

        const keys = await OnyxUtils.getAllKeys();

        expect(new Set(keys)).toEqual(new Set([REPORT_1, NESTED_1, ACTIONS_1, KEYS.PLAIN]));
        expect(storage.getAllKeys).not.toHaveBeenCalled();
    });

    it('leaves RAM-only keys and RAM-only collection members that storage still holds out of the key set', async () => {
        const {OnyxUtils} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [KEYS.RAM_ONLY]: 'stale', [RAM_MEMBER]: {stale: true}}});

        const keys = await OnyxUtils.getAllKeys();

        expect(new Set(keys)).toEqual(new Set([REPORT_1]));
    });

    it('reads keys from storage when nothing is known yet and filters RAM-only keys there too', async () => {
        const {OnyxUtils, storage} = await startOnyx();
        await storage.multiSet([
            [REPORT_1, {id: 1}],
            [KEYS.PLAIN, 'plain'],
            [KEYS.RAM_ONLY, 'stale'],
            [RAM_MEMBER, {stale: true}],
        ]);

        const keys = await OnyxUtils.getAllKeys();

        expect(new Set(keys)).toEqual(new Set([REPORT_1, KEYS.PLAIN]));
        expect(storage.getAllKeys).toHaveBeenCalledTimes(1);
    });

    it('shares one storage read between concurrent calls and resolves the same keys for both', async () => {
        const {OnyxUtils, storage} = await startOnyx();
        await storage.multiSet([
            [REPORT_1, {id: 1}],
            [KEYS.PLAIN, 'plain'],
        ]);

        const [first, second] = await Promise.all([OnyxUtils.getAllKeys(), OnyxUtils.getAllKeys()]);

        expect(new Set(first)).toEqual(new Set([REPORT_1, KEYS.PLAIN]));
        expect(new Set(second)).toEqual(new Set(first));
        expect(storage.getAllKeys).toHaveBeenCalledTimes(1);
    });

    it('stops reading storage once the key set was loaded from it', async () => {
        const {OnyxUtils, storage} = await startOnyx();
        await storage.setItem(KEYS.PLAIN, 'plain');
        await OnyxUtils.getAllKeys();

        await OnyxUtils.getAllKeys();
        await OnyxUtils.getAllKeys();

        expect(storage.getAllKeys).toHaveBeenCalledTimes(1);
    });

    it('lets the storage keys feed the collection snapshot after they were loaded', async () => {
        const {OnyxUtils, storage} = await startOnyx();
        await storage.multiSet([
            [REPORT_1, {id: 1}],
            [NESTED_1, {id: 'n'}],
        ]);

        await OnyxUtils.getAllKeys();
        await OnyxUtils.multiGet([REPORT_1, NESTED_1]);

        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_1]: {id: 1}});
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT_NESTED)).toEqual({[NESTED_1]: {id: 'n'}});
    });

    it('includes keys written through Onyx and keeps them for later calls', async () => {
        const {Onyx, OnyxUtils, storage} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'plain'}});

        await Onyx.set(REPORT_1, {id: 1});
        await Onyx.merge(REPORT_2, {id: 2});
        await Onyx.multiSet({[NESTED_1]: {id: 'n'}});

        expect(new Set(await OnyxUtils.getAllKeys())).toEqual(new Set([KEYS.PLAIN, REPORT_1, REPORT_2, NESTED_1]));
        expect(storage.getAllKeys).not.toHaveBeenCalled();
    });

    it('includes RAM-only keys once they are written in memory', async () => {
        const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'plain'}});

        await Onyx.set(KEYS.RAM_ONLY, 'in memory');

        expect(await OnyxUtils.getAllKeys()).toContain(KEYS.RAM_ONLY);
    });

    it('drops keys removed with set null, merge null and multiSet null', async () => {
        const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'plain', [KEYS.PLAIN_2]: 'plain2', [REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});

        await Onyx.set(KEYS.PLAIN_2, null);
        await Onyx.merge(REPORT_1, null);
        await Onyx.multiSet({[REPORT_2]: null});
        await waitForPromisesToResolve();

        expect(new Set(await OnyxUtils.getAllKeys())).toEqual(new Set([KEYS.PLAIN]));
    });

    it('drops every key on clear except the ones it keeps', async () => {
        const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'plain', [REPORT_1]: {id: 1}}});

        await Onyx.clear([KEYS.PLAIN]);
        await waitForPromisesToResolve();

        const keys = await OnyxUtils.getAllKeys();
        expect(keys).not.toContain(REPORT_1);
        expect(keys).toContain(KEYS.PLAIN);
    });

    it('delivers members only written to storage after an empty boot to a collection subscriber', async () => {
        const {Onyx, storage} = await startOnyx();
        await storage.multiSet([
            [REPORT_1, {id: 1}],
            [REPORT_2, {id: 2}],
            [RAM_MEMBER, {stale: true}],
        ]);
        const callback = jest.fn();
        const ramCallback = jest.fn();

        Onyx.connect({key: KEYS.COLLECTION.REPORT, callback});
        Onyx.connect({key: KEYS.COLLECTION.RAM_ONLY, callback: ramCallback});
        await waitForPromisesToResolve();

        expect(callback.mock.calls.at(-1)).toEqual([{[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}, KEYS.COLLECTION.REPORT]);
        for (const [value] of ramCallback.mock.calls) {
            expect(value ?? {}).toEqual({});
        }
    });
});

describe('current behaviour (suspected bug)', () => {
    it('reads storage on every call while the store holds no keys, since an empty key set looks unloaded', async () => {
        const {OnyxUtils, storage} = await startOnyx();

        await OnyxUtils.getAllKeys();
        await OnyxUtils.getAllKeys();

        // Expected: one read, the loaded empty set is as final as a non-empty one.
        expect(storage.getAllKeys).toHaveBeenCalledTimes(2);
    });
});
