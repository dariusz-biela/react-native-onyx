import useOnyx from '@app/useOnyx';

import ONYXKEYS from '@app/ONYXKEYS';
import {personalDetailsLoginSelector, sessionEmailAndAccountIDSelector} from '@app/selectors';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {waitForOnyx} from '../../harness/onyx';
import type {ProbeProps} from '../../harness/probes';
import {renderProbeGrid} from '../../harness/probes';
import type {RenderedTree} from '../../harness/react';
import {actAsync, renderProbes, unmountTree} from '../../harness/react';
import {countRender, getRenderCount, resetRenderCount} from '../../harness/renderCount';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * Every scenario here mounts its probes once in `setup` and times only the write plus the React
 * flush it causes: `actAsync` around the awaited `Onyx.merge` and the Onyx drain, so the timed region
 * ends after the last component has re-rendered. `renders` says how many components React actually
 * ran, which is the number the store layer under measurement decides.
 */
type UpdateContext = {
    tree: RenderedTree;
    state: {revision: number};
};

const UPDATE_MEASURE = {timeBudgetMs: 4000, minIterations: 12, maxIterations: 30};
const BURST_SIZE = 20;

function SessionProbe() {
    countRender();
    useOnyx(ONYXKEYS.SESSION);
    return null;
}

/** Reads only the email and the account id, so a write to any other session field leaves the result equal. */
function SessionSelectorProbe() {
    countRender();
    useOnyx(ONYXKEYS.SESSION, {selector: sessionEmailAndAccountIDSelector});
    return null;
}

function ReportMemberProbe({index}: ProbeProps) {
    countRender();
    useOnyx(`${ONYXKEYS.COLLECTION.REPORT}${index + 1}`);
    return null;
}

function PolicyCollectionProbe() {
    countRender();
    useOnyx(ONYXKEYS.COLLECTION.POLICY);
    return null;
}

function TypingProbe({onyxKey}: ProbeProps) {
    countRender();
    useOnyx(onyxKey);
    return null;
}

/** The largest K of any profile. */
const MAX_PER_INSTANCE_SELECTORS = 300;

/**
 * One login selector per probe, each for a different person, built once so its identity is stable the way
 * the React Compiler keeps `personalDetailsLoginSelector(accountID)` stable at a call site.
 */
const LOGIN_SELECTORS = Array.from({length: MAX_PER_INSTANCE_SELECTORS}, (value, index) => personalDetailsLoginSelector(index + 1));

function PersonLoginProbe({index}: ProbeProps) {
    countRender();
    useOnyx(ONYXKEYS.PERSONAL_DETAILS_LIST, {selector: LOGIN_SELECTORS[index]});
    return null;
}

async function unmountProbes(context: UpdateContext): Promise<void> {
    await unmountTree(context.tree);
}

async function bumpRevision(context: UpdateContext): Promise<void> {
    context.state.revision++;
    resetRenderCount();
}

const updateValueChanges = defineScenario({
    id: 'hooks/update/value-changes',
    title: 'one session merge that changes the value for all K mounted hooks, timed until the last component has re-rendered',
    realUsage: [
        {file: 'src/libs/actions/Session/index.ts', line: 155, note: 'setSupportAuthToken merges several fields into ONYXKEYS.SESSION'},
        {file: 'src/DeepLinkHandler.tsx', line: 40, note: 'one of the 162 files that re-render on any session change'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: UPDATE_MEASURE,
    setup: async (params): Promise<UpdateContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {tree: await renderProbes(params.hookComponents, SessionProbe), state: {revision: 0}};
    },
    beforeEach: bumpRevision,
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.merge(ONYXKEYS.SESSION, {authToken: `token-${context.state.revision}`});
            await waitForOnyx();
        });

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    teardown: unmountProbes,
});

const updateResultUnchanged = defineScenario({
    id: 'hooks/update/result-unchanged',
    title: 'one session merge on a field outside the selector, so all K hooks recompute and none of them re-renders',
    realUsage: [
        {file: 'src/pages/inbox/sidebar/FABPopoverContent/menuItems/CreateReportMenuItem.tsx', line: 44, note: 'reads only email and accountID out of the session'},
        {file: 'src/libs/actions/Session/index.ts', line: 1133, note: 'invalidateAuthToken merges authToken, which that selector does not read'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents}),
    measure: UPDATE_MEASURE,
    setup: async (params): Promise<UpdateContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {tree: await renderProbes(params.hookComponents, SessionSelectorProbe), state: {revision: 0}};
    },
    beforeEach: bumpRevision,
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.merge(ONYXKEYS.SESSION, {authToken: `token-${context.state.revision}`});
            await waitForOnyx();
        });

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    teardown: unmountProbes,
});

