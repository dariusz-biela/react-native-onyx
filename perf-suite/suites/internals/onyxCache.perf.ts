import ONYXKEYS from '@app/ONYXKEYS';
import type {Report} from '@app/types';

import type {OnyxKey} from 'react-native-onyx';

import cache from 'react-native-onyx/dist/OnyxCache';

import {getHeavyAccount, seedOnyxWithAccount} from '../../fixtures/account';
import {buildCollectionMemberKeys} from '../../fixtures/keys';
import type {PartialOnyxRecord} from '../../harness/onyxRecords';
import toOnyxKeyRecord from '../../harness/onyxRecords';
import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * `OnyxCache` is the in-memory store behind every read and write. These scenarios call it directly,
 * with the report collection of the heavy-account fixture as the data, so a change in the cache shows
 * up here without the merge queue, the notification fan-out and the storage layer on top of it.
 */
type ReportKey = `${typeof ONYXKEYS.COLLECTION.REPORT}${string}`;

type ReportEntry = [ReportKey, Report];

type GetSetContext = {
    keys: ReportKey[];
    values: Report[];
    state: {revision: number};
};

type MergeCollectionContext = {
    patch: PartialOnyxRecord;
    state: {revision: number};
};

type CollectionSnapshotContext = {
    memberKey: ReportKey;
    state: {revision: number};
};

type EvictionContext = {
    evictableKeys: Array<`${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}`>;
    state: {revision: number};
};

type HydrateContext = {
    data: PartialOnyxRecord;
    keys: OnyxKey[];
    state: {revision: number};
};

/** The report entries of the fixture, as the [key, value] pairs the cache stores. */
function getReportEntries(): ReportEntry[] {
    const account = getHeavyAccount();
    const entries: ReportEntry[] = [];

    for (const reportID of account.reportIDs) {
        const key: ReportKey = `${ONYXKEYS.COLLECTION.REPORT}${reportID}`;
        const report = account.reports[key];

        if (!report) {
            continue;
        }

        entries.push([key, report]);
    }

    return entries;
}

const cacheGetSet = defineScenario({
    id: 'internals/OnyxCache/get-set',
    title: 'N cache.set of report values followed by N cache.get of the same keys, the store under every read and write',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1542, note: 'every Onyx.merge ends in a cache.set for the key it wrote'},
        {file: 'src/hooks/useOnyx.ts', line: 75, note: 'every hook read goes through the cache by way of OnyxUtils.tryGetCachedValue'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    setup: async (): Promise<GetSetContext> => {
        const entries = getReportEntries();

        return {keys: entries.map(([key]) => key), values: [], state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        // The values are built outside the timed region, so the samples hold cache work and not the
        // allocation of the objects handed to it.
        context.values = getReportEntries().map(([, report]) => ({...report, lastMessageText: `revision ${context.state.revision}`}));
    },
    run: async (context) => {
        let read = 0;

        for (const [index, key] of context.keys.entries()) {
            cache.set(key, context.values[index]);
        }

        for (const key of context.keys) {
            if (cache.get(key)) {
                read++;
            }
        }

        return {keysWritten: context.keys.length, keysRead: read};
    },
});

const cacheMergeCollection = defineScenario({
    id: 'internals/OnyxCache/merge-collection',
    title: 'cache.merge of U report members into a cache that already holds N of them, U the update batch of the scale',
    realUsage: [
        {file: 'src/libs/actions/IOU/MoneyRequest.ts', line: 670, note: 'Onyx.mergeCollection of transaction drafts, which lands in cache.merge'},
        {file: 'src/libs/Middleware/SaveResponseInOnyx.ts', line: 27, note: 'the middleware that applies every server response batch as collection merges'},
    ],
    scale: (profile) => ({reports: profile.reports, mergedMembers: profile.updateBatchKeys}),
    setup: async (): Promise<MergeCollectionContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        return {patch: {}, state: {revision: 0}};
    },
    beforeEach: async (context, params) => {
        context.state.revision++;

        const entries = getReportEntries().slice(0, params.mergedMembers);
        const patch: PartialOnyxRecord = {};

        for (const [key, report] of entries) {
            patch[key] = {...report, lastMessageText: `revision ${context.state.revision}`};
        }

        context.patch = patch;
    },
    run: async (context, params) => {
        cache.merge(toOnyxKeyRecord(context.patch));

        return {mergedMembers: params.mergedMembers};
    },
});

