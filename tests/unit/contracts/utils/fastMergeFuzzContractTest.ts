/**
 * Seeded property tests for `utils.fastMerge` and `utils.removeNestedNullValues` against the reference models
 * in `helpers/models.ts`, for every option combination Onyx uses and the defaults. Each case checks the
 * merged value, the replace-null patches, which references the result shares with its inputs, and that the
 * frozen inputs were never written to.
 */
import type {FastMergeOptions} from '../../../../lib/utils';
import type {ModelOptions} from './helpers/models';

import utils from '../../../../lib/utils';
import {findSharingProblems, modelFastMerge, modelRemoveNestedNulls, sharingInputs} from './helpers/models';
import {createRng, deepFreeze, deriveSource, describeValue, generateObject, generateValue} from './helpers/values';

const SEEDS = 400;

type OptionCase = {
    name: string;
    options: FastMergeOptions | undefined;
    model: ModelOptions;
};

const OPTION_CASES: OptionCase[] = [
    {name: 'no options', options: undefined, model: {removeNulls: false, mode: 'none'}},
    {name: 'empty options', options: {}, model: {removeNulls: false, mode: 'none'}},
    {name: 'remove nulls', options: {shouldRemoveNestedNulls: true}, model: {removeNulls: true, mode: 'none'}},
    {name: 'mark', options: {objectRemovalMode: 'mark'}, model: {removeNulls: false, mode: 'mark'}},
    {name: 'mark and remove nulls', options: {shouldRemoveNestedNulls: true, objectRemovalMode: 'mark'}, model: {removeNulls: true, mode: 'mark'}},
    {name: 'replace', options: {objectRemovalMode: 'replace'}, model: {removeNulls: false, mode: 'replace'}},
    {name: 'replace and remove nulls (cache and storage merges)', options: {shouldRemoveNestedNulls: true, objectRemovalMode: 'replace'}, model: {removeNulls: true, mode: 'replace'}},
    {name: 'explicit none', options: {shouldRemoveNestedNulls: false, objectRemovalMode: 'none'}, model: {removeNulls: false, mode: 'none'}},
];

type Coverage = {keptTarget: number; changed: number; withPatches: number};

describe('utils.fastMerge matches the reference model', () => {
    it.each(OPTION_CASES)('with $name', ({options, model}) => {
        const coverage: Coverage = {keptTarget: 0, changed: 0, withPatches: 0};

        for (let seed = 1; seed <= SEEDS; seed++) {
            const rng = createRng(seed);
            const generateOptions = {withMarks: model.mode === 'replace' || rng() < 0.1};
            const target = deepFreeze(generateValue(rng, 0, generateOptions));
            const source = deepFreeze(deriveSource(rng, target, 0, generateOptions));
            const label = `seed ${seed}: ${describeValue(target)} <- ${describeValue(source)}`;
            const targetBefore = describeValue(target);
            const sourceBefore = describeValue(source);

            const expected = modelFastMerge(target, source, model);
            const actual = utils.fastMerge<unknown>(target, source, options);

            expect({label, value: actual.result}).toStrictEqual({label, value: expected.value});
            expect({label, keyOrder: describeValue(actual.result)}).toStrictEqual({label, keyOrder: describeValue(expected.value)});
            expect({label, patches: actual.replaceNullPatches}).toStrictEqual({label, patches: expected.patches});
            expect({label, problems: findSharingProblems(actual.result, expected.value, sharingInputs(target, source))}).toStrictEqual({label, problems: []});
            expect({label, target: describeValue(target), source: describeValue(source)}).toStrictEqual({label, target: targetBefore, source: sourceBefore});

            if (actual.result === target) {
                coverage.keptTarget++;
            } else {
                coverage.changed++;
            }
            if (actual.replaceNullPatches.length > 0) {
                coverage.withPatches++;
            }
        }

        expect(coverage.keptTarget).toBeGreaterThan(SEEDS / 20);
        expect(coverage.changed).toBeGreaterThan(SEEDS / 2);
        if (model.mode === 'mark') {
            expect(coverage.withPatches).toBeGreaterThan(SEEDS / 40);
        }
    });

    it('keeps merging a sequence of patches equal to the model at every step', () => {
        for (let seed = 1; seed <= SEEDS / 4; seed++) {
            const rng = createRng(seed * 7919);
            let current: unknown = deepFreeze(generateObject(rng, 0, {withMarks: false}));
            let expected: unknown = current;

            for (let step = 0; step < 4; step++) {
                const patch = deepFreeze(deriveSource(rng, current, 0, {withMarks: false}));
                const label = `seed ${seed}, step ${step}: ${describeValue(current)} <- ${describeValue(patch)}`;
                expected = modelFastMerge(expected, patch, {removeNulls: true, mode: 'replace'}).value;
                const merged = utils.fastMerge<unknown>(current, patch, {shouldRemoveNestedNulls: true, objectRemovalMode: 'replace'}).result;

                expect({label, value: merged}).toStrictEqual({label, value: expected});
                expect({label, keyOrder: describeValue(merged)}).toStrictEqual({label, keyOrder: describeValue(expected)});
                expect({label, problems: findSharingProblems(merged, expected, sharingInputs(current, patch))}).toStrictEqual({label, problems: []});
                current = deepFreeze(merged);
                expected = current;
            }
        }
    });
});

describe('utils.removeNestedNullValues matches the reference model', () => {
    it('for generated values, keeping every untouched subtree by reference', () => {
        let changed = 0;
        for (let seed = 1; seed <= SEEDS; seed++) {
            const rng = createRng(seed * 31);
            const value = deepFreeze(generateValue(rng, 0, {withMarks: rng() < 0.2}));
            const label = `seed ${seed}: ${describeValue(value)}`;
            const before = describeValue(value);

            const expected = modelRemoveNestedNulls(value);
            const actual = utils.removeNestedNullValues(value);

            expect({label, value: actual}).toStrictEqual({label, value: expected});
            expect({label, keyOrder: describeValue(actual)}).toStrictEqual({label, keyOrder: describeValue(expected)});
            expect({label, problems: findSharingProblems(actual, expected, sharingInputs(value, undefined))}).toStrictEqual({label, problems: []});
            expect({label, value: describeValue(value)}).toStrictEqual({label, value: before});
            if (actual !== value) {
                changed++;
            }
        }
        expect(changed).toBeGreaterThan(SEEDS / 4);
        expect(changed).toBeLessThan(SEEDS);
    });
});
