import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {renderProbes, unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/** The scenario keeps no state between iterations: every iteration mounts and unmounts its own tree. */
type ChurnContext = Record<string, never>;

/** A virtualized row: mounted and unmounted again as the list scrolls, always on the same warm key. */
function SessionProbe() {
    countRender();
    useOnyx(ONYXKEYS.SESSION);
    return null;
}

const mountUnmountChurn = defineScenario({
    id: 'hooks/unmount-remount/churn',
    title: 'one mount plus unmount cycle of K components on a warm key, the list virtualization pattern',
    realUsage: [
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'the LHN list whose rows mount and unmount as it is scrolled'},
        {file: 'src/DeepLinkHandler.tsx', line: 40, note: 'the session read a remounting row pays for again on every remount'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30},
    setup: async (): Promise<ChurnContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const warmup = await renderProbes(1, SessionProbe);
        await unmountTree(warmup);

        return {};
    },
    beforeEach: async () => {
        resetRenderCount();
    },
    run: async (context, params) => {
        const tree = await renderProbes(params.hookComponents, SessionProbe);
        await unmountTree(tree);

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
});

runScenarios([mountUnmountChurn]);
