import React from 'react';
import {render} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import type {OnyxKey} from '../../../../lib';
import {KEYS, SelectorProbe, committedValues, createRecorder, createRecorders, initContractOnyx, lastCommit, readField, renderCounts, settle, write} from './SelectorHarness';

initContractOnyx();

const PERSON_COUNT = 6;

type Login = {login: unknown};

/** One selector per person, built once so its identity is stable, like `personalDetailsLoginSelector(accountID)` in the App. */
function createLoginSelector(accountID: number): UseOnyxSelector<OnyxKey, Login> {
    return (list) => ({login: readField(readField(list, String(accountID)), 'login')});
}

const LOGIN_SELECTORS = Array.from({length: PERSON_COUNT}, (value, index) => createLoginSelector(index + 1));

function buildPersonalDetails(): Record<string, {login: string; displayName: string}> {
    const list: Record<string, {login: string; displayName: string}> = {};
    for (let accountID = 1; accountID <= PERSON_COUNT; accountID++) {
        list[String(accountID)] = {login: `user${accountID}@test.com`, displayName: `User ${accountID}`};
    }
    return list;
}

beforeEach(async () => {
    await Onyx.clear();
});

describe('useOnyx with a different selector per hook instance on the same key', () => {
    it('gives every hook the output of its own selector', async () => {
        await Onyx.set(KEYS.PLAIN, buildPersonalDetails());
        const recorders = createRecorders<Login>(PERSON_COUNT);

        render(
            <>
                {recorders.map((recorder, index) => (
                    <SelectorProbe
                        key={recorder.id}
                        onyxKey={KEYS.PLAIN}
                        selector={LOGIN_SELECTORS[index]}
                        recorder={recorder}
                    />
                ))}
            </>,
        );
        await settle();

        for (const [index, recorder] of recorders.entries()) {
            expect(committedValues(recorder)).toEqual([{login: `user${index + 1}@test.com`}]);
        }
    });

    it('re-renders only the hook whose selected person changed, exactly once', async () => {
        await Onyx.set(KEYS.PLAIN, buildPersonalDetails());
        const recorders = createRecorders<Login>(PERSON_COUNT);
        render(
            <>
                {recorders.map((recorder, index) => (
                    <SelectorProbe
                        key={recorder.id}
                        onyxKey={KEYS.PLAIN}
                        selector={LOGIN_SELECTORS[index]}
                        recorder={recorder}
                    />
                ))}
            </>,
        );
        await settle();
        const rendersBefore = renderCounts(recorders);
        const resultsBefore = recorders.map((recorder) => lastCommit(recorder));

        await write(() => Onyx.merge(KEYS.PLAIN, {'3': {login: 'changed@test.com'}}));

        for (const [index, recorder] of recorders.entries()) {
            if (index === 2) {
                expect(recorder.renders.length - rendersBefore[index]).toBe(1);
                expect(lastCommit(recorder)[0]).toEqual({login: 'changed@test.com'});
                continue;
            }
            expect(recorder.renders.length).toBe(rendersBefore[index]);
            expect(lastCommit(recorder)).toBe(resultsBefore[index]);
        }
    });

    it('does not re-render any hook when a field no selector reads changes', async () => {
        await Onyx.set(KEYS.PLAIN, buildPersonalDetails());
        const recorders = createRecorders<Login>(PERSON_COUNT);
        render(
            <>
                {recorders.map((recorder, index) => (
                    <SelectorProbe
                        key={recorder.id}
                        onyxKey={KEYS.PLAIN}
                        selector={LOGIN_SELECTORS[index]}
                        recorder={recorder}
                    />
                ))}
            </>,
        );
        await settle();
        const rendersBefore = renderCounts(recorders);

        await write(() => Onyx.merge(KEYS.PLAIN, {'1': {displayName: 'Renamed'}, '4': {displayName: 'Renamed too'}}));

        expect(renderCounts(recorders)).toEqual(rendersBefore);
    });

    it('never hands one selector the result of another selector on the same key, even when both outputs are shallow-equal objects', async () => {
        await Onyx.set(KEYS.PLAIN, {first: {value: 1}, second: {value: 1}});
        const selectFirst: UseOnyxSelector<OnyxKey, {value: unknown}> = (data) => ({value: readField(readField(data, 'first'), 'value')});
        const selectSecond: UseOnyxSelector<OnyxKey, {value: unknown}> = (data) => ({value: readField(readField(data, 'second'), 'value')});
        const first = createRecorder<{value: unknown}>();
        const second = createRecorder<{value: unknown}>();
        render(
            <>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectFirst}
                    recorder={first}
                />
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={selectSecond}
                    recorder={second}
                />
            </>,
        );
        await settle();

        await write(() => Onyx.merge(KEYS.PLAIN, {second: {value: 2}}));
        await write(() => Onyx.merge(KEYS.PLAIN, {first: {value: 3}}));

        expect(committedValues(first)).toEqual([{value: 1}, {value: 3}]);
        expect(committedValues(second)).toEqual([{value: 1}, {value: 2}]);
    });

    it('keeps two separately built selectors with the same logic independent and correct', async () => {
        await Onyx.set(KEYS.PLAIN, buildPersonalDetails());
        const selectorA = createLoginSelector(1);
        const selectorB = createLoginSelector(1);
        const recorderA = createRecorder<Login>();
        const recorderB = createRecorder<Login>();
        const {rerender} = render(
            <>
                <SelectorProbe
                    key={recorderA.id}
                    onyxKey={KEYS.PLAIN}
                    selector={selectorA}
                    recorder={recorderA}
                />
                <SelectorProbe
                    key={recorderB.id}
                    onyxKey={KEYS.PLAIN}
                    selector={selectorB}
                    recorder={recorderB}
                />
            </>,
        );
        await settle();

        await write(() => Onyx.merge(KEYS.PLAIN, {'1': {login: 'new@test.com'}}));
        rerender(
            <SelectorProbe
                key={recorderB.id}
                onyxKey={KEYS.PLAIN}
                selector={selectorB}
                recorder={recorderB}
            />,
        );
        await write(() => Onyx.merge(KEYS.PLAIN, {'1': {login: 'newer@test.com'}}));

        expect(committedValues(recorderA)).toEqual([{login: 'user1@test.com'}, {login: 'new@test.com'}]);
        expect(committedValues(recorderB)).toEqual([{login: 'user1@test.com'}, {login: 'new@test.com'}, {login: 'newer@test.com'}]);
    });

    it('serves hooks with and without a selector on the same key from the same data', async () => {
        await Onyx.set(KEYS.PLAIN, buildPersonalDetails());
        const withSelector = createRecorder<Login>();
        const withoutSelector = createRecorder<unknown>();
        render(
            <>
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={LOGIN_SELECTORS[0]}
                    recorder={withSelector}
                />
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    recorder={withoutSelector}
                />
            </>,
        );
        await settle();
        const selectedBefore = lastCommit(withSelector);

        await write(() => Onyx.merge(KEYS.PLAIN, {'2': {login: 'two@test.com'}}));

        expect(lastCommit(withSelector)).toBe(selectedBefore);
        expect(readField(readField(lastCommit(withoutSelector)[0], '2'), 'login')).toBe('two@test.com');
        expect(withoutSelector.commits).toHaveLength(2);

        await write(() => Onyx.merge(KEYS.PLAIN, {'1': {login: 'one@test.com'}}));

        expect(lastCommit(withSelector)[0]).toEqual({login: 'one@test.com'});
        expect(readField(readField(lastCommit(withoutSelector)[0], '1'), 'login')).toBe('one@test.com');
    });
});
