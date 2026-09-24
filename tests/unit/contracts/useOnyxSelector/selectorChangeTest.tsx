import React, {useLayoutEffect} from 'react';
import {act, render, renderHook} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import {KEYS, initContractOnyx, readField, settle, write} from './SelectorHarness';

initContractOnyx();

type Login = {login: unknown};

const loginSelectors = new Map<number, UseOnyxSelector<OnyxKey, Login>>();

/** Stable per account, like a factory selector memoized by the React Compiler at the call site. */
function getLoginSelector(accountID: number): UseOnyxSelector<OnyxKey, Login> {
    const existing = loginSelectors.get(accountID);
    if (existing) {
        return existing;
    }
    const selector: UseOnyxSelector<OnyxKey, Login> = (list) => ({login: readField(readField(list, String(accountID)), 'login')});
    loginSelectors.set(accountID, selector);
    return selector;
}

type AccountCommit = {accountID: number; value: Login | undefined};

type AccountProbeProps = {
    accountID: number;
    commits: AccountCommit[];
};

function AccountProbe({accountID, commits}: AccountProbeProps) {
    const [value] = useOnyx(KEYS.PLAIN, {selector: getLoginSelector(accountID)});

    useLayoutEffect(() => {
        commits.push({accountID, value});
    });

    return null;
}

type OptionalSelectorProps = {selector?: UseOnyxSelector<OnyxKey, unknown>};

type KeyAndSelectorProps = {onyxKey: OnyxKey; selector: UseOnyxSelector<OnyxKey, unknown>};

const PEOPLE = {
    '1': {login: 'one@test.com'},
    '2': {login: 'two@test.com'},
    '3': {login: 'three@test.com'},
};

beforeEach(async () => {
    await Onyx.clear();
});

