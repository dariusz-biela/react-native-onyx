import {act, render, renderHook, screen} from '@testing-library/react-native';
import React, {Suspense} from 'react';
import type {PropsWithChildren} from 'react';
import {Text} from 'react-native';
import v8 from 'v8';
import vm from 'vm';
import type {OnyxEntry, OnyxKey} from '../../lib';
import Onyx, {useOnyx} from '../../lib';
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

/** Runs a full garbage collection, which Node only exposes behind a V8 flag that can be set at runtime. */
async function collectGarbage(): Promise<void> {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    gc();
    await waitForPromisesToResolve();
    gc();
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

it('does not retain the slot of a render that React discarded', async () => {
    await Onyx.set(TEST_KEY, {value: 1});
    const selectorRefs: Array<WeakRef<object>> = [];
    let isResolved = false;
    let resolveSuspension = (): void => undefined;
    const suspension = new Promise<void>((resolve) => {
        resolveSuspension = () => {
            isResolved = true;
            resolve();
        };
    });

    // Suspends after the hook ran, so the slot created for this render's selector is never subscribed to.
    function SuspendingChild() {
        const selector = (value: OnyxEntry<TestValue>) => value?.value;
        selectorRefs.push(new WeakRef(selector));
        const [value] = useOnyx(TEST_KEY, {selector: selector as UseOnyxSelector<OnyxKey, number | undefined>});
        if (!isResolved) {
            throw suspension;
        }
        return <Text>{String(value)}</Text>;
    }

    render(
        <Suspense fallback={<Text>Suspended</Text>}>
            <SuspendingChild />
        </Suspense>,
    );
    expect(JSON.stringify(screen.toJSON())).toContain('Suspended');

    await act(async () => {
        resolveSuspension();
        await waitForPromisesToResolve();
    });
    // Queried through the JSON tree because the RNTL queries trip over the discarded Suspense fallback fiber.
    expect(JSON.stringify(screen.toJSON())).toContain('"1"');

    const discardedSelectors = selectorRefs.slice(0, -1);
    expect(discardedSelectors.length).toBeGreaterThan(0);

    await collectGarbage();

    expect(discardedSelectors.map((ref) => ref.deref())).toEqual(discardedSelectors.map(() => undefined));
    expect(selectorRefs.at(-1)?.deref()).toBeDefined();
});
