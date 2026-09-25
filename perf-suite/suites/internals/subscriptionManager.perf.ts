import ONYXKEYS from '@app/ONYXKEYS';
import type {Report} from '@app/types';

import type {OnyxCollection} from 'react-native-onyx';

import subscriptionManager from 'react-native-onyx/dist/OnyxSubscriptionManager';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * `OnyxSubscriptionManager` is the flat key-to-listener registry the store layer notifies through. One
 * iteration subscribes M listeners on report member keys and M on the collection key, fires one
 * single-key notification and one collection batch, then unsubscribes everything.
 */
type SubscriptionContext = {
    partialCollection: OnyxCollection<Report>;
    previousCollection: OnyxCollection<Report>;
    state: {callbacks: number; revision: number};
};

const CHANGED_MEMBERS = 100;

const notifyListeners = defineScenario({
    id: 'internals/OnyxSubscriptionManager/notify',
    title: 'subscribe M member listeners and M collection listeners, then notifyKey once and notifyCollection for 100 members',
    realUsage: [
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'a whole-collection subscriber, the listener notifyCollection fires once per batch'},
        {file: 'src/components/ArchivedReportFooter.tsx', line: 29, note: 'a single member subscriber, the listener notifyKey fires'},
    ],
    scale: (profile) => ({moduleListeners: profile.moduleListeners, changedMembers: CHANGED_MEMBERS}),
    setup: async (): Promise<SubscriptionContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {partialCollection: {}, previousCollection: {}, state: {callbacks: 0, revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.callbacks = 0;
        context.state.revision++;

        const account = getHeavyAccount();
        const partialCollection: OnyxCollection<Report> = {};
        const previousCollection: OnyxCollection<Report> = {};

        for (let index = 0; index < CHANGED_MEMBERS; index++) {
            const key: `${typeof ONYXKEYS.COLLECTION.REPORT}${string}` = `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[index % account.reportIDs.length]}`;
            const report = account.reports[key];

            previousCollection[key] = report;
            partialCollection[key] = report ? {...report, lastMessageText: `revision ${context.state.revision}`} : undefined;
        }

        context.partialCollection = partialCollection;
        context.previousCollection = previousCollection;
    },
    run: async (context, params) => {
        const account = getHeavyAccount();
        const unsubscribes: Array<() => void> = [];

        // A fresh closure per subscription: the registry stores listeners in a set, so registering one
        // shared function M times would collapse into a single listener and notify nobody else.
        for (let index = 0; index < params.moduleListeners; index++) {
            const memberListener = () => {
                context.state.callbacks++;
            };
            const collectionListener = () => {
                context.state.callbacks++;
            };

            unsubscribes.push(subscriptionManager.subscribe(`${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[index % account.reportIDs.length]}`, memberListener));
            unsubscribes.push(subscriptionManager.subscribe(ONYXKEYS.COLLECTION.REPORT, collectionListener));
        }

        subscriptionManager.notifyKey(ONYXKEYS.SESSION, account.session);
        subscriptionManager.notifyCollection(ONYXKEYS.COLLECTION.REPORT, context.partialCollection, context.previousCollection);

        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }

        return {moduleListeners: params.moduleListeners, changedMembers: params.changedMembers, callbacks: context.state.callbacks};
    },
    teardown: async () => {
        subscriptionManager.clearAll();
    },
});

runScenarios([notifyListeners]);
