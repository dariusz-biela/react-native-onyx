import ONYXKEYS from '@app/ONYXKEYS';

import type {Connection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import type {ReconnectUpdate} from '../../fixtures/updates';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildReconnectDelta} from '../../fixtures/updates';
import {prepareDerivedValues} from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The derived values under a server batch rather than a single merge: a ReconnectApp delta of up to 200
 * changed reports applied through `Onyx.update`, with the derived-value engine live, timed until the
 * report attributes derived key has been written and Onyx has drained. `subscriptions/derived/report-attributes`
 * is the one-merge case; this row is what a reconnect costs on top of the write itself, because every
 * derived config with a report collection dependency recomputes on the batch.
 */
type DerivedBatchContext = {
    connection: Connection | undefined;
    updates: ReconnectUpdate[];
    state: {revision: number; derivedWrites: number; resolve: (() => void) | undefined};
};

const RECONNECT_REPORTS = 200;

const derivedReconnectDelta = defineScenario({
    id: 'subscriptions/derived/reconnect-delta',
    title: 'a ReconnectApp delta of R reports applied through Onyx.update with the derived-value engine running, timed until report attributes are written and Onyx drains',
    realUsage: [
        {file: 'src/libs/actions/OnyxDerived/index.ts', line: 266, note: 'the collection-root connection every derived value with a collection dependency opens'},
        {file: 'src/libs/actions/OnyxDerived/configs/reportAttributes.ts', line: 219, note: 'the dependencies report attributes recomputes from, the report collection first'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'a ReconnectApp response applied through Onyx.update'},
    ],
    scale: (profile) => ({reports: profile.reports, changedReports: Math.min(RECONNECT_REPORTS, profile.reports)}),
    measure: {warmupIterations: 3, minIterations: 8, maxIterations: 20, timeBudgetMs: 6000},
    setup: async (): Promise<DerivedBatchContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        await prepareDerivedValues();

        const state: DerivedBatchContext['state'] = {revision: 0, derivedWrites: 0, resolve: undefined};
        const connection = Onyx.connectWithoutView({
            key: ONYXKEYS.DERIVED.REPORT_ATTRIBUTES,
            callback: () => {
                state.derivedWrites++;
                state.resolve?.();
                state.resolve = undefined;
            },
        });
        await waitForOnyx();

        return {connection, updates: [], state};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;
        context.state.derivedWrites = 0;
        context.state.resolve = undefined;
        context.updates = buildReconnectDelta(getHeavyAccount(), params.changedReports, context.state.revision);
    },
    run: async (context, params) => {
        const derivedWritten = new Promise<void>((resolve) => {
            context.state.resolve = resolve;
        });

        await Onyx.update(context.updates);
        await derivedWritten;
        await waitForOnyx();

        return {changedReports: params.changedReports, derivedWrites: context.state.derivedWrites};
    },
    teardown: async (context) => {
        if (!context.connection) {
            return;
        }
        Onyx.disconnect(context.connection);
    },
});

runScenarios([derivedReconnectDelta]);
