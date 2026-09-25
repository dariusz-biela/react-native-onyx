import type {OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {KEYS} from '../connect/utils/freshOnyx';
import {R1, R2, REPORT, countFor, startHarness, valuesFor} from './utils/harness';

describe('notifyKey duplicate suppression', () => {
    it.each([
        ['a plain key', KEYS.PLAIN],
        ['a collection member', R1],
    ])('delivers the same reference once when notifyKey repeats it for %s', async (_label, key) => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('exact', key);
        await settle();
        const value = {a: 1};

        OnyxUtils.notifyKey(key, value);
        OnyxUtils.notifyKey(key, value);

        expect(valuesFor(log, 'exact')).toEqual([value]);
    });

    it('delivers a changed value after a suppressed repeat, and the earlier value again once it comes back', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('exact', KEYS.PLAIN);
        await settle();
        const first = {a: 1};
        const second = {a: 2};

        OnyxUtils.notifyKey(KEYS.PLAIN, first);
        OnyxUtils.notifyKey(KEYS.PLAIN, first);
        OnyxUtils.notifyKey(KEYS.PLAIN, second);
        OnyxUtils.notifyKey(KEYS.PLAIN, first);

        expect(valuesFor(log, 'exact')).toEqual([first, second, first]);
    });

    it('delivers undefined after a value and suppresses a repeated undefined', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('exact', KEYS.PLAIN);
        await settle();

        OnyxUtils.notifyKey<OnyxKey>(KEYS.PLAIN, 'value');
        OnyxUtils.notifyKey(KEYS.PLAIN, undefined);
        OnyxUtils.notifyKey(KEYS.PLAIN, undefined);

        expect(valuesFor(log, 'exact')).toEqual(['value', undefined]);
    });

    it('suppresses per subscription, so a new subscription still receives a value an older one already had', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('old', KEYS.PLAIN);
        await settle();
        const value = {a: 1};
        OnyxUtils.notifyKey(KEYS.PLAIN, value);
        connect('new', KEYS.PLAIN);
        await settle();

        OnyxUtils.notifyKey(KEYS.PLAIN, value);

        expect(countFor(log, 'old')).toBe(0);
        expect(valuesFor(log, 'new')).toEqual([value]);
    });

    it('suppresses a notifyKey for the reference a collection batch already delivered to a member subscriber', async () => {
        const {Onyx, OnyxUtils, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('R1', R1);
        await settle();

        await Onyx.mergeCollection(REPORT, {[R1]: {name: 'one'}});
        OnyxUtils.notifyKey(R1, cache.get(R1));

        expect(valuesFor(log, 'R1')).toEqual([{id: 1, name: 'one'}]);
    });

    it('does not re-deliver to a member subscriber when multiSet writes back the reference an earlier write delivered', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        connect('R1', R1);
        await settle();
        const value = {id: 1};

        await Onyx.set(R1, value);
        await Onyx.multiSet({[R1]: valuesFor(log, 'R1').at(0)});

        expect(valuesFor(log, 'R1')).toEqual([value]);
    });

    it('does not re-deliver to a plain subscriber when multiSet writes back the reference notifyKey delivered', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        connect('plain', KEYS.PLAIN);
        await settle();

        await Onyx.set(KEYS.PLAIN, {a: 1});
        await Onyx.multiSet({[KEYS.PLAIN]: valuesFor(log, 'plain').at(0)});

        expect(valuesFor(log, 'plain')).toEqual([{a: 1}]);
    });
});

describe('notifyCollection repeated batches', () => {
    it('re-notifies root and changed member listeners at least once and never more than once per call', async () => {
        const {OnyxUtils, cache, log, listen, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        listen('R1', R1);
        listen('R2', R2);
        listen('root', REPORT);
        await settle();
        const partial = {[R1]: {id: 1}};
        const previous = {[R1]: {id: 0}};

        for (let call = 0; call < 3; call++) {
            OnyxUtils.notifyCollection(REPORT, partial, previous);
        }

        for (const name of ['R1', 'root']) {
            expect(countFor(log, name)).toBeGreaterThanOrEqual(1);
            expect(countFor(log, name)).toBeLessThanOrEqual(3);
        }
        expect(countFor(log, 'R2')).toBe(0);
        for (const value of valuesFor(log, 'R1')) {
            expect(value).toBe(cache.get(R1));
        }
    });
});

describe('first delivery dedup', () => {
    // Fixed by #834: main's first delivery went through sendDataToConnection, which never recorded what it delivered, so plain got {a: 1} twice and root twice.
    it('does not re-deliver to a subscriber the same reference its first delivery already carried', async () => {
        const {Onyx, log, connect} = await startHarness({storedValues: {[KEYS.PLAIN]: {a: 1}, [R1]: {id: 1}}});
        connect('plain', KEYS.PLAIN);
        connect('R1', R1);
        connect('root', REPORT);
        await waitForPromisesToResolve();
        const firstPlain = valuesFor(log, 'plain').at(0);
        const firstMember = valuesFor(log, 'R1').at(0);

        await Onyx.multiSet({[KEYS.PLAIN]: firstPlain, [R1]: firstMember});

        expect(valuesFor(log, 'plain')).toEqual([{a: 1}]);
        expect(valuesFor(log, 'R1')).toEqual([{id: 1}]);
        expect(valuesFor(log, 'root')).toEqual([{[R1]: {id: 1}}]);
    });
});

describe('current behaviour (#834 change)', () => {
    // Main re-notified the root once or twice with the same collection; #834 skips a root whose cached collection object did not change.
    it('does not notify a root when notifyKey repeats a member reference the cache does not hold', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('root', REPORT);
        await settle();
        const value = {id: 1};

        OnyxUtils.notifyKey(R1, value);
        OnyxUtils.notifyKey(R1, value);

        expect(countFor(log, 'root')).toBe(0);
    });

    // Main re-delivered the root and the changed member one to three times; #834 dedups each connection against its first delivery.
    it('does not notify connected roots or members when repeated batches leave the cache unchanged', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        connect('R1', R1);
        connect('R2', R2);
        connect('root', REPORT);
        await settle();

        for (let call = 0; call < 3; call++) {
            OnyxUtils.notifyCollection(REPORT, {[R1]: {id: 1}}, {[R1]: {id: 0}});
        }

        expect(log).toEqual([]);
    });
});
