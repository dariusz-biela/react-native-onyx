import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {KEYS} from '../connect/utils/freshOnyx';
import {R1, R2, REPORT, countFor, namesOf, startHarness, valuesFor} from './utils/harness';

describe('subscribers added during a notification', () => {
    it.each([
        ['the written plain key', KEYS.PLAIN, KEYS.PLAIN, 'go'],
        ['the written member', R1, R1, 'go'],
        ['the root of the written member', R1, REPORT, {[R1]: 'go'}],
    ])('delivers the new value exactly once to a subscriber of %s connected from inside the notifying callback', async (_label, writtenKey, lateKey, expected) => {
        const {Onyx, log, connect, settle} = await startHarness();
        let joined = false;
        connect('trigger', writtenKey, (value) => {
            if (value !== 'go' || joined) {
                return;
            }
            joined = true;
            connect('late', lateKey);
        });
        await settle();

        await Onyx.set(writtenKey, 'go');
        await waitForPromisesToResolve();

        expect(valuesFor(log, 'late')).toEqual([expected]);
    });

    it('delivers a keysChanged batch exactly once to a member subscriber connected from a root callback in that batch', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        let armed = false;
        connect('root', REPORT, () => {
            if (!armed) {
                return;
            }
            armed = false;
            connect('late', R2);
        });
        await settle();
        armed = true;

        await Onyx.mergeCollection(REPORT, {[R1]: {id: 1}, [R2]: {id: 2}});
        await waitForPromisesToResolve();

        expect(valuesFor(log, 'late')).toEqual([{id: 2}]);
    });
});

describe('subscribers removed during a notification', () => {
    it.each([
        ['keyChanged on a plain key', KEYS.PLAIN],
        ['keyChanged on a member', R1],
    ])('lets the remaining subscribers receive the value when one disconnects itself during %s', async (_label, key) => {
        const {Onyx, OnyxUtils, log, connect, settle} = await startHarness();
        const leaving = {connection: connect('leaving', key, () => Onyx.disconnect(leaving.connection))};
        connect('after', key);
        await settle();
        const leavingCallsBefore = countFor(log, 'leaving');

        OnyxUtils.keyChanged(key, 'first');
        OnyxUtils.keyChanged(key, 'second');

        expect(countFor(log, 'leaving')).toBe(leavingCallsBefore);
        expect(valuesFor(log, 'after')).toEqual(['first', 'second']);
    });

    it('does not deliver the current value to a later subscriber that an earlier one disconnected during keysChanged', async () => {
        const {Onyx, OnyxUtils, cache, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}}});
        const later = {connection: connect('placeholder', KEYS.PLAIN)};
        connect('root', REPORT, () => Onyx.disconnect(later.connection));
        later.connection = connect('R1', R1);
        await settle();

        OnyxUtils.keysChanged(REPORT, {[R1]: cache.get(R1)}, {[R1]: {id: 0}});

        expect(namesOf(log)).toEqual(['root']);
    });
});

describe('writes during a notification', () => {
    it('delivers a write to another key made inside a callback, and still notifies later subscribers of the first key', async () => {
        const {Onyx, cache, log, connect, settle} = await startHarness();
        connect('first', KEYS.PLAIN, (value) => {
            if (value !== 'trigger') {
                return;
            }
            Onyx.set(KEYS.PLAIN_2, 'derived');
        });
        connect('second', KEYS.PLAIN);
        connect('other key', KEYS.PLAIN_2);
        await settle();

        await Onyx.set(KEYS.PLAIN, 'trigger');
        await waitForPromisesToResolve();

        expect(valuesFor(log, 'first')).toEqual(['trigger']);
        expect(valuesFor(log, 'second')).toEqual(['trigger']);
        expect(valuesFor(log, 'other key')).toEqual(['derived']);
        expect(cache.get(KEYS.PLAIN_2)).toBe('derived');
    });

    it('ends every member and root subscriber on the final state when a member callback writes another member', async () => {
        const {Onyx, cache, log, connect, settle} = await startHarness();
        connect('R1', R1, (value) => {
            if (value === undefined || cache.get(R2) !== undefined) {
                return;
            }
            Onyx.set(R2, {from: 'R1'});
        });
        connect('R2', R2);
        connect('root', REPORT);
        await settle();

        await Onyx.set(R1, {id: 1});
        await waitForPromisesToResolve();

        const finalCollection = {[R1]: {id: 1}, [R2]: {from: 'R1'}};
        expect(cache.getCollectionData(REPORT)).toEqual(finalCollection);
        expect(valuesFor(log, 'R2')).toEqual([{from: 'R1'}]);
        expect(valuesFor(log, 'root')).toContainEqual(finalCollection);
        expect(countFor(log, 'root')).toBeLessThanOrEqual(2);
    });
});
