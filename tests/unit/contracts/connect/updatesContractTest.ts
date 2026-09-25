import lodashCloneDeep from 'lodash/cloneDeep';
import type {Connection} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {deliveredValues, expectNoStaleOrRepeatedDelivery, expectOrderedSubsequenceOfStates, recordDeliveriesAgainstState} from './utils/deliveries';
import {KEYS, startOnyx} from './utils/freshOnyx';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const REPORT_3 = `${KEYS.COLLECTION.REPORT}3`;
const REPORT_10 = `${KEYS.COLLECTION.REPORT}10`;
const NESTED_1 = `${KEYS.COLLECTION.REPORT_NESTED}1`;
const REPORT_ACTIONS_1 = `${KEYS.COLLECTION.REPORT_ACTIONS}1`;

/** Connects and waits for the first delivery, then clears the mock so tests only see later deliveries. */
async function connectAndSettle(connect: () => Connection, callback: jest.Mock): Promise<Connection> {
    const connection = connect();
    await waitForPromisesToResolve();
    callback.mockClear();
    return connection;
}

describe('Onyx.connect deliveries after the first one', () => {
    describe('plain and member keys', () => {
        it('delivers set, merge and removal with the key', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {a: 1}}});
            const callback = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback}), callback);

            await Onyx.set(KEYS.PLAIN, {a: 2});
            await Onyx.merge(KEYS.PLAIN, {b: 1});
            await Onyx.set(KEYS.PLAIN, null);
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([
                [{a: 2}, KEYS.PLAIN],
                [{a: 2, b: 1}, KEYS.PLAIN],
                [undefined, KEYS.PLAIN],
            ]);
        });

        it('does not call the subscriber when a write leaves the value deep-equal', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {a: {b: 1}}}});
            const first = jest.fn();
            const second = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: first}), first);
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: second}), second);

            await Onyx.set(KEYS.PLAIN, {a: {b: 1}});
            await Onyx.merge(KEYS.PLAIN, {a: {b: 1}});
            await Onyx.merge(KEYS.PLAIN, {});
            await waitForPromisesToResolve();

            expect(first).not.toHaveBeenCalled();
            expect(second).not.toHaveBeenCalled();
        });

        it('delivers a new reference on change and never mutates the previously delivered object', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {nested: {count: 1}, untouched: {flag: true}}}});
            const callback = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();
            const before = callback.mock.calls[0][0];
            const beforeCopy = lodashCloneDeep(before);

            await Onyx.merge(KEYS.PLAIN, {nested: {count: 2}});
            await waitForPromisesToResolve();

            const after = callback.mock.calls.at(-1)?.[0];
            expect(after).toEqual({nested: {count: 2}, untouched: {flag: true}});
            expect(after).not.toBe(before);
            expect(after.nested).not.toBe(before.nested);
            expect(before).toEqual(beforeCopy);
        });

        it('only notifies the exact key, not keys that share its prefix', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 'p', [REPORT_1]: {id: 1}}});
            const plain = jest.fn();
            const member = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: plain}), plain);
            await connectAndSettle(() => Onyx.connect({key: REPORT_1, callback: member}), member);

            await Onyx.set(KEYS.PLAIN_2, 'p2');
            await Onyx.set(REPORT_10, {id: 10});
            await Onyx.set(`${REPORT_1}1`, {id: 11});
            await Onyx.set(REPORT_2, {id: 2});
            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_2]: {id: 22}, [REPORT_3]: {id: 3}});
            await waitForPromisesToResolve();

            expect(plain).not.toHaveBeenCalled();
            expect(member).not.toHaveBeenCalled();
        });

        it('delivers collection batch writes to member subscribers with the member value and key', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1, name: 'a'}, [REPORT_2]: {id: 2}}});
            const member1 = jest.fn();
            const member2 = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: REPORT_1, callback: member1}), member1);
            await connectAndSettle(() => Onyx.connect({key: REPORT_2, callback: member2}), member2);

            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {name: 'b'}});
            // @ts-expect-error The public type forbids null members, but mergeCollection documents null as a removal.
            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: null, [REPORT_2]: {id: 2}});
            await waitForPromisesToResolve();

            expect(member1.mock.calls).toEqual([
                [{id: 1, name: 'b'}, REPORT_1],
                [undefined, REPORT_1],
            ]);
            expect(member2).not.toHaveBeenCalled();
        });

        it('does not call the subscriber again when multiSet writes the reference it already delivered', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {v: 0}}});
            const callback = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback}), callback);
            const value = {v: 1};

            await Onyx.multiSet({[KEYS.PLAIN]: value});
            await Onyx.multiSet({[KEYS.PLAIN]: value});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{v: 1}, KEYS.PLAIN]]);
        });
    });

    describe('collection root key', () => {
        it('delivers the whole collection after a member write, keeping unchanged members by reference', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
            const callback = jest.fn();
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback});
            await waitForPromisesToResolve();
            const before = callback.mock.calls[0][0];
            const beforeCopy = lodashCloneDeep(before);

            await Onyx.merge(REPORT_1, {name: 'changed'});
            await waitForPromisesToResolve();

            expect(callback.mock.calls.at(-1)).toEqual([{[REPORT_1]: {id: 1, name: 'changed'}, [REPORT_2]: {id: 2}}, KEYS.COLLECTION.REPORT]);
            const after = callback.mock.calls.at(-1)?.[0];
            expect(after).not.toBe(before);
            expect(after[REPORT_2]).toBe(before[REPORT_2]);
            expect(before).toEqual(beforeCopy);
            expect(callback).toHaveBeenCalledTimes(2);
        });

        it('delivers one collection per mergeCollection that contains every merged member', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const callback = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback}), callback);

            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {name: 'one'}, [REPORT_2]: {id: 2}, [REPORT_3]: {id: 3}});
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([[{[REPORT_1]: {id: 1, name: 'one'}, [REPORT_2]: {id: 2}, [REPORT_3]: {id: 3}}, KEYS.COLLECTION.REPORT]]);
        });

        it('drops removed members from the collection and delivers an empty object once the last one is gone', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}});
            const callback = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback}), callback);

            await Onyx.set(REPORT_1, null);
            await Onyx.set(REPORT_2, null);
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([
                [{[REPORT_2]: {id: 2}}, KEYS.COLLECTION.REPORT],
                [{}, KEYS.COLLECTION.REPORT],
            ]);
            expect(Object.keys(callback.mock.calls[0][0])).toEqual([REPORT_2]);
        });

        it('is not notified by writes to prefix-colliding collections or plain keys', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const callback = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback}), callback);

            await Onyx.set(NESTED_1, {id: 'nested'});
            await Onyx.set(REPORT_ACTIONS_1, {id: 'actions'});
            await Onyx.set(KEYS.PLAIN, 'plain');
            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT_NESTED, {[`${KEYS.COLLECTION.REPORT_NESTED}2`]: {id: 'nested2'}});
            await waitForPromisesToResolve();

            expect(callback).not.toHaveBeenCalled();
        });

        it('delivers the nested collection only to its own root subscriber', async () => {
            const {Onyx} = await startOnyx();
            const nested = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT_NESTED, callback: nested}), nested);

            await Onyx.set(NESTED_1, {id: 'nested'});
            await Onyx.set(REPORT_1, {id: 1});
            await waitForPromisesToResolve();

            expect(nested.mock.calls).toEqual([[{[NESTED_1]: {id: 'nested'}}, KEYS.COLLECTION.REPORT_NESTED]]);
        });

        it('does not notify the root when a member write leaves the member deep-equal', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1, nested: {a: 1}}}});
            const callback = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback}), callback);

            await Onyx.set(REPORT_1, {id: 1, nested: {a: 1}});
            await Onyx.merge(REPORT_1, {nested: {a: 1}});
            await waitForPromisesToResolve();

            expect(callback).not.toHaveBeenCalled();
        });

        it('delivers the same collection reference to every root subscriber in one dispatch', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const first = jest.fn();
            const second = jest.fn();
            const third = jest.fn();
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: first});
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: second});
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: third});
            await waitForPromisesToResolve();

            await Onyx.set(REPORT_2, {id: 2});
            await waitForPromisesToResolve();

            const delivered = first.mock.calls.at(-1)?.[0];
            expect(delivered).toEqual({[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}});
            expect(second.mock.calls.at(-1)?.[0]).toBe(delivered);
            expect(third.mock.calls.at(-1)?.[0]).toBe(delivered);
            expect(Object.isFrozen(delivered)).toBe(true);
        });
    });

    describe('delivery order', () => {
        it('calls subscribers of one key in the order they connected, for the first delivery and for writes', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const order: string[] = [];
            Onyx.connect({key: KEYS.PLAIN, callback: (value) => order.push(`a:${String(value)}`)});
            Onyx.connect({key: KEYS.PLAIN, callback: (value) => order.push(`b:${String(value)}`)});
            Onyx.connect({key: KEYS.PLAIN, callback: (value) => order.push(`c:${String(value)}`)});
            Onyx.connect({key: KEYS.PLAIN, callback: (value) => order.push(`d:${String(value)}`)});
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(order.slice(0, 4).sort()).toEqual(['a:1', 'b:1', 'c:1', 'd:1']);
            expect(order.slice(4)).toEqual(['a:2', 'b:2', 'c:2', 'd:2']);
        });

        it('delivers first values of warm plain keys in connect order', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1, [KEYS.PLAIN_2]: 2, [KEYS.WITH_UNDERSCORE]: 3}});
            const order: unknown[] = [];

            Onyx.connect({key: KEYS.PLAIN_2, callback: (value) => order.push(value)});
            Onyx.connect({key: KEYS.WITH_UNDERSCORE, callback: (value) => order.push(value)});
            Onyx.connect({key: KEYS.PLAIN, callback: (value) => order.push(value)});
            await waitForPromisesToResolve();

            expect(order).toEqual([2, 3, 1]);
        });

        it('delivers a member write to both the member and the root subscriber before the write resolves', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const member = jest.fn();
            const root = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: REPORT_1, callback: member}), member);
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: root}), root);

            await Onyx.set(REPORT_1, {id: 'set'});
            expect(member.mock.calls).toEqual([[{id: 'set'}, REPORT_1]]);
            expect(root.mock.calls).toEqual([[{[REPORT_1]: {id: 'set'}}, KEYS.COLLECTION.REPORT]]);

            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {name: 'batch'}});
            expect(member.mock.calls.at(-1)).toEqual([{id: 'set', name: 'batch'}, REPORT_1]);
            expect(root.mock.calls.at(-1)).toEqual([{[REPORT_1]: {id: 'set', name: 'batch'}}, KEYS.COLLECTION.REPORT]);
        });

        // Pins today's cross-kind order: single-key writes reach the member first, batch writes reach the root first.
        it('notifies the member before the root for single-key writes and the root before the member for batch writes', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const order: string[] = [];
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: () => order.push('root')});
            Onyx.connect({key: REPORT_1, callback: () => order.push('member')});
            await waitForPromisesToResolve();
            order.length = 0;

            await Onyx.set(REPORT_1, {id: 2});
            order.push('|');
            await Onyx.merge(REPORT_1, {id: 3});
            order.push('|');
            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {id: 4}});
            order.push('|');
            await Onyx.multiSet({[REPORT_1]: {id: 5}});
            await waitForPromisesToResolve();

            expect(order).toEqual(['member', 'root', '|', 'member', 'root', '|', 'root', 'member', '|', 'root', 'member']);
        });
    });

    describe('interleaved writes', () => {
        it('delivers states in order and ends on the final value when writes are not awaited', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {v: 0}}});
            const first = jest.fn();
            const second = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: first}), first);
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: second}), second);

            Onyx.set(KEYS.PLAIN, {v: 1});
            Onyx.merge(KEYS.PLAIN, {extra: true});
            Onyx.set(KEYS.PLAIN, {v: 2});
            Onyx.merge(KEYS.PLAIN, {v: 3});
            await waitForPromisesToResolve();

            const states = [{v: 1}, {v: 1, extra: true}, {v: 2}, {v: 3}];
            expectOrderedSubsequenceOfStates(deliveredValues(first), states);
            expectOrderedSubsequenceOfStates(deliveredValues(second), states);
        });

        it('never delivers a stale collection to the root when unawaited member writes interleave', async () => {
            const {Onyx, cache} = await startOnyx();
            const {callback, records} = recordDeliveriesAgainstState(() => cache.getCollectionData(KEYS.COLLECTION.REPORT) ?? {});
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback}), callback);
            records.length = 0;

            Onyx.set(REPORT_1, {id: 1});
            Onyx.merge(REPORT_2, {id: 2});
            Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_3]: {id: 3}});
            Onyx.set(REPORT_1, null);
            await waitForPromisesToResolve();

            expectNoStaleOrRepeatedDelivery(records, {[REPORT_2]: {id: 2}, [REPORT_3]: {id: 3}});
        });

        it('never delivers a stale member value when a set, a collection merge and a merge interleave', async () => {
            const {Onyx, cache, storage} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const {callback, records} = recordDeliveriesAgainstState(() => cache.get(REPORT_1));
            await connectAndSettle(() => Onyx.connect({key: REPORT_1, callback}), callback);
            records.length = 0;

            Onyx.set(REPORT_1, {id: 'a'});
            Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {name: 'b'}});
            Onyx.merge(REPORT_1, {name: 'c'});
            await waitForPromisesToResolve();

            expectNoStaleOrRepeatedDelivery(records, cache.get(REPORT_1));
            expect(await storage.getItem(REPORT_1)).toEqual(records.at(-1)?.value);
        });
    });

    describe('writes and connects inside callbacks', () => {
        it('lets a subscriber write the same key from its callback, which it then receives, and later connections see the result', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[KEYS.PLAIN]: 0}});
            const writer = jest.fn((value: unknown) => {
                if (value !== 1) {
                    return;
                }
                Onyx.set(KEYS.PLAIN, 2);
            });
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: writer}), writer);

            await Onyx.set(KEYS.PLAIN, 1);
            await waitForPromisesToResolve();
            const late = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: late});
            await waitForPromisesToResolve();

            expect(deliveredValues(writer)).toEqual([1, 2]);
            expect(cache.get(KEYS.PLAIN)).toBe(2);
            expect(late.mock.calls).toEqual([[2, KEYS.PLAIN]]);
        });

        it('lets a root subscriber write another member from its callback and ends on the full collection', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const root = jest.fn((collection: Record<string, unknown> | undefined) => {
                if (!collection || REPORT_2 in collection) {
                    return;
                }
                Onyx.set(REPORT_2, {id: 2});
            });
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: root});
            await waitForPromisesToResolve();
            await waitForPromisesToResolve();

            expect(root.mock.calls.at(-1)).toEqual([{[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}}, KEYS.COLLECTION.REPORT]);
            expect(root).toHaveBeenCalledTimes(2);
        });

        it('delivers exactly once to a connection opened inside a callback for another key', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1, [KEYS.PLAIN_2]: 'other'}});
            const inner = jest.fn();
            let hasConnected = false;
            Onyx.connect({
                key: KEYS.PLAIN,
                callback: () => {
                    if (hasConnected) {
                        return;
                    }
                    hasConnected = true;
                    Onyx.connect({key: KEYS.PLAIN_2, callback: inner});
                },
            });
            await waitForPromisesToResolve();
            await waitForPromisesToResolve();

            expect(inner.mock.calls).toEqual([['other', KEYS.PLAIN_2]]);
        });
    });

    describe('throwing callbacks', () => {
        it('does not stop other subscribers from receiving values, and the thrower keeps receiving later writes', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const thrower = jest.fn();
            const sameKey = jest.fn();
            const secondThrower = jest.fn();
            const afterSecondThrower = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: thrower});
            Onyx.connect({key: KEYS.PLAIN, callback: sameKey});
            Onyx.connect({key: KEYS.PLAIN, callback: secondThrower});
            Onyx.connect({key: KEYS.PLAIN, callback: afterSecondThrower});
            await waitForPromisesToResolve();
            // A throw on the first delivery is pinned separately under the #834 change below.
            thrower.mockImplementation(() => {
                throw new Error('subscriber failure');
            });
            secondThrower.mockImplementation(() => {
                throw new Error('second failure');
            });

            await Onyx.set(KEYS.PLAIN, 2);
            await Onyx.set(KEYS.PLAIN, 3);
            await waitForPromisesToResolve();

            expect(deliveredValues(thrower)).toEqual([1, 2, 3]);
            expect(deliveredValues(sameKey)).toEqual([1, 2, 3]);
            expect(deliveredValues(secondThrower)).toEqual([1, 2, 3]);
            expect(deliveredValues(afterSecondThrower)).toEqual([1, 2, 3]);
        });

        it('does not stop member subscribers after a throwing root subscriber in a collection batch', async () => {
            const {Onyx} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const root = jest.fn();
            const member = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: root}), root);
            await connectAndSettle(() => Onyx.connect({key: REPORT_1, callback: member}), member);
            root.mockImplementation(() => {
                throw new Error('root failure');
            });

            await Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {name: 'x'}});
            await waitForPromisesToResolve();

            expect(root).toHaveBeenCalledTimes(1);
            expect(member.mock.calls).toEqual([[{id: 1, name: 'x'}, REPORT_1]]);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        // notifyKey hands its captured value to later listeners after a nested write already delivered a newer one.
        // main ended the default shared connection on 2 ([2, 2]); only a reuseConnection: false connection ended on 1.
        it('delivers a stale value last to later connections when an earlier subscriber writes the same key from its callback', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[KEYS.PLAIN]: 0}});
            Onyx.connect({
                key: KEYS.PLAIN,
                callback: (value: unknown) => {
                    if (value !== 1) {
                        return;
                    }
                    Onyx.set(KEYS.PLAIN, 2);
                },
            });
            const first = jest.fn();
            const second = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: first}), first);
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: second}), second);

            await Onyx.set(KEYS.PLAIN, 1);
            await waitForPromisesToResolve();

            expect(cache.get(KEYS.PLAIN)).toBe(2);
            expect(deliveredValues(first)).toEqual([2, 1]);
            expect(deliveredValues(second)).toEqual([2, 1]);
        });

        // The dispatch captures one collection snapshot, so a later root subscriber gets it after the nested newer one.
        it('delivers a stale collection last to a later root connection when an earlier root subscriber writes a member from its callback', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            Onyx.connect({
                key: KEYS.COLLECTION.REPORT,
                callback: (collection: Record<string, unknown> | undefined) => {
                    if (!collection || !(REPORT_2 in collection) || REPORT_3 in collection) {
                        return;
                    }
                    Onyx.set(REPORT_3, {id: 3});
                },
            });
            const later = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: later}), later);

            await Onyx.set(REPORT_2, {id: 2});
            await waitForPromisesToResolve();

            expect(Object.keys(cache.getCollectionData(KEYS.COLLECTION.REPORT) ?? {}).sort()).toEqual([REPORT_1, REPORT_2, REPORT_3]);
            expect(deliveredValues(later)).toEqual([
                {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}, [REPORT_3]: {id: 3}},
                {[REPORT_1]: {id: 1}, [REPORT_2]: {id: 2}},
            ]);
        });

        // Onyx.set skips deep-equal values, but multiSet re-notifies every subscriber of the key.
        it('re-notifies plain, member and root subscribers when multiSet writes a deep-equal value', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: {a: 1}, [REPORT_1]: {id: 1}}});
            const plain = jest.fn();
            const member = jest.fn();
            const root = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: KEYS.PLAIN, callback: plain}), plain);
            await connectAndSettle(() => Onyx.connect({key: REPORT_1, callback: member}), member);
            await connectAndSettle(() => Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: root}), root);

            await Onyx.multiSet({[KEYS.PLAIN]: {a: 1}, [REPORT_1]: {id: 1}});
            await waitForPromisesToResolve();

            expect(plain.mock.calls).toEqual([[{a: 1}, KEYS.PLAIN]]);
            expect(member.mock.calls).toEqual([[{id: 1}, REPORT_1]]);
            expect(root.mock.calls).toEqual([[{[REPORT_1]: {id: 1}}, KEYS.COLLECTION.REPORT]]);
        });

        // The writes are issued as set, mergeCollection, merge, yet the collection merge lands last.
        it('applies a mergeCollection issued before a merge of the same member after that merge', async () => {
            const {Onyx, cache} = await startOnyx({storedValues: {[REPORT_1]: {id: 1}}});
            const member = jest.fn();
            await connectAndSettle(() => Onyx.connect({key: REPORT_1, callback: member}), member);

            Onyx.set(REPORT_1, {id: 'a'});
            Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_1]: {name: 'b'}});
            Onyx.merge(REPORT_1, {name: 'c'});
            await waitForPromisesToResolve();

            expect(deliveredValues(member)).toEqual([{id: 'a'}, {id: 'a', name: 'c'}, {id: 'a', name: 'b'}]);
            expect(cache.get(REPORT_1)).toEqual({id: 'a', name: 'b'});
        });
    });

    describe('fixed by #834 (was a suspected bug)', () => {
        // main called the joiner twice with 2: once from the running dispatch and once from the deferred late-joiner delivery.
        it('delivers the value once to a subscriber that connects to the same key from inside a dispatch', async () => {
            const {Onyx} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const joiner = jest.fn();
            let hasJoined = false;
            Onyx.connect({
                key: KEYS.PLAIN,
                callback: (value: unknown) => {
                    if (value !== 2 || hasJoined) {
                        return;
                    }
                    hasJoined = true;
                    Onyx.connect({key: KEYS.PLAIN, callback: joiner});
                },
            });
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(joiner.mock.calls).toEqual([[2, KEYS.PLAIN]]);
        });
    });

    describe('current behaviour (#834 change)', () => {
        // main passed undefined as the key argument of the first delivery: [undefined, undefined].
        it('delivers the first write to a key that was missing at connect time', async () => {
            const {Onyx} = await startOnyx();
            const callback = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback});
            await waitForPromisesToResolve();

            await Onyx.set(KEYS.PLAIN, 'created');
            await waitForPromisesToResolve();

            expect(callback.mock.calls).toEqual([
                [undefined, KEYS.PLAIN],
                ['created', KEYS.PLAIN],
            ]);
        });

        // main caught a throw on the first delivery as well and logged it via Logger.logAlert.
        it('lets a throw on the first delivery escape unlogged, while a throw on a later write is caught and logged', async () => {
            const {Onyx, OnyxUtils} = await startOnyx({storedValues: {[KEYS.PLAIN]: 1}});
            const alerts: string[] = [];
            Onyx.registerLogger(({level, message}) => {
                if (level !== 'alert') {
                    return;
                }
                alerts.push(message);
            });
            const escaped: unknown[] = [];
            const scheduleInitialFire = OnyxUtils.scheduleInitialFire;
            jest.spyOn(OnyxUtils, 'scheduleInitialFire').mockImplementation((key, fire) =>
                scheduleInitialFire(key, () => {
                    try {
                        fire();
                    } catch (error) {
                        escaped.push(error);
                    }
                }),
            );
            const thrower = jest.fn(() => {
                throw new Error('subscriber failure');
            });
            const other = jest.fn();
            Onyx.connect({key: KEYS.PLAIN, callback: thrower});
            Onyx.connect({key: KEYS.PLAIN, callback: other});
            await waitForPromisesToResolve();

            expect(escaped).toEqual([new Error('subscriber failure')]);
            expect(alerts).toEqual([]);

            await Onyx.set(KEYS.PLAIN, 2);
            await waitForPromisesToResolve();

            expect(escaped).toHaveLength(1);
            expect(alerts).toEqual([`[Onyx] [OnyxSubscriptionManager] Listener threw an error for key '${KEYS.PLAIN}': Error: subscriber failure`]);
            expect(deliveredValues(thrower)).toEqual([1, 2]);
            expect(deliveredValues(other)).toEqual([1, 2]);
        });
    });
});
