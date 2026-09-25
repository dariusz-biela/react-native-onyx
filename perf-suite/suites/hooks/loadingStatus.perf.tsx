import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {waitForOnyx} from '../../harness/onyx';
import type {ProbeProps} from '../../harness/probes';
import {renderProbeGrid} from '../../harness/probes';
import type {RenderedTree} from '../../harness/react';
import {actAsync, unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type LoadingContext = {
    state: {tree: RenderedTree | undefined; revision: number};
};

type TypingKey = `${typeof ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${string}`;

function TypingProbe({onyxKey}: ProbeProps) {
    countRender();
    useOnyx(onyxKey);
    return null;
}

const mountWithPendingMerge = defineScenario({
    id: 'hooks/loading-status/pending-merge',
    title: 'mount K components on a key whose merge is still queued, so every hook starts in the loading status and settles',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 654, note: 'broadcastUserIsTyping merges the typing key without awaiting it, which is what leaves a merge queued'},
        {file: 'src/pages/inbox/ReportScreen.tsx', line: 95, note: 'a screen mounting its hooks while the data it reads is still being written'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30},
    setup: async (): Promise<LoadingContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {tree: undefined, revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        resetRenderCount();
    },
    run: async (context, params) => {
        const account = getHeavyAccount();
        const typingKey: TypingKey = `${ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${account.reportIDs[0]}`;

        // `hasPendingMergeForKey` is what makes a freshly mounted hook report `loading` rather than the
        // value the cache already holds, so the merge has to still be queued while the components mount.
        // It is started inside the timed region because there is no way to hold one open from `beforeEach`.
        const pendingMerge = Onyx.merge(typingKey, {[`user${context.state.revision}`]: true});
        context.state.tree = await renderProbeGrid(params.hookComponents, TypingProbe, typingKey);

        await actAsync(async () => {
            await pendingMerge;
            await waitForOnyx();
        });

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

runScenarios([mountWithPendingMerge]);
