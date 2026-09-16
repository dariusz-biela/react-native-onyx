import {act, render, screen} from '@testing-library/react-native';
import React, {StrictMode} from 'react';
import {Text} from 'react-native';
import type {OnyxEntry, OnyxKey, UseOnyxOptions} from '../../lib';
import Onyx, {useOnyx} from '../../lib';
import OnyxUtils from '../../lib/OnyxUtils';
import type {UseOnyxSelector} from '../../lib/useOnyx';
import waitForPromisesToResolve from '../utils/waitForPromisesToResolve';

const ONYXKEYS = {TEST_KEY: 'test'};

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

beforeEach(async () => {
    await Onyx.clear();
    selectorCalls = 0;
    results.length = 0;
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
