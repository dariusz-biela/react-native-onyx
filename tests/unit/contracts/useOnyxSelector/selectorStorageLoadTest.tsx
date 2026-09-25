import React from 'react';
import {render} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import StorageMock from '../../../../lib/storage';
import {KEYS, SelectorProbeList, createRecorders, readField, settle, write} from './SelectorHarness';

// No initial key states here, so the only data is what each test writes straight to storage.
Onyx.init({keys: KEYS});

const HOOK_COUNT = 3;

const selectName: UseOnyxSelector<OnyxKey, unknown> = (value) => readField(value, 'name');

beforeEach(async () => {
    await Onyx.clear();
});

describe('useOnyx with a selector over a value that is only in storage', () => {
    describe('current behaviour (#834 change)', () => {
        // On main the K hooks committed [undefined, loading] and then [stored, loaded] after storage was read.
        it('reports loaded without a value for K hooks and never reads the stored value, even after a merge', async () => {
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
                expect(recorder.commits.map(([value, metadata]) => [value, metadata.status])).toEqual([[undefined, 'loaded']]);
            }

            await settle();
            await write(() => Onyx.merge(KEYS.PLAIN, {count: 2}));

            for (const recorder of recorders) {
                expect(recorder.commits.map(([value, metadata]) => [value, metadata.status])).toEqual([[undefined, 'loaded']]);
            }
        });

        // On main the K hooks ended on [['one', 'two'], loaded].
        it('ends on an empty projection for K hooks over stored collection members', async () => {
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
                expect(recorder.commits.map(([value, metadata]) => [value, metadata.status])).toEqual([[[], 'loaded']]);
            }
        });

        // On main the hook committed the fallback as loaded and then the stored name.
        it('commits only the fallback as loaded when the selector maps a missing value to something defined', async () => {
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

            expect(recorders[0].commits.map(([value, metadata]) => [value, metadata.status])).toEqual([['fallback', 'loaded']]);
        });

        // On main the hook committed an empty projection as loaded and then the stored members.
        it('commits only an empty collection projection as loaded', async () => {
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

            expect(recorders[0].commits.map(([value, metadata]) => [value, metadata.status])).toEqual([[[], 'loaded']]);
        });
    });
});
