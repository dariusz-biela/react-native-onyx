import type {OnyxKey} from '../../../../lib/types';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';
import type {OnyxModules} from './harness';
import {KEYS, startOnyx} from './harness';

type Fields = Record<string, number>;
type Model = Map<OnyxKey, Fields>;
type Operation = {
    describe: string;
    run: (modules: OnyxModules) => Promise<unknown>;
    apply: (model: Model) => void;
    touchesWithNull: OnyxKey[];
    rewritesWithoutCompare?: OnyxKey[];
    keys: OnyxKey[];
    isMergeCollection?: boolean;
};

const REPORT_MEMBERS = [1, 2, 3, 4].map((id) => `${KEYS.COLLECTION.REPORT}${id}`);
const NESTED_MEMBER = `${KEYS.COLLECTION.REPORT_NESTED}1`;
const ACTIONS_MEMBER = `${KEYS.COLLECTION.REPORT_ACTIONS}1`;
const WRITABLE_KEYS = [...REPORT_MEMBERS, NESTED_MEMBER, ACTIONS_MEMBER, KEYS.PLAIN];
const CHECKED_COLLECTIONS = [KEYS.COLLECTION.REPORT, KEYS.COLLECTION.REPORT_NESTED, KEYS.COLLECTION.REPORT_ACTIONS, KEYS.COLLECTION.EMPTY];
const SEEDS = [1, 7, 42, 99, 1337, 2024, 4242, 31337];
const STEPS = 60;

/** Park-Miller PRNG, so every run replays the same sequence. */
function createRandom(seed: number): () => number {
    const modulus = 2147483647;
    let state = seed % modulus;
    return () => {
        state = (state * 48271) % modulus;
        return (state - 1) / (modulus - 1);
    };
}

function pick<T>(random: () => number, items: readonly T[]): T {
    return items[Math.floor(random() * items.length)];
}

function randomFields(random: () => number): Fields {
    const fields: Fields = {};
    for (const name of ['a', 'b', 'c']) {
        if (random() < 0.5) {
            fields[name] = Math.floor(random() * 3);
        }
    }
    return Object.keys(fields).length > 0 ? fields : {a: 0};
}

function applyMerge(model: Model, key: OnyxKey, fields: Fields | null): void {
    if (fields === null) {
        model.delete(key);
        return;
    }
    model.set(key, {...(model.get(key) ?? {}), ...fields});
}

function applySet(model: Model, key: OnyxKey, fields: Fields | null): void {
    if (fields === null) {
        model.delete(key);
        return;
    }
    model.set(key, {...fields});
}

function randomOperation(random: () => number): Operation {
    const kind = pick(random, ['set', 'merge', 'setNull', 'mergeNull', 'mergeCollection', 'multiSet'] as const);
    const key = pick(random, WRITABLE_KEYS);
    const fields = randomFields(random);
    switch (kind) {
        case 'set':
            return {
                describe: `set ${key} ${JSON.stringify(fields)}`,
                run: ({Onyx}) => Onyx.set(key, fields),
                apply: (model) => applySet(model, key, fields),
                touchesWithNull: [],
                keys: [key],
            };
        case 'merge':
            return {
                describe: `merge ${key} ${JSON.stringify(fields)}`,
                run: ({Onyx}) => Onyx.merge(key, fields),
                apply: (model) => applyMerge(model, key, fields),
                touchesWithNull: [],
                keys: [key],
            };
        case 'setNull':
            return {describe: `set ${key} null`, run: ({Onyx}) => Onyx.set(key, null), apply: (model) => applySet(model, key, null), touchesWithNull: [key], keys: [key]};
        case 'mergeNull':
            return {describe: `merge ${key} null`, run: ({Onyx}) => Onyx.merge(key, null), apply: (model) => applyMerge(model, key, null), touchesWithNull: [key], keys: [key]};
        case 'mergeCollection': {
            const first = pick(random, REPORT_MEMBERS);
            const second = pick(random, REPORT_MEMBERS);
            const members: Record<string, Fields> = {[first]: fields};
            members[second] = randomFields(random);
            return {
                describe: `mergeCollection ${JSON.stringify(members)}`,
                run: ({Onyx}) => Onyx.mergeCollection(KEYS.COLLECTION.REPORT, members),
                apply: (model) => {
                    for (const [member, value] of Object.entries(members)) {
                        applyMerge(model, member, value);
                    }
                },
                touchesWithNull: [],
                keys: Object.keys(members),
                isMergeCollection: true,
            };
        }
        case 'multiSet':
        default: {
            const other = pick(random, WRITABLE_KEYS);
            const otherFields = randomFields(random);
            const pairs: Record<string, Fields> = {[key]: fields};
            pairs[other] = otherFields;
            return {
                describe: `multiSet ${JSON.stringify(pairs)}`,
                run: ({Onyx}) => Onyx.multiSet(pairs),
                apply: (model) => {
                    for (const [pairKey, value] of Object.entries(pairs)) {
                        applySet(model, pairKey, value);
                    }
                },
                touchesWithNull: [],
                // multiSet does not skip equal values (pinned in getCachedCollection suspected bugs).
                rewritesWithoutCompare: Object.keys(pairs),
                keys: Object.keys(pairs),
            };
        }
    }
}

