import type {Connection} from '../../../../lib/OnyxConnectionManager';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {deliveredValues} from './utils/deliveries';
import {KEYS, startOnyx} from './utils/freshOnyx';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;

describe('Onyx.connect connection reuse', () => {
    describe('default reuse for the same key and options', () => {
        it('delivers the first value once to every subscriber that joined before the first delivery', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 1}}});
            const callbacks = [jest.fn(), jest.fn(), jest.fn()];

            for (const callback of callbacks) {
                Onyx.connect({key: KEYS.PLAIN, callback});
            }
            await waitForPromisesToResolve();

            for (const callback of callbacks) {
                expect(callback.mock.calls).toEqual([[{id: 1}, KEYS.PLAIN]]);
            }
            expect(callbacks[1].mock.calls[0][0]).toBe(callbacks[0].mock.calls[0][0]);
            expect(callbacks[2].mock.calls[0][0]).toBe(callbacks[0].mock.calls[0][0]);
        });

        it('gives a late joiner the current value once, asynchronously, without re-notifying earlier subscribers', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'first'}});
            const early = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: early});
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'second');
            await Onyx.merge(KEYS.PLAIN, 'third');
            await waitForPromisesToResolve();
            const earlyCallsBeforeJoin = early.mock.calls.length;
            const late = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback: late});
            expect(late).not.toHaveBeenCalled();
            await waitForPromisesToResolve();

            expect(late.mock.calls).toEqual([['third', KEYS.PLAIN]]);
            expect(early.mock.calls).toHaveLength(earlyCallsBeforeJoin);
            expect(deliveredValues(early)).toEqual(['first', 'second', 'third']);
        });

        it('gives a late joiner the current object by reference, the same one earlier subscribers hold', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {v: 1}}});
            const early = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: early});
            await waitForPromisesToResolve();
            await Onyx.merge(KEYS.PLAIN, {v: 2});
            await waitForPromisesToResolve();
            const late = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback: late});
            await waitForPromisesToResolve();

            expect(late.mock.calls).toEqual([[{v: 2}, KEYS.PLAIN]]);
            expect(late.mock.calls[0][0]).toBe(early.mock.calls.at(-1)?.[0]);
        });

        it('gives a late joiner on a missing key undefined for both arguments', async () => {
            const {Onyx} = await startOnyx();
            const early = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: early});
            await waitForPromisesToResolve();
            const late = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback: late});
            await waitForPromisesToResolve();

            expect(early.mock.calls).toEqual([[undefined, undefined]]);
            expect(late.mock.calls).toEqual([[undefined, undefined]]);
        });

        it('gives a late joiner on a member key the member and its key', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            Onyx.connect({key: REPORT_1, callback: jest.fn()});
            await waitForPromisesToResolve();
            const late = jest.fn();

            Onyx.connect({key: REPORT_1, callback: late});
            await waitForPromisesToResolve();

            expect(late.mock.calls).toEqual([[{id: 1}, REPORT_1]]);
        });

        it('gives a late joiner on a collection root the latest collection object by reference', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const early = jest.fn();
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: early});
            await waitForPromisesToResolve();
            await Onyx.set(REPORT_2, {id: 2});
            await waitForPromisesToResolve();
            const late = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: late});
            await waitForPromisesToResolve();

            expect(late.mock.calls).toEqual([[{[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}, KEYS.COLLECTION.REPORT]]);
            expect(late.mock.calls[0][0]).toBe(early.mock.calls.at(-1)?.[0]);
        });

        it('delivers every later write once to early and late subscribers alike', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const early = jest.fn();
            const late = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: early});
            await waitForPromisesToResolve();
            Onyx.connect({key: KEYS.PLAIN, callback: late});
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 2);
            await Onyx.set(KEYS.PLAIN, 3);
            await waitForPromisesToResolve();

            expect(deliveredValues(early)).toEqual([1, 2, 3]);
            expect(deliveredValues(late)).toEqual([1, 2, 3]);
        });

        it('calls the same function once per connect when it is connected twice', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'a'}});
            const callback = jest.fn();
            const first = Onyx.connect({key: KEYS.PLAIN, callback});
            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();
            expect(deliveredValues(callback)).toEqual(['a', 'a']);

            Onyx.disconnect(first);
            await Onyx.set(KEYS.PLAIN, 'b');
            await waitForPromisesToResolve();

            expect(deliveredValues(callback)).toEqual(['a', 'a', 'b']);
        });

        it('lets a connection without a callback coexist with subscribers that have one', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const silent = Onyx.connect({key: KEYS.PLAIN});
            await waitForPromisesToResolve();
            const callback = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();
            Onyx.disconnect(silent);
            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(deliveredValues(callback)).toEqual([1, 2]);
        });

        it('does not share a connection between different keys', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'p', [KEYS.PLAIN_2]: 'p2'}});
            const plain = jest.fn();
            const plain2 = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: plain});
            Onyx.connect({key: KEYS.PLAIN_2, callback: plain2});
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 'p-next');
            await waitForPromisesToResolve();

            expect(plain.mock.calls).toEqual([
                ['p', KEYS.PLAIN],
                ['p-next', KEYS.PLAIN],
            ]);
            expect(plain2.mock.calls).toEqual([['p2', KEYS.PLAIN_2]]);
        });
    });

    describe('disconnecting reused subscribers', () => {
        it('keeps delivering to the remaining subscriber after one disconnects', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const leaving = jest.fn();
            const staying = jest.fn();
            const leavingConnection = Onyx.connect({key: KEYS.PLAIN, callback: leaving});
            Onyx.connect({key: KEYS.PLAIN, callback: staying});
            await waitForPromisesToResolve();

            Onyx.disconnect(leavingConnection);
            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(deliveredValues(leaving)).toEqual([1]);
            expect(deliveredValues(staying)).toEqual([1, 2]);
        });

        it('still gives the first value to a subscriber whose co-subscriber disconnected before the first delivery', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const leaving = jest.fn();
            const staying = jest.fn();
            const leavingConnection = Onyx.connect({key: KEYS.PLAIN, callback: leaving});
            Onyx.connect({key: KEYS.PLAIN, callback: staying});

            Onyx.disconnect(leavingConnection);
            await waitForPromisesToResolve();

            expect(leaving).not.toHaveBeenCalled();
            expect(staying.mock.calls).toEqual([[1, KEYS.PLAIN]]);
        });

        it('keeps disconnecting the same connection twice from removing another subscriber', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const leaving = jest.fn();
            const staying = jest.fn();
            const leavingConnection = Onyx.connect({key: KEYS.PLAIN, callback: leaving});
            Onyx.connect({key: KEYS.PLAIN, callback: staying});
            await waitForPromisesToResolve();

            Onyx.disconnect(leavingConnection);
            Onyx.disconnect(leavingConnection);
            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(deliveredValues(staying)).toEqual([1, 2]);
        });

        it('never calls a subscriber that disconnects synchronously after connecting to a fresh key, even across many cycles', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'warm'}});
            const churned = jest.fn();

            for (let cycle = 0; cycle < 200; cycle++) {
                Onyx.disconnect(Onyx.connect({key: KEYS.PLAIN, callback: churned}));
            }
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 'changed');
            await waitForPromisesToResolve();

            expect(churned).not.toHaveBeenCalled();

            const fresh = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: fresh});
            await waitForPromisesToResolve();
            expect(fresh.mock.calls).toEqual([['changed', KEYS.PLAIN]]);
        });

        it('supports the one-shot read that disconnects inside its first callback', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 'session'}}});
            const staying = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: staying});
            const oneShotValues: unknown[] = [];
            const readOnce = () =>
                new Promise<unknown>((resolve) => {
                    const connection: Connection = Onyx.connect({
                        key: KEYS.PLAIN,
                        callback: (value) => {
                            Onyx.disconnect(connection);
                            oneShotValues.push(value);
                            resolve(value);
                        },
                    });
                });

            const [first, second] = await Promise.all([readOnce(), readOnce()]);
            await Onyx.set(KEYS.PLAIN, {id: 'changed'});
            await waitForPromisesToResolve();

            expect(first).toEqual({id: 'session'});
            expect(second).toEqual({id: 'session'});
            expect(oneShotValues).toHaveLength(2);
            expect(deliveredValues(staying)).toEqual([{id: 'session'}, {id: 'changed'}]);
        });

        it('still calls the next subscriber in the same dispatch when an earlier one disconnects itself', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const order: string[] = [];
            const selfDisconnecting: Connection = Onyx.connect({
                key: KEYS.PLAIN,
                callback: (value: unknown) => {
                    order.push(`first:${String(value)}`);
                    if (value === 2) {
                        Onyx.disconnect(selfDisconnecting);
                    }
                },
            });
            Onyx.connect({key: KEYS.PLAIN, callback: (value) => order.push(`second:${String(value)}`)});
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 2);
            await Onyx.set(KEYS.PLAIN, 3);
            await waitForPromisesToResolve();

            expect(order).toEqual(['first:1', 'second:1', 'first:2', 'second:2', 'second:3']);
        });

        it('builds a fresh connection with the current value after the last subscriber left', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const first = jest.fn();
            Onyx.disconnect(Onyx.connect({key: KEYS.PLAIN, callback: first}));
            const connection = Onyx.connect({key: KEYS.PLAIN, callback: first});
            await waitForPromisesToResolve();
            Onyx.disconnect(connection);
            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();
            const second = jest.fn();

            Onyx.connect({key: KEYS.PLAIN, callback: second});
            await waitForPromisesToResolve();

            expect(deliveredValues(first)).toEqual([1]);
            expect(second.mock.calls).toEqual([[2, KEYS.PLAIN]]);
        });
    });

    describe('reuseConnection false', () => {
        it('gives each connection its own first delivery', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {id: 1}}});
            const callbacks = Array.from({length: 100}, () => jest.fn());

            for (const callback of callbacks) {
                Onyx.connect({key: KEYS.PLAIN, callback, reuseConnection: false});
            }
            await waitForPromisesToResolve();

            for (const callback of callbacks) {
                expect(callback.mock.calls).toEqual([[{id: 1}, KEYS.PLAIN]]);
            }
        });

        it('delivers each write once to every separate connection, and a disconnect only affects its own', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const leaving = jest.fn();
            const staying = jest.fn();
            const shared = jest.fn();
            const leavingConnection = Onyx.connect({key: KEYS.PLAIN, callback: leaving, reuseConnection: false});
            Onyx.connect({key: KEYS.PLAIN, callback: staying, reuseConnection: false});
            Onyx.connect({key: KEYS.PLAIN, callback: shared});
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 2);
            Onyx.disconnect(leavingConnection);
            await Onyx.set(KEYS.PLAIN, 3);
            await waitForPromisesToResolve();

            expect(deliveredValues(leaving)).toEqual([1, 2]);
            expect(deliveredValues(staying)).toEqual([1, 2, 3]);
            expect(deliveredValues(shared)).toEqual([1, 2, 3]);
        });

        it('makes a separate connection even after a reusable one exists, so the joiner gets its own first delivery', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.COLLECTION.REPORT + 1]: {id: 1}}});
            const reusable = jest.fn();
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: reusable});
            await waitForPromisesToResolve();
            const separate = jest.fn();

            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: separate, reuseConnection: false});
            await waitForPromisesToResolve();

            expect(reusable).toHaveBeenCalledTimes(1);
            expect(separate.mock.calls).toEqual([[{[REPORT_1]: {id: 1}}, KEYS.COLLECTION.REPORT]]);
            expect(separate.mock.calls[0][0]).toBe(reusable.mock.calls[0][0]);
        });

        it('never calls a separate connection that disconnects synchronously', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const live = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: live});
            await waitForPromisesToResolve();
            const churned = jest.fn();

            for (let cycle = 0; cycle < 50; cycle++) {
                Onyx.disconnect(Onyx.connect({key: KEYS.PLAIN, callback: churned, reuseConnection: false}));
            }
            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(churned).not.toHaveBeenCalled();
            expect(deliveredValues(live)).toEqual([1, 2]);
        });
    });

    describe('Onyx.clear', () => {
        it('notifies live connections with the cleared or default value and keeps them live afterwards', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}, initialKeyStates: {[KEYS.WITH_DEFAULT]: 'default'}});
            const plain = jest.fn();
            const withDefault = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: plain});
            Onyx.connect({key: KEYS.WITH_DEFAULT, callback: withDefault});
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.WITH_DEFAULT, 'changed');

            await Onyx.clear();
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(plain.mock.calls).toEqual([
                [1, KEYS.PLAIN],
                [undefined, KEYS.PLAIN],
                [2, KEYS.PLAIN],
            ]);
            expect(deliveredValues(withDefault)).toEqual(['default', 'changed', 'default']);
        });

        it('gives a subscriber that connects after clear the current value, not the value from before clear', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'before', [REPORT_1]: {id: 1}}});
            const oldPlain = jest.fn();
            const oldCollection = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: oldPlain});
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: oldCollection});
            await waitForPromisesToResolve();

            await Onyx.clear();
            await waitForPromisesToResolve();
            const newPlain = jest.fn();
            const newCollection = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: newPlain});
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: newCollection});
            await waitForPromisesToResolve();

            expect(newPlain.mock.calls).toEqual([[undefined, undefined]]);
            expect(deliveredValues(newCollection)).not.toContainEqual({[REPORT_1]: {id: 1}});
            expect(newCollection).toHaveBeenCalledTimes(1);

            await Onyx.set(KEYS.PLAIN, 'after');
            await waitForPromisesToResolve();

            expect(deliveredValues(oldPlain).at(-1)).toBe('after');
            expect(deliveredValues(newPlain)).toEqual([undefined, 'after']);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        // The deferred late-joiner delivery does not check whether the subscriber disconnected meanwhile.
        it('still calls a late joiner that disconnected synchronously while the connection was live', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            Onyx.connect({key: KEYS.PLAIN, callback: jest.fn()});
            await waitForPromisesToResolve();
            const late = jest.fn();

            Onyx.disconnect(Onyx.connect({key: KEYS.PLAIN, callback: late}));
            await waitForPromisesToResolve();
            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(late.mock.calls).toEqual([[1, KEYS.PLAIN]]);
        });
    });
});
