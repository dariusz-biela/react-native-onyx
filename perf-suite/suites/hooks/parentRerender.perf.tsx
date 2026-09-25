import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import type {ProbeProps} from '../../harness/probes';
import {renderProbeGrid, rerenderProbeGrid} from '../../harness/probes';
import type {RenderedTree} from '../../harness/react';
import {unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type ParentRerenderContext = {
    tree: RenderedTree;
    state: {revision: number};
};

/**
 * The `revision` prop changes on every parent render, which is what makes React (and the React
 * Compiler, which does compile these files) actually re-run the child. The Onyx value behind the hook
 * never changes, so everything the timed region measures is the per-render cost of `useOnyx` itself.
 */
function SessionProbe(props: ProbeProps) {
    countRender();
    useOnyx(ONYXKEYS.SESSION);

    // The prop is not rendered, only received: a changed `revision` is what invalidates the memoized
    // child and forces the hook to run again.
    return props.revision < 0 ? null : null;
}

const parentRerenderStable = defineScenario({
    id: 'hooks/parent-rerender/stable',
    title: 'a parent re-rendering K children whose Onyx value did not change, so every hook re-reads but nothing updates',
    realUsage: [
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'a list re-rendered by its own state while the rows keep reading unchanged Onyx data'},
        {file: 'src/DeepLinkHandler.tsx', line: 40, note: 'the session read that every such child pays for again on each parent render'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30},
    setup: async (params): Promise<ParentRerenderContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {tree: await renderProbeGrid(params.hookComponents, SessionProbe, ONYXKEYS.SESSION), state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        resetRenderCount();
    },
    run: async (context, params) => {
        await rerenderProbeGrid(context.tree, params.hookComponents, SessionProbe, ONYXKEYS.SESSION, context.state.revision);

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    teardown: async (context) => {
        await unmountTree(context.tree);
    },
});

runScenarios([parentRerenderStable]);
