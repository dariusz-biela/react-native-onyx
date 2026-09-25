import type {OnyxKey} from '../../../../lib/types';
import type {OnyxKeysModule} from './freshOnyxKeys';
import {COLLECTIONS, PLAIN_KEYS, loadOnyxKeys, membersOf} from './freshOnyxKeys';

/** Every key the resolution tests run over, with the collection key it belongs to. */
const RESOLUTION_CASES: Array<[OnyxKey, OnyxKey | undefined]> = [
    ['report_1', 'report_'],
    ['report_', 'report_'],
    ['reportActions_1', 'reportActions_'],
    ['reportActions_', 'reportActions_'],
    ['reportActionsDrafts_1_2', 'reportActionsDrafts_'],
    ['reportMetadata_abc', 'reportMetadata_'],
    // An id that itself looks like another collection key still belongs to the outer prefix.
    ['report_reportActions_1', 'report_'],
    ['report_actions_1', 'report_'],
    ['report__1', 'report_'],
    ['report_1_', 'report_'],
    ['policy_1', 'policy_'],
    ['policyCategories_1', 'policyCategories_'],
    ['test_1', 'test_'],
    ['test_level_1', 'test_level_'],
    ['test_level_', 'test_level_'],
    ['test_level_last_3', 'test_level_last_'],
    ['test_level_last_', 'test_level_last_'],
    // Only a boundary at `_` counts, so `test_level_lastX_` falls back to `test_level_`.
    ['test_level_lastX_1', 'test_level_'],
    ['test_levelX_1', 'test_'],
    ['sharedNVP_user_-1_something', 'sharedNVP_user_'],
    ['ramCollection_1', 'ramCollection_'],
    ['ramCollection_nested_1', 'ramCollection_nested_'],
    [PLAIN_KEYS.SESSION, undefined],
    [PLAIN_KEYS.NVP_PRIORITY_MODE, undefined],
    ['report', undefined],
    ['reportActions', undefined],
    ['repor_1', undefined],
    ['sharedNVP_1', undefined],
    ['_', undefined],
    ['_report_1', undefined],
    ['', undefined],
];

const MEMBER_CASES = RESOLUTION_CASES.filter(([key, collectionKey]) => collectionKey !== undefined && key !== collectionKey);

