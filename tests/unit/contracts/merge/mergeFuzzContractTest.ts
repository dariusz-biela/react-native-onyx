/**
 * Seeded property tests for `Onyx.merge`: random batches of same-tick merges (nested objects, nulls,
 * undefined, arrays, primitives, incompatible changes) are compared with the independent model in
 * `helpers/model.ts`, for both `OnyxMerge` variants on a real SQLite provider. Batches that hit a known
 * native divergence (see the suspected bug tests) are skipped for the affected check only, and the run
 * asserts that most batches were still checked.
 */
import {deepEqual} from 'fast-equals';

import type {MergeVariant} from './helpers/mergeVariant';
import type {Rng} from './helpers/model';
import type {OnyxKey} from '../../../../lib/types';

import Onyx from '../../../../lib';
import cache from '../../../../lib/OnyxCache';
import {KEYS, disconnectAll, flush, initOnyxForMergeContracts, record} from './helpers/harness';
import {MERGE_VARIANTS, setMergeVariant} from './helpers/mergeVariant';
import {applyBatch, createRng, deepFreeze, findForbiddenLeaf, generateBatch, generatePatch, isNativeCacheSafeBatch, isNativeStorageSafeBatch, pick} from './helpers/model';
import {readStored, removeStored, writeStored} from './helpers/sqliteStorage';

jest.mock('../../../../lib/storage', () => require('./helpers/sqliteStorage'));
jest.mock('../../../../lib/OnyxMerge', () => require('./helpers/mergeVariant'));

const SEEDS_PER_CHUNK = 25;
const CHUNKS = 8;
const MEMBER = `${KEYS.COLLECTION.TEST}1`;
const SIBLING = `${KEYS.COLLECTION.TEST}2`;

type Coverage = {batches: number; cacheChecked: number; storageChecked: number; changedBatches: number};

function describeCase(seed: number, batchIndex: number, before: unknown, batch: unknown[]): string {
    return `seed ${seed}, batch ${batchIndex}: ${JSON.stringify(before)} <- ${JSON.stringify(batch, (_, value: unknown) => (value === undefined ? '__undefined__' : value))}`;
}

async function seedInitialValue(rng: Rng, key: OnyxKey): Promise<void> {
    if (rng() < 0.3) {
        return;
    }
    await Onyx.set(key, deepFreeze(generatePatch(rng)));
}

async function resyncStorage(key: OnyxKey): Promise<void> {
    const value = cache.get(key);
    if (value === undefined) {
        await removeStored(key);
        return;
    }
    await writeStored(key, value);
}

async function runSeed(variant: MergeVariant, seed: number): Promise<Coverage> {
    const coverage: Coverage = {batches: 0, cacheChecked: 0, storageChecked: 0, changedBatches: 0};
    const rng = createRng(seed);
    const key = pick(rng, [KEYS.OBJECT, MEMBER]);
    const isMember = key === MEMBER;

    await Onyx.merge(SIBLING, {sibling: seed});
    await seedInitialValue(rng, key);
    const recorder = record(key);
    const collectionRecorder = record(KEYS.COLLECTION.TEST);
    await flush();

    const batchCount = 1 + Math.floor(rng() * 4);
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
        const before = cache.get(key);
        const batch = generateBatch(rng).map(deepFreeze);
        const expected = applyBatch(before, batch);
        const label = describeCase(seed, batchIndex, before, batch);
        recorder.reset();
        collectionRecorder.reset();
        coverage.batches++;

        await Promise.all(batch.map((change) => Onyx.merge(key, change)));
        await flush();

        const actual = cache.get(key);
        const cacheIsComparable = variant === 'web' || isNativeCacheSafeBatch(batch);
        if (cacheIsComparable) {
            coverage.cacheChecked++;
            expect({label, value: actual}).toStrictEqual({label, value: expected});
            expect({label, forbidden: findForbiddenLeaf(actual)}).toStrictEqual({label, forbidden: undefined});
        }

        const changed = !deepEqual(before, actual);
        const delivered = recorder.values();
        if (changed) {
            coverage.changedBatches++;
            expect({label, count: delivered.length}).toStrictEqual({label, count: 1});
            expect(delivered.at(-1)).toBe(actual);
        } else {
            // Removing a key that is already absent re-delivers undefined once today, see the suspected bug test.
            const allowedDeliveries = before === undefined && actual === undefined ? [[], [undefined]] : [[]];
            expect({label, delivered: allowedDeliveries.some((allowed) => deepEqual(allowed, delivered))}).toStrictEqual({label, delivered: true});
            expect(actual).toBe(before);
        }

        if (isMember) {
            const snapshots = collectionRecorder.values() as Array<Record<string, unknown>>;
            const staysAbsent = before === undefined && actual === undefined;
            expect({label, count: snapshots.length <= (changed || staysAbsent ? 1 : 0), atLeastOne: !changed || snapshots.length >= 1}).toStrictEqual({label, count: true, atLeastOne: true});
            if (changed) {
                expect(snapshots.at(-1)?.[MEMBER]).toBe(actual);
                expect(snapshots.at(-1)?.[SIBLING]).toBe(cache.get(SIBLING));
            }
        } else {
            expect({label, collectionDeliveries: collectionRecorder.values()}).toStrictEqual({label, collectionDeliveries: []});
        }

        const storageIsComparable = cacheIsComparable && (variant === 'web' || isNativeStorageSafeBatch(before, batch));
        if (storageIsComparable) {
            coverage.storageChecked++;
            expect({label, stored: await readStored(key)}).toStrictEqual({label, stored: actual ?? null});
        }
        if (!cacheIsComparable) {
            await Onyx.set(key, expected ?? null);
        }
        if (!storageIsComparable) {
            await resyncStorage(key);
        }
    }

    disconnectAll();
    await Onyx.clear();
    await flush();
    return coverage;
}

function addCoverage(total: Coverage, delta: Coverage): Coverage {
    return {
        batches: total.batches + delta.batches,
        cacheChecked: total.cacheChecked + delta.cacheChecked,
        storageChecked: total.storageChecked + delta.storageChecked,
        changedBatches: total.changedBatches + delta.changedBatches,
    };
}

describe.each(MERGE_VARIANTS)('Onyx.merge against the reference model (%s OnyxMerge)', (variant: MergeVariant) => {
    let coverage: Coverage = {batches: 0, cacheChecked: 0, storageChecked: 0, changedBatches: 0};

    beforeAll(() => {
        setMergeVariant(variant);
        initOnyxForMergeContracts();
    });

    beforeEach(() => setMergeVariant(variant));

    it.each(Array.from({length: CHUNKS}, (_, chunk) => chunk))('matches the model for seed chunk %i', async (chunk: number) => {
        for (let offset = 0; offset < SEEDS_PER_CHUNK; offset++) {
            coverage = addCoverage(coverage, await runSeed(variant, chunk * SEEDS_PER_CHUNK + offset + 1));
        }
    });

    it('checked most batches', () => {
        expect(coverage.batches).toBeGreaterThan(CHUNKS * SEEDS_PER_CHUNK);
        expect(coverage.changedBatches).toBeGreaterThan(coverage.batches / 2);
        expect(coverage.cacheChecked).toBeGreaterThan(coverage.batches * 0.8);
        expect(coverage.storageChecked).toBeGreaterThan(coverage.batches * 0.6);
    });
});
