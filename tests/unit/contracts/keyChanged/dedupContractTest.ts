import type {OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {KEYS} from '../connect/utils/freshOnyx';
import {R1, R2, REPORT, countFor, startHarness, valuesFor} from './utils/harness';

describe('keyChanged duplicate suppression', () => {
    it.each([
        ['a plain key', KEYS.PLAIN],
        ['a collection member', R1],
    ])('delivers the same reference once when keyChanged repeats it for %s', async (_label, key) => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('exact', key);
        await settle();
        const value = {a: 1};

        OnyxUtils.keyChanged(key, value);
        OnyxUtils.keyChanged(key, value);

        expect(valuesFor(log, 'exact')).toEqual([value]);
    });

    it('delivers a changed value after a suppressed repeat, and the earlier value again once it comes back', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('exact', KEYS.PLAIN);
        await settle();
        const first = {a: 1};
        const second = {a: 2};

        OnyxUtils.keyChanged(KEYS.PLAIN, first);
        OnyxUtils.keyChanged(KEYS.PLAIN, first);
        OnyxUtils.keyChanged(KEYS.PLAIN, second);
        OnyxUtils.keyChanged(KEYS.PLAIN, first);

        expect(valuesFor(log, 'exact')).toEqual([first, second, first]);
    });

    it('delivers undefined after a value and suppresses a repeated undefined', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('exact', KEYS.PLAIN);
        await settle();

        OnyxUtils.keyChanged<OnyxKey>(KEYS.PLAIN, 'value');
        OnyxUtils.keyChanged(KEYS.PLAIN, undefined);
        OnyxUtils.keyChanged(KEYS.PLAIN, undefined);

        expect(valuesFor(log, 'exact')).toEqual(['value', undefined]);
    });

    it('suppresses per subscription, so a new subscription still receives a value an older one already had', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('old', KEYS.PLAIN);
        await settle();
        const value = {a: 1};
        OnyxUtils.keyChanged(KEYS.PLAIN, value);
        connect('new', KEYS.PLAIN);
        await settle();

        OnyxUtils.keyChanged(KEYS.PLAIN, value);

        expect(countFor(log, 'old')).toBe(0);
        expect(valuesFor(log, 'new')).toEqual([value]);
    });

    it('suppresses a keyChanged for the reference keysChanged already delivered to a member subscriber', async () => {
        const {OnyxUtils, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('R1', R1);
        await settle();

        OnyxUtils.keysChanged(REPORT, {[R1]: cache.get(R1)}, {[R1]: {id: 0}});
        OnyxUtils.keyChanged(R1, cache.get(R1));

        expect(valuesFor(log, 'R1')).toEqual([{id: 1}]);
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

    it('does not re-deliver to a plain subscriber when multiSet writes back the reference keyChanged delivered', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        connect('plain', KEYS.PLAIN);
        await settle();

        await Onyx.set(KEYS.PLAIN, {a: 1});
        await Onyx.multiSet({[KEYS.PLAIN]: valuesFor(log, 'plain').at(0)});

        expect(valuesFor(log, 'plain')).toEqual([{a: 1}]);
    });

    it('re-notifies a root at least once and at most once per call when keyChanged repeats a member reference', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        connect('root', REPORT);
        await settle();
        const value = {id: 1};

        OnyxUtils.keyChanged(R1, value);
        OnyxUtils.keyChanged(R1, value);

        expect(countFor(log, 'root')).toBeGreaterThanOrEqual(1);
        expect(countFor(log, 'root')).toBeLessThanOrEqual(2);
        expect(valuesFor(log, 'root').at(-1)).toEqual({[R1]: {id: 1}});
    });
});

describe('keysChanged repeated batches', () => {
    it('re-notifies roots and changed members at least once and never more than once per call', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}}});
        connect('R1', R1);
        connect('R2', R2);
        connect('root', REPORT);
        await settle();
        const partial = {[R1]: {id: 1}};
        const previous = {[R1]: {id: 0}};

        for (let call = 0; call < 3; call++) {
            OnyxUtils.keysChanged(REPORT, partial, previous);
        }

        for (const name of ['R1', 'root']) {
            expect(countFor(log, name)).toBeGreaterThanOrEqual(1);
            expect(countFor(log, name)).toBeLessThanOrEqual(3);
        }
        expect(countFor(log, 'R2')).toBe(0);
        expect(new Set(valuesFor(log, 'R1').map((value) => JSON.stringify(value)))).toEqual(new Set([JSON.stringify({id: 1})]));
    });
});

describe('current behaviour (suspected bug)', () => {
    // The first delivery goes through sendDataToConnection, which never records what it delivered.
    it('re-delivers to a plain subscriber the same reference its first delivery already carried', async () => {
        const {Onyx, log, connect} = await startHarness({storedValues: {[KEYS.PLAIN]: {a: 1}, [R1]: {id: 1}}});
        connect('plain', KEYS.PLAIN);
        connect('R1', R1);
        connect('root', REPORT);
        await waitForPromisesToResolve();
        const firstPlain = valuesFor(log, 'plain').at(0);
        const firstMember = valuesFor(log, 'R1').at(0);

        await Onyx.multiSet({[KEYS.PLAIN]: firstPlain, [R1]: firstMember});

        expect(valuesFor(log, 'plain')).toEqual([{a: 1}, {a: 1}]);
        expect(valuesFor(log, 'plain').at(1)).toBe(firstPlain);
        expect(valuesFor(log, 'R1')).toEqual([{id: 1}]);
        expect(countFor(log, 'root')).toBe(2);
    });
});
