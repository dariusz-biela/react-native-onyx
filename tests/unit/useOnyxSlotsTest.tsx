import {act, render, screen} from '@testing-library/react-native';
import React, {StrictMode, useEffect, useState} from 'react';
import {Text} from 'react-native';
import type {OnyxEntry, OnyxKey, UseOnyxOptions} from '../../lib';
import Onyx, {useOnyx} from '../../lib';
import OnyxUtils from '../../lib/OnyxUtils';
import type {UseOnyxSelector} from '../../lib/useOnyx';
import waitForPromisesToResolve from '../utils/waitForPromisesToResolve';

const ONYXKEYS = {TEST_KEY: 'test', OTHER_KEY: 'other'};

Onyx.init({keys: ONYXKEYS});

type TestValue = {a: number; b: number};

let selectorCalls = 0;
const sharedSelector = ((value: OnyxEntry<TestValue>) => {
    selectorCalls++;
    return value?.a;
}) as UseOnyxSelector<OnyxKey, number | undefined>;

const results: unknown[] = [];

function Child({options}: {options: UseOnyxOptions<OnyxKey, number | undefined>}) {
    const result = useOnyx(ONYXKEYS.TEST_KEY, options);
    results.push(result);
    return <Text>{String(result[0])}</Text>;
}

type NestedValue = {nested: {a: number | undefined}};

/** Allocates a fresh selector and a fresh nested output on every call, which no shallow comparison can dedupe. */
function selectNested(value: OnyxEntry<TestValue>): NestedValue {
    return {nested: {a: value?.a}};
}

function NestedChild({onyxKey = ONYXKEYS.TEST_KEY}: {onyxKey?: string}) {
    // eslint-disable-next-line rulesdir/no-inline-useOnyx-selector -- the test needs a selector reference that changes every render
    const result = useOnyx(onyxKey, {selector: (value) => selectNested(value as OnyxEntry<TestValue>)});
    results.push(result);
    return <Text>{String(result[0]?.nested.a)}</Text>;
}

const MAX_EFFECT_RUNS = 20;
let effectRuns = 0;

/** Mirrors a component whose effect reacts to the selected value and updates its own state. */
function EffectChild() {
    // eslint-disable-next-line rulesdir/no-inline-useOnyx-selector -- the test needs a selector reference that changes every render
    const [value] = useOnyx(ONYXKEYS.TEST_KEY, {selector: (data) => selectNested(data as OnyxEntry<TestValue>)});
    const [, setTick] = useState(0);
    useEffect(() => {
        effectRuns++;
        if (effectRuns < MAX_EFFECT_RUNS) {
            setTick((tick) => tick + 1);
        }
    }, [value]);
    return <Text>{String(value?.nested.a)}</Text>;
}

beforeEach(async () => {
    await Onyx.clear();
    selectorCalls = 0;
    results.length = 0;
    effectRuns = 0;
});

describe('unstable selector reference', () => {
    it('keeps the result identity across renders when the selected data is deep-equal', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        const {rerender} = render(<NestedChild />);
        await act(async () => waitForPromisesToResolve());
        for (let i = 0; i < 5; i++) {
            rerender(<NestedChild />);
        }
        await act(async () => waitForPromisesToResolve());

        expect(results.length).toBeGreaterThanOrEqual(6);
        expect(results[0]).toEqual([{nested: {a: 1}}, {status: 'loaded'}]);
        expect(results.every((result) => result === results[0])).toBe(true);
    });

    it('keeps the result identity across renders when the selected data is undefined', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        const {rerender} = render(<Child options={{selector: (value) => (value as {missing?: number} | undefined)?.missing}} />);
        await act(async () => waitForPromisesToResolve());
        for (let i = 0; i < 5; i++) {
            rerender(<Child options={{selector: (value) => (value as {missing?: number} | undefined)?.missing}} />);
        }
        await act(async () => waitForPromisesToResolve());

        expect(results.length).toBeGreaterThanOrEqual(6);
        expect(results[0]).toEqual([undefined, {status: 'loaded'}]);
        expect(results.every((result) => result === results[0])).toBe(true);
    });

    it('does not loop through an effect that updates state when the selected value changes identity', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        render(<EffectChild />);
        await act(async () => waitForPromisesToResolve());

        expect(effectRuns).toBe(1);
        expect(screen.getByText('1')).toBeTruthy();
    });

    it('publishes a new result when the selected data changes', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        const {rerender} = render(<NestedChild />);
        await act(async () => waitForPromisesToResolve());
        rerender(<NestedChild />);
        await act(async () => Onyx.merge(ONYXKEYS.TEST_KEY, {b: 3}));
        expect(screen.getByText('1')).toBeTruthy();
        const resultBeforeChange = results.at(-1);

        await act(async () => Onyx.merge(ONYXKEYS.TEST_KEY, {a: 2}));
        rerender(<NestedChild />);
        await act(async () => waitForPromisesToResolve());

        expect(screen.getByText('2')).toBeTruthy();
        expect(results.at(-1)).not.toBe(resultBeforeChange);
        expect(results.at(-1)).toEqual([{nested: {a: 2}}, {status: 'loaded'}]);
    });

    it('reads the new key instead of the previous result when the key changes', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});
        await Onyx.set(ONYXKEYS.OTHER_KEY, {a: 5, b: 2});

        const {rerender} = render(<NestedChild />);
        await act(async () => waitForPromisesToResolve());
        rerender(<NestedChild onyxKey={ONYXKEYS.OTHER_KEY} />);
        await act(async () => waitForPromisesToResolve());

        expect(screen.getByText('5')).toBeTruthy();
    });
});