const cacheCollectionSnapshot = defineScenario({
    id: 'internals/OnyxCache/collection-snapshot',
    title: 'getCollectionData on the report collection right after a member changed (rebuild) and again while clean (cached)',
    realUsage: [
        {file: 'src/components/LHNOptionsList/LHNOptionsList.tsx', line: 41, note: 'a whole-collection report subscriber, served from the frozen collection snapshot'},
        {file: 'src/FullstoryUserContextHandler.tsx', line: 21, note: 'another whole-collection read that pays for a rebuild after any member write'},
    ],
    scale: (profile) => ({reports: profile.reports}),
    setup: async (): Promise<CollectionSnapshotContext> => {
        const account = getHeavyAccount();
        await seedOnyxWithAccount(account);

        return {memberKey: `${ONYXKEYS.COLLECTION.REPORT}${account.reportIDs[0]}`, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;
    },
    run: async (context) => {
        // The write is what marks the collection dirty, so the first read rebuilds and the second one
        // is served from the frozen snapshot. Both are timed on purpose: that pair is what a collection
        // subscriber costs per write.
        cache.set(context.memberKey, {reportID: '1', lastMessageText: `revision ${context.state.revision}`});

        const rebuilt = cache.getCollectionData(ONYXKEYS.COLLECTION.REPORT);
        const cached = cache.getCollectionData(ONYXKEYS.COLLECTION.REPORT);

        return {rebuiltMembers: Object.keys(rebuilt ?? {}).length, isSameReference: rebuilt === cached ? 1 : 0};
    },
});

const cacheDropAndEviction = defineScenario({
    id: 'internals/OnyxCache/drop-and-eviction',
    title: 'cache.drop of one evictable key plus getKeyForEviction over a recently-accessed list of N report-actions keys',
    realUsage: [
        {file: 'src/setup/index.ts', line: 48, note: 'the evictableKeys the app registers, which is the list this scenario evicts from'},
        {file: 'src/libs/actions/Report/index.ts', line: 2469, note: 'report actions, the biggest evictable collection, written on every new action'},
    ],
    scale: (profile) => ({evictableKeys: profile.reports}),
    setup: async (params): Promise<EvictionContext> => {
        await seedOnyxWithAccount(getHeavyAccount());

        const evictableKeys: Array<`${typeof ONYXKEYS.COLLECTION.REPORT_ACTIONS}${string}`> = [];
        for (let index = 0; index < params.evictableKeys; index++) {
            evictableKeys.push(`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}evictable-${index}`);
        }

        return {evictableKeys, state: {revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.revision++;

        // Refill both the cache and the recently-accessed list, which the measured drop consumes.
        for (const key of context.evictableKeys) {
            cache.set(key, {[`action-${context.state.revision}`]: {reportActionID: `action-${context.state.revision}`}});
            cache.addLastAccessedKey(key, false);
        }
    },
    run: async (context, params) => {
        const keyToEvict = cache.getKeyForEviction();

        if (keyToEvict) {
            cache.drop(keyToEvict);
        }

        return {candidates: params.evictableKeys, evicted: keyToEvict ? 1 : 0};
    },
});

const cacheHydrate = defineScenario({
    id: 'internals/OnyxCache/hydrate',
    title: 'cache.hydrate of N keys, the bulk load Onyx.init does with everything read back from storage',
    realUsage: [
        {file: 'src/setup/index.ts', line: 45, note: 'Onyx.init, whose initStoreValues hydrates the cache with everything storage holds'},
        {file: 'src/libs/actions/App.ts', line: 423, note: 'the boot path that reads those hydrated keys immediately afterwards'},
    ],
    scale: (profile) => ({keys: profile.reports}),
    setup: async (params): Promise<HydrateContext> => ({data: {}, keys: buildCollectionMemberKeys(params.keys), state: {revision: 0}}),
    beforeEach: async (context) => {
        context.state.revision++;

        // `hydrate` only skips its per-key clone for keys the cache does not hold yet, so every
        // iteration drops what the last one loaded before building the next payload.
        const data: PartialOnyxRecord = {};
        for (const key of context.keys) {
            cache.drop(key);
            data[key] = {revision: context.state.revision};
        }

        context.data = data;
    },
    run: async (context, params) => {
        cache.hydrate(toOnyxKeyRecord(context.data));

        return {keys: params.keys};
    },
});

runScenarios([cacheGetSet, cacheMergeCollection, cacheCollectionSnapshot, cacheDropAndEviction, cacheHydrate]);
