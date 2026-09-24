import lodashCloneDeep from 'lodash/cloneDeep';
import isEqual from 'lodash/isEqual';

/** Returns the values a jest.fn connect callback received, in call order. */
function deliveredValues(callback: jest.Mock): unknown[] {
    return callback.mock.calls.map((call: unknown[]) => call[0]);
}

/**
 * Asserts that every delivered value is one of the states the key went through, in the order the
 * states happened, with no repeats, and that the last delivered value is the final state.
 * An optimizer may skip intermediate states but may never deliver a stale or reordered one.
 */
function expectOrderedSubsequenceOfStates(delivered: unknown[], states: unknown[]): void {
    expect(delivered.length).toBeGreaterThan(0);

    let previousStateIndex = -1;
    for (const [deliveryIndex, value] of delivered.entries()) {
        const stateIndex = states.findIndex((state, index) => index > previousStateIndex && isEqual(state, value));
        if (stateIndex === -1) {
            throw new Error(`Delivery #${deliveryIndex} ${JSON.stringify(value)} is stale, repeated or unknown. Deliveries: ${JSON.stringify(delivered)}, states: ${JSON.stringify(states)}`);
        }
        previousStateIndex = stateIndex;
    }

    expect(delivered.at(-1)).toEqual(states.at(-1));
}

type DeliveryRecord = {value: unknown; stateAtDelivery: unknown};

/** Creates a connect callback that also records what the store held at the moment of each delivery. */
function recordDeliveriesAgainstState(readState: () => unknown) {
    const records: DeliveryRecord[] = [];
    const callback = jest.fn((value: unknown) => {
        records.push({value: lodashCloneDeep(value), stateAtDelivery: lodashCloneDeep(readState())});
    });
    return {callback, records};
}

/**
 * Asserts that no delivery was stale: each value equals what the store held when it was delivered,
 * two consecutive deliveries never carry the same value, and the last one equals the final state.
 */
function expectNoStaleOrRepeatedDelivery(records: DeliveryRecord[], finalState: unknown): void {
    expect(records.length).toBeGreaterThan(0);
    for (const [index, record] of records.entries()) {
        expect({index, value: record.value}).toEqual({index, value: record.stateAtDelivery});
        if (index > 0) {
            expect({index, value: record.value}).not.toEqual({index, value: records[index - 1].value});
        }
    }
    expect(records.at(-1)?.value).toEqual(finalState);
}

export {deliveredValues, expectOrderedSubsequenceOfStates, recordDeliveriesAgainstState, expectNoStaleOrRepeatedDelivery};

// Jest collects every file under tests/unit as a suite, so this helper checks itself only when run as the suite.
if (expect.getState().testPath === __filename) {
    describe('expectOrderedSubsequenceOfStates', () => {
        it('accepts skipped intermediate states', () => {
            expect(() => expectOrderedSubsequenceOfStates([{v: 1}, {v: 3}], [{v: 1}, {v: 2}, {v: 3}])).not.toThrow();
        });

        it.each([
            ['a stale value after a newer one', [2, 1, 3]],
            ['a repeated value', [1, 1, 3]],
            ['a value that never existed', [1, 4, 3]],
            ['a final value that is not the last state', [1, 2]],
        ])('rejects %s', (_label, delivered) => {
            expect(() => expectOrderedSubsequenceOfStates(delivered, [1, 2, 3])).toThrow();
        });

        it('rejects no delivery at all', () => {
            expect(() => expectOrderedSubsequenceOfStates([], [1])).toThrow();
        });
    });

    describe('expectNoStaleOrRepeatedDelivery', () => {
        it('accepts deliveries that match the state at delivery time', () => {
            expect(() =>
                expectNoStaleOrRepeatedDelivery(
                    [
                        {value: 1, stateAtDelivery: 1},
                        {value: 2, stateAtDelivery: 2},
                    ],
                    2,
                ),
            ).not.toThrow();
        });

        it.each([
            ['a stale delivery', [{value: 1, stateAtDelivery: 2}], 2],
            [
                'a repeated delivery',
                [
                    {value: 2, stateAtDelivery: 2},
                    {value: 2, stateAtDelivery: 2},
                ],
                2,
            ],
            ['a wrong final value', [{value: 1, stateAtDelivery: 1}], 2],
        ])('rejects %s', (_label, records, finalState) => {
            expect(() => expectNoStaleOrRepeatedDelivery(records, finalState)).toThrow();
        });
    });
}
