import {act, render, renderHook, screen} from '@testing-library/react-native';
import React from 'react';
import type {PropsWithChildren} from 'react';
import {Text} from 'react-native';
import type {OnyxEntry, OnyxKey} from '../../lib';
import Onyx, {useOnyx} from '../../lib';
import acquireSlot from '../../lib/OnyxSlots';
import type {UseOnyxSelector} from '../../lib/useOnyx';
import waitForPromisesToResolve from '../utils/waitForPromisesToResolve';

const TEST_KEY = 'slotLifecycle';
type TestValue = {value: number};

Onyx.init({keys: {TEST_KEY}});

const selectValue = ((value: OnyxEntry<TestValue>) => ({selected: value?.value})) as UseOnyxSelector<OnyxKey, {selected: number | undefined}>;

class ErrorBoundary extends React.Component<PropsWithChildren, {hasError: boolean}> {
    constructor(props: PropsWithChildren) {
        super(props);
        this.state = {hasError: false};
    }

    static getDerivedStateFromError() {
        return {hasError: true};
    }

    render() {
        return this.state.hasError ? <Text>Selector failed</Text> : this.props.children;
    }
}

beforeEach(async () => {
    await Onyx.clear();
});

it('passes a selector error during an update to the error boundary', async () => {
    await Onyx.set(TEST_KEY, {value: 1});
    const selector = ((value: OnyxEntry<TestValue>) => {
        if (value?.value === 2) {
            throw new Error('Invalid value');
        }
        return value?.value;
    }) as UseOnyxSelector<OnyxKey, number | undefined>;

    function Child() {
        const [value] = useOnyx(TEST_KEY, {selector});
        return <Text>{String(value)}</Text>;
    }

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
        render(
            <ErrorBoundary>
                <Child />
            </ErrorBoundary>,
        );
        await act(async () => waitForPromisesToResolve());
        expect(screen.getByText('1')).toBeTruthy();

        await act(async () => Onyx.merge(TEST_KEY, {value: 2}));

        expect(screen.queryByText('1')).toBeNull();
        expect(screen.getByText('Selector failed')).toBeTruthy();
    } finally {
        consoleError.mockRestore();
    }
});

it.each([undefined, false])('releases the last result after teardown with reuseConnection=%s', async (reuseConnection) => {
    await Onyx.set(TEST_KEY, {value: 1});
    const first = renderHook(() => useOnyx(TEST_KEY, {selector: selectValue, reuseConnection}));
    await act(async () => waitForPromisesToResolve());
    const previousResult = first.result.current;

    first.unmount();
    await act(async () => waitForPromisesToResolve());

    const second = renderHook(() => useOnyx(TEST_KEY, {selector: selectValue, reuseConnection}));
    await act(async () => waitForPromisesToResolve());

    expect(second.result.current).toEqual(previousResult);
    expect(second.result.current).not.toBe(previousResult);
    expect(second.result.current[0]).not.toBe(previousResult[0]);
});

it.each([undefined, false])('keeps result sharing while another slot is connected with reuseConnection=%s', async (reuseConnection) => {
    await Onyx.set(TEST_KEY, {value: 1});
    const first = renderHook(() => useOnyx(TEST_KEY, {selector: selectValue}));
    const otherSelector: typeof selectValue = (value) => selectValue(value);
    const second = renderHook(() => useOnyx(TEST_KEY, {selector: otherSelector, reuseConnection}));
    await act(async () => waitForPromisesToResolve());
    const previousResult = second.result.current;
    expect(first.result.current).toBe(previousResult);

    first.unmount();
    await act(async () => waitForPromisesToResolve());

    const third = renderHook(() => useOnyx(TEST_KEY, {selector: selectValue}));
    await act(async () => waitForPromisesToResolve());

    expect(third.result.current).toBe(previousResult);
    await act(async () => Onyx.merge(TEST_KEY, {value: 2}));
    expect(second.result.current[0]).toEqual({selected: 2});
    expect(third.result.current).toBe(second.result.current);
});

it("does not release another slot's result when a subscription is cleaned up twice in one tick", async () => {
    await Onyx.set(TEST_KEY, {value: 1});
    const retained = renderHook(() => useOnyx(TEST_KEY, {selector: selectValue}));
    await act(async () => waitForPromisesToResolve());
    const previousResult = retained.result.current;

    const slot = acquireSlot(TEST_KEY, selectValue, false);
    const onStoreChange = () => slot.getSnapshot();
    const unsubscribe = slot.subscribe(onStoreChange);
    unsubscribe();
    slot.subscribe(onStoreChange)();
    await act(async () => waitForPromisesToResolve());

    const otherSelector: typeof selectValue = (value) => selectValue(value);
    const next = renderHook(() => useOnyx(TEST_KEY, {selector: otherSelector}));
    await act(async () => waitForPromisesToResolve());

    expect(next.result.current).toBe(previousResult);
});
