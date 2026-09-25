import type {PersonalDetailsList} from '@app/types';

import type {NullishDeep} from 'react-native-onyx';

import utils from 'react-native-onyx/dist/utils';

import {getHeavyAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * The two `utils` helpers that are not `fastMerge` (which has its own file): the null stripper every
 * set and multiSet runs before storage, and the type check the merge queue runs for every change.
 */
type NullishPersonalDetails = NullishDeep<PersonalDetailsList>;

type RemoveNullsContext = {
    value: NullishPersonalDetails;
    state: {revision: number};
};

type CompatibilityContext = {
    pairs: Array<[unknown, unknown]>;
};

const COMPATIBILITY_CALLS = 10000;

// One pass over the list is around a tenth of a millisecond, close enough to the harness's own overhead
// around the timed region to matter, so a sample repeats the call.
const REMOVE_NULLS_CALLS_PER_SAMPLE = 10;

const removeNestedNulls = defineScenario({
    id: 'internals/utils/removeNestedNullValues',
    title: 'ten removeNestedNullValues passes over the personal details list of N entries where every third entry has nulls',
    realUsage: [
        {file: 'src/libs/actions/PersonalDetails.ts', line: 127, note: 'a personal details merge whose nested nulls are stripped before the value is stored'},
        {file: 'src/libs/actions/App.ts', line: 423, note: 'Onyx.multiSet of the boot keys, which strips nulls from every value it writes'},
    ],
    scale: (profile) => ({personalDetails: profile.personalDetails, callsPerSample: REMOVE_NULLS_CALLS_PER_SAMPLE}),
    setup: async (): Promise<RemoveNullsContext> => ({value: {}, state: {revision: 0}}),
    beforeEach: async (context, params) => {
        context.state.revision++;

        const account = getHeavyAccount();
        const value: NullishPersonalDetails = {};

        for (let index = 0; index < params.personalDetails; index++) {
            const accountID = index + 1;
            const details = account.personalDetails[accountID];

            // `removeNestedNullValues` returns its input unchanged when it finds nothing, so a third of
            // the entries carry nulls to make sure the copying branch is the one being measured.
            value[accountID] = index % 3 === 0 ? {...details, avatar: null, pronouns: null, displayName: `revision ${context.state.revision}`} : details;
        }

        context.value = value;
    },
    run: async (context, params) => {
        let cleaned = utils.removeNestedNullValues(context.value);

        for (let index = 1; index < REMOVE_NULLS_CALLS_PER_SAMPLE; index++) {
            cleaned = utils.removeNestedNullValues(context.value);
        }

        return {personalDetails: params.personalDetails, callsPerSample: params.callsPerSample, entries: Object.keys(cleaned ?? {}).length};
    },
});

const compatibilityChecks = defineScenario({
    id: 'internals/utils/checkCompatibilityWithExistingValue',
    title: 'ten thousand checkCompatibilityWithExistingValue calls over the object, array, empty-array and mismatched pairs the merge queue sees',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 2109, note: 'a pages array written over a key that already holds an array, the replace branch'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 66, note: 'every change in a response batch is type-checked against the existing value first'},
    ],
    scale: () => ({calls: COMPATIBILITY_CALLS}),
    sizeIndependent: 'the check compares the array-ness of the two values and never looks inside them',
    setup: async (): Promise<CompatibilityContext> => {
        const account = getHeavyAccount();
        const firstReport = Object.values(account.reports).at(0);

        return {
            pairs: [
                [{lastMessageText: 'patch'}, firstReport],
                [['page-1', 'page-2'], ['page-0']],
                [[], ['page-0']],
                [{lastMessageText: 'patch'}, ['page-0']],
                ['scalar', firstReport],
            ],
        };
    },
    run: async (context, params) => {
        let compatible = 0;

        for (let index = 0; index < COMPATIBILITY_CALLS; index++) {
            const [value, existingValue] = context.pairs[index % context.pairs.length];

            if (utils.checkCompatibilityWithExistingValue(value, existingValue).isCompatible) {
                compatible++;
            }
        }

        return {calls: params.calls, compatible};
    },
});

runScenarios([removeNestedNulls, compatibilityChecks]);
