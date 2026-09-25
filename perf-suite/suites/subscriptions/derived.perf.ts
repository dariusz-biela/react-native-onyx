import ONYXKEYS from '@app/ONYXKEYS';

import type {Connection} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {prepareDerivedValues} from '../../harness/loadedApp';
import {waitForOnyx} from '../../harness/onyx';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The derived-value engine (`app/derived`) wires every derived key the App defines with the App's dependency
 * lists, so one report merge recomputes report attributes alongside the other derived values that depend on the
 * report collection. `reportAttributes` only starts writing once every dependency connection has fired, and its
 * locale dependency is gated behind `RAM_ONLY_ARE_TRANSLATIONS_LOADING`, which is why setup clears that flag first
 * (the same recipe as the App's `tests/unit/OnyxDerivedTest.tsx:38-45`).
 *
 * Timed region: `Onyx.merge` on one report plus the wait until the derived key's subscriber fires, because
 * the recompute happens on a microtask after the dependency callback, not inside the merge.
 */
type DerivedContext = {
    reportKey: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;
    connection: Connection | undefined;
    state: {revision: number; updates: number; resolve: (() => void) | undefined};
};

const derivedReportAttributes = defineScenario({
    id: 'subscriptions/derived/report-attributes',
    title: 'one report merge with the derived-value engine running, timed until the report attributes derived key is written again',
    realUsage: [
        {file: 'src/libs/actions/OnyxDerived/index.ts', line: 266, note: 'the collection-root connection every derived value with a collection dependency opens'},
        {file: 'src/libs/actions/OnyxDerived/configs/reportAttributes.ts', line: 219, note: 'the twelve dependencies report attributes recomputes from'},
        {file: 'src/libs/actions/OnyxDerived/utils.ts', line: 26, note: 'setDerivedValue writes the recomputed value back into Onyx'},
    ],
    scale: (profile) => ({reports: profile.reports, activeReports: profile.activeReports}),
    // The recompute walks the whole report collection, so a handful of samples is already several seconds.
    measure: {warmupIterations: 3, minIterations: 8, maxIterations: 20, timeBudgetMs: 6000},
    setup: async (): Promise<DerivedContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        await prepareDerivedValues();

        const state: DerivedContext['state'] = {revision: 0, updates: 0, resolve: undefined};
        const connection = Onyx.connectWithoutView({
            key: ONYXKEYS.DERIVED.REPORT_ATTRIBUTES,
            callback: () => {
                state.updates++;
                state.resolve?.();
                state.resolve = undefined;
            },
        });

        await waitForOnyx();

        return {reportKey: `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[0]}`, connection, state};
    },
    beforeEach: async (context) => {
        context.state.revision++;
        context.state.updates = 0;
        context.state.resolve = undefined;
    },
    run: async (context) => {
        const derivedUpdated = new Promise<void>((resolve) => {
            context.state.resolve = resolve;
        });

        await Onyx.merge(context.reportKey, {lastMessageText: `revision ${context.state.revision}`});
        await derivedUpdated;

        return {derivedUpdates: context.state.updates};
    },
    teardown: async (context) => {
        if (!context.connection) {
            return;
        }

        Onyx.disconnect(context.connection);
    },
});

runScenarios([derivedReportAttributes]);
