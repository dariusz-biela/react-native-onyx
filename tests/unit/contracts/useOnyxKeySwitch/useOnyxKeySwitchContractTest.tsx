import React from 'react';
import {act, render, renderHook} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import StorageMock from '../../../../lib/storage';
import cache from '../../../../lib/OnyxCache';
import onyxSnapshotCache from '../../../../lib/OnyxSnapshotCache';
import type {FetchStatus, UseOnyxResult} from '../../../../lib/useOnyx';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

const ONYXKEYS = {
    KEY_A: 'keyA',
    KEY_B: 'keyB',
    COLLECTION: {
        MEMBER: 'member_',
        MEMBER_NESTED: 'member_nested_',
        OTHER: 'other_',
    },
};

const COLLECTION_ROOTS: readonly string[] = Object.values(ONYXKEYS.COLLECTION);

const MEMBER_1 = `${ONYXKEYS.COLLECTION.MEMBER}1`;
const MEMBER_2 = `${ONYXKEYS.COLLECTION.MEMBER}2`;
const NESTED_1 = `${ONYXKEYS.COLLECTION.MEMBER_NESTED}1`;

Onyx.init({keys: ONYXKEYS});

type OwnedValue = {
    owner: string;
    rev?: number;
    [field: string]: unknown;
};

type RenderEntry = {
    key: string;
    value: unknown;
    status: FetchStatus;
};