describe('useOnyx when the selector changes between renders', () => {
    it('never commits the output of the previous selector together with the new props', async () => {
        await Onyx.set(KEYS.PLAIN, PEOPLE);
        const commits: AccountCommit[] = [];
        const {rerender} = render(
            <AccountProbe
                accountID={1}
                commits={commits}
            />,
        );
        await settle();

        rerender(
            <AccountProbe
                accountID={2}
                commits={commits}
            />,
        );
        rerender(
            <AccountProbe
                accountID={3}
                commits={commits}
            />,
        );
        rerender(
            <AccountProbe
                accountID={1}
                commits={commits}
            />,
        );

        for (const commit of commits) {
            expect(commit.value).toEqual({login: `${['one', 'two', 'three'][commit.accountID - 1]}@test.com`});
        }
        expect(commits.map(({accountID}) => accountID)).toEqual([1, 2, 3, 1]);
    });

    it('applies the new selector to data written after the switch', async () => {
        await Onyx.set(KEYS.PLAIN, PEOPLE);
        const commits: AccountCommit[] = [];
        const {rerender} = render(
            <AccountProbe
                accountID={1}
                commits={commits}
            />,
        );
        await settle();

        rerender(
            <AccountProbe
                accountID={2}
                commits={commits}
            />,
        );
        await write(() => Onyx.merge(KEYS.PLAIN, {'1': {login: 'one-changed@test.com'}}));
        await write(() => Onyx.merge(KEYS.PLAIN, {'2': {login: 'two-changed@test.com'}}));

        expect(commits.at(-1)).toEqual({accountID: 2, value: {login: 'two-changed@test.com'}});
        expect(commits.some(({value}) => value?.login === 'one-changed@test.com')).toBe(false);
    });

    it('stops calling the previous selector once it has been replaced', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        const oldSelector = jest.fn((value: unknown) => readField(value, 'name'));
        const newSelector = jest.fn((value: unknown) => readField(value, 'count'));
        const {result, rerender} = renderHook((selector: UseOnyxSelector<OnyxKey, unknown>) => useOnyx(KEYS.PLAIN, {selector}), {initialProps: oldSelector});
        await settle();

        rerender(newSelector);
        const oldCallsAfterSwitch = oldSelector.mock.calls.length;
        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));
        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));

        expect(result.current[0]).toBe(2);
        expect(oldSelector.mock.calls.length).toBe(oldCallsAfterSwitch);
        expect(newSelector).toHaveBeenLastCalledWith({name: 'b', count: 2});
    });

    it('returns the raw value after the selector is removed and the selected value after it is added back', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', count: 1});
        const selector: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'name');
        const initialProps: OptionalSelectorProps = {selector};
        const {result, rerender} = renderHook((props: OptionalSelectorProps) => useOnyx(KEYS.PLAIN, {selector: props.selector}), {initialProps});
        await settle();
        expect(result.current[0]).toBe('a');

        rerender({});
        expect(result.current[0]).toEqual({name: 'a', count: 1});

        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));
        expect(result.current[0]).toEqual({name: 'b', count: 1});

        rerender({selector});
        expect(result.current[0]).toBe('b');
        expect(result.current[1].status).toBe('loaded');
    });

    it('returns the right output when the key and the selector change in the same render', async () => {
        await Onyx.multiSet({[KEYS.PLAIN]: {name: 'plain', count: 1}, [KEYS.OTHER]: {name: 'other', count: 2}});
        const selectName: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'name');
        const selectCount: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'count');
        const initialProps: KeyAndSelectorProps = {onyxKey: KEYS.PLAIN, selector: selectName};
        const {result, rerender} = renderHook(({onyxKey, selector}: KeyAndSelectorProps) => useOnyx(onyxKey, {selector}), {initialProps});
        await settle();

        rerender({onyxKey: KEYS.OTHER, selector: selectCount});

        expect(result.current[0]).toBe(2);
        expect(result.current[1].status).toBe('loaded');

        await settle();
        await write(() => Onyx.merge(KEYS.OTHER, {count: 3}));
        await write(() => Onyx.merge(KEYS.PLAIN, {count: 9}));

        expect(result.current[0]).toBe(3);
    });

    it('lands on the new selector output when the switch and a write happen in the same act', async () => {
        await Onyx.set(KEYS.PLAIN, PEOPLE);
        const commits: AccountCommit[] = [];
        const {rerender} = render(
            <AccountProbe
                accountID={1}
                commits={commits}
            />,
        );
        await settle();

        await act(async () => {
            const pendingMerge = Onyx.merge(KEYS.PLAIN, {'2': {login: 'two-changed@test.com'}});
            rerender(
                <AccountProbe
                    accountID={2}
                    commits={commits}
                />,
            );
            await pendingMerge;
            await waitForPromisesToResolve();
        });

        expect(commits.at(-1)).toEqual({accountID: 2, value: {login: 'two-changed@test.com'}});
        for (const commit of commits) {
            const validLogins = commit.accountID === 1 ? ['one@test.com'] : ['two@test.com', 'two-changed@test.com'];
            expect(validLogins).toContain(commit.value?.login);
        }
    });

    it('returns a correct output after switching to a selector whose output is deep equal to the previous one', async () => {
        await Onyx.set(KEYS.PLAIN, {name: 'a', alias: 'a'});
        const selectName: UseOnyxSelector<OnyxKey, {value: unknown}> = (value) => ({value: readField(value, 'name')});
        const selectAlias: UseOnyxSelector<OnyxKey, {value: unknown}> = (value) => ({value: readField(value, 'alias')});
        const {result, rerender} = renderHook((selector: UseOnyxSelector<OnyxKey, {value: unknown}>) => useOnyx(KEYS.PLAIN, {selector}), {initialProps: selectName});
        await settle();

        rerender(selectAlias);
        expect(result.current[0]).toEqual({value: 'a'});

        await write(() => Onyx.merge(KEYS.PLAIN, {name: 'b'}));
        expect(result.current[0]).toEqual({value: 'a'});

        await write(() => Onyx.merge(KEYS.PLAIN, {alias: 'c'}));
        expect(result.current[0]).toEqual({value: 'c'});
    });
});
