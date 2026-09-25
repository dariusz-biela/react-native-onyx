import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';
import {sessionEmailAndAccountIDSelector} from '@app/selectors';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {waitForOnyx} from '../../harness/onyx';
import type {ProbeProps} from '../../harness/probes';
import {renderProbeGrid} from '../../harness/probes';
import type {RenderedTree} from '../../harness/react';
import {actAsync, renderProbes, unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type MountContext = {
    state: {tree: RenderedTree | undefined; revision: number};
};

/** Mounting hundreds of components is heavier than an Onyx write, so the mount group gets a longer budget. */
const MOUNT_MEASURE = {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30};

function createMountContext(): MountContext {
    return {state: {tree: undefined, revision: 0}};
}

async function unmountAfterIteration(context: MountContext): Promise<void> {
    if (!context.state.tree) {
        return;
    }

    await unmountTree(context.state.tree);
    context.state.tree = undefined;
}

/** Mounted K times on a key that is already in the Onyx cache, the common case in a booted app. */
function SessionProbe() {
    countRender();
    useOnyx(ONYXKEYS.SESSION);
    return null;
}

/** Same key, but every instance shares one module-level selector reference. */
function SharedSelectorProbe() {
    countRender();
    useOnyx(ONYXKEYS.SESSION, {selector: sessionEmailAndAccountIDSelector});
    return null;
}

/** Same key, but the selector closes over the instance's index, so no two probes share one. */
function InlineSelectorProbe({index}: ProbeProps) {
    countRender();
    useOnyx(ONYXKEYS.SESSION, {selector: (session) => ({email: session?.email, index})});
    return null;
}

/** Reads whatever key the scenario hands it, used for the key that is not in the cache yet. */
function KeyedProbe({onyxKey}: ProbeProps) {
    countRender();
    useOnyx(onyxKey);
    return null;
}

/** Reads the whole policy collection object, the way the workspace switcher and Fullstory context do. */
function PolicyCollectionProbe() {
    countRender();
    useOnyx(ONYXKEYS.COLLECTION.POLICY);
    return null;
}

/** One report row: every instance reads a different member of the report collection. */
function ReportMemberProbe({index}: ProbeProps) {
    countRender();
    useOnyx(`${ONYXKEYS.COLLECTION.REPORT}${index + 1}`);
    return null;
}

const mountOnWarmKey = defineScenario({
    id: 'hooks/mount/warm-key-no-selector',
    title: 'mount K components that each call the app wrapper useOnyx on the already-cached session key, no selector',
    realUsage: [
        {file: 'src/DeepLinkHandler.tsx', line: 40, note: 'useOnyx(ONYXKEYS.SESSION), one of 162 files reading the session this way'},
        {file: 'src/hooks/useOnyx.ts', line: 75, note: 'the app wrapper that every useOnyx call in src/ goes through'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: MOUNT_MEASURE,
    setup: async (): Promise<MountContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        // One throwaway mount so the key, the connection and the JIT are all warm before the first sample.
        const warmup = await renderProbes(1, SessionProbe);
        await unmountTree(warmup);

        return createMountContext();
    },
    beforeEach: async () => {
        resetRenderCount();
    },
    run: async (context, params) => {
        context.state.tree = await renderProbes(params.hookComponents, SessionProbe);
        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    afterEach: unmountAfterIteration,
});

const mountWithSharedSelector = defineScenario({
    id: 'hooks/mount/warm-key-shared-selector',
    title: 'mount K components on the session key, all of them passing the same module-level selector reference',
    realUsage: [
        {file: 'src/pages/inbox/sidebar/FABPopoverContent/menuItems/CreateReportMenuItem.tsx', line: 44, note: 'useOnyx(SESSION, {selector: sessionEmailAndAccountIDSelector})'},
        {file: 'src/selectors/Session.ts', line: 12, note: 'sessionEmailAndAccountIDSelector, a module-level selector shared by every call site'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: MOUNT_MEASURE,
    setup: async (): Promise<MountContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const warmup = await renderProbes(1, SharedSelectorProbe);
        await unmountTree(warmup);

        return createMountContext();
    },
    beforeEach: async () => {
        resetRenderCount();
    },
    run: async (context, params) => {
        context.state.tree = await renderProbes(params.hookComponents, SharedSelectorProbe);
        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    afterEach: unmountAfterIteration,
});

const mountWithInlineSelector = defineScenario({
    id: 'hooks/mount/warm-key-inline-selector',
    title: 'mount K components on the session key, each one passing a selector created inside its own body',
    realUsage: [
        {file: 'src/components/Tables/WorkspaceRoomsTable/index.tsx', line: 44, note: 'selector: (value) => value?.[policyID], an inline selector closing over a prop'},
        {file: 'src/components/TransactionItemRow/DataCells/TypeCell.tsx', line: 66, note: 'inline selector over CARD_LIST closing over the row item'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: MOUNT_MEASURE,
    setup: async (): Promise<MountContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const warmup = await renderProbeGrid(1, InlineSelectorProbe, ONYXKEYS.SESSION);
        await unmountTree(warmup);

        return createMountContext();
    },
    beforeEach: async () => {
        resetRenderCount();
    },
    run: async (context, params) => {
        context.state.tree = await renderProbeGrid(params.hookComponents, InlineSelectorProbe, ONYXKEYS.SESSION);
        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    afterEach: unmountAfterIteration,
});

const mountOnColdKey = defineScenario({
    id: 'hooks/mount/cold-key',
    title: 'mount K components on a report member key that is in neither the cache nor storage, through the loading status and back',
    realUsage: [
        {file: 'src/DeepLinkHandler.tsx', line: 42, note: 'useOnyx on the concierge report before that report has been fetched'},
        {file: 'src/libs/Navigation/AppNavigator/AuthScreensInitHandler.tsx', line: 98, note: 'the same read on the first authenticated screen after boot'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: MOUNT_MEASURE,
    setup: async (): Promise<MountContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const warmup = await renderProbeGrid(1, KeyedProbe, `${ONYXKEYS.COLLECTION.REPORT}cold-warmup`);
        await unmountTree(warmup);

        return createMountContext();
    },
    beforeEach: async (context) => {
        // A fresh key every iteration, otherwise the second iteration would mount on a warm key.
        context.state.revision++;
        resetRenderCount();
    },
    run: async (context, params) => {
        context.state.tree = await renderProbeGrid(params.hookComponents, KeyedProbe, `${ONYXKEYS.COLLECTION.REPORT}cold-${context.state.revision}`);
        await actAsync(() => waitForOnyx());

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    afterEach: unmountAfterIteration,
});

const mountOnCollection = defineScenario({
    id: 'hooks/mount/collection',
    title: 'mount K components that each read the whole policy collection object',
    realUsage: [
        {file: 'src/FullstoryUserContextHandler.tsx', line: 21, note: 'useOnyx(ONYXKEYS.COLLECTION.POLICY), the whole collection'},
        {file: 'src/components/WorkspaceConfirmationForm.tsx', line: 127, note: 'another of the 180 whole-collection policy reads'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents, policies: profile.policies}),
    measure: MOUNT_MEASURE,
    setup: async (): Promise<MountContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const warmup = await renderProbes(1, PolicyCollectionProbe);
        await unmountTree(warmup);

        return createMountContext();
    },
    beforeEach: async () => {
        resetRenderCount();
    },
    run: async (context, params) => {
        context.state.tree = await renderProbes(params.hookComponents, PolicyCollectionProbe);
        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    afterEach: unmountAfterIteration,
});

const mountOnCollectionMembers = defineScenario({
    id: 'hooks/mount/collection-member',
    title: 'mount K components that each read a different member of the report collection, the LHN row shape',
    realUsage: [
        {file: 'src/components/ArchivedReportFooter.tsx', line: 29, note: 'useOnyx(`${ONYXKEYS.COLLECTION.REPORT}${reportID}`) on a single member'},
        {file: 'src/components/ParentNavigationSubtitle.tsx', line: 101, note: 'two member reads in one component, one per report id'},
    ],
    scale: (profile) => ({hookComponents: Math.min(profile.hookComponents, profile.reports), reports: profile.reports}),
    measure: MOUNT_MEASURE,
    setup: async (): Promise<MountContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const warmup = await renderProbeGrid(1, ReportMemberProbe, ONYXKEYS.COLLECTION.REPORT);
        await unmountTree(warmup);

        return createMountContext();
    },
    beforeEach: async () => {
        resetRenderCount();
    },
    run: async (context, params) => {
        context.state.tree = await renderProbeGrid(params.hookComponents, ReportMemberProbe, ONYXKEYS.COLLECTION.REPORT);
        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    afterEach: unmountAfterIteration,
});

runScenarios([mountOnWarmKey, mountWithSharedSelector, mountWithInlineSelector, mountOnColdKey, mountOnCollection, mountOnCollectionMembers]);
