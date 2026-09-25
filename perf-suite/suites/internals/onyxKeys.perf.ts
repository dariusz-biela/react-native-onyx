import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxKey} from 'react-native-onyx';

import OnyxKeys from 'react-native-onyx/dist/OnyxKeys';

import {storeKeyCount} from '../../fixtures/account';
import {buildCollectionMemberKeys} from '../../fixtures/keys';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * `OnyxKeys` is a prefix matcher over the app's roughly one hundred registered collection prefixes,
 * and every notification and every read passes through it. The key list is built from the real
 * `ONYXKEYS.COLLECTION` prefixes plus ids, so the cost of the shared leading substrings between
 * prefixes such as `policy_`, `policyDrafts_` and `policyCategories_` is part of the measurement.
 */
type KeyMatchContext = {
    keys: OnyxKey[];
};

const keyMatching = defineScenario({
    id: 'internals/OnyxKeys/isKeyMatch',
    title: 'isKeyMatch, isCollectionMemberKey, getCollectionKey and splitCollectionMemberKey over as many real collection member keys as the store of the scale holds',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1542, note: 'every write resolves its collection key before notifying anyone'},
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'a collection subscriber whose key is matched against every changed key'},
    ],
    // Hydration and every collection notification classify each stored key, so the key count of the store is the dimension.
    scale: (profile) => ({keys: storeKeyCount(profile)}),
    setup: async (params): Promise<KeyMatchContext> => ({keys: buildCollectionMemberKeys(params.keys)}),
    run: async (context, params) => {
        let matches = 0;
        let members = 0;
        let resolved = 0;
        let split = 0;

        for (const key of context.keys) {
            if (OnyxKeys.isKeyMatch(ONYXKEYS.COLLECTION.REPORT, key)) {
                matches++;
            }

            if (OnyxKeys.isCollectionMemberKey(ONYXKEYS.COLLECTION.POLICY, key)) {
                members++;
            }

            if (OnyxKeys.getCollectionKey(key)) {
                resolved++;
            }
        }

        // `splitCollectionMemberKey` throws on anything that is not a member key, so it only runs over
        // the report members, which is also how the Onyx code calls it.
        for (const key of context.keys) {
            if (!OnyxKeys.isCollectionMemberKey(ONYXKEYS.COLLECTION.REPORT, key)) {
                continue;
            }

            const [, memberID] = OnyxKeys.splitCollectionMemberKey(key);
            if (memberID) {
                split++;
            }
        }

        return {keys: params.keys, matches, members, resolved, split};
    },
});

runScenarios([keyMatching]);