/** Builds one tick of writes; a write never follows a mergeCollection on the same key (pinned as a suspected bug below). */
function randomBatch(random: () => number): Operation[] {
    const size = 1 + Math.floor(random() * 3);
    const batch: Operation[] = [];
    while (batch.length < size) {
        const operation = randomOperation(random);
        const mergedByCollection = new Set(batch.filter((earlier) => earlier.isMergeCollection).flatMap((earlier) => earlier.keys));
        if (!operation.keys.some((key) => mergedByCollection.has(key))) {
            batch.push(operation);
        }
    }
    return batch;
}

function expectedCollection(model: Model, collectionKey: string): Record<string, Fields> {
    const members: Record<string, Fields> = {};
    for (const [key, value] of model) {
        const rest = key.startsWith(collectionKey) ? key.slice(collectionKey.length) : undefined;
        if (rest !== undefined && rest.length > 0 && !CHECKED_COLLECTIONS.some((other) => other !== collectionKey && other.startsWith(collectionKey) && key.startsWith(other))) {
            members[key] = value;
        }
    }
    return members;
}

function isCollectionMemberOf(collectionKey: string, key: OnyxKey): boolean {
    return Object.keys(expectedCollection(new Map([[key, {}]]), collectionKey)).length > 0;
}

describe('cached reads under a random write sequence', () => {
    it.each(SEEDS)('match a plain model and keep references exactly while content is unchanged (seed %i)', async (seed) => {
        const random = createRandom(seed);
        const initial: Record<string, Fields> = {[REPORT_MEMBERS[0]]: {a: 1}, [NESTED_MEMBER]: {a: 1}, [ACTIONS_MEMBER]: {a: 1}, [KEYS.PLAIN]: {a: 1}};
        const modules = await startOnyx({storedValues: {...initial, [KEYS.PLAIN_2]: 'untouched'}});
        const {OnyxUtils} = modules;
        const model: Model = new Map(Object.entries(initial));
        const history: string[] = [];

        for (let step = 0; step < STEPS; step++) {
            const batch = randomBatch(random);
            const previous = new Map(CHECKED_COLLECTIONS.map((collectionKey) => [collectionKey, OnyxUtils.getCachedCollection(collectionKey)]));
            const previousExpected = new Map(CHECKED_COLLECTIONS.map((collectionKey) => [collectionKey, expectedCollection(model, collectionKey)]));

            history.push(batch.map((operation) => operation.describe).join(' | '));
            const pending = batch.map((operation) => operation.run(modules));
            for (const operation of batch) {
                operation.apply(model);
            }
            await Promise.all(pending);
            await waitForPromisesToResolve();

            const context = `seed ${seed} step ${step}\n${history.join('\n')}`;
            for (const collectionKey of CHECKED_COLLECTIONS) {
                const actual = OnyxUtils.getCachedCollection(collectionKey);
                const expected = expectedCollection(model, collectionKey);
                expect({context, collectionKey, actual}).toEqual({context, collectionKey, actual: expected});
                expect(OnyxUtils.tryGetCachedValue(collectionKey)).toBe(actual);
                for (const member of Object.keys(actual)) {
                    expect({context, same: actual[member] === OnyxUtils.tryGetCachedValue(member)}).toEqual({context, same: true});
                }

                const unchanged = JSON.stringify(previousExpected.get(collectionKey)) === JSON.stringify(expected);
                const touchedByNull = batch.some((operation) => operation.touchesWithNull.some((key) => isCollectionMemberOf(collectionKey, key)));
                const rewritten = batch.some((operation) => (operation.rewritesWithoutCompare ?? []).some((key) => isCollectionMemberOf(collectionKey, key)));
                if (unchanged && !touchedByNull && !rewritten) {
                    expect({context, collectionKey, sameReference: actual === previous.get(collectionKey)}).toEqual({context, collectionKey, sameReference: true});
                }
                if (!unchanged) {
                    expect({context, collectionKey, newReference: actual !== previous.get(collectionKey)}).toEqual({context, collectionKey, newReference: true});
                }
            }
            expect({context, plain: OnyxUtils.tryGetCachedValue(KEYS.PLAIN)}).toEqual({context, plain: model.get(KEYS.PLAIN)});
        }
    });
});

describe('current behaviour (suspected bug)', () => {
    const REPORT_4 = REPORT_MEMBERS[3];

    it.each([
        ['set', {a: 1, b: 0}, {a: 2, b: 0}],
        ['merge', {a: 3}, {a: 2, b: 2, c: 1}],
        ['merge null', null, {a: 2}],
        ['set null', null, {a: 2}],
    ] as const)('a mergeCollection lands after a %s of the same member issued later in the same tick', async (kind, value, currentResult) => {
        const {Onyx, OnyxUtils, storage} = await startOnyx({storedValues: {[REPORT_4]: {b: 2, c: 1}, [KEYS.PLAIN]: 'plain'}});

        const mergeCollection = Onyx.mergeCollection(KEYS.COLLECTION.REPORT, {[REPORT_4]: {a: 2}});
        const later = kind.startsWith('set') ? Onyx.set(REPORT_4, value) : Onyx.merge(REPORT_4, value);
        await Promise.all([mergeCollection, later]);
        await waitForPromisesToResolve();

        // Expected: the later write wins (set/null replace, merge applies on top), like merge then set does.
        expect(OnyxUtils.tryGetCachedValue(REPORT_4)).toEqual(currentResult);
        expect(OnyxUtils.getCachedCollection(KEYS.COLLECTION.REPORT)).toEqual({[REPORT_4]: currentResult});
        await expect(storage.getItem(REPORT_4)).resolves.toEqual(currentResult);
    });
});
