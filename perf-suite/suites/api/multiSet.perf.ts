import ONYXKEYS from '@app/ONYXKEYS';
import type {Report} from '@app/types';

import type {OnyxMultiSetInput} from 'react-native-onyx';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type MixedKeysContext = {
    state: {revision: number};
    nextValues: OnyxMultiSetInput[];
};

type CollectionMembersContext = {
    state: {revision: number};
    nextValue: OnyxMultiSetInput;
};

// One multiSet of ten plain keys is around a tenth of a millisecond, close enough to the harness's own
// async overhead around the timed region to matter, so a sample writes ten of them in a row.
const MIXED_KEY_WRITES_PER_SAMPLE = 10;

/** Ten unrelated plain keys, the shape `Onyx.multiSet` is used with outside the import flow. */
function buildMixedKeys(revision: number): OnyxMultiSetInput {
    const isEven = revision % 2 === 0;

    return {
        [ONYXKEYS.IS_LOADING_APP]: isEven,
        [ONYXKEYS.HAS_LOADED_APP]: !isEven,
        [ONYXKEYS.IS_USING_IMPORTED_STATE]: isEven,
        [ONYXKEYS.IS_DEBUG_MODE_ENABLED]: !isEven,
        [ONYXKEYS.IS_SENTRY_DEBUG_ENABLED]: isEven,
        [ONYXKEYS.HAS_DENIED_CONTACT_IMPORT_PROMPT]: !isEven,
        [ONYXKEYS.USER_LOCATION]: {longitude: revision, latitude: -revision},
        [ONYXKEYS.ODOMETER_DRAFT]: {odometerStartReading: revision},
        [ONYXKEYS.REPORT_LAST_VISIT_TIMES]: {'1': `2026-09-14 12:00:${String(revision % 60).padStart(2, '0')}.000`},
        [ONYXKEYS.LAST_VISITED_PATH]: `/r/${revision}`,
    };
}

const multiSetMixedKeys = defineScenario({
    id: 'api/multiSet/mixed-keys',
    title: 'ten consecutive Onyx.multiSet calls, each writing the same ten unrelated plain keys with no subscribers',
    realUsage: [
        {file: 'src/libs/actions/App.ts', line: 423, note: 'multiSet of the two app loading flags when running from imported state'},
        {file: 'src/libs/actions/PersistedRequests.ts', line: 322, note: 'multiSet of the persisted request queue and the ongoing request'},
    ],
    scale: (profile) => ({keys: 10, writesPerSample: MIXED_KEY_WRITES_PER_SAMPLE, storeKeys: storeKeyCount(profile)}),
    setup: async (): Promise<MixedKeysContext> => {
        // Plain keys only; the seeded store behind them grows with the scale.
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {revision: 0}, nextValues: [buildMixedKeys(0)]};
    },
    beforeEach: async (context) => {
        // Every write in the sample carries its own revision, so no call is skipped as a no-op.
        context.nextValues = Array.from({length: MIXED_KEY_WRITES_PER_SAMPLE}, () => buildMixedKeys(++context.state.revision));
    },
    run: async (context, params) => {
        for (const value of context.nextValues) {
            // eslint-disable-next-line no-await-in-loop
            await Onyx.multiSet(value);
        }

        return {keysWritten: params.keys * params.writesPerSample, writesPerSample: params.writesPerSample};
    },
});

const multiSetCollectionMembers = defineScenario({
    id: 'api/multiSet/collection-members',
    title: 'Onyx.multiSet of N report collection member keys, the shape the imported-state flow writes',
    realUsage: [
        {file: 'src/libs/actions/ImportOnyxState.ts', line: 22, note: 'importOnyxRegularState multiSets the whole imported state in one call'},
        {file: 'src/libs/cleanupPreMountedDraftReports.ts', line: 43, note: 'multiSet of a batch of draft report keys'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    // N member keys go through prepareKeyValuePairsForStorage and one notify pass each, so this is the slowest multiSet shape.
    measure: {timeBudgetMs: 4000, maxIterations: 30},
    setup: async (): Promise<CollectionMembersContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {state: {revision: 0}, nextValue: {}};
    },
    beforeEach: async (context) => {
        const account = getHeavyAccount();
        context.state.revision++;

        const next: OnyxMultiSetInput = {};
        for (const reportID of account.reportIDs) {
            const existing: Report = account.reports[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`];
            next[`${ONYXKEYS.COLLECTION.REPORT}${reportID}`] = {...existing, lastMessageText: `revision ${context.state.revision}`};
        }

        context.nextValue = next;
    },
    run: async (context, params) => {
        await Onyx.multiSet(context.nextValue);

        return {membersWritten: params.reports};
    },
});

runScenarios([multiSetMixedKeys, multiSetCollectionMembers]);
