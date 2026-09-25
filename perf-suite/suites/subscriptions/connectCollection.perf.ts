import ONYXKEYS from '@app/ONYXKEYS';

import Onyx from 'react-native-onyx';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type ConnectContext = {
    memberCount: number;
};

/**
 * This version of Onyx has no `waitForCollectionCallback` option: connecting to a collection root key
 * already delivers the whole collection in one callback (see `types.ts:228-235` in the clone), so the
 * scenario measures exactly that first delivery plus the disconnect.
 */
const connectReportCollection = defineScenario({
    id: 'subscriptions/connect/collection-object',
    title: 'Onyx.connect to the report collection root, first whole-collection callback, then disconnect',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 521, note: 'Onyx.connect on ONYXKEYS.COLLECTION.REPORT to keep allReports warm'},
        {file: 'src/libs/actions/OnyxUpdates.ts', line: 37, note: 'Onyx.connectWithoutView for non-render logic'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    setup: async (params): Promise<ConnectContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {memberCount: params.reports};
    },
    run: async (context) => {
        // The collection callback is typed as the raw key-value record for a collection root key.
        const collection = await new Promise<Record<string, unknown>>((resolve) => {
            const connection = Onyx.connect({
                key: ONYXKEYS.COLLECTION.REPORT,
                callback: (value) => {
                    Onyx.disconnect(connection);
                    resolve(value);
                },
            });
        });

        return {membersDelivered: Object.keys(collection).length, membersExpected: context.memberCount};
    },
});

runScenarios([connectReportCollection]);
