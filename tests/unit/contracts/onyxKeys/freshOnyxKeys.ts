import type OnyxKeysDefault from '../../../../lib/OnyxKeys';
import type {OnyxKey} from '../../../../lib/types';

/**
 * A registry shaped like the App's: prefixes that share a leading substring without the `_` boundary
 * (`report_`, `reportActions_`, `reportActionsDrafts_`) and prefixes nested inside another prefix
 * (`test_`, `test_level_`, `test_level_last_`), where a member key starts with more than one collection key.
 */
const COLLECTIONS = {
    REPORT: 'report_',
    REPORT_ACTIONS: 'reportActions_',
    REPORT_ACTIONS_DRAFTS: 'reportActionsDrafts_',
    REPORT_METADATA: 'reportMetadata_',
    POLICY: 'policy_',
    POLICY_CATEGORIES: 'policyCategories_',
    TEST: 'test_',
    TEST_LEVEL: 'test_level_',
    TEST_LEVEL_LAST: 'test_level_last_',
    SHARED_NVP_USER: 'sharedNVP_user_',
    RAM_COLLECTION: 'ramCollection_',
    // Nested inside a RAM-only collection but not RAM-only itself.
    RAM_COLLECTION_NESTED: 'ramCollection_nested_',
} as const;

const PLAIN_KEYS = {
    SESSION: 'session',
    // Has an underscore but no registered `nvp_` collection, so it is a plain key.
    NVP_PRIORITY_MODE: 'nvp_priorityMode',
    RAM_ONLY: 'ramOnly',
} as const;

const DEFAULT_RAM_ONLY_KEYS: OnyxKey[] = [PLAIN_KEYS.RAM_ONLY, COLLECTIONS.RAM_COLLECTION];

type OnyxKeysModule = typeof OnyxKeysDefault;

type LoadOptions = {
    collectionKeys?: OnyxKey[];
    ramOnlyKeys?: OnyxKey[];
};

/** Loads `lib/OnyxKeys` from a fresh module registry, so its lookup maps start empty in every test. */
function loadOnyxKeys({collectionKeys = Object.values(COLLECTIONS), ramOnlyKeys = DEFAULT_RAM_ONLY_KEYS}: LoadOptions = {}): OnyxKeysModule {
    let onyxKeys: OnyxKeysModule | undefined;
    jest.isolateModules(() => {
        onyxKeys = require('../../../../lib/OnyxKeys').default;
    });
    if (!onyxKeys) {
        throw new Error('lib/OnyxKeys failed to load');
    }
    onyxKeys.setCollectionKeys(new Set(collectionKeys));
    onyxKeys.setRamOnlyKeys(new Set(ramOnlyKeys));
    return onyxKeys;
}

/** Members of a collection as a sorted array, with an empty array when the module holds no member set. */
function membersOf(onyxKeys: OnyxKeysModule, collectionKey: OnyxKey): OnyxKey[] {
    return [...(onyxKeys.getMembersOfCollection(collectionKey) ?? [])].sort();
}

export {COLLECTIONS, PLAIN_KEYS, DEFAULT_RAM_ONLY_KEYS, loadOnyxKeys, membersOf};
export type {OnyxKeysModule, LoadOptions};

// Jest collects every file under tests/unit as a suite, so this helper checks itself only when run as the suite.
if (expect.getState().testPath === __filename) {
    describe('loadOnyxKeys', () => {
        it('gives every call its own lookup maps', () => {
            const first = loadOnyxKeys();
            first.registerMemberKey('report_1');
            const second = loadOnyxKeys();

            expect(second).not.toBe(first);
            expect(membersOf(first, COLLECTIONS.REPORT)).toEqual(['report_1']);
            expect(membersOf(second, COLLECTIONS.REPORT)).toEqual([]);
        });
    });
}