describe('OnyxKeys function contracts', () => {
    let OnyxKeys: OnyxKeysModule;

    beforeEach(() => {
        OnyxKeys = loadOnyxKeys();
    });

    describe('isKeyMatch', () => {
        const cases: Array<[OnyxKey, OnyxKey, boolean]> = [
            ['report_', 'report_1', true],
            ['report_', 'report_', true],
            ['report_', 'reportActions_1', false],
            ['report_', 'reportActions_', false],
            ['report_', 'report', false],
            ['report_', 'repor', false],
            ['report_', '', false],
            ['reportActions_', 'reportActions_1', true],
            ['reportActions_', 'reportActionsDrafts_1', false],
            ['reportActions_', 'report_1', false],
            ['reportActionsDrafts_', 'reportActions_1', false],
            // A nested collection member also starts with the parent collection key.
            ['test_', 'test_level_1', true],
            ['test_', 'test_level_', true],
            ['test_level_', 'test_1', false],
            ['test_level_', 'test_', false],
            ['test_level_', 'test_level_last_3', true],
            [PLAIN_KEYS.SESSION, PLAIN_KEYS.SESSION, true],
            [PLAIN_KEYS.SESSION, 'session_1', false],
            [PLAIN_KEYS.SESSION, 'sessio', false],
            [PLAIN_KEYS.SESSION, 'Session', false],
            // `nvp_` is not a registered collection, so it only matches itself.
            ['nvp_', PLAIN_KEYS.NVP_PRIORITY_MODE, false],
            ['nvp_', 'nvp_', true],
            // A member used as the config key matches only itself.
            ['report_1', 'report_1', true],
            ['report_1', 'report_12', false],
            ['report_1', 'report_', false],
            ['', '', true],
            ['', 'report_1', false],
        ];

        it.each(cases)('isKeyMatch(%j, %j) is %j', (configKey, key, expected) => {
            expect(OnyxKeys.isKeyMatch(configKey, key)).toBe(expected);
        });

        it('starts to prefix match a key once it is registered as a collection key', () => {
            expect(OnyxKeys.isKeyMatch('nvp_', PLAIN_KEYS.NVP_PRIORITY_MODE)).toBe(false);

            OnyxKeys.setCollectionKeys(new Set([...Object.values(COLLECTIONS), 'nvp_']));

            expect(OnyxKeys.isKeyMatch('nvp_', PLAIN_KEYS.NVP_PRIORITY_MODE)).toBe(true);
        });

        it('stops prefix matching a key once it is no longer registered as a collection key', () => {
            expect(OnyxKeys.isKeyMatch(COLLECTIONS.POLICY, 'policy_1')).toBe(true);

            OnyxKeys.setCollectionKeys(new Set([COLLECTIONS.REPORT]));

            expect(OnyxKeys.isKeyMatch(COLLECTIONS.POLICY, 'policy_1')).toBe(false);
            expect(OnyxKeys.isKeyMatch(COLLECTIONS.POLICY, COLLECTIONS.POLICY)).toBe(true);
        });

        it('does not depend on member keys being registered or resolved', () => {
            OnyxKeys.registerMemberKey('test_level_1');
            OnyxKeys.getCollectionKey('reportActions_1');

            expect(OnyxKeys.isKeyMatch(COLLECTIONS.TEST, 'test_level_1')).toBe(true);
            expect(OnyxKeys.isKeyMatch(COLLECTIONS.REPORT, 'reportActions_1')).toBe(false);
        });
    });

    describe('isCollectionKey and getCollectionKeys', () => {
        it('is true only for the registered collection keys', () => {
            for (const collectionKey of Object.values(COLLECTIONS)) {
                expect(OnyxKeys.isCollectionKey(collectionKey)).toBe(true);
            }
            for (const key of ['report_1', 'report', 'nvp_', 'reportActions', 'test_level', 'Report_', '', PLAIN_KEYS.SESSION]) {
                expect(OnyxKeys.isCollectionKey(key)).toBe(false);
            }
        });

        it('lists exactly the registered collection keys', () => {
            expect([...OnyxKeys.getCollectionKeys()].sort()).toEqual(Object.values(COLLECTIONS).sort());
        });

        it('replaces the whole registry on every setCollectionKeys call instead of adding to it', () => {
            OnyxKeys.setCollectionKeys(new Set(['nvp_']));

            expect(OnyxKeys.isCollectionKey('nvp_')).toBe(true);
            expect(OnyxKeys.isCollectionKey(COLLECTIONS.REPORT)).toBe(false);
            expect([...OnyxKeys.getCollectionKeys()]).toEqual(['nvp_']);
        });

        it('is not changed by registering member keys', () => {
            OnyxKeys.registerMemberKey('report_1');
            OnyxKeys.registerMemberKey('unknown_1');

            expect(OnyxKeys.isCollectionKey('report_1')).toBe(false);
            expect(OnyxKeys.isCollectionKey('unknown_')).toBe(false);
            expect([...OnyxKeys.getCollectionKeys()].sort()).toEqual(Object.values(COLLECTIONS).sort());
        });
    });

    describe('isCollectionMemberKey', () => {
        const cases: Array<[OnyxKey, OnyxKey, boolean]> = [
            ['report_', 'report_1', true],
            ['report_', 'report_', false],
            ['report_', 'report', false],
            ['report_', 'reportActions_1', false],
            ['report_', 'Report_1', false],
            // It checks the prefix, not the most specific collection, so a nested member counts for its parent.
            ['test_', 'test_level_1', true],
            ['test_', 'test_level_', true],
            ['test_level_', 'test_1', false],
            // A suffix or an inner match is not a prefix.
            ['port_', 'report_1', false],
            ['_1', 'report_1', false],
            // It is a string check that does not consult the registry.
            ['notRegistered_', 'notRegistered_1', true],
            ['notRegistered_', 'notRegistered_', false],
            ['', 'a', true],
            ['', '', false],
        ];

        it.each(cases)('isCollectionMemberKey(%j, %j) is %j', (collectionKey, key, expected) => {
            expect(OnyxKeys.isCollectionMemberKey(collectionKey, key)).toBe(expected);
        });

        it('is true for a key exactly one character longer than the collection key', () => {
            expect(OnyxKeys.isCollectionMemberKey(COLLECTIONS.REPORT, 'report_x')).toBe(true);
            expect(OnyxKeys.isCollectionMemberKey(COLLECTIONS.TEST_LEVEL, 'test_level_1')).toBe(true);
        });
    });

    describe('getCollectionKey', () => {
        it.each(RESOLUTION_CASES)('resolves %j to %j on a cold lookup', (key, expected) => {
            expect(OnyxKeys.getCollectionKey(key)).toBe(expected);
        });

        it('returns the same result on a warm lookup as on a cold one for every key', () => {
            const cold = RESOLUTION_CASES.map(([key]) => OnyxKeys.getCollectionKey(key));
            const warm = RESOLUTION_CASES.map(([key]) => OnyxKeys.getCollectionKey(key));

            expect(warm).toEqual(cold);
            expect(warm).toEqual(RESOLUTION_CASES.map(([, expected]) => expected));
        });

        it('returns the same result for a member registered through registerMemberKey as for a cold lookup', () => {
            for (const [key] of MEMBER_CASES) {
                OnyxKeys.registerMemberKey(key);
            }

            for (const [key, expected] of MEMBER_CASES) {
                expect(OnyxKeys.getCollectionKey(key)).toBe(expected);
            }
        });

        it('resolves the same regardless of the order the keys are first looked up in', () => {
            const forward = loadOnyxKeys();
            const backward = loadOnyxKeys();
            const forwardResults = RESOLUTION_CASES.map(([key]) => forward.getCollectionKey(key));
            const backwardResults = [...RESOLUTION_CASES]
                .reverse()
                .map(([key]) => backward.getCollectionKey(key))
                .reverse();

            expect(backwardResults).toEqual(forwardResults);
        });

        it('keeps resolving a member after it is deregistered', () => {
            OnyxKeys.registerMemberKey('test_level_1');
            OnyxKeys.deregisterMemberKey('test_level_1');

            expect(OnyxKeys.getCollectionKey('test_level_1')).toBe(COLLECTIONS.TEST_LEVEL);
            expect(OnyxKeys.getCollectionKey('test_1')).toBe(COLLECTIONS.TEST);
        });

        it('forgets a deregistered member, so it resolves against the current registry', () => {
            const onyxKeys = loadOnyxKeys({collectionKeys: [COLLECTIONS.TEST]});
            onyxKeys.registerMemberKey('test_level_1');
            expect(onyxKeys.getCollectionKey('test_level_1')).toBe(COLLECTIONS.TEST);

            onyxKeys.deregisterMemberKey('test_level_1');
            onyxKeys.setCollectionKeys(new Set([COLLECTIONS.TEST, COLLECTIONS.TEST_LEVEL]));

            expect(onyxKeys.getCollectionKey('test_level_1')).toBe(COLLECTIONS.TEST_LEVEL);
            onyxKeys.registerMemberKey('test_level_1');
            expect(membersOf(onyxKeys, COLLECTIONS.TEST_LEVEL)).toEqual(['test_level_1']);
            expect(membersOf(onyxKeys, COLLECTIONS.TEST)).toEqual([]);
        });

        it('does not remember a miss, so a key resolves once its collection is registered', () => {
            expect(OnyxKeys.getCollectionKey(PLAIN_KEYS.NVP_PRIORITY_MODE)).toBeUndefined();
            expect(OnyxKeys.getCollectionKey('nvp_')).toBeUndefined();

            OnyxKeys.setCollectionKeys(new Set([...Object.values(COLLECTIONS), 'nvp_']));

            expect(OnyxKeys.getCollectionKey(PLAIN_KEYS.NVP_PRIORITY_MODE)).toBe('nvp_');
            expect(OnyxKeys.getCollectionKey('nvp_')).toBe('nvp_');
        });

        it('does not remember a miss from registerMemberKey either', () => {
            OnyxKeys.registerMemberKey(PLAIN_KEYS.NVP_PRIORITY_MODE);
            expect(OnyxKeys.getCollectionKey(PLAIN_KEYS.NVP_PRIORITY_MODE)).toBeUndefined();

            OnyxKeys.setCollectionKeys(new Set([...Object.values(COLLECTIONS), 'nvp_']));

            expect(OnyxKeys.getCollectionKey(PLAIN_KEYS.NVP_PRIORITY_MODE)).toBe('nvp_');
        });

        it('stops resolving a never looked up collection key once it is unregistered', () => {
            OnyxKeys.setCollectionKeys(new Set([COLLECTIONS.REPORT]));

            expect(OnyxKeys.getCollectionKey(COLLECTIONS.POLICY)).toBeUndefined();
            expect(OnyxKeys.getCollectionKey('policy_1')).toBeUndefined();
            expect(OnyxKeys.getCollectionKey('report_1')).toBe(COLLECTIONS.REPORT);
        });
    });

    describe('isCollectionMember', () => {
        it.each(RESOLUTION_CASES)('is true for %j only when it resolves to a longer collection key (%j)', (key, collectionKey) => {
            expect(OnyxKeys.isCollectionMember(key)).toBe(collectionKey !== undefined && key !== collectionKey);
        });

        it('gives the same answers after the members are registered', () => {
            for (const [key] of RESOLUTION_CASES) {
                OnyxKeys.registerMemberKey(key);
            }
            // Collection keys are not registered as their own members, see the suspected bug below for a nested one.
            for (const [key, collectionKey] of RESOLUTION_CASES.filter(([caseKey]) => !OnyxKeys.isCollectionKey(caseKey))) {
                expect(OnyxKeys.isCollectionMember(key)).toBe(collectionKey !== undefined);
            }
        });
    });

    describe('splitCollectionMemberKey', () => {
        const cases: Array<[OnyxKey, OnyxKey, string]> = [
            ['report_123', 'report_', '123'],
            ['reportActions_123', 'reportActions_', '123'],
            ['reportActionsDrafts_1_2', 'reportActionsDrafts_', '1_2'],
            ['report_reportActions_1', 'report_', 'reportActions_1'],
            ['test_levelX_1', 'test_', 'levelX_1'],
            ['test_level_lastX_1', 'test_level_', 'lastX_1'],
            ['test_level_last_', 'test_level_last_', ''],
            ['sharedNVP_user_-1_something', 'sharedNVP_user_', '-1_something'],
            ['ramCollection_nested_7', 'ramCollection_nested_', '7'],
        ];

        it.each(cases)('splits %j into %j and %j', (key, collectionKey, id) => {
            expect(OnyxKeys.splitCollectionMemberKey(key)).toEqual([collectionKey, id]);
        });

        it('splits every member the same way whether it was looked up, registered or never seen', () => {
            const cold = MEMBER_CASES.map(([key]) => OnyxKeys.splitCollectionMemberKey(key));
            const warmModule = loadOnyxKeys();
            for (const [key] of MEMBER_CASES) {
                warmModule.registerMemberKey(key);
            }
            const warm = MEMBER_CASES.map(([key]) => warmModule.splitCollectionMemberKey(key));

            expect(warm).toEqual(cold);
            expect(cold).toEqual(MEMBER_CASES.map(([key, collectionKey = '']) => [collectionKey, key.slice(collectionKey.length)]));
        });

        it('uses a compatible explicit collection key as given, even a less specific one', () => {
            expect(OnyxKeys.splitCollectionMemberKey('test_level_1', COLLECTIONS.TEST)).toEqual(['test_', 'level_1']);
            expect(OnyxKeys.splitCollectionMemberKey('test_level_1', COLLECTIONS.TEST_LEVEL)).toEqual(['test_level_', '1']);
        });

        it('does not check an explicit collection key against the registry', () => {
            expect(OnyxKeys.splitCollectionMemberKey(PLAIN_KEYS.NVP_PRIORITY_MODE, 'nvp_')).toEqual(['nvp_', 'priorityMode']);
            expect(OnyxKeys.splitCollectionMemberKey('reportActions_1', 'report')).toEqual(['report', 'Actions_1']);
        });

        it('throws for an explicit collection key that only shares a prefix with the key', () => {
            expect(() => OnyxKeys.splitCollectionMemberKey('reportActions_1', COLLECTIONS.REPORT)).toThrow(
                "Invalid 'report_' collection key provided, it isn't compatible with 'reportActions_1' key.",
            );
            expect(() => OnyxKeys.splitCollectionMemberKey('test_1', COLLECTIONS.TEST_LEVEL)).toThrow(
                "Invalid 'test_level_' collection key provided, it isn't compatible with 'test_1' key.",
            );
        });

        it('throws for an explicit collection key equal to the key', () => {
            expect(() => OnyxKeys.splitCollectionMemberKey(COLLECTIONS.REPORT, COLLECTIONS.REPORT)).toThrow(
                "Invalid 'report_' collection key provided, it isn't compatible with 'report_' key.",
            );
        });

        it('resolves the collection key when the explicit one is empty', () => {
            expect(OnyxKeys.splitCollectionMemberKey('reportActions_9', '')).toEqual(['reportActions_', '9']);
        });

        it('throws for a key with an underscore whose prefix is not a registered collection', () => {
            expect(() => OnyxKeys.splitCollectionMemberKey(PLAIN_KEYS.NVP_PRIORITY_MODE)).toThrow("Invalid 'nvp_priorityMode' key provided, only collection keys are allowed.");
            expect(() => OnyxKeys.splitCollectionMemberKey('repor_1')).toThrow("Invalid 'repor_1' key provided, only collection keys are allowed.");
        });

        it('throws after the collection of a never looked up key is unregistered', () => {
            OnyxKeys.setCollectionKeys(new Set([COLLECTIONS.REPORT]));

            expect(() => OnyxKeys.splitCollectionMemberKey('policy_1')).toThrow("Invalid 'policy_1' key provided, only collection keys are allowed.");
        });
    });

    describe('registerMemberKey, deregisterMemberKey and getMembersOfCollection', () => {
        const collidingMembers = ['report_1', 'reportActions_1', 'reportActionsDrafts_1', 'report_reportActions_1', 'test_1', 'test_level_1', 'test_level_last_1', 'test_levelX_1'];

        function expectCollidingMembership(onyxKeys: OnyxKeysModule): void {
            expect(membersOf(onyxKeys, COLLECTIONS.REPORT)).toEqual(['report_1', 'report_reportActions_1']);
            expect(membersOf(onyxKeys, COLLECTIONS.REPORT_ACTIONS)).toEqual(['reportActions_1']);
            expect(membersOf(onyxKeys, COLLECTIONS.REPORT_ACTIONS_DRAFTS)).toEqual(['reportActionsDrafts_1']);
            expect(membersOf(onyxKeys, COLLECTIONS.TEST)).toEqual(['test_1', 'test_levelX_1']);
            expect(membersOf(onyxKeys, COLLECTIONS.TEST_LEVEL)).toEqual(['test_level_1']);
            expect(membersOf(onyxKeys, COLLECTIONS.TEST_LEVEL_LAST)).toEqual(['test_level_last_1']);
        }

        it('files every member under exactly its most specific collection', () => {
            for (const key of collidingMembers) {
                OnyxKeys.registerMemberKey(key);
            }

            expectCollidingMembership(OnyxKeys);
        });

        it('files members the same way in any registration order', () => {
            for (const key of [...collidingMembers].reverse()) {
                OnyxKeys.registerMemberKey(key);
            }

            expectCollidingMembership(OnyxKeys);
        });

        it('files a member that getCollectionKey resolved first', () => {
            for (const key of collidingMembers) {
                OnyxKeys.getCollectionKey(key);
            }
            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT)).toEqual([]);

            for (const key of collidingMembers) {
                OnyxKeys.registerMemberKey(key);
            }

            expectCollidingMembership(OnyxKeys);
        });

        it('files a member that was deregistered and registered again', () => {
            OnyxKeys.registerMemberKey('reportActions_1');
            OnyxKeys.registerMemberKey('reportActions_2');
            OnyxKeys.deregisterMemberKey('reportActions_1');
            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT_ACTIONS)).toEqual(['reportActions_2']);

            OnyxKeys.registerMemberKey('reportActions_1');

            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT_ACTIONS)).toEqual(['reportActions_1', 'reportActions_2']);
            expect(OnyxKeys.getCollectionKey('reportActions_1')).toBe(COLLECTIONS.REPORT_ACTIONS);
        });

        it('leaves a colliding collection untouched when a member is deregistered', () => {
            for (const key of collidingMembers) {
                OnyxKeys.registerMemberKey(key);
            }

            OnyxKeys.deregisterMemberKey('test_level_1');
            OnyxKeys.deregisterMemberKey('reportActions_1');

            expect(membersOf(OnyxKeys, COLLECTIONS.TEST)).toEqual(['test_1', 'test_levelX_1']);
            expect(membersOf(OnyxKeys, COLLECTIONS.TEST_LEVEL)).toEqual([]);
            expect(membersOf(OnyxKeys, COLLECTIONS.TEST_LEVEL_LAST)).toEqual(['test_level_last_1']);
            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT)).toEqual(['report_1', 'report_reportActions_1']);
            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT_ACTIONS)).toEqual([]);
        });

        it('leaves the members alone when a key that was never registered is deregistered', () => {
            OnyxKeys.registerMemberKey('report_1');
            OnyxKeys.getCollectionKey('report_2');

            OnyxKeys.deregisterMemberKey('report_2');
            OnyxKeys.deregisterMemberKey('report_3');
            OnyxKeys.deregisterMemberKey(COLLECTIONS.REPORT);

            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT)).toEqual(['report_1']);
        });

        it('files nothing for keys outside every collection', () => {
            for (const key of [PLAIN_KEYS.SESSION, PLAIN_KEYS.NVP_PRIORITY_MODE, 'repor_1', '', '_']) {
                OnyxKeys.registerMemberKey(key);
            }

            for (const collectionKey of [...Object.values(COLLECTIONS), 'nvp_', 'repor_', '']) {
                expect(membersOf(OnyxKeys, collectionKey)).toEqual([]);
            }
        });

        it('does not file a collection key under itself', () => {
            OnyxKeys.registerMemberKey(COLLECTIONS.REPORT);
            OnyxKeys.registerMemberKey(COLLECTIONS.REPORT_ACTIONS);

            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT)).toEqual([]);
            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT_ACTIONS)).toEqual([]);
            expect(OnyxKeys.getCollectionKey(COLLECTIONS.REPORT_ACTIONS)).toBe(COLLECTIONS.REPORT_ACTIONS);
        });

        it('files a key whose collection was registered after its first registration attempt', () => {
            OnyxKeys.registerMemberKey('nvp_a');
            OnyxKeys.setCollectionKeys(new Set([...Object.values(COLLECTIONS), 'nvp_']));
            OnyxKeys.registerMemberKey('nvp_b');
            expect(membersOf(OnyxKeys, 'nvp_')).toEqual(['nvp_b']);

            OnyxKeys.registerMemberKey('nvp_a');

            expect(membersOf(OnyxKeys, 'nvp_')).toEqual(['nvp_a', 'nvp_b']);
        });

        it('keeps one entry per member however often it is registered', () => {
            OnyxKeys.getCollectionKey('policy_1');
            OnyxKeys.registerMemberKey('policy_1');
            OnyxKeys.registerMemberKey('policy_1');
            OnyxKeys.registerMemberKey('policy_2');
            OnyxKeys.registerMemberKey('policy_2');

            expect(OnyxKeys.getMembersOfCollection(COLLECTIONS.POLICY)?.size).toBe(2);
        });

        it('empties the member set once the last member is deregistered', () => {
            OnyxKeys.registerMemberKey('policy_1');
            OnyxKeys.deregisterMemberKey('policy_1');

            expect(OnyxKeys.getMembersOfCollection(COLLECTIONS.POLICY)?.size ?? 0).toBe(0);
        });

        it('tracks a thousand members of colliding collections without mixing them up', () => {
            const reportKeys = Array.from({length: 500}, (_, index) => `report_${index}`);
            const actionKeys = Array.from({length: 500}, (_, index) => `reportActions_${index}`);
            for (let index = 0; index < 500; index++) {
                OnyxKeys.registerMemberKey(reportKeys[index]);
                OnyxKeys.registerMemberKey(actionKeys[index]);
            }
            for (let index = 0; index < 500; index += 2) {
                OnyxKeys.deregisterMemberKey(actionKeys[index]);
            }

            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT)).toEqual([...reportKeys].sort());
            expect(membersOf(OnyxKeys, COLLECTIONS.REPORT_ACTIONS)).toEqual(actionKeys.filter((_, index) => index % 2 === 1).sort());
        });
    });

    describe('isRamOnlyKey', () => {
        const cases: Array<[OnyxKey, boolean]> = [
            [PLAIN_KEYS.RAM_ONLY, true],
            ['ramOnly_1', false],
            ['ramOnlyX', false],
            ['ramOnl', false],
            [COLLECTIONS.RAM_COLLECTION, true],
            ['ramCollection_1', true],
            ['ramCollection_a_b', true],
            ['ramCollection_nestedX_1', true],
            // A nested collection is RAM-only only when it is listed itself.
            [COLLECTIONS.RAM_COLLECTION_NESTED, false],
            ['ramCollection_nested_1', false],
            ['ramCollection', false],
            ['report_1', false],
            [COLLECTIONS.REPORT, false],
            [PLAIN_KEYS.SESSION, false],
            ['', false],
        ];

        it.each(cases)('isRamOnlyKey(%j) is %j on a cold lookup', (key, expected) => {
            expect(OnyxKeys.isRamOnlyKey(key)).toBe(expected);
        });

        it('gives the same answers after the keys are registered and resolved', () => {
            // Registering a nested collection key itself changes its answer, see the suspected bugs below.
            for (const [key] of cases.filter(([caseKey]) => !OnyxKeys.isCollectionKey(caseKey))) {
                OnyxKeys.registerMemberKey(key);
            }
            for (const [key] of cases) {
                OnyxKeys.getCollectionKey(key);
            }

            expect(cases.map(([key]) => OnyxKeys.isRamOnlyKey(key))).toEqual(cases.map(([, expected]) => expected));
        });

        it('covers a single collection member listed on its own without its siblings', () => {
            const onyxKeys = loadOnyxKeys({ramOnlyKeys: ['report_special']});

            expect(onyxKeys.isRamOnlyKey('report_special')).toBe(true);
            expect(onyxKeys.isRamOnlyKey('report_other')).toBe(false);
            expect(onyxKeys.isRamOnlyKey(COLLECTIONS.REPORT)).toBe(false);
        });

        it('covers the members of a listed nested collection but not the members of its parent', () => {
            const onyxKeys = loadOnyxKeys({ramOnlyKeys: [COLLECTIONS.TEST_LEVEL]});

            expect(onyxKeys.isRamOnlyKey('test_level_1')).toBe(true);
            expect(onyxKeys.isRamOnlyKey('test_1')).toBe(false);
            expect(onyxKeys.isRamOnlyKey('test_level_last_1')).toBe(false);
        });

        it('extends a listed prefix to its members only while the prefix is a registered collection', () => {
            const onyxKeys = loadOnyxKeys({ramOnlyKeys: ['nvp_']});
            expect(onyxKeys.isRamOnlyKey('nvp_')).toBe(true);
            expect(onyxKeys.isRamOnlyKey(PLAIN_KEYS.NVP_PRIORITY_MODE)).toBe(false);

            onyxKeys.setCollectionKeys(new Set([...Object.values(COLLECTIONS), 'nvp_']));

            expect(onyxKeys.isRamOnlyKey(PLAIN_KEYS.NVP_PRIORITY_MODE)).toBe(true);
        });

        it('replaces the whole RAM-only set on every setRamOnlyKeys call', () => {
            OnyxKeys.setRamOnlyKeys(new Set([COLLECTIONS.POLICY]));

            expect(OnyxKeys.isRamOnlyKey('policy_1')).toBe(true);
            expect(OnyxKeys.isRamOnlyKey(PLAIN_KEYS.RAM_ONLY)).toBe(false);
            expect(OnyxKeys.isRamOnlyKey('ramCollection_1')).toBe(false);
        });

        it('reflects a RAM-only set change for keys that were already looked up', () => {
            expect(OnyxKeys.isRamOnlyKey('policy_1')).toBe(false);

            OnyxKeys.setRamOnlyKeys(new Set([COLLECTIONS.POLICY]));

            expect(OnyxKeys.isRamOnlyKey('policy_1')).toBe(true);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('keeps resolving a looked up member to a less specific collection after a more specific one is registered', () => {
            const onyxKeys = loadOnyxKeys({collectionKeys: [COLLECTIONS.TEST]});
            expect(onyxKeys.getCollectionKey('test_level_1')).toBe(COLLECTIONS.TEST);

            onyxKeys.setCollectionKeys(new Set([COLLECTIONS.TEST, COLLECTIONS.TEST_LEVEL]));

            // A fresh lookup would give 'test_level_', see 'test_level_2'.
            expect(onyxKeys.getCollectionKey('test_level_1')).toBe(COLLECTIONS.TEST);
            expect(onyxKeys.getCollectionKey('test_level_2')).toBe(COLLECTIONS.TEST_LEVEL);
            expect(onyxKeys.splitCollectionMemberKey('test_level_1')).toEqual(['test_', 'level_1']);
        });

        it('keeps resolving a looked up member after its collection is unregistered', () => {
            const onyxKeys = loadOnyxKeys();
            expect(onyxKeys.getCollectionKey('policy_1')).toBe(COLLECTIONS.POLICY);

            onyxKeys.setCollectionKeys(new Set([COLLECTIONS.REPORT]));

            expect(onyxKeys.getCollectionKey('policy_1')).toBe(COLLECTIONS.POLICY);
            expect(onyxKeys.isCollectionMember('policy_1')).toBe(true);
            expect(onyxKeys.getCollectionKey('policy_2')).toBeUndefined();
        });

        it('keeps a registered member filed under a less specific collection after a more specific one is registered', () => {
            const onyxKeys = loadOnyxKeys({collectionKeys: [COLLECTIONS.TEST]});
            onyxKeys.registerMemberKey('test_level_1');

            onyxKeys.setCollectionKeys(new Set([COLLECTIONS.TEST, COLLECTIONS.TEST_LEVEL]));
            onyxKeys.registerMemberKey('test_level_1');
            onyxKeys.registerMemberKey('test_level_2');

            expect(membersOf(onyxKeys, COLLECTIONS.TEST)).toEqual(['test_level_1']);
            expect(membersOf(onyxKeys, COLLECTIONS.TEST_LEVEL)).toEqual(['test_level_2']);
        });

        it('files a nested collection key under its parent, after which it resolves to the parent', () => {
            expect(OnyxKeys.getCollectionKey(COLLECTIONS.TEST_LEVEL)).toBe(COLLECTIONS.TEST_LEVEL);

            OnyxKeys.registerMemberKey(COLLECTIONS.TEST_LEVEL);

            expect(membersOf(OnyxKeys, COLLECTIONS.TEST)).toEqual([COLLECTIONS.TEST_LEVEL]);
            expect(OnyxKeys.getCollectionKey(COLLECTIONS.TEST_LEVEL)).toBe(COLLECTIONS.TEST);
            expect(OnyxKeys.isCollectionMember(COLLECTIONS.TEST_LEVEL)).toBe(true);
            expect(OnyxKeys.splitCollectionMemberKey(COLLECTIONS.TEST_LEVEL)).toEqual(['test_', 'level_']);
        });

        it('makes a nested collection key RAM-only once it is filed under a RAM-only parent', () => {
            const onyxKeys = loadOnyxKeys({ramOnlyKeys: []});
            onyxKeys.setRamOnlyKeys(new Set([COLLECTIONS.TEST]));
            expect(onyxKeys.isRamOnlyKey(COLLECTIONS.TEST_LEVEL)).toBe(false);

            onyxKeys.registerMemberKey(COLLECTIONS.TEST_LEVEL);

            expect(onyxKeys.isRamOnlyKey(COLLECTIONS.TEST_LEVEL)).toBe(true);
        });

        it('treats every key outside a collection as RAM-only when the empty key is listed as RAM-only', () => {
            const onyxKeys = loadOnyxKeys({ramOnlyKeys: ['']});

            expect(onyxKeys.isRamOnlyKey(PLAIN_KEYS.SESSION)).toBe(true);
            expect(onyxKeys.isRamOnlyKey(PLAIN_KEYS.NVP_PRIORITY_MODE)).toBe(true);
            expect(onyxKeys.isRamOnlyKey('report_1')).toBe(false);
        });
    });
});
