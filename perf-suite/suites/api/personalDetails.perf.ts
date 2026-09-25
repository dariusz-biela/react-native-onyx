import ONYXKEYS from '@app/ONYXKEYS';
import type {PersonalDetailsList} from '@app/types';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * `PERSONAL_DETAILS_LIST` is one key holding every person the account has ever seen, about 20k entries on
 * a P95 account (Expensify/App#101083). Because it is one value, a batch touching a hundred people still
 * merges into, compares (`OnyxCache.hasValueChanged` falls back to `deepEqual` over the whole list) and
 * stores the whole object. `api/merge/deep-personal-details` is the one-person case; this row is the
 * batch OpenApp and ReconnectApp deliver.
 */
type PersonalDetailsBatchContext = {
    accountIDs: number[];
    nextPatch: PersonalDetailsList;
    state: {revision: number};
};

const BATCH_SIZE = 100;

const mergePersonalDetailsBatch = defineScenario({
    id: 'api/merge/personal-details-batch',
    title: 'Onyx.merge of a 100-entry patch into the personal details list with N entries, no subscribers',
    realUsage: [
        {file: 'src/libs/actions/PersonalDetails.ts', line: 127, note: 'a personal details merge issued by the app itself'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'OpenApp and ReconnectApp responses merge the list through Onyx.update'},
    ],
    scale: (profile) => ({personalDetails: profile.personalDetails, batch: Math.min(BATCH_SIZE, profile.personalDetails)}),
    setup: async (params): Promise<PersonalDetailsBatchContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const accountIDs: number[] = [];
        const step = Math.max(1, Math.floor(params.personalDetails / params.batch));
        for (let index = 0; index < params.batch; index++) {
            accountIDs.push(index * step + 1);
        }

        return {accountIDs, nextPatch: {}, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        const patch: PersonalDetailsList = {};
        for (const accountID of context.accountIDs) {
            patch[accountID] = {accountID, displayName: `person ${accountID} r${context.state.revision}`};
        }
        context.nextPatch = patch;
    },
    run: async (context, params) => {
        await Onyx.merge(ONYXKEYS.PERSONAL_DETAILS_LIST, context.nextPatch);

        return {entries: params.personalDetails, entriesMerged: params.batch};
    },
});

runScenarios([mergePersonalDetailsBatch]);
