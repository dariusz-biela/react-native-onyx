import ONYXKEYS from '@app/ONYXKEYS';

import type {OnyxKey} from 'react-native-onyx';

import InstanceSyncWeb from 'react-native-onyx/dist/storage/InstanceSync/index.web.js';

import {getHeavyAccount, storeKeyCount} from '../../fixtures/account';
import {buildCollectionMemberKeys} from '../../fixtures/keys';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type RaiseEventsContext = {
    memberKeys: OnyxKey[];
    storeKeys: OnyxKey[];
};

/**
 * The sending side of the cross-tab sync on web, paid by every storage write even with one tab open: the
 * key list goes through `JSON.stringify` and a `localStorage` setItem and removeItem pair. Jest resolves
 * the native variant (a no-op), so the web one is loaded through its explicit path, the recipe
 * `internals/OnyxMerge/apply-web` uses. jsdom's `localStorage` is not a browser's, so read the row for the
 * Onyx share of the cost.
 */
const raiseSyncEvents = defineScenario({
    id: 'storage/instance-sync/raise-events',
    title: 'the web InstanceSync events of one write: multiSet of U member keys, one setItem, and the removeItems of every stored key that a sign-out clear raises',
    realUsage: [
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 128, note: 'a Pusher update, whose storage writes raise the multiSet event'},
        {file: 'src/libs/actions/SignInRedirect.ts', line: 104, note: 'the sign-out clear, which raises every removed key in one batch'},
    ],
    scale: (profile) => ({members: profile.updateBatchKeys, storeKeys: storeKeyCount(profile)}),
    setup: async (params): Promise<RaiseEventsContext> => {
        const account = getHeavyAccount();
        const memberKeys = account.reportIDs.slice(0, params.members).map((reportID): OnyxKey => `${ONYXKEYS.COLLECTION.REPORT}${reportID}`);

        return {memberKeys, storeKeys: buildCollectionMemberKeys(params.storeKeys)};
    },
    run: async (context, params) => {
        InstanceSyncWeb.multiSet(context.memberKeys);
        InstanceSyncWeb.setItem(ONYXKEYS.SESSION);
        InstanceSyncWeb.removeItems(context.storeKeys);

        return {members: params.members, storeKeys: params.storeKeys};
    },
});

runScenarios([raiseSyncEvents]);