describe('slot sharing', () => {
    it('runs a shared selector once per change and hands every hook the same result', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        render(
            <>
                <Child options={{selector: sharedSelector}} />
                <Child options={{selector: sharedSelector}} />
                <Child options={{selector: sharedSelector}} />
            </>,
        );
        await act(async () => waitForPromisesToResolve());

        selectorCalls = 0;
        results.length = 0;
        await act(async () => Onyx.merge(ONYXKEYS.TEST_KEY, {a: 5}));

        expect(selectorCalls).toBe(1);
        expect(results).toHaveLength(3);
        expect(results[0]).toBe(results[1]);
        expect(results[1]).toBe(results[2]);
        expect(screen.getAllByText('5')).toHaveLength(3);
    });

    it('runs a shared selector once and re-renders nothing when the selected data is unchanged', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        render(
            <>
                <Child options={{selector: sharedSelector}} />
                <Child options={{selector: sharedSelector}} />
            </>,
        );
        await act(async () => waitForPromisesToResolve());

        selectorCalls = 0;
        results.length = 0;
        await act(async () => Onyx.merge(ONYXKEYS.TEST_KEY, {b: 99}));

        expect(selectorCalls).toBe(1);
        // The selected value didn't change, so nothing re-rendered.
        expect(results).toHaveLength(0);
    });

    it('keeps working after every subscriber unmounts and a new one mounts', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        const {unmount} = render(<Child options={{selector: sharedSelector}} />);
        await act(async () => waitForPromisesToResolve());
        expect(screen.getByText('1')).toBeTruthy();

        unmount();
        await act(async () => Onyx.merge(ONYXKEYS.TEST_KEY, {a: 7}));

        render(<Child options={{selector: sharedSelector}} />);
        await act(async () => waitForPromisesToResolve());
        expect(screen.getByText('7')).toBeTruthy();
    });
});

describe('reuseConnection: false', () => {
    it('loads and updates on its own connection', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        render(
            <>
                <Child options={{selector: sharedSelector, reuseConnection: false}} />
                <Child options={{selector: sharedSelector, reuseConnection: false}} />
            </>,
        );
        await act(async () => waitForPromisesToResolve());
        expect(screen.getAllByText('1')).toHaveLength(2);

        await act(async () => Onyx.merge(ONYXKEYS.TEST_KEY, {a: 3}));
        expect(screen.getAllByText('3')).toHaveLength(2);
    });
});

describe('StrictMode', () => {
    it('survives the mount, unmount and remount of its subscription', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        render(
            <StrictMode>
                <Child options={{selector: sharedSelector}} />
                <Child options={{selector: sharedSelector}} />
            </StrictMode>,
        );
        await act(async () => waitForPromisesToResolve());
        expect(screen.getAllByText('1')).toHaveLength(2);

        await act(async () => Onyx.merge(ONYXKEYS.TEST_KEY, {a: 4}));
        expect(screen.getAllByText('4')).toHaveLength(2);
    });
});

describe('connection reuse', () => {
    it('does not rebuild the Onyx subscription when the selector reference changes every render', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        const {rerender} = render(<Child options={{selector: (value) => (value as TestValue | undefined)?.a}} />);
        await act(async () => waitForPromisesToResolve());

        const subscribeSpy = jest.spyOn(OnyxUtils, 'subscribeToKey');
        for (let i = 0; i < 5; i++) {
            rerender(<Child options={{selector: (value) => (value as TestValue | undefined)?.a}} />);
        }
        await act(async () => waitForPromisesToResolve());

        // Each render swaps the slot, but the connection behind it must survive.
        expect(subscribeSpy).not.toHaveBeenCalled();
        expect(screen.getByText('1')).toBeTruthy();
        subscribeSpy.mockRestore();
    });

    it('reuses the connection when a component unmounts and remounts in the same tick', async () => {
        await Onyx.set(ONYXKEYS.TEST_KEY, {a: 1, b: 2});

        const {unmount} = render(<Child options={{selector: sharedSelector}} />);
        await act(async () => waitForPromisesToResolve());

        const subscribeSpy = jest.spyOn(OnyxUtils, 'subscribeToKey');
        unmount();
        render(<Child options={{selector: sharedSelector}} />);
        await act(async () => waitForPromisesToResolve());

        expect(subscribeSpy).not.toHaveBeenCalled();
        expect(screen.getByText('1')).toBeTruthy();
        subscribeSpy.mockRestore();
    });
});
