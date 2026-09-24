import React from 'react';
import {render} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import {ErrorBoundary, KEYS, SelectorProbe, committedValues, createRecorder, initContractOnyx, readField, settle, write} from './SelectorHarness';

initContractOnyx();

const selectorFailure = new Error('selector failed');

/** Throws while the stored `fail` flag is set, otherwise projects the name. */
const failingSelector: UseOnyxSelector<OnyxKey, unknown> = (value) => {
    if (readField(value, 'fail') === true) {
        throw selectorFailure;
    }
    return readField(value, 'name');
};

let consoleErrorSpy: jest.SpyInstance;

beforeEach(async () => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await Onyx.clear();
});

afterEach(() => {
    consoleErrorSpy.mockRestore();
});

describe('useOnyx when the selector throws', () => {
    it('forwards an error thrown during the first render to the nearest error boundary', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', fail: true});
        const onError = jest.fn();
        const recorder = createRecorder<unknown>();

        render(
            <ErrorBoundary onError={onError}>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={failingSelector}
                    recorder={recorder}
                />
            </ErrorBoundary>,
        );
        await settle();

        expect(onError).toHaveBeenCalledWith(selectorFailure);
        expect(recorder.commits).toHaveLength(0);
    });

    it('forwards an error thrown on an update to the nearest error boundary', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', fail: false});
        const onError = jest.fn();
        const recorder = createRecorder<unknown>();
        render(
            <ErrorBoundary onError={onError}>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={failingSelector}
                    recorder={recorder}
                />
            </ErrorBoundary>,
        );
        await settle();
        expect(onError).not.toHaveBeenCalled();

        await write(() => Onyx.merge(KEYS.PLAIN, {fail: true}));

        expect(onError).toHaveBeenCalledWith(selectorFailure);
        expect(committedValues(recorder)).toEqual(['a']);
    });

    it('keeps sibling hooks behind their own boundary working when one hook throws', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', fail: false});
        const safeSelector: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'name');
        const onError = jest.fn();
        const failing = createRecorder<unknown>();
        const safe = createRecorder<unknown>();
        render(
            <>
                <ErrorBoundary onError={onError}>
                    <SelectorProbe
                        onyxKey={KEYS.PLAIN}
                        selector={failingSelector}
                        recorder={failing}
                    />
                </ErrorBoundary>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={safeSelector}
                    recorder={safe}
                />
            </>,
        );
        await settle();

        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b', fail: true}));
        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'c'}));

        expect(onError).toHaveBeenCalledTimes(1);
        expect(committedValues(safe)).toEqual(['a', 'b', 'c']);
    });

    it('works again in a fresh mount after the data that made it throw is fixed', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', fail: true});
        const onError = jest.fn();
        const firstMount = createRecorder<unknown>();
        const {unmount} = render(
            <ErrorBoundary onError={onError}>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={failingSelector}
                    recorder={firstMount}
                />
            </ErrorBoundary>,
        );
        await settle();
        expect(onError).toHaveBeenCalledTimes(1);
        unmount();

        await write(() => Onyx.merge(KEYS.PLAIN, {fail: false, name: 'fixed'}));
        const secondMount = createRecorder<unknown>();
        render(
            <ErrorBoundary onError={onError}>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={failingSelector}
                    recorder={secondMount}
                />
            </ErrorBoundary>,
        );
        await settle();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(committedValues(secondMount)).toEqual(['fixed']);

        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'later'}));
        expect(committedValues(secondMount)).toEqual(['fixed', 'later']);
    });
});
