import ONYXKEYS from '@app/ONYXKEYS';
import type {Report, Session} from '@app/types';

import Onyx from 'react-native-onyx';
import cache from 'react-native-onyx/dist/OnyxCache';

import {getHeavyAccount, seedOnyxWithAccount, storeKeyCount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

type PlainKeyContext = {
    state: {revision: number};
};

type MemberKeyContext = {
    reportKey: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;
};

/** Connect, wait for the first callback, disconnect inside it: the one-shot read shape the app uses. */
function readSessionOnce(): Promise<Session | undefined> {
    return new Promise((resolve) => {
        const connection = Onyx.connectWithoutView({
            key: ONYXKEYS.SESSION,
            callback: (session) => {
                Onyx.disconnect(connection);
                resolve(session);
            },
        });
    });
}

const connectWarmPlainKey = defineScenario({
    id: 'subscriptions/connect/plain-key-warm',
    title: 'connectWithoutView on the session key that is already in cache, timed until the first callback fires',
    realUsage: [
        {file: 'src/libs/SessionUtils.ts', line: 73, note: 'a module listener on ONYXKEYS.SESSION'},
        {file: 'src/libs/ApiUtils.ts', line: 23, note: 'connectWithoutView for non-render logic, 207 sites in src/'},
    ],
    scale: (profile) => ({storeKeys: storeKeyCount(profile)}),
    setup: async (): Promise<PlainKeyContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {revision: 0}};
    },
    run: async () => {
        const session = await readSessionOnce();

        return {receivedValue: session ? 1 : 0};
    },
});

const connectColdPlainKey = defineScenario({
    id: 'subscriptions/connect/plain-key-cold',
    title: 'connectWithoutView on the session key after its cached value was dropped, so the first callback waits for a storage read',
    realUsage: [
        {file: 'src/libs/SessionUtils.ts', line: 73, note: 'the same module listener, running at boot before anything warmed the key'},
        {file: 'src/libs/actions/OnyxDerived/index.ts', line: 50, note: 'the one-shot read every derived value does before wiring its dependencies'},
    ],
    scale: (profile) => ({storeKeys: storeKeyCount(profile)}),
    setup: async (): Promise<PlainKeyContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        // `drop` also removes the key from the cache key index, and `addKey` puts it back: the subscriber then
        // finds a matching key but no cached value, which is exactly the boot-time state this measures.
        cache.drop(ONYXKEYS.SESSION);
        cache.addKey(ONYXKEYS.SESSION);
    },
    run: async () => {
        const session = await readSessionOnce();

        return {receivedValue: session ? 1 : 0};
    },
});

const connectCollectionMemberKey = defineScenario({
    id: 'subscriptions/connect/collection-member-key',
    title: 'connectWithoutView on one report collection member key, timed until the first callback fires',
    realUsage: [
        {file: 'src/libs/actions/TransactionEdit.ts', line: 41, note: 'a one-shot connect on a single collection member key'},
        {file: 'src/libs/cleanupPreMountedDraftReports.ts', line: 46, note: 'connect then disconnect inside the first callback, the same shape'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    setup: async (): Promise<MemberKeyContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {reportKey: `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[0]}`};
    },
    run: async (context, params) => {
        const report = await new Promise<Report | undefined>((resolve) => {
            const connection = Onyx.connectWithoutView({
                key: context.reportKey,
                callback: (value) => {
                    Onyx.disconnect(connection);
                    resolve(value);
                },
            });
        });

        return {receivedValue: report ? 1 : 0, membersInCollection: params.reports};
    },
});

runScenarios([connectWarmPlainKey, connectColdPlainKey, connectCollectionMemberKey]);
