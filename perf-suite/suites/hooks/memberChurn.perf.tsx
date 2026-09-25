import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import type {ProbeProps} from '../../harness/probes';
import {renderProbeGrid} from '../../harness/probes';
import {unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The LHN under a fast fling: every row that scrolls into view mounts a hook on its own report member
 * key and drops it again on the way out, so the subscription layer sees K connects and K disconnects on
 * K different keys per pass. `hooks/unmount-remount/churn` is the same cycle on one shared warm key; the
 * difference between the two rows is what per-key bookkeeping costs.
 */
type MemberChurnContext = Record<string, never>;

function ReportMemberProbe({index}: ProbeProps) {
    countRender();
    useOnyx(`${ONYXKEYS.COLLECTION.REPORT}${index + 1}`);
    return null;
}

const memberKeysChurn = defineScenario({
    id: 'hooks/unmount-remount/member-keys',
    title: 'one mount plus unmount cycle of K components each on its own report member key, the LHN fling pattern',
    realUsage: [
        {file: 'src/components/LHNOptionsList/OptionRowLHN/OptionRowLHNData.tsx', line: 125, note: 'an LHN row reading one report member key'},
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'the virtualized list whose rows mount and unmount as it scrolls'},
    ],
    scale: (profile) => ({hookComponents: Math.min(profile.hookComponents, profile.reports)}),
    measure: {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30},
    setup: async (): Promise<MemberChurnContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const warmup = await renderProbeGrid(1, ReportMemberProbe, ONYXKEYS.COLLECTION.REPORT);
        await unmountTree(warmup);

        return {};
    },
    beforeEach: async () => {
        resetRenderCount();
    },
    run: async (context, params) => {
        const tree = await renderProbeGrid(params.hookComponents, ReportMemberProbe, ONYXKEYS.COLLECTION.REPORT);
        await unmountTree(tree);

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
});

runScenarios([memberKeysChurn]);