function isOwnedValue(value: unknown): value is OwnedValue {
    return typeof value === 'object' && value !== null && 'owner' in value && typeof value.owner === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let coldKeyCounter = 0;

// Keys never written through Onyx in any test, so storage is their only source.
function nextColdKey(): string {
    coldKeyCounter += 1;
    return `coldKey${coldKeyCounter}`;
}

// Mirrors a key that Onyx listed from storage at startup but has not read into memory yet.
async function seedColdKey(key: string, value: unknown) {
    await StorageMock.setItem(key, value);
    cache.addKey(key);
}

function owned(key: string, rev = 1): OwnedValue {
    return {owner: key, rev};
}

// Each call returns a new function, like a selector written inline in a component.
function createOwnerNameSelector() {
    return (value: unknown) => (isOwnedValue(value) ? `${value.owner}:${String(value.name)}` : 'none');
}

function createSuffixSelector(field: string, suffix: string) {
    return (value: unknown) => (isOwnedValue(value) ? `${String(value[field])}${suffix}` : suffix);
}

function createRenderLog() {
    const entries: RenderEntry[] = [];

    function record<TValue>(key: string, result: UseOnyxResult<TValue>): UseOnyxResult<TValue> {
        entries.push({key, value: result[0], status: result[1].status});
        return result;
    }

    function since(index: number): RenderEntry[] {
        return entries.slice(index);
    }

    return {entries, record, since};
}

// Values are tagged with the key they were written under, so data rendered under another key is detectable.
function findForeignData(entry: RenderEntry): string | undefined {
    const {key, value} = entry;
    if (value === undefined || value === null) {
        return undefined;
    }

    if (isOwnedValue(value)) {
        return value.owner === key ? undefined : value.owner;
    }

    if (!COLLECTION_ROOTS.includes(key) || !isPlainObject(value)) {
        return undefined;
    }

    const longerRoots = COLLECTION_ROOTS.filter((root) => root !== key && root.startsWith(key));
    for (const [memberKey, member] of Object.entries(value)) {
        const belongsToRoot = memberKey.startsWith(key) && !longerRoots.some((root) => memberKey.startsWith(root));
        if (!belongsToRoot) {
            return memberKey;
        }
        if (isOwnedValue(member) && member.owner !== memberKey) {
            return member.owner;
        }
    }

    return undefined;
}

function expectNoForeignData(entries: RenderEntry[]) {
    const offending = entries.map((entry) => ({entry, foreign: findForeignData(entry)})).filter(({foreign}) => foreign !== undefined);
    expect(offending).toEqual([]);
}

function expectLoadingOnlyWithoutValue(entries: RenderEntry[]) {
    const loadingWithValue = entries.filter((entry) => entry.status === 'loading' && entry.value !== undefined);
    expect(loadingWithValue).toEqual([]);
}

function expectValidRenders(entries: RenderEntry[]) {
    expectNoForeignData(entries);
    expectLoadingOnlyWithoutValue(entries);
}

function revisionsOf(entries: RenderEntry[]): number[] {
    return entries.flatMap((entry) => (isOwnedValue(entry.value) && entry.value.rev !== undefined ? [entry.value.rev] : []));
}

function expectNonDecreasing(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
}

async function settle() {
    await act(async () => waitForPromisesToResolve());
}

beforeEach(async () => {
    await Onyx.clear();
    onyxSnapshotCache.clear();
});

describe('useOnyx key switching contract', () => {
    describe('render log detector', () => {
        it('flags data owned by another key and members of a prefix-colliding collection', () => {
            expect(findForeignData({key: ONYXKEYS.KEY_B, value: owned(ONYXKEYS.KEY_A), status: 'loaded'})).toBe(ONYXKEYS.KEY_A);
            expect(findForeignData({key: ONYXKEYS.KEY_B, value: owned(ONYXKEYS.KEY_B), status: 'loaded'})).toBeUndefined();
            expect(findForeignData({key: ONYXKEYS.COLLECTION.MEMBER, value: {[NESTED_1]: owned(NESTED_1)}, status: 'loaded'})).toBe(NESTED_1);
            expect(findForeignData({key: ONYXKEYS.COLLECTION.MEMBER, value: {[MEMBER_1]: owned(MEMBER_2)}, status: 'loaded'})).toBe(MEMBER_2);
            expect(findForeignData({key: ONYXKEYS.COLLECTION.MEMBER_NESTED, value: {[NESTED_1]: owned(NESTED_1)}, status: 'loaded'})).toBeUndefined();
        });
    });

    describe('switching between warm keys', () => {
        it('renders the new regular key value as loaded in every render after the switch', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            rerender(ONYXKEYS.KEY_B);
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B));
            expect(result.current[1].status).toBe('loaded');
            await settle();

            const afterSwitch = log.since(switchStart);
            expect(afterSwitch.length).toBeGreaterThanOrEqual(1);
            expect(afterSwitch.length).toBeLessThanOrEqual(2);
            expect(afterSwitch).toEqual(afterSwitch.map(() => ({key: ONYXKEYS.KEY_B, value: owned(ONYXKEYS.KEY_B), status: 'loaded'})));

            const {result: reader} = renderHook(() => useOnyx(ONYXKEYS.KEY_B));
            expect(result.current[0]).toBe(reader.current[0]);
        });

        it('renders the new collection member value as loaded in every render after the switch', async () => {
            await Onyx.set(MEMBER_1, owned(MEMBER_1));
            await Onyx.set(MEMBER_2, owned(MEMBER_2));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: MEMBER_1});
            await settle();

            const switchStart = log.entries.length;
            rerender(MEMBER_2);
            await settle();

            const afterSwitch = log.since(switchStart);
            expect(afterSwitch.length).toBeGreaterThanOrEqual(1);
            expect(afterSwitch.length).toBeLessThanOrEqual(2);
            expect(afterSwitch).toEqual(afterSwitch.map(() => ({key: MEMBER_2, value: owned(MEMBER_2), status: 'loaded'})));
            expect(result.current[0]).toEqual(owned(MEMBER_2));
        });

        it('never shows a member of a prefix-colliding collection under the other member key', async () => {
            await Onyx.set(MEMBER_1, owned(MEMBER_1));
            await Onyx.set(NESTED_1, owned(NESTED_1));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: MEMBER_1});
            await settle();

            rerender(NESTED_1);
            expect(result.current[0]).toEqual(owned(NESTED_1));
            await settle();
            rerender(MEMBER_1);
            expect(result.current[0]).toEqual(owned(MEMBER_1));
            await settle();

            expectValidRenders(log.entries);
            expect(log.entries.every((entry) => entry.status === 'loaded')).toBe(true);
        });

        it('returns the same value reference when coming back to a key that was not written meanwhile', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const {result, rerender} = renderHook((key: string) => useOnyx(key), {initialProps: ONYXKEYS.KEY_A});
            await settle();
            const firstValueOfA = result.current[0];

            rerender(ONYXKEYS.KEY_B);
            await settle();
            rerender(ONYXKEYS.KEY_A);
            expect(result.current[0]).toBe(firstValueOfA);
            await settle();
            expect(result.current[0]).toBe(firstValueOfA);
        });

        it('renders once and keeps the value reference when the parent re-renders with the same key', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();
            const valueBefore = result.current[0];
            const rendersBefore = log.entries.length;

            rerender(ONYXKEYS.KEY_A);
            await settle();

            expect(log.entries.length).toBe(rendersBefore + 1);
            expect(result.current[0]).toBe(valueBefore);
            expect(result.current[1].status).toBe('loaded');
        });

        it('applies an inline selector to the new key data in every render after the switch', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, {owner: ONYXKEYS.KEY_A, name: 'Alice'});
            await Onyx.set(ONYXKEYS.KEY_B, {owner: ONYXKEYS.KEY_B, name: 'Bob'});
            const renders: Array<{key: string; selected: unknown; status: FetchStatus}> = [];
            const {result, rerender} = renderHook(
                (key: string) => {
                    const onyxResult = useOnyx(key, {selector: createOwnerNameSelector()});
                    renders.push({key, selected: onyxResult[0], status: onyxResult[1].status});
                    return onyxResult;
                },
                {initialProps: ONYXKEYS.KEY_A},
            );
            await settle();
            expect(result.current[0]).toBe('keyA:Alice');

            const switchStart = renders.length;
            rerender(ONYXKEYS.KEY_B);
            await settle();

            const afterSwitch = renders.slice(switchStart);
            expect(afterSwitch.length).toBeGreaterThanOrEqual(1);
            expect(afterSwitch.length).toBeLessThanOrEqual(2);
            expect(afterSwitch).toEqual(afterSwitch.map(() => ({key: ONYXKEYS.KEY_B, selected: 'keyB:Bob', status: 'loaded'})));
        });

        it('keeps the selected reference stable across writes that do not change the selected data after a switch', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, {owner: ONYXKEYS.KEY_A, name: 'Alice'});
            await Onyx.set(ONYXKEYS.KEY_B, {owner: ONYXKEYS.KEY_B, name: 'Bob', counter: 1});
            const selector = (value: unknown) => (isOwnedValue(value) ? {owner: value.owner, details: {name: value.name}} : undefined);
            let renderCount = 0;
            const {result, rerender} = renderHook(
                (key: string) => {
                    renderCount += 1;
                    return useOnyx(key, {selector});
                },
                {initialProps: ONYXKEYS.KEY_A},
            );
            await settle();

            rerender(ONYXKEYS.KEY_B);
            await settle();
            const selectedB = result.current[0];
            expect(selectedB).toEqual({owner: ONYXKEYS.KEY_B, details: {name: 'Bob'}});
            const rendersBefore = renderCount;

            await act(async () => Onyx.merge(ONYXKEYS.KEY_B, {counter: 2}));
            expect(result.current[0]).toBe(selectedB);
            expect(renderCount).toBe(rendersBefore);

            await act(async () => Onyx.merge(ONYXKEYS.KEY_B, {name: 'Bobby'}));
            expect(result.current[0]).toEqual({owner: ONYXKEYS.KEY_B, details: {name: 'Bobby'}});
        });

        it('applies a selector that changes with props while the key stays the same', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, {owner: ONYXKEYS.KEY_A, name: 'Alice'});
            const {result, rerender} = renderHook(({key, suffix}: {key: string; suffix: string}) => useOnyx(key, {selector: createSuffixSelector('name', suffix)}), {
                initialProps: {key: ONYXKEYS.KEY_A, suffix: '-1'},
            });
            await settle();
            expect(result.current[0]).toBe('Alice-1');

            rerender({key: ONYXKEYS.KEY_A, suffix: '-2'});
            expect(result.current[0]).toBe('Alice-2');
            await settle();
            expect(result.current[0]).toBe('Alice-2');
            expect(result.current[1].status).toBe('loaded');
        });
    });

    describe('switching to a cold key', () => {
        it('settles on undefined and loaded for a key without data and never shows the previous key data', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            rerender(coldKey);
            expect(result.current[0]).toBeUndefined();
            await settle();

            const afterSwitch = log.since(switchStart);
            expectValidRenders(afterSwitch);
            expect(afterSwitch.every((entry) => entry.key === coldKey && entry.value === undefined)).toBe(true);
            expect(afterSwitch.map((entry) => entry.status)).toContain('loading');
            expect(afterSwitch.length).toBeLessThanOrEqual(3);
            expect(result.current[0]).toBeUndefined();
            expect(result.current[1].status).toBe('loaded');
        });

        it('delivers a value that only exists in storage after the switch, preceded by loading', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await seedColdKey(coldKey, owned(coldKey));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            rerender(coldKey);
            await settle();

            const afterSwitch = log.since(switchStart);
            expectValidRenders(afterSwitch);
            expect(afterSwitch.length).toBeLessThanOrEqual(3);
            const firstLoading = afterSwitch.findIndex((entry) => entry.status === 'loading');
            const firstValue = afterSwitch.findIndex((entry) => entry.value !== undefined);
            expect(firstLoading).toBeGreaterThanOrEqual(0);
            expect(firstValue).toBeGreaterThan(firstLoading);
            expect(afterSwitch.slice(firstValue).every((entry) => entry.status === 'loaded')).toBe(true);
            expect(result.current[0]).toEqual(owned(coldKey));
            expect(result.current[1].status).toBe('loaded');
        });

        it('never leaks the previous key value when switching before the previous cold key finished loading', async () => {
            const firstColdKey = nextColdKey();
            const secondColdKey = nextColdKey();
            await seedColdKey(firstColdKey, owned(firstColdKey));
            await seedColdKey(secondColdKey, owned(secondColdKey));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: firstColdKey});

            rerender(secondColdKey);
            await settle();
            await settle();

            expectValidRenders(log.entries);
            expect(log.entries.some((entry) => isOwnedValue(entry.value) && entry.value.owner === firstColdKey)).toBe(false);
            expect(log.entries.length).toBeLessThanOrEqual(4);
            expect(result.current[0]).toEqual(owned(secondColdKey));
            expect(result.current[1].status).toBe('loaded');
        });

        it('settles on the first key when switching to a cold key and back within one tick', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await seedColdKey(coldKey, owned(coldKey));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();
            const firstValueOfA = result.current[0];

            rerender(coldKey);
            rerender(ONYXKEYS.KEY_A);
            await settle();

            expectValidRenders(log.entries);
            expect(result.current[0]).toBe(firstValueOfA);
            expect(result.current[1].status).toBe('loaded');

            const rendersAfterReturn = log.entries.length;
            await act(async () => Onyx.merge(coldKey, {rev: 2}));
            expect(log.entries.length).toBe(rendersAfterReturn);
        });

        it('reports the selector result for missing data once a cold key has loaded', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            const renders: Array<{selected: unknown; status: FetchStatus}> = [];
            const selector = (value: unknown) => (isOwnedValue(value) ? value.owner : 'none');
            const {result, rerender} = renderHook(
                (key: string) => {
                    const onyxResult = useOnyx(key, {selector});
                    renders.push({selected: onyxResult[0], status: onyxResult[1].status});
                    return onyxResult;
                },
                {initialProps: ONYXKEYS.KEY_A},
            );
            await settle();

            const switchStart = renders.length;
            rerender(coldKey);
            await settle();

            const afterSwitch = renders.slice(switchStart);
            expect(afterSwitch.some((entry) => entry.selected === ONYXKEYS.KEY_A)).toBe(false);
            expect(afterSwitch.filter((entry) => entry.status === 'loading').every((entry) => entry.selected === undefined)).toBe(true);
            expect(result.current[0]).toBe('none');
            expect(result.current[1].status).toBe('loaded');
        });

        it('delivers the same value to a hook switching onto a key that another hook is still loading', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await seedColdKey(coldKey, owned(coldKey));
            const {result: switching, rerender} = renderHook((key: string) => useOnyx(key), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const {result: loadingReader} = renderHook(() => useOnyx(coldKey));
            rerender(coldKey);
            await settle();

            expect(loadingReader.current[0]).toEqual(owned(coldKey));
            expect(switching.current[0]).toBe(loadingReader.current[0]);
            expect(switching.current[1].status).toBe('loaded');
            expect(loadingReader.current[1].status).toBe('loaded');
        });

        it('switches keys the same way with reuseConnection disabled', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            await seedColdKey(coldKey, owned(coldKey));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key, {reuseConnection: false})), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            rerender(ONYXKEYS.KEY_B);
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B));
            await settle();
            rerender(coldKey);
            await settle();

            expectValidRenders(log.entries);
            expect(result.current[0]).toEqual(owned(coldKey));
            expect(result.current[1].status).toBe('loaded');

            const rendersBefore = log.entries.length;
            await act(async () => Onyx.merge(ONYXKEYS.KEY_B, {rev: 2}));
            expect(log.entries.length).toBe(rendersBefore);
            await act(async () => Onyx.merge(coldKey, {rev: 2}));
            expect(result.current[0]).toEqual(owned(coldKey, 2));
        });
    });

    describe('collection roots', () => {
        it('never mixes members of prefix-colliding collections when switching roots', async () => {
            await Onyx.set(MEMBER_1, owned(MEMBER_1));
            await Onyx.set(MEMBER_2, owned(MEMBER_2));
            await Onyx.set(NESTED_1, owned(NESTED_1));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.COLLECTION.MEMBER});
            await settle();
            expect(result.current[0]).toEqual({[MEMBER_1]: owned(MEMBER_1), [MEMBER_2]: owned(MEMBER_2)});

            const switchStart = log.entries.length;
            rerender(ONYXKEYS.COLLECTION.MEMBER_NESTED);
            expect(result.current[0]).toEqual({[NESTED_1]: owned(NESTED_1)});
            await settle();
            expect(log.since(switchStart).length).toBeLessThanOrEqual(2);

            rerender(ONYXKEYS.COLLECTION.MEMBER);
            expect(result.current[0]).toEqual({[MEMBER_1]: owned(MEMBER_1), [MEMBER_2]: owned(MEMBER_2)});
            await settle();

            expectValidRenders(log.entries);
            expect(log.entries.every((entry) => entry.status === 'loaded')).toBe(true);
        });

        it('returns an empty object when switching to an empty collection root', async () => {
            await Onyx.set(MEMBER_1, owned(MEMBER_1));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.COLLECTION.MEMBER});
            await settle();

            rerender(ONYXKEYS.COLLECTION.OTHER);
            await settle();

            expectValidRenders(log.entries);
            expect(result.current[0]).toEqual({});
            expect(result.current[1].status).toBe('loaded');
        });

        it('delivers later member writes of the new root and ignores writes to the previous root', async () => {
            await Onyx.set(MEMBER_1, owned(MEMBER_1));
            await Onyx.set(NESTED_1, owned(NESTED_1));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.COLLECTION.MEMBER});
            await settle();

            rerender(ONYXKEYS.COLLECTION.MEMBER_NESTED);
            await settle();
            const nestedValue = result.current[0];
            const rendersBefore = log.entries.length;

            await act(async () => Onyx.merge(MEMBER_1, {rev: 2}));
            expect(log.entries.length).toBe(rendersBefore);
            expect(result.current[0]).toBe(nestedValue);

            await act(async () => Onyx.merge(NESTED_1, {rev: 2}));
            expect(result.current[0]).toEqual({[NESTED_1]: owned(NESTED_1, 2)});
            expectValidRenders(log.entries);
        });

        it('allows switching between roots, members and regular keys without logging errors', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(MEMBER_1, owned(MEMBER_1));
            await Onyx.set(NESTED_1, owned(NESTED_1));
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: MEMBER_1});
            await settle();

            const expected: Array<[string, unknown]> = [
                [ONYXKEYS.COLLECTION.MEMBER, {[MEMBER_1]: owned(MEMBER_1)}],
                [NESTED_1, owned(NESTED_1)],
                [ONYXKEYS.COLLECTION.MEMBER_NESTED, {[NESTED_1]: owned(NESTED_1)}],
                [ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A)],
                [coldKey, undefined],
                [MEMBER_1, owned(MEMBER_1)],
            ];
            for (const [key, value] of expected) {
                rerender(key);
                await settle();
                expect(result.current[0]).toEqual(value);
                expect(result.current[1].status).toBe('loaded');
            }

            expectValidRenders(log.entries);
            expect(consoleError).not.toHaveBeenCalled();
            consoleError.mockRestore();
        });
    });

    describe('writes around a switch', () => {
        it('does not render or change the value for writes to the previous key after the switch', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();
            rerender(ONYXKEYS.KEY_B);
            await settle();
            const valueOfB = result.current[0];
            const rendersBefore = log.entries.length;

            await act(async () => Onyx.merge(ONYXKEYS.KEY_A, {rev: 2}));
            await act(async () => Onyx.set(ONYXKEYS.KEY_A, null));

            expect(log.entries.length).toBe(rendersBefore);
            expect(result.current[0]).toBe(valueOfB);
        });

        it('does not render for a write to the new key that leaves its value unchanged', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();
            rerender(ONYXKEYS.KEY_B);
            await settle();
            const valueOfB = result.current[0];
            const rendersBefore = log.entries.length;

            await act(async () => Onyx.merge(ONYXKEYS.KEY_B, {rev: 1}));

            expect(log.entries.length).toBe(rendersBefore);
            expect(result.current[0]).toBe(valueOfB);
        });

        it('delivers a write to the new key made in the same tick as the switch', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            rerender(ONYXKEYS.KEY_B);
            Onyx.merge(ONYXKEYS.KEY_B, {rev: 2});
            await settle();

            const afterSwitch = log.since(switchStart);
            expectValidRenders(afterSwitch);
            expectNonDecreasing(revisionsOf(afterSwitch));
            expect(afterSwitch.length).toBeLessThanOrEqual(3);
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B, 2));
            expect(result.current[1].status).toBe('loaded');
        });

        it('never shows a write to the previous key made while the switch is in progress', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await seedColdKey(coldKey, owned(coldKey));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            rerender(coldKey);
            Onyx.merge(ONYXKEYS.KEY_A, {rev: 2});
            Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A, 3));
            await settle();

            expectValidRenders(log.entries);
            expect(revisionsOf(log.entries.filter((entry) => entry.key === ONYXKEYS.KEY_A))).toEqual([1]);
            expect(result.current[0]).toEqual(owned(coldKey));
        });

        it('settles on the last of interleaved writes to both keys made before the new connection settles', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            Onyx.merge(ONYXKEYS.KEY_B, {rev: 2});
            rerender(ONYXKEYS.KEY_B);
            Onyx.merge(ONYXKEYS.KEY_A, {rev: 2});
            Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B, 3));
            Onyx.merge(ONYXKEYS.KEY_A, {rev: 3});
            Onyx.merge(ONYXKEYS.KEY_B, {rev: 4});
            await settle();

            const afterSwitch = log.since(switchStart);
            expectValidRenders(afterSwitch);
            expectNonDecreasing(revisionsOf(afterSwitch));
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B, 4));
            expect(result.current[1].status).toBe('loaded');
        });

        it('settles on the final value when a subscriber writes to the new key while being notified', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const connection = Onyx.connect({
                key: ONYXKEYS.KEY_B,
                callback: (value) => {
                    if (!isOwnedValue(value) || value.rev !== 2) {
                        return;
                    }
                    Onyx.merge(ONYXKEYS.KEY_B, {rev: 3});
                },
            });
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            rerender(ONYXKEYS.KEY_B);
            await act(async () => Onyx.merge(ONYXKEYS.KEY_B, {rev: 2}));
            await settle();

            const afterSwitch = log.since(switchStart);
            expectValidRenders(afterSwitch);
            expectNonDecreasing(revisionsOf(afterSwitch));
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B, 3));
            Onyx.disconnect(connection);
        });

        it('settles on undefined and loaded when the new key is removed right after the switch', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            rerender(ONYXKEYS.KEY_B);
            Onyx.set(ONYXKEYS.KEY_B, null);
            await settle();

            expectValidRenders(log.entries);
            expect(result.current[0]).toBeUndefined();
            expect(result.current[1].status).toBe('loaded');
        });
    });

    describe('sharing a key with other hooks', () => {
        it('does not re-render a hook already on the target key when another hook switches onto it and away again', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const readerLog = createRenderLog();
            const {result: reader} = renderHook(() => readerLog.record(ONYXKEYS.KEY_B, useOnyx(ONYXKEYS.KEY_B)));
            const {result: switching, rerender} = renderHook((key: string) => useOnyx(key), {initialProps: ONYXKEYS.KEY_A});
            await settle();
            const readerValue = reader.current[0];
            const readerRenders = readerLog.entries.length;

            rerender(ONYXKEYS.KEY_B);
            await settle();
            expect(switching.current[0]).toBe(readerValue);
            rerender(ONYXKEYS.KEY_A);
            await settle();

            expect(readerLog.entries.length).toBe(readerRenders);
            expect(reader.current[0]).toBe(readerValue);

            await act(async () => Onyx.merge(ONYXKEYS.KEY_B, {rev: 2}));
            expect(reader.current[0]).toEqual(owned(ONYXKEYS.KEY_B, 2));
            expect(switching.current[0]).toEqual(owned(ONYXKEYS.KEY_A));
        });

        it('delivers later writes to both hooks with the same reference after a switch onto a shared key', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const {result: reader} = renderHook(() => useOnyx(ONYXKEYS.KEY_B));
            const {result: switching, rerender} = renderHook((key: string) => useOnyx(key), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            rerender(ONYXKEYS.KEY_B);
            await settle();
            await act(async () => Onyx.merge(ONYXKEYS.KEY_B, {rev: 2}));

            expect(reader.current[0]).toEqual(owned(ONYXKEYS.KEY_B, 2));
            expect(switching.current[0]).toBe(reader.current[0]);
        });

        it('keeps delivering writes to the hook left behind after a sibling switched away', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const {result: stayer} = renderHook(() => useOnyx(ONYXKEYS.KEY_A));
            const switchingLog = createRenderLog();
            const {result: switching, rerender} = renderHook((key: string) => switchingLog.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            rerender(ONYXKEYS.KEY_B);
            await settle();
            const switchingRenders = switchingLog.entries.length;

            await act(async () => Onyx.merge(ONYXKEYS.KEY_A, {rev: 2}));

            expect(stayer.current[0]).toEqual(owned(ONYXKEYS.KEY_A, 2));
            expect(switchingLog.entries.length).toBe(switchingRenders);
            expect(switching.current[0]).toEqual(owned(ONYXKEYS.KEY_B));
        });

        it('renders every component of a group switching together within the per-switch upper bound', async () => {
            await Onyx.set(MEMBER_1, owned(MEMBER_1));
            await Onyx.set(MEMBER_2, owned(MEMBER_2));
            const logs = [createRenderLog(), createRenderLog(), createRenderLog()];
            function Probe({onyxKey, index}: {onyxKey: string; index: number}) {
                logs[index].record(onyxKey, useOnyx(onyxKey));
                return null;
            }
            function Group({onyxKey}: {onyxKey: string}) {
                return (
                    <>
                        {logs.map((log, index) => (
                            <Probe
                                // eslint-disable-next-line react/no-array-index-key
                                key={index}
                                onyxKey={onyxKey}
                                index={index}
                            />
                        ))}
                    </>
                );
            }
            const {rerender} = render(<Group onyxKey={MEMBER_1} />);
            await settle();
            expect(logs.map((log) => log.entries.length)).toEqual([1, 1, 1]);

            const warmSwitchStarts = logs.map((log) => log.entries.length);
            rerender(<Group onyxKey={MEMBER_2} />);
            await settle();
            for (const [index, log] of logs.entries()) {
                const afterSwitch = log.since(warmSwitchStarts[index]);
                expect(afterSwitch.length).toBeLessThanOrEqual(2);
                expect(afterSwitch).toEqual(afterSwitch.map(() => ({key: MEMBER_2, value: owned(MEMBER_2), status: 'loaded'})));
            }

            const coldSwitchStarts = logs.map((log) => log.entries.length);
            rerender(<Group onyxKey={`${ONYXKEYS.COLLECTION.MEMBER}3`} />);
            await settle();
            for (const [index, log] of logs.entries()) {
                const afterSwitch = log.since(coldSwitchStarts[index]);
                expect(afterSwitch.length).toBeLessThanOrEqual(3);
                expectValidRenders(afterSwitch);
                expect(afterSwitch.at(-1)).toEqual({key: `${ONYXKEYS.COLLECTION.MEMBER}3`, value: undefined, status: 'loaded'});
            }

            await act(async () => Onyx.set(`${ONYXKEYS.COLLECTION.MEMBER}3`, owned(`${ONYXKEYS.COLLECTION.MEMBER}3`)));
            for (const log of logs) {
                expect(log.entries.at(-1)).toEqual({key: `${ONYXKEYS.COLLECTION.MEMBER}3`, value: owned(`${ONYXKEYS.COLLECTION.MEMBER}3`), status: 'loaded'});
            }
        });

        it('stops all deliveries after unmounting a hook that switched keys', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {rerender, unmount} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();
            rerender(ONYXKEYS.KEY_B);
            await settle();
            unmount();
            const rendersBefore = log.entries.length;

            await act(async () => Onyx.merge(ONYXKEYS.KEY_A, {rev: 2}));
            await act(async () => Onyx.merge(ONYXKEYS.KEY_B, {rev: 2}));

            expect(log.entries.length).toBe(rendersBefore);
        });
    });

    describe('loading status', () => {
        it('stays loaded with a value while a merge on the current key is pending', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const mergeStart = log.entries.length;
            Onyx.merge(ONYXKEYS.KEY_A, {rev: 2});
            rerender(ONYXKEYS.KEY_A);
            expect(result.current[1].status).toBe('loaded');
            expect(result.current[0]).toBeDefined();
            await settle();

            const afterMerge = log.since(mergeStart);
            expect(afterMerge.every((entry) => entry.status === 'loaded' && entry.value !== undefined)).toBe(true);
            expectNonDecreasing(revisionsOf(afterMerge));
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_A, 2));
        });

        it('stays loaded when a subscriber writes to the current key while being notified', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            const connection = Onyx.connect({
                key: ONYXKEYS.KEY_A,
                callback: (value) => {
                    if (!isOwnedValue(value) || value.rev !== 2) {
                        return;
                    }
                    Onyx.merge(ONYXKEYS.KEY_A, {rev: 3});
                },
            });
            const log = createRenderLog();
            const {result} = renderHook(() => log.record(ONYXKEYS.KEY_A, useOnyx(ONYXKEYS.KEY_A)));
            await settle();

            const writeStart = log.entries.length;
            await act(async () => Onyx.merge(ONYXKEYS.KEY_A, {rev: 2}));
            await settle();

            const afterWrite = log.since(writeStart);
            expect(afterWrite.every((entry) => entry.status === 'loaded' && entry.value !== undefined)).toBe(true);
            expectNonDecreasing(revisionsOf(afterWrite));
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_A, 3));
            Onyx.disconnect(connection);
        });

        it('never shows the pre-merge value when returning to a key with a pending merge before the other key connected', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            rerender(ONYXKEYS.KEY_B);
            const returnStart = log.entries.length;
            Onyx.merge(ONYXKEYS.KEY_A, {rev: 2});
            rerender(ONYXKEYS.KEY_A);
            await settle();

            const afterReturn = log.since(returnStart);
            expectValidRenders(afterReturn);
            expect(revisionsOf(afterReturn)).not.toContain(1);
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_A, 2));
            expect(result.current[1].status).toBe('loaded');
        });

        it('stays loaded when the selector changes while a merge on the current key is pending', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            const renders: Array<{selected: unknown; status: FetchStatus}> = [];
            const {result, rerender} = renderHook(
                ({suffix}: {suffix: string}) => {
                    const onyxResult = useOnyx(ONYXKEYS.KEY_A, {selector: createSuffixSelector('rev', suffix)});
                    renders.push({selected: onyxResult[0], status: onyxResult[1].status});
                    return onyxResult;
                },
                {initialProps: {suffix: '-x'}},
            );
            await settle();
            const loadedAt = renders.findIndex((entry) => entry.status === 'loaded');

            Onyx.merge(ONYXKEYS.KEY_A, {rev: 2});
            rerender({suffix: '-y'});
            expect(result.current[1].status).toBe('loaded');
            await settle();

            expect(renders.slice(loadedAt).every((entry) => entry.status === 'loaded' && entry.selected !== undefined)).toBe(true);
            expect(result.current[0]).toBe('2-y');
        });

        it('never goes back to loading for writes on the current key once loaded', async () => {
            const log = createRenderLog();
            const {result} = renderHook(() => log.record(ONYXKEYS.KEY_A, useOnyx(ONYXKEYS.KEY_A)));
            await settle();
            const loadedAt = log.entries.findIndex((entry) => entry.status === 'loaded');
            expect(loadedAt).toBeGreaterThanOrEqual(0);

            await act(async () => Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A)));
            await act(async () => Onyx.merge(ONYXKEYS.KEY_A, {rev: 2}));
            await act(async () => Onyx.set(ONYXKEYS.KEY_A, null));
            await act(async () => Onyx.merge(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A, 3)));

            expect(log.since(loadedAt).every((entry) => entry.status === 'loaded')).toBe(true);
            expect(log.since(loadedAt).map((entry) => (isOwnedValue(entry.value) ? entry.value.rev : undefined))).toEqual([undefined, 1, 2, undefined, 3]);
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_A, 3));
        });

        it('never shows the pre-merge value when switching onto a key with a pending merge that no other hook reads', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            Onyx.merge(ONYXKEYS.KEY_B, {rev: 2});
            rerender(ONYXKEYS.KEY_B);
            expect(result.current[0]).toBeUndefined();
            expect(result.current[1].status).toBe('loading');
            await settle();

            const afterSwitch = log.since(switchStart);
            expectValidRenders(afterSwitch);
            expect(revisionsOf(afterSwitch)).not.toContain(1);
            expect(afterSwitch.length).toBeLessThanOrEqual(3);
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B, 2));
            expect(result.current[1].status).toBe('loaded');
        });

        it('applies every queued merge on the switch target', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const {result, rerender} = renderHook((key: string) => useOnyx(key), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            Onyx.merge(ONYXKEYS.KEY_B, {x: 1});
            Onyx.merge(ONYXKEYS.KEY_B, {y: 2});
            rerender(ONYXKEYS.KEY_B);
            Onyx.merge(ONYXKEYS.KEY_B, {x: 3, rev: 2});
            await settle();

            expect(result.current[0]).toEqual({owner: ONYXKEYS.KEY_B, rev: 2, x: 3, y: 2});
            expect(result.current[1].status).toBe('loaded');
        });

        it('never shows the removed value when a pending merge removes the switch target', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            Onyx.merge(ONYXKEYS.KEY_B, null);
            rerender(ONYXKEYS.KEY_B);
            await settle();

            const afterSwitch = log.since(switchStart);
            expectValidRenders(afterSwitch);
            expect(afterSwitch.every((entry) => entry.value === undefined)).toBe(true);
            expect(result.current[0]).toBeUndefined();

            await act(async () => Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B, 2)));
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B, 2));
            expect(result.current[1].status).toBe('loaded');
        });

        it('merges a pending change onto a value that only exists in storage when switching onto it', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await seedColdKey(coldKey, {...owned(coldKey), kept: true});
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            Onyx.merge(coldKey, {rev: 2});
            rerender(coldKey);
            await settle();

            const afterSwitch = log.since(switchStart);
            expectValidRenders(afterSwitch);
            expectNonDecreasing(revisionsOf(afterSwitch));
            expect(afterSwitch.length).toBeLessThanOrEqual(3);
            expect(result.current[0]).toEqual({owner: coldKey, rev: 2, kept: true});
            expect(result.current[1].status).toBe('loaded');
        });

        it('is not affected by a merge pending on the previous key', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            Onyx.merge(ONYXKEYS.KEY_A, {rev: 2});
            rerender(ONYXKEYS.KEY_B);
            await settle();

            const afterSwitch = log.since(switchStart);
            expect(afterSwitch.length).toBeLessThanOrEqual(2);
            expect(afterSwitch).toEqual(afterSwitch.map(() => ({key: ONYXKEYS.KEY_B, value: owned(ONYXKEYS.KEY_B), status: 'loaded'})));
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B));
        });

        it('settles to loaded when switching keys while Onyx.clear() is pending', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            Onyx.clear();
            rerender(ONYXKEYS.KEY_B);
            await settle();
            await settle();

            expectValidRenders(log.entries);
            expect(result.current[0]).toBeUndefined();
            expect(result.current[1].status).toBe('loaded');
        });
    });

    describe('current behaviour (suspected bug)', () => {
        // The first render after switching to a cold key reports 'loaded' with no value, then drops back to 'loading'.
        it('reports a cold key as loaded without a value before it reports loading', async () => {
            const coldKey = nextColdKey();
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await seedColdKey(coldKey, owned(coldKey));
            const log = createRenderLog();
            const {rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            rerender(coldKey);
            await settle();

            expect(log.since(switchStart)).toEqual([
                {key: coldKey, value: undefined, status: 'loaded'},
                {key: coldKey, value: undefined, status: 'loading'},
                {key: coldKey, value: owned(coldKey), status: 'loaded'},
            ]);
        });

        // The pending-merge 'loading' rule is skipped when another hook already reads the key, so the stale value shows.
        it('shows the pre-merge value as loaded when switching onto a key with a pending merge that another hook reads', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            renderHook(() => useOnyx(ONYXKEYS.KEY_B));
            const log = createRenderLog();
            const {result, rerender} = renderHook((key: string) => log.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();

            const switchStart = log.entries.length;
            Onyx.merge(ONYXKEYS.KEY_B, {rev: 2});
            rerender(ONYXKEYS.KEY_B);
            await settle();

            expect(log.since(switchStart)).toEqual([
                {key: ONYXKEYS.KEY_B, value: owned(ONYXKEYS.KEY_B), status: 'loaded'},
                {key: ONYXKEYS.KEY_B, value: owned(ONYXKEYS.KEY_B), status: 'loaded'},
                {key: ONYXKEYS.KEY_B, value: owned(ONYXKEYS.KEY_B, 2), status: 'loaded'},
            ]);
            expect(result.current[0]).toEqual(owned(ONYXKEYS.KEY_B, 2));
        });

        // A merge to null that is pending when the hook connects leaves the status at 'loading' until the next write.
        it('stays loading after a pending merge that removes the key settles on mount and on switch', async () => {
            await Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A));
            await Onyx.set(ONYXKEYS.KEY_B, owned(ONYXKEYS.KEY_B));
            Onyx.merge(ONYXKEYS.KEY_A, null);
            const mountLog = createRenderLog();
            renderHook(() => mountLog.record(ONYXKEYS.KEY_A, useOnyx(ONYXKEYS.KEY_A)));
            await settle();
            await settle();
            expect(mountLog.entries).toEqual([{key: ONYXKEYS.KEY_A, value: undefined, status: 'loading'}]);

            await act(async () => Onyx.set(ONYXKEYS.KEY_A, owned(ONYXKEYS.KEY_A, 2)));
            const switchLog = createRenderLog();
            const {rerender} = renderHook((key: string) => switchLog.record(key, useOnyx(key)), {initialProps: ONYXKEYS.KEY_A});
            await settle();
            const switchStart = switchLog.entries.length;
            Onyx.merge(ONYXKEYS.KEY_B, null);
            rerender(ONYXKEYS.KEY_B);
            await settle();
            await settle();
            expect(switchLog.since(switchStart)).toEqual([
                {key: ONYXKEYS.KEY_B, value: undefined, status: 'loading'},
                {key: ONYXKEYS.KEY_B, value: undefined, status: 'loading'},
            ]);
        });
    });
});
