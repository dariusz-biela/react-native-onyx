import type {OnyxKey} from '../../../../lib/types';
import {KEYS} from '../connect/utils/freshOnyx';
import {R1, R2, R3, REPORT, instanceSyncHandler, namesOf, startHarness} from './utils/harness';

describe('keyChanged notification order', () => {
    it('notifies subscribers of a plain key in subscription order', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness();
        connect('first', KEYS.PLAIN);
        connect('second', KEYS.PLAIN);
        connect('third', KEYS.PLAIN);
        await settle();

        OnyxUtils.keyChanged<OnyxKey>(KEYS.PLAIN, 'value');

        expect(namesOf(log)).toEqual(['first', 'second', 'third']);
    });

    it('notifies member subscribers in subscription order, then roots in subscription order, however the subscriptions interleave', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        connect('root A', REPORT);
        connect('member A', R1);
        connect('root B', REPORT);
        connect('member B', R1);
        await settle();

        await Onyx.set(R1, {id: 1});

        expect(namesOf(log)).toEqual(['member A', 'member B', 'root A', 'root B']);
    });

    it('keeps subscription order for the remaining subscribers after an earlier one disconnects', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        const first = connect('first', KEYS.PLAIN);
        connect('second', KEYS.PLAIN);
        connect('third', KEYS.PLAIN);
        await settle();

        Onyx.disconnect(first);
        connect('fourth', KEYS.PLAIN);
        await settle();
        await Onyx.set(KEYS.PLAIN, 'value');

        expect(namesOf(log)).toEqual(['second', 'third', 'fourth']);
    });
});

describe('keysChanged notification order', () => {
    it('notifies roots first, then member subscribers in batch key order with each key in subscription order', async () => {
        const {OnyxUtils, log, connect, settle} = await startHarness({storedValues: {[R1]: {id: 1}, [R2]: {id: 2}, [R3]: {id: 3}}});
        connect('R1 A', R1);
        connect('root A', REPORT);
        connect('R2 A', R2);
        connect('R1 B', R1);
        connect('root B', REPORT);
        connect('R3 A', R3);
        await settle();

        OnyxUtils.keysChanged(REPORT, {[R2]: {id: 2}, [R1]: {id: 1}}, {});

        expect(namesOf(log)).toEqual(['root A', 'root B', 'R2 A', 'R1 A', 'R1 B']);
    });

    it('notifies the root before the members for a public mergeCollection', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        connect('R1', R1);
        connect('R2', R2);
        connect('root', REPORT);
        await settle();

        await Onyx.mergeCollection(REPORT, {[R1]: {id: 1}, [R2]: {id: 2}});

        expect(namesOf(log).at(0)).toBe('root');
        expect([...namesOf(log)].sort()).toEqual(['R1', 'R2', 'root']);
    });
});

describe('multiSet notification order', () => {
    it('notifies plain keys inline in payload order before the collection batch', async () => {
        const {Onyx, log, connect, settle} = await startHarness();
        connect('R1', R1);
        connect('root', REPORT);
        connect('plain', KEYS.PLAIN);
        connect('plain2', KEYS.PLAIN_2);
        await settle();

        await Onyx.multiSet({[R1]: {id: 1}, [KEYS.PLAIN_2]: 'second', [KEYS.PLAIN]: 'first'});

        expect(namesOf(log)).toEqual(['plain2', 'plain', 'root', 'R1']);
    });

    it('lets a plain subscriber read every earlier payload key, collection members included, from the cache', async () => {
        const {Onyx, cache, connect, settle} = await startHarness();
        const seenFromPlain: unknown[] = [];
        connect('plain', KEYS.PLAIN, () => seenFromPlain.push([cache.get(KEYS.PLAIN_2), cache.get(R1)]));
        await settle();
        seenFromPlain.length = 0;

        await Onyx.multiSet({[KEYS.PLAIN_2]: 'earlier', [R1]: {id: 1}, [KEYS.PLAIN]: 'value'});

        expect(seenFromPlain).toEqual([['earlier', {id: 1}]]);
    });
});

describe('instance sync notification order', () => {
    it('notifies plain keys first, then one batch per collection with the root before its members', async () => {
        const {log, connect, settle} = await startHarness({shouldSyncMultipleInstances: true});
        connect('R1', R1);
        connect('root', REPORT);
        connect('plain', KEYS.PLAIN);
        connect('nested root', KEYS.COLLECTION.REPORT_NESTED);
        await settle();
        const onSync = instanceSyncHandler();

        onSync([
            [R1, {id: 1}],
            [`${KEYS.COLLECTION.REPORT_NESTED}1`, {id: 'n'}],
            [KEYS.PLAIN, 'synced'],
            [R2, {id: 2}],
        ]);

        expect(namesOf(log)).toEqual(['plain', 'root', 'R1', 'nested root']);
    });
});
