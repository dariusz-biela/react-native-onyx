import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import type {ProbeProps} from '../../harness/probes';
import {renderProbeGrid, rerenderProbeGrid} from '../../harness/probes';
import type {RenderedTree} from '../../harness/react';
import {unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type KeySwitchContext = {
    tree: RenderedTree;
    reportKeys: Array<`${typeof ONYXKEYS.COLLECTION.REPORT}${string}`>;
    state: {revision: number};
};

/**
 * Navigating to another report re-renders the report screen with a different report member key.
 *
 * Marked indicative only: a sample is N separate `act` round trips, so it carries N event-loop turns worth
 * of scheduler jitter on top of about 3 ms of work. Two A/A runs left it with a MAD near 17% of the median,
 * which no amount of warmup or extra iterations moved. The render counter next to the timing is exact and
 * is the part of this row to trust; the timing only says whether something changed by a lot.
 */
function ReportScreenProbe({onyxKey}: ProbeProps) {
    countRender();
    useOnyx(onyxKey);
    return null;
}

const KEY_SWITCHES = 20;

const switchReportKey = defineScenario({
    id: 'hooks/key-switch/report-screen',
    title: 'indicative only: C components walking their Onyx key together across 20 report member keys, the report screen navigation pattern',
    realUsage: [
        {file: 'src/pages/inbox/ReportScreen.tsx', line: 95, note: 'the report screen reads the report member key of the route it is showing'},
        {file: 'src/pages/inbox/ReportScreen.tsx', line: 65, note: 'a second member read on the same screen, keyed by the same report id'},
    ],
    // One switch is O(1) per hook, so the size dimension is how many hooks switch together: a tenth of K,
    // 1, 15 and 30 components, the order of the hooks a report screen keys by the current report.
    scale: (profile) => ({keySwitches: Math.min(KEY_SWITCHES, profile.reports), components: Math.max(1, Math.round(profile.hookComponents / 10)), storeKeys: storeKeyCount(profile)}),
    measure: {timeBudgetMs: 12000, minIterations: 24, maxIterations: 30},
    setup: async (params): Promise<KeySwitchContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const reportKeys = account.reportIDs.slice(0, params.keySwitches).map((reportID): `${typeof ONYXKEYS.COLLECTION.REPORT}${string}` => `${ONYXKEYS.COLLECTION.REPORT}${reportID}`);

        return {tree: await renderProbeGrid(params.components, ReportScreenProbe, reportKeys[0]), reportKeys, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        resetRenderCount();
    },
    run: async (context, params) => {
        for (const reportKey of context.reportKeys) {
            // Each switch is its own React commit, the way a navigation is: the slot or the connection
            // behind the hook has to be swapped before the component can render the new report.
            // eslint-disable-next-line no-await-in-loop
            await rerenderProbeGrid(context.tree, params.components, ReportScreenProbe, reportKey, context.state.revision);
        }

        return {keySwitches: params.keySwitches, components: params.components, renders: getRenderCount()};
    },
    teardown: async (context) => {
        await unmountTree(context.tree);
    },
});

runScenarios([switchReportKey]);
