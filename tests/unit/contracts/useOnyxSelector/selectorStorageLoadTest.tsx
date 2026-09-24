import React from 'react';
import {render} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import StorageMock from '../../../../lib/storage';
import {KEYS, SelectorProbeList, createRecorders, readField, settle, write} from './SelectorHarness';

// No initial key states here: Onyx only reads storage for a key while its cached key list is empty.
Onyx.init({keys: KEYS});

const HOOK_COUNT = 3;

const selectName: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'name');

beforeEach(async () => {
    await Onyx.clear();
});

describe('useOnyx with a selector over a value that is only in storage', () => {
    it('reports loading first and then gives K hooks the projection of the stored value', async () => {
        await StorageMock.setItem(KEYS.PLAIN, {name: 'stored', count: 1});
        const recorders = createRecorders<unknown>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.PLAIN}
                selector={selectName}
                recorders={recorders}
            />,
        );

        for (const recorder of recorders) {
            expect(recorder.commits.map(([value, metadata]) => [value, metadata.status])).toEqual([[undefined, 'loading']]);
        }

        await settle();

        for (const recorder of recorders) {
            expect(recorder.commits.map(([value, metadata]) => [value, metadata.status])).toEqual([
                [undefined, 'loading'],
                ['stored', 'loaded'],
            ]);
        }

        await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));
        for (const recorder of recorders) {
            expect(recorder.commits).toHaveLength(2);
        }
    });

    it('ends on the projection of stored collection members for K hooks', async () => {
        await StorageMock.setItem(`${KEYS.COLLECTION.ITEM}1`, {name: 'one'});
        await StorageMock.setItem(`${KEYS.COLLECTION.ITEM}2`, {name: 'two'});
        const selectNames: UseOnyxSelector<OnyxKey, unknown[]> = (collection) =>
            Object.values(typeof collection === 'object' && collection !== null ? collection : {})
                .map((member) => readField(member, 'name'))
                .sort();
        const recorders = createRecorders<unknown[]>(HOOK_COUNT);
        render(
            <SelectorProbeList
                onyxKey={KEYS.COLLECTION.ITEM}
                selector={selectNames}
                recorders={recorders}
            />,
        );

        await settle();

        for (const recorder of recorders) {
            expect(recorder.commits.at(-1)?.[0]).toEqual(['one', 'two']);
            expect(recorder.commits.at(-1)?.[1].status).toBe('loaded');
        }
    });

    describe('current behaviour (suspected bug)', () => {
        it('reports loaded with the fallback before storage is read when the selector maps a missing value to something defined', async () => {
            await StorageMock.setItem(KEYS.PLAIN, {name: 'stored'});
            const selectNameOrFallback: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'name') ?? 'fallback';
            const recorders = createRecorders<unknown>(1);
            render(
                <SelectorProbeList
                    onyxKey={KEYS.PLAIN}
                    selector={selectNameOrFallback}
                    recorders={recorders}
                />,
            );
            await settle();

            expect(recorders[0].commits.map(([value, metadata]) => [value, metadata.status])).toEqual([
                ['fallback', 'loaded'],
                ['stored', 'loaded'],
            ]);
        });

        it('reports an empty collection projection as loaded before stored members are read', async () => {
            await StorageMock.setItem(`${KEYS.COLLECTION.ITEM}1`, {name: 'one'});
            const selectNames: UseOnyxSelector<OnyxKey, unknown[]> = (collection) =>
                Object.values(typeof collection === 'object' && collection !== null ? collection : {}).map((member) => readField(member, 'name'));
            const recorders = createRecorders<unknown[]>(1);
            render(
                <SelectorProbeList
                    onyxKey={KEYS.COLLECTION.ITEM}
                    selector={selectNames}
                    recorders={recorders}
                />,
            );
            await settle();

            expect(recorders[0].commits.map(([value, metadata]) => [value, metadata.status])).toEqual([
                [[], 'loaded'],
                [['one'], 'loaded'],
            ]);
        });
    });
});
