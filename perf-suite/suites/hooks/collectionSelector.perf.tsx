import ONYXKEYS from '@app/ONYXKEYS';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {QUICK_MEASURE} from '../../harness/measure';
import {waitForOnyx} from '../../harness/onyx';
import type {RenderedTree} from '../../harness/react';
import {actAsync, renderProbes, unmountTree} from '../../harness/react';
import {getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import type {MeasureOverrides} from '../../harness/scenario';
import defineScenario from '../../harness/scenario';
import ReportSummariesProbe from './reportSummariesProbe';

/**
 * A hook on a whole collection with a selector, the shape 121 call sites in `src/` use on the report
 * collection alone. On every member change Onyx hands the selector the whole collection object, so each
 * of the K hooks walks all N members again (`OnyxUtils.reduceCollectionWithSelector` is the internals row
 * for the same walk). `reportSummariesSelector` is the one `usePersonalDetailOptions` keeps at module level:
 * it projects every report onto a few fields, so its result is a new object on every run and the compare
 * afterwards decides whether the component re-renders.
 */
type CollectionSelectorContext = {
    state: {revision: number; tree: RenderedTree | undefined};
};

const HOOK_MEASURE = {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30};

const REAL_USAGE = [
    {file: 'src/hooks/usePersonalDetailOptions.ts', line: 188, note: 'useOnyx(COLLECTION.REPORT, {selector: reportsSelector}), a module-level selector over the whole collection'},
    {file: 'src/components/FloatingCameraButton/BaseFloatingCameraButton.tsx', line: 68, note: 'another whole-collection selector hook on the report collection'},
];

const mountCollectionSelector = defineScenario({
    id: 'hooks/mount/collection-selector',
    title: 'mount K components on the whole report collection through one module-level selector that projects every one of N reports',
    realUsage: REAL_USAGE,
    scale: (profile) => ({hookComponents: profile.hookComponents, reports: profile.reports}),
    measure: HOOK_MEASURE,
    setup: async (): Promise<CollectionSelectorContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const warmup = await renderProbes(1, ReportSummariesProbe);
        await unmountTree(warmup);

        return {state: {revision: 0, tree: undefined}};
    },
    beforeEach: async () => {
        resetRenderCount();
    },
    run: async (context, params) => {
        context.state.tree = await renderProbes(params.hookComponents, ReportSummariesProbe);
        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    afterEach: async (context) => {
        if (!context.state.tree) {
            return;
        }
        await unmountTree(context.state.tree);
        context.state.tree = undefined;
    },
});

type ReportPatch = {reportName: string} | {lastReadTime: string};

type UpdateRowOptions = {
    id: string;
    title: string;
    buildPatch: (revision: number) => ReportPatch;
    measure: MeasureOverrides;
};

/** One report member merge under K mounted selector hooks; `buildPatch` decides whether the selected fields change. */
function defineUpdateRow({id, title, buildPatch, measure}: UpdateRowOptions) {
    return defineScenario({
        id,
        title,
        realUsage: [...REAL_USAGE, {file: 'src/libs/actions/Report/index.ts', line: 982, note: 'the optimistic report head fields merged into one report member'}],
        scale: (profile) => ({hookComponents: profile.hookComponents, reports: profile.reports}),
        measure,
        setup: async (params): Promise<CollectionSelectorContext> => {
            await seedOnyxWithAccount(getHeavyAccount());

            return {state: {revision: 0, tree: await renderProbes(params.hookComponents, ReportSummariesProbe)}};
        },
        beforeEach: async (context) => {
            context.state.revision++;
            resetRenderCount();
        },
        run: async (context, params) => {
            await actAsync(async () => {
                await Onyx.merge(`${ONYXKEYS.COLLECTION.REPORT}1`, buildPatch(context.state.revision));
                await waitForOnyx();
            });

            return {mounted: params.hookComponents, renders: getRenderCount()};
        },
        teardown: async (context) => {
            if (!context.state.tree) {
                return;
            }
            await unmountTree(context.state.tree);
        },
    });
}

const updateCollectionSelector = defineUpdateRow({
    id: 'hooks/update/collection-selector',
    title: 'one report member merge with K hooks on the whole collection through a shared selector, so every hook re-projects all N reports',
    buildPatch: (revision) => ({reportName: `report ${revision}`}),
    measure: HOOK_MEASURE,
});

const updateUnselectedField = defineUpdateRow({
    id: 'hooks/update/collection-selector-unselected-field',
    title: 'one report member merge of a field the shared selector does not read, with K hooks on the whole collection: all N reports are re-projected and compared for a result that cannot change, 0 renders expected',
    buildPatch: (revision) => ({lastReadTime: `2026-09-28 12:00:${String(revision % 60).padStart(2, '0')}.000`}),
    measure: QUICK_MEASURE,
});

runScenarios([mountCollectionSelector, updateCollectionSelector, updateUnselectedField]);
