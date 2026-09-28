import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxMergeCollectionInput} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import {useLayoutEffect, useState} from 'react';

import type {RenderedTree} from '../../harness/react';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {QUICK_MEASURE} from '../../harness/measure';
import {waitForOnyx} from '../../harness/onyx';
import {actAsync, buildProbeList, unmountTree} from '../../harness/react';
import {getRenderCount, resetRenderCount} from '../../harness/renderCount';
import render from '../../harness/renderer';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';
import ReportSummariesProbe from './reportSummariesProbe';

/**
 * How long a user input waits behind a background Onyx write. `useOnyx` subscribes through
 * `useSyncExternalStore`, whose store updates React always renders at SyncLane, so the K hooks a write reaches
 * re-render before a default-priority input update that was issued at the same moment. The row runs outside
 * `act`, on React's own scheduler, since `act` would flush both updates as one batch and hide the ordering.
 */
type InputChannel = {
    setValue: ((value: number) => void) | undefined;
    onCommit: ((value: number) => void) | undefined;
};

type InputProbeProps = {
    onSetterReady: (setValue: (value: number) => void) => void;
    onCommit: (value: number) => void;
};

// The channel arrives through callbacks, not a module variable: a hot-swap run mounts one tree per arm, and each
// lane must drive its own tree's input.
function InputProbe({onSetterReady, onCommit}: InputProbeProps) {
    const [value, setValue] = useState(0);

    useLayoutEffect(() => {
        onSetterReady(setValue);
    }, [onSetterReady]);

    useLayoutEffect(() => {
        onCommit(value);
    }, [onCommit, value]);

    return null;
}

type PriorityContext = {
    tree: RenderedTree;
    channel: InputChannel;
    state: {revision: number; write: Promise<void>};
    patch: OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT>;
};

function setActEnvironment(isActEnvironment: boolean): void {
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: isActEnvironment});
}

// Far above any sample; a lost commit fails the row instead of hanging it until the Jest timeout.
const INPUT_COMMIT_TIMEOUT_MS = 10000;

/** Resolves with the probe renders counted when the input's `value` commits. */
function waitForInputCommit(channel: InputChannel, value: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`hooks/priority: input value ${value} never committed`)), INPUT_COMMIT_TIMEOUT_MS);

        channel.onCommit = (committed) => {
            if (committed !== value) {
                return;
            }
            clearTimeout(timeout);
            resolve(getRenderCount());
        };
    });
}

const inputAfterBackgroundWrite = defineScenario({
    id: 'hooks/priority/input-after-background-write',
    title: 'a default-priority input update issued right after a mergeCollection of U report members that K whole-collection selector hooks read, timed until the input commits',
    realUsage: [
        {
            file: 'src/hooks/usePersonalDetailOptions.ts',
            line: 188,
            note: 'useOnyx(COLLECTION.REPORT, {selector: reportsSelector}), a whole-collection selector hook on screen while the user types',
        },
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 128, note: 'a Pusher update applied in the background, whose report entries go through mergeCollection'},
    ],
    scale: (profile) => ({hookComponents: profile.hookComponents, members: profile.updateBatchKeys, reports: profile.reports}),
    measure: QUICK_MEASURE,
    setup: async (params): Promise<PriorityContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const channel: InputChannel = {setValue: undefined, onCommit: undefined};
        const tree = render(
            <>
                <InputProbe
                    onSetterReady={(setValue) => {
                        channel.setValue = setValue;
                    }}
                    onCommit={(value) => channel.onCommit?.(value)}
                />
                {buildProbeList(params.hookComponents, ReportSummariesProbe)}
            </>,
        );
        await actAsync(() => {});

        return {tree, channel, state: {revision: 0, write: Promise.resolve()}, patch: {}};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;

        const patch: OnyxMergeCollectionInput<typeof ONYXKEYS.COLLECTION.REPORT> = {};
        for (const reportID of getHeavyAccount().reportIDs.slice(0, params.members)) {
            patch[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`] = {reportName: `background ${context.state.revision}`};
        }

        context.patch = patch;
        resetRenderCount();
        setActEnvironment(false);
    },
    run: async (context, params) => {
        const setInput = context.channel.setValue;
        if (!setInput) {
            throw new Error('hooks/priority: the input probe never exposed its setter');
        }
        const committed = waitForInputCommit(context.channel, context.state.revision);

        context.state.write = Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT, context.patch);
        setInput(context.state.revision);

        const probeRendersBeforeInput = await committed;

        return {hookComponents: params.hookComponents, members: params.members, probeRendersBeforeInput};
    },
    afterEach: async (context) => {
        await context.state.write;
        await waitForOnyx();
        context.channel.onCommit = undefined;
        setActEnvironment(true);
    },
    teardown: async (context) => {
        await unmountTree(context.tree);
    },
});

runScenarios([inputAfterBackgroundWrite]);