const updateUnrelatedMember = defineScenario({
    id: 'hooks/update/unrelated-member',
    title: 'K hooks on K different report members, one member merged, so only that one component re-renders',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 982, note: 'the optimistic report head fields an LHN row shows, merged into one report member'},
        {file: 'src/components/ArchivedReportFooter.tsx', line: 29, note: 'a component subscribed to exactly one report member key'},
    ],
    scale: (profile) => ({hookComponents: Math.min(profile.hookComponents, profile.reports)}),
    measure: UPDATE_MEASURE,
    setup: async (params): Promise<UpdateContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {tree: await renderProbeGrid(params.hookComponents, ReportMemberProbe, ONYXKEYS.COLLECTION.REPORT), state: {revision: 0}};
    },
    beforeEach: bumpRevision,
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.merge(`${ONYXKEYS.COLLECTION.REPORT}1`, {lastMessageText: `message ${context.state.revision}`});
            await waitForOnyx();
        });

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    teardown: unmountProbes,
});

const updateCollectionObject = defineScenario({
    id: 'hooks/update/collection-object',
    title: 'K hooks on the whole policy collection object, one policy member merged',
    realUsage: [
        {file: 'src/libs/actions/Workflow.ts', line: 83, note: 'an approval-workflow change merged into one policy member key'},
        {file: 'src/FullstoryUserContextHandler.tsx', line: 21, note: 'a component subscribed to the whole policy collection'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents, policies: profile.policies}),
    measure: UPDATE_MEASURE,
    setup: async (params): Promise<UpdateContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {tree: await renderProbes(params.hookComponents, PolicyCollectionProbe), state: {revision: 0}};
    },
    beforeEach: bumpRevision,
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.merge(`${ONYXKEYS.COLLECTION.POLICY}1`, {name: `policy ${context.state.revision}`});
            await waitForOnyx();
        });

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    teardown: unmountProbes,
});

const updateBurst = defineScenario({
    id: 'hooks/update/burst',
    title: 'twenty merges fired in one tick on the typing key K hooks watch, timed until the queue has flushed and React has settled',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 654, note: 'broadcastUserIsTyping merges the typing status for the open report'},
        {file: 'src/libs/actions/Report/index.ts', line: 632, note: 'the same key is reset when the report is opened'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents, merges: BURST_SIZE}),
    measure: UPDATE_MEASURE,
    setup: async (params): Promise<UpdateContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        const typingKey: `${typeof ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${string}` = `${ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${account.reportIDs[0]}`;

        return {tree: await renderProbeGrid(params.hookComponents, TypingProbe, typingKey), state: {revision: 0}};
    },
    beforeEach: bumpRevision,
    run: async (context, params) => {
        const account = getHeavyAccount();
        const typingKey: `${typeof ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${string}` = `${ONYXKEYS.COLLECTION.REPORT_USER_IS_TYPING}${account.reportIDs[0]}`;

        await actAsync(async () => {
            const merges: Array<Promise<void>> = [];

            for (let index = 0; index < BURST_SIZE; index++) {
                merges.push(Onyx.merge(typingKey, {[`user${index}`]: (context.state.revision + index) % 2 === 0}));
            }

            await Promise.all(merges);
            await waitForOnyx();
        });

        return {mounted: params.hookComponents, merges: params.merges, renders: getRenderCount()};
    },
    teardown: unmountProbes,
});

/**
 * 85 of the 187 personal details hooks select one person through a selector of their own. Every write to
 * the list runs each of those selectors and compares its result, and exactly one of them changes.
 */
const updatePerInstanceSelector = defineScenario({
    id: 'hooks/update/per-instance-selector',
    title: 'one personal details merge changing one person, with K hooks on the N-entry list each selecting a different person, timed until React settles',
    realUsage: [
        {file: 'src/components/MoneyRequestHeader.tsx', line: 63, note: 'useOnyx(PERSONAL_DETAILS_LIST, {selector: personalDetailsLoginSelector(ownerAccountID)})'},
        {file: 'src/selectors/PersonalDetails.ts', line: 26, note: 'the per-person selector factory those call sites use'},
    ],
    scale: (profile) => ({hookComponents: Math.min(MAX_PER_INSTANCE_SELECTORS, profile.hookComponents), personalDetails: profile.personalDetails}),
    measure: UPDATE_MEASURE,
    setup: async (params): Promise<UpdateContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {tree: await renderProbeGrid(params.hookComponents, PersonLoginProbe, ONYXKEYS.PERSONAL_DETAILS_LIST), state: {revision: 0}};
    },
    beforeEach: bumpRevision,
    run: async (context, params) => {
        await actAsync(async () => {
            await Onyx.merge(ONYXKEYS.PERSONAL_DETAILS_LIST, {'1': {login: `perf-${context.state.revision}@expensify.com`}});
            await waitForOnyx();
        });

        return {mounted: params.hookComponents, renders: getRenderCount()};
    },
    teardown: unmountProbes,
});

runScenarios([updateValueChanges, updateResultUnchanged, updateUnrelatedMember, updateCollectionObject, updateBurst, updatePerInstanceSelector]);
