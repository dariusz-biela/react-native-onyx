/**
 * Contract tests for `Onyx.merge`, run through the public API against both `OnyxMerge` variants (web
 * `setItem` and native `mergeItem`) on a real SQLite provider. They pin observable results only: cache and
 * storage values, delivered values and their order, reference identity, and "no notification when nothing
 * changed", so a performance rewrite of the merge path can be checked without trusting its internals.
 */
import type {MergeVariant} from './helpers/mergeVariant';
import type {Recorder} from './helpers/harness';
import type {OnyxKey} from '../../../../lib/types';

import Onyx from '../../../../lib';
import cache from '../../../../lib/OnyxCache';
import {DEFAULT_OBJECT_VALUE, KEYS, SKIPPABLE_MEMBER_ID, alertMessages, captureLogs, disconnectAll, flush, initOnyxForMergeContracts, record} from './helpers/harness';
import {MERGE_VARIANTS, setMergeVariant} from './helpers/mergeVariant';
import {deepFreeze} from './helpers/model';
import {readStored, storageWriteCallCount, writeStored} from './helpers/sqliteStorage';

jest.mock('../../../../lib/storage', () => require('./helpers/sqliteStorage'));
jest.mock('../../../../lib/OnyxMerge', () => require('./helpers/mergeVariant'));

const MEMBER_1 = `${KEYS.COLLECTION.TEST}1`;
const MEMBER_2 = `${KEYS.COLLECTION.TEST}2`;

/** Subscribes, waits for the initial delivery and drops it, so the recorder holds only what later writes deliver. */
async function recordFromNow(key: OnyxKey): Promise<Recorder> {
    const recorder = record(key);
    await flush();
    recorder.reset();
    return recorder;
}

async function expectStorageToMatchCache(key: OnyxKey): Promise<void> {
    await flush();
    expect(await readStored(key)).toStrictEqual(cache.get(key) ?? null);
}

describe.each(MERGE_VARIANTS)('Onyx.merge contract (%s OnyxMerge)', (variant: MergeVariant) => {
    beforeAll(() => {
        setMergeVariant(variant);
        initOnyxForMergeContracts();
    });

    beforeEach(() => {
        setMergeVariant(variant);
        captureLogs();
    });

    afterEach(async () => {
        disconnectAll();
        await Onyx.clear();
        await flush();
    });

    describe('values', () => {
        it('merges objects deeply and keeps untouched properties', async () => {
            await Onyx.set(KEYS.OBJECT, {a: {b: 1, c: {d: 1}}, e: 1});
            await Onyx.merge(KEYS.OBJECT, {a: {c: {f: 2}}});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: {b: 1, c: {d: 1, f: 2}}, e: 1});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('replaces arrays instead of merging them, at the top level and nested', async () => {
            await Onyx.set(KEYS.ARRAY, [1, 2, 3]);
            await Onyx.merge(KEYS.ARRAY, [4]);
            expect(cache.get(KEYS.ARRAY)).toStrictEqual([4]);
            await expectStorageToMatchCache(KEYS.ARRAY);

            await Onyx.set(KEYS.OBJECT, {list: [1, 2, 3], objects: [{a: 1, b: 1}], kept: true});
            await Onyx.merge(KEYS.OBJECT, {list: [9], objects: [{a: 2}]});
            expect(cache.get(KEYS.OBJECT)).toStrictEqual({list: [9], objects: [{a: 2}], kept: true});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('replaces an array with an empty array', async () => {
            await Onyx.set(KEYS.OBJECT, {list: [1, 2]});
            await Onyx.merge(KEYS.OBJECT, {list: []});
            expect(cache.get(KEYS.OBJECT)).toStrictEqual({list: []});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('creates a missing key and drops nested nulls from the first value', async () => {
            await Onyx.merge(KEYS.OBJECT, {a: 1, b: null, c: {d: null, e: 1}});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, c: {e: 1}});
        });

        it('persists the first value of a missing key when it has no nulls', async () => {
            await Onyx.merge(KEYS.OBJECT, {a: 1, c: {e: 1}, list: [1]});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, c: {e: 1}, list: [1]});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('treats a key removed by null like a missing key', async () => {
            await Onyx.set(KEYS.OBJECT, {old: 1});
            await Onyx.set(KEYS.OBJECT, null);
            await Onyx.merge(KEYS.OBJECT, {fresh: 1});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({fresh: 1});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('reads a value persisted by an earlier session before merging into it', async () => {
            cache.drop(KEYS.OTHER_OBJECT);
            await writeStored(KEYS.OTHER_OBJECT, {a: 1, b: {c: 1}});
            await Onyx.merge(KEYS.OTHER_OBJECT, {b: {d: 1}});

            expect(cache.get(KEYS.OTHER_OBJECT)).toStrictEqual({a: 1, b: {c: 1, d: 1}});
            await expectStorageToMatchCache(KEYS.OTHER_OBJECT);
        });

        it('merges on top of a default key state', async () => {
            await Onyx.merge(KEYS.DEFAULT_OBJECT, {b: 2});

            expect(cache.get(KEYS.DEFAULT_OBJECT)).toStrictEqual({...DEFAULT_OBJECT_VALUE, b: 2});
            await expectStorageToMatchCache(KEYS.DEFAULT_OBJECT);
        });

        it('removes the key when the change is a top-level null', async () => {
            await Onyx.set(KEYS.OBJECT, {a: 1});
            const recorder = await recordFromNow(KEYS.OBJECT);

            await Onyx.merge(KEYS.OBJECT, null);

            expect(cache.get(KEYS.OBJECT)).toBeUndefined();
            expect(recorder.values()).toStrictEqual([undefined]);
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('removes a property when a nested value is null, at any depth', async () => {
            await Onyx.set(KEYS.OBJECT, {a: 1, b: {c: 1, d: {e: 1, f: 1}}});

            await Onyx.merge(KEYS.OBJECT, {b: {d: {e: null}}});
            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: {c: 1, d: {f: 1}}});
            await expectStorageToMatchCache(KEYS.OBJECT);

            await Onyx.merge(KEYS.OBJECT, {b: null});
            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('ignores nested undefined values', async () => {
            await Onyx.set(KEYS.OBJECT, {a: 1, b: {c: 1}});
            await Onyx.merge(KEYS.OBJECT, {a: undefined, b: {c: undefined, d: 1}});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: {c: 1, d: 1}});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('replaces a nested object with a primitive and a primitive with an object', async () => {
            await Onyx.set(KEYS.OBJECT, {a: {b: 1}, c: 'text'});
            await Onyx.merge(KEYS.OBJECT, {a: 5, c: {d: 1}});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 5, c: {d: 1}});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('keeps falsy primitive values instead of removing the key', async () => {
            await Onyx.merge(KEYS.STRING, '');
            expect(cache.get(KEYS.STRING)).toBe('');
            await expectStorageToMatchCache(KEYS.STRING);

            await Onyx.merge(KEYS.STRING, 0);
            expect(cache.get(KEYS.STRING)).toBe(0);

            await Onyx.merge(KEYS.STRING, false);
            expect(cache.get(KEYS.STRING)).toBe(false);
            await expectStorageToMatchCache(KEYS.STRING);

            await Onyx.merge(KEYS.OBJECT, {zero: 0, empty: '', no: false});
            expect(cache.get(KEYS.OBJECT)).toStrictEqual({zero: 0, empty: '', no: false});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('delivers every keystroke of a draft in order when each merge is awaited', async () => {
            const recorder = await recordFromNow(KEYS.STRING);
            const drafts = Array.from({length: 30}, (_, index) => 'hello world, this is a longer draft text'.slice(0, index + 1));

            for (const draft of drafts) {
                await Onyx.merge(KEYS.STRING, draft);
            }

            expect(recorder.values()).toStrictEqual(drafts);
            expect(cache.get(KEYS.STRING)).toBe(drafts.at(-1));
            await expectStorageToMatchCache(KEYS.STRING);
        });
    });

    describe('same-key bursts in one tick', () => {
        it('applies every change of a burst in call order and delivers one final value', async () => {
            await Onyx.set(KEYS.OBJECT, {typing: {}});
            const recorder = await recordFromNow(KEYS.OBJECT);

            const promises = Array.from({length: 20}, (_, index) => Onyx.merge(KEYS.OBJECT, {typing: {[`user${index % 5}`]: index % 2 === 0}, last: index}));
            await Promise.all(promises);

            const expected = {typing: {user0: false, user1: true, user2: false, user3: true, user4: false}, last: 19};
            expect(cache.get(KEYS.OBJECT)).toStrictEqual(expected);
            expect(recorder.values().length).toBeGreaterThanOrEqual(1);
            expect(recorder.values().length).toBeLessThanOrEqual(1);
            expect(recorder.values().at(-1)).toStrictEqual(expected);
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('lets a later change in the burst overwrite an earlier one at the same path', async () => {
            await Onyx.set(KEYS.OBJECT, {seed: true});
            const recorder = await recordFromNow(KEYS.OBJECT);

            Onyx.merge(KEYS.OBJECT, {a: 1, nested: {x: 1}});
            Onyx.merge(KEYS.OBJECT, {b: 2, nested: {x: 2, y: 1}});
            await Onyx.merge(KEYS.OBJECT, {a: 3, nested: {y: null}});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({seed: true, a: 3, b: 2, nested: {x: 2}});
            expect(recorder.values()).toStrictEqual([{seed: true, a: 3, b: 2, nested: {x: 2}}]);
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('has the final value in the cache once any promise of the burst resolves', async () => {
            const first = Onyx.merge(KEYS.OBJECT, {a: 1});
            const second = Onyx.merge(KEYS.OBJECT, {b: 1});
            Onyx.merge(KEYS.OBJECT, {c: 1});

            await first;
            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: 1, c: 1});
            await second;
            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: 1, c: 1});
        });

        it('starts from an empty value when a null precedes objects in the same batch', async () => {
            await Onyx.set(KEYS.OBJECT, {old: 1, nested: {old: 1}});
            const recorder = await recordFromNow(KEYS.OBJECT);

            Onyx.merge(KEYS.OBJECT, null);
            await Onyx.merge(KEYS.OBJECT, {fresh: 1, nested: {fresh: 1}});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({fresh: 1, nested: {fresh: 1}});
            expect(recorder.values()).toStrictEqual([{fresh: 1, nested: {fresh: 1}}]);
        });

        it('removes the key when an object is followed by a null in the same batch', async () => {
            await Onyx.set(KEYS.OBJECT, {old: 1});
            const recorder = await recordFromNow(KEYS.OBJECT);

            Onyx.merge(KEYS.OBJECT, {a: 1});
            await Onyx.merge(KEYS.OBJECT, null);

            expect(cache.get(KEYS.OBJECT)).toBeUndefined();
            expect(recorder.values()).toStrictEqual([undefined]);
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('replaces a nested object when its null and its new object arrive in the same batch', async () => {
            await Onyx.set(KEYS.OBJECT, {a: {old: 1}, kept: 1});

            Onyx.merge(KEYS.OBJECT, {a: null});
            await Onyx.merge(KEYS.OBJECT, {a: {fresh: 1}});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: {fresh: 1}, kept: 1});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('replaces a deeper nested object when its null and its new object arrive in the same batch', async () => {
            await Onyx.set(KEYS.OBJECT, {a: {b: {old: 1}, keep: 1}});

            Onyx.merge(KEYS.OBJECT, {a: {b: null}});
            await Onyx.merge(KEYS.OBJECT, {a: {b: {fresh: {deep: 1}}}});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: {b: {fresh: {deep: 1}}, keep: 1}});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('keeps bursts on different keys apart when they interleave', async () => {
            const objectRecorder = await recordFromNow(KEYS.OBJECT);
            const otherRecorder = await recordFromNow(KEYS.OTHER_OBJECT);

            Onyx.merge(KEYS.OBJECT, {a: 1});
            Onyx.merge(KEYS.OTHER_OBJECT, {x: 1});
            Onyx.merge(KEYS.OBJECT, {b: 1});
            await Onyx.merge(KEYS.OTHER_OBJECT, {y: 1});
            await flush();

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: 1});
            expect(cache.get(KEYS.OTHER_OBJECT)).toStrictEqual({x: 1, y: 1});
            expect(objectRecorder.values()).toStrictEqual([{a: 1, b: 1}]);
            expect(otherRecorder.values()).toStrictEqual([{x: 1, y: 1}]);
            await expectStorageToMatchCache(KEYS.OBJECT);
            await expectStorageToMatchCache(KEYS.OTHER_OBJECT);
        });

        it('starts a new batch after the previous one resolved', async () => {
            const recorder = await recordFromNow(KEYS.OBJECT);

            await Onyx.merge(KEYS.OBJECT, {a: 1});
            await Onyx.merge(KEYS.OBJECT, {b: 1});

            expect(recorder.values()).toStrictEqual([{a: 1}, {a: 1, b: 1}]);
        });
    });

    describe('ordering with Onyx.set', () => {
        it('applies a merge on top of a set made earlier in the same tick', async () => {
            await Onyx.set(KEYS.OBJECT, {old: 1});

            Onyx.set(KEYS.OBJECT, {a: 1});
            await Onyx.merge(KEYS.OBJECT, {b: 1});
            await flush();

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: 1});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('drops a pending merge when a set follows it in the same tick', async () => {
            await Onyx.set(KEYS.OBJECT, {old: 1});
            const recorder = await recordFromNow(KEYS.OBJECT);

            const mergePromise = Onyx.merge(KEYS.OBJECT, {merged: 1});
            await Onyx.set(KEYS.OBJECT, {set: 1});
            await mergePromise;
            await flush();

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({set: 1});
            expect(recorder.values()).toStrictEqual([{set: 1}]);
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('applies only the merge made after a set when merge, set, merge run in one tick', async () => {
            await Onyx.set(KEYS.OBJECT, {old: 1});

            Onyx.merge(KEYS.OBJECT, {first: 1});
            Onyx.set(KEYS.OBJECT, {set: 1});
            await Onyx.merge(KEYS.OBJECT, {second: 1});
            await flush();

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({set: 1, second: 1});
            await expectStorageToMatchCache(KEYS.OBJECT);
        });
    });

    describe('changes Onyx rejects or ignores', () => {
        it('returns the pending batch promise for a top-level undefined and changes nothing', async () => {
            await Onyx.set(KEYS.OBJECT, {a: 1});
            const recorder = await recordFromNow(KEYS.OBJECT);

            const pending = Onyx.merge(KEYS.OBJECT, {b: 1});
            const ignored = Onyx.merge(KEYS.OBJECT, undefined);
            expect(ignored).toBe(pending);
            await ignored;
            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: 1});

            recorder.reset();
            const writesBefore = storageWriteCallCount();
            await Onyx.merge(KEYS.OBJECT, undefined);
            await flush();
            expect(recorder.values()).toStrictEqual([]);
            expect(storageWriteCallCount()).toBe(writesBefore);
        });

        it('skips an array merged into an object and logs an alert, keeping compatible changes of the same batch', async () => {
            await Onyx.set(KEYS.OBJECT, {a: 1});

            Onyx.merge(KEYS.OBJECT, [1, 2]);
            await Onyx.merge(KEYS.OBJECT, {b: 1});

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: 1});
            expect(alertMessages().some((message) => message.includes(KEYS.OBJECT))).toBe(true);
            await expectStorageToMatchCache(KEYS.OBJECT);
        });

        it('skips an object merged into a non-empty array without notifying or writing', async () => {
            await Onyx.set(KEYS.ARRAY, [1]);
            const recorder = await recordFromNow(KEYS.ARRAY);
            const writesBefore = storageWriteCallCount();

            await Onyx.merge(KEYS.ARRAY, {a: 1});
            await flush();

            expect(cache.get(KEYS.ARRAY)).toStrictEqual([1]);
            expect(recorder.values()).toStrictEqual([]);
            expect(storageWriteCallCount()).toBe(writesBefore);
            expect(alertMessages().some((message) => message.includes(KEYS.ARRAY))).toBe(true);
        });

        it('coerces an empty array into an object and logs the bugbot alert', async () => {
            await Onyx.set(KEYS.ARRAY, []);

            await Onyx.merge(KEYS.ARRAY, {a: 1});

            expect(cache.get(KEYS.ARRAY)).toStrictEqual({a: 1});
            expect(alertMessages().some((message) => message.includes('[ENSURE_BUGBOT]'))).toBe(true);
            await expectStorageToMatchCache(KEYS.ARRAY);
        });

        it('ignores every merge into a skippable collection member', async () => {
            const skippableKey = `${KEYS.COLLECTION.TEST}${SKIPPABLE_MEMBER_ID}`;
            const recorder = await recordFromNow(KEYS.COLLECTION.TEST);
            const writesBefore = storageWriteCallCount();

            await Onyx.merge(skippableKey, {a: 1});
            await flush();

            expect(cache.get(skippableKey)).toBeUndefined();
            expect(recorder.values()).toStrictEqual([]);
            expect(storageWriteCallCount()).toBe(writesBefore);
            expect(await readStored(skippableKey)).toBeNull();
        });
    });

    describe('unchanged merges', () => {
        it('does not re-deliver undefined for a second null once a merge has removed the key', async () => {
            await Onyx.set(KEYS.OBJECT, {a: 1});
            const recorder = await recordFromNow(KEYS.OBJECT);

            await Onyx.merge(KEYS.OBJECT, null);
            await flush();
            await Onyx.merge(KEYS.OBJECT, null);
            await flush();

            expect(recorder.values()).toStrictEqual([undefined]);
        });

        it('neither notifies nor writes nor replaces the cached reference when nothing changes', async () => {
            await Onyx.set(KEYS.OBJECT, {a: 1, b: {c: 1}, list: [1, 2]});
            const recorder = await recordFromNow(KEYS.OBJECT);
            const cachedBefore = cache.get(KEYS.OBJECT);
            const writesBefore = storageWriteCallCount();

            await Onyx.merge(KEYS.OBJECT, {a: 1});
            await Onyx.merge(KEYS.OBJECT, {b: {c: 1}});
            await Onyx.merge(KEYS.OBJECT, {list: [1, 2]});
            await Onyx.merge(KEYS.OBJECT, {});
            await Onyx.merge(KEYS.OBJECT, {missing: null});
            await Onyx.merge(KEYS.OBJECT, {b: {missing: null}});
            await flush();

            expect(recorder.values()).toStrictEqual([]);
            expect(storageWriteCallCount()).toBe(writesBefore);
            expect(cache.get(KEYS.OBJECT)).toBe(cachedBefore);
        });

        it('treats a batch that changes and then restores a value as unchanged', async () => {
            await Onyx.set(KEYS.OBJECT, {a: 1});
            const recorder = await recordFromNow(KEYS.OBJECT);
            const writesBefore = storageWriteCallCount();

            Onyx.merge(KEYS.OBJECT, {a: 2});
            await Onyx.merge(KEYS.OBJECT, {a: 1});
            await flush();

            expect(recorder.values()).toStrictEqual([]);
            expect(storageWriteCallCount()).toBe(writesBefore);
        });

        it('does not notify for an unchanged primitive', async () => {
            await Onyx.set(KEYS.STRING, 'same');
            const recorder = await recordFromNow(KEYS.STRING);
            const writesBefore = storageWriteCallCount();

            await Onyx.merge(KEYS.STRING, 'same');
            await flush();

            expect(recorder.values()).toStrictEqual([]);
            expect(storageWriteCallCount()).toBe(writesBefore);
        });

        it('does not deliver anything but undefined for a null merged into a key that does not exist', async () => {
            const recorder = await recordFromNow(KEYS.OBJECT);

            await Onyx.merge(KEYS.OBJECT, null);
            await flush();

            expect(recorder.values().length).toBeLessThanOrEqual(1);
            expect(recorder.values().every((value) => value === undefined)).toBe(true);
            expect(cache.get(KEYS.OBJECT)).toBeUndefined();
            expect(await readStored(KEYS.OBJECT)).toBeNull();
        });
    });

    describe('references and mutation', () => {
        it('keeps the references of untouched nested objects and gives changed ones new references', async () => {
            await Onyx.set(KEYS.OBJECT, {a: {x: 1}, b: {y: 1}, c: {z: {deep: 1}, w: 1}});
            const before = cache.get(KEYS.OBJECT) as {a: object; b: object; c: {z: object}};

            await Onyx.merge(KEYS.OBJECT, {a: {x: 2}, c: {w: 2}});
            const after = cache.get(KEYS.OBJECT) as {a: object; b: object; c: {z: object}};

            expect(after).not.toBe(before);
            expect(after.a).not.toBe(before.a);
            expect(after.c).not.toBe(before.c);
            expect(after.b).toBe(before.b);
            expect(after.c.z).toBe(before.c.z);
        });

        it('keeps the references of nested objects that a patch restates with equal values', async () => {
            await Onyx.set(KEYS.OBJECT, {a: {x: 1}, b: {y: 1, z: {deep: 1}}, c: {w: 1}});
            const before = cache.get(KEYS.OBJECT) as {a: object; b: {z: object}; c: object};

            await Onyx.merge(KEYS.OBJECT, {a: {x: 2}, b: {y: 1, z: {deep: 1}}, c: {w: 1}});
            const after = cache.get(KEYS.OBJECT) as {a: object; b: {z: object}; c: object};

            expect(after).toStrictEqual({a: {x: 2}, b: {y: 1, z: {deep: 1}}, c: {w: 1}});
            expect(after.a).not.toBe(before.a);
            expect(after.b).toBe(before.b);
            expect(after.b.z).toBe(before.b.z);
            expect(after.c).toBe(before.c);
        });

        it('delivers the cached reference to every subscriber of the key', async () => {
            const first = await recordFromNow(KEYS.OBJECT);
            const second = await recordFromNow(KEYS.OBJECT);

            await Onyx.merge(KEYS.OBJECT, {a: {b: 1}});

            expect(first.values().at(-1)).toBe(cache.get(KEYS.OBJECT));
            expect(second.values().at(-1)).toBe(cache.get(KEYS.OBJECT));
        });

        it('never mutates frozen inputs, the previous value or previously delivered values', async () => {
            const initial = deepFreeze({a: {b: 1, list: [1]}, c: {d: {e: 1}}});
            await Onyx.set(KEYS.OBJECT, initial);
            const recorder = await recordFromNow(KEYS.OBJECT);
            const previous = cache.get(KEYS.OBJECT);
            const previousSnapshot = JSON.stringify(previous);

            const patches = [deepFreeze({a: {b: 2, list: [2]}}), deepFreeze({c: {d: null}}), deepFreeze({c: {d: {f: 1}}}), deepFreeze({g: {h: null, i: 1}})];
            for (const patch of patches) {
                Onyx.merge(KEYS.OBJECT, patch);
            }
            await Onyx.merge(KEYS.OBJECT, {a: {extra: 1}});
            await Onyx.merge(KEYS.OBJECT, {c: null});

            expect(JSON.stringify(previous)).toBe(previousSnapshot);
            expect(initial).toStrictEqual({a: {b: 1, list: [1]}, c: {d: {e: 1}}});
            expect(recorder.values()).toStrictEqual([
                {a: {b: 2, list: [2], extra: 1}, c: {d: {f: 1}}, g: {i: 1}},
                {a: {b: 2, list: [2], extra: 1}, g: {i: 1}},
            ]);
        });

        it('does not let a caller mutate the cache through a nested object of the patch it merged', async () => {
            const patch = {a: {b: 1}, list: [1]};
            await Onyx.merge(KEYS.OBJECT, patch);

            patch.a.b = 99;

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: {b: 1}, list: [1]});
        });
    });

    describe('subscribers', () => {
        it('notifies only the matching collection when collection keys share a prefix', async () => {
            const twin = await recordFromNow(KEYS.PREFIX_TWIN);
            const collection = await recordFromNow(KEYS.COLLECTION.TEST);
            const policies = await recordFromNow(KEYS.COLLECTION.TEST_POLICY);
            const nested = await recordFromNow(KEYS.COLLECTION.NESTED);

            await Onyx.merge(MEMBER_1, {a: 1});
            expect(collection.values()).toStrictEqual([{[MEMBER_1]: {a: 1}}]);
            expect(twin.values()).toStrictEqual([]);
            expect(policies.values()).toStrictEqual([]);
            expect(nested.values()).toStrictEqual([]);

            collection.reset();
            await Onyx.merge(KEYS.PREFIX_TWIN, {a: 1});
            await Onyx.merge(`${KEYS.COLLECTION.TEST_POLICY}1`, {a: 1});
            expect(twin.values()).toStrictEqual([{a: 1}]);
            expect(policies.values()).toStrictEqual([{[`${KEYS.COLLECTION.TEST_POLICY}1`]: {a: 1}}]);
            expect(collection.values()).toStrictEqual([]);
        });

        it('delivers a nested collection member to the longest matching collection only', async () => {
            const collection = await recordFromNow(KEYS.COLLECTION.TEST);
            const nested = await recordFromNow(KEYS.COLLECTION.NESTED);
            const nestedMember = `${KEYS.COLLECTION.NESTED}1`;

            await Onyx.merge(nestedMember, {a: 1});

            expect(nested.values()).toStrictEqual([{[nestedMember]: {a: 1}}]);
            expect(collection.values()).toStrictEqual([]);
        });

        it('notifies a member subscriber and gives the collection a new snapshot that keeps untouched members', async () => {
            await Onyx.merge(MEMBER_2, {b: 1});
            const member = await recordFromNow(MEMBER_1);
            const otherMember = await recordFromNow(MEMBER_2);
            const collection = await recordFromNow(KEYS.COLLECTION.TEST);
            const untouched = cache.get(MEMBER_2);

            await Onyx.merge(MEMBER_1, {a: 1});

            expect(member.values()).toStrictEqual([{a: 1}]);
            expect(otherMember.values()).toStrictEqual([]);
            const snapshot = collection.values().at(-1) as Record<string, unknown>;
            expect(snapshot).toStrictEqual({[MEMBER_1]: {a: 1}, [MEMBER_2]: {b: 1}});
            expect(snapshot[MEMBER_2]).toBe(untouched);
            expect(snapshot[MEMBER_1]).toBe(cache.get(MEMBER_1));
        });

        it('removes a member from the collection snapshot when it is merged with null', async () => {
            await Onyx.merge(MEMBER_1, {a: 1});
            await Onyx.merge(MEMBER_2, {b: 1});
            const collection = await recordFromNow(KEYS.COLLECTION.TEST);

            await Onyx.merge(MEMBER_1, null);

            expect(collection.values().at(-1)).toStrictEqual({[MEMBER_2]: {b: 1}});
            await expectStorageToMatchCache(MEMBER_1);
        });

        it('does not notify the collection when a member merge changes nothing', async () => {
            await Onyx.merge(MEMBER_1, {a: 1});
            const collection = await recordFromNow(KEYS.COLLECTION.TEST);

            await Onyx.merge(MEMBER_1, {a: 1});
            await flush();

            expect(collection.values()).toStrictEqual([]);
        });

        it('applies a merge made from inside a subscriber callback after the value that triggered it', async () => {
            const deliveries: unknown[] = [];
            const connection = Onyx.connect({
                key: KEYS.OBJECT,
                callback: (value) => {
                    deliveries.push(value);
                    if (value && !('b' in value)) {
                        Onyx.merge(KEYS.OBJECT, {b: 1});
                        Onyx.merge(KEYS.OTHER_OBJECT, {fromCallback: true});
                    }
                },
            });
            await flush();
            deliveries.length = 0;

            await Onyx.merge(KEYS.OBJECT, {a: 1});
            await flush();
            await flush();

            expect(cache.get(KEYS.OBJECT)).toStrictEqual({a: 1, b: 1});
            expect(cache.get(KEYS.OTHER_OBJECT)).toStrictEqual({fromCallback: true});
            expect(deliveries).toStrictEqual([{a: 1}, {a: 1, b: 1}]);
            await expectStorageToMatchCache(KEYS.OBJECT);
            Onyx.disconnect(connection);
        });
    });

    describe('RAM-only keys', () => {
        it('merges in the cache and notifies without ever writing to storage', async () => {
            const ramMember = `${KEYS.COLLECTION.RAM_ONLY}1`;
            const recorder = await recordFromNow(KEYS.RAM_ONLY);
            const writesBefore = storageWriteCallCount();

            await Onyx.merge(KEYS.RAM_ONLY, {a: 1});
            await Onyx.merge(KEYS.RAM_ONLY, {b: {c: 1}});
            await Onyx.merge(ramMember, {a: 1});
            await Onyx.merge(KEYS.RAM_ONLY, null);
            await Onyx.merge(ramMember, {a: 2});
            await flush();

            expect(recorder.values()).toStrictEqual([{a: 1}, {a: 1, b: {c: 1}}, undefined]);
            expect(cache.get(ramMember)).toStrictEqual({a: 2});
            expect(storageWriteCallCount()).toBe(writesBefore);
            expect(await readStored(KEYS.RAM_ONLY)).toBeNull();
            expect(await readStored(ramMember)).toBeNull();
        });
    });
});

/** Each case lists what the web and the native variant produce today; the storage values are what SQLite holds afterwards. */
type DivergenceCase = {
    name: string;
    initial: unknown;
    changes: unknown[];
    cache: Record<MergeVariant, unknown>;
    storage: Record<MergeVariant, unknown>;
};

const SUSPECTED_BUG_CASES: DivergenceCase[] = [
    {
        name: 'native storage keeps the old properties when a top-level null and an object share a batch',
        initial: {a: 1, keep: 1},
        changes: [null, {b: 1}],
        cache: {web: {b: 1}, native: {b: 1}},
        storage: {web: {b: 1}, native: {a: 1, keep: 1, b: 1}},
    },
    {
        name: 'native storage drops later objects merged after a nested null in the same batch',
        initial: {a: {old: 1}},
        changes: [{a: null}, {a: {x: 1}}, {a: {y: 2}}],
        cache: {web: {a: {x: 1, y: 2}}, native: {a: {x: 1, y: 2}}},
        storage: {web: {a: {x: 1, y: 2}}, native: {a: {x: 1}}},
    },
    {
        name: 'native storage keeps the first replacement object when a later change writes an array to the same path',
        initial: {a: {old: 1}},
        changes: [{a: null}, {a: {x: 1}}, {a: [1]}],
        cache: {web: {a: [1]}, native: {a: [1]}},
        storage: {web: {a: [1]}, native: {a: {x: 1}}},
    },
    {
        name: 'native keeps nested nulls, in the cache and in storage, inside an object that replaces a nulled property',
        initial: {a: {old: 1}},
        changes: [{a: null}, {a: {b: null, c: 1}}],
        cache: {web: {a: {c: 1}}, native: {a: {b: null, c: 1}}},
        storage: {web: {a: {c: 1}}, native: {a: {b: null, c: 1}}},
    },
    {
        name: 'native storage keeps nested nulls from the first merge into a key with no stored row',
        initial: undefined,
        changes: [{a: 1, b: null, c: {d: null, e: 1}}],
        cache: {web: {a: 1, c: {e: 1}}, native: {a: 1, c: {e: 1}}},
        storage: {web: {a: 1, c: {e: 1}}, native: {a: 1, b: null, c: {d: null, e: 1}}},
    },
    {
        name: 'native merges into the old nested object when a primitive and then an object are written to it in one batch',
        initial: {p: {old: 1}},
        changes: [{p: 5}, {p: {y: 1}}],
        cache: {web: {p: {y: 1}}, native: {p: {old: 1, y: 1}}},
        storage: {web: {p: {y: 1}}, native: {p: {old: 1, y: 1}}},
    },
    {
        name: 'native keeps the old value when a top-level primitive and then an object share a batch',
        initial: {a: 1},
        changes: ['text', {b: 1}],
        cache: {web: {b: 1}, native: {a: 1, b: 1}},
        storage: {web: {b: 1}, native: {a: 1, b: 1}},
    },
];

describe('current behaviour (suspected bug)', () => {
    beforeAll(initOnyxForMergeContracts);

    it('re-delivers undefined when a null is merged into a key that is already absent', async () => {
        const recorder = await recordFromNow(KEYS.OBJECT);

        await Onyx.merge(KEYS.OBJECT, null);
        await flush();

        expect(recorder.values()).toStrictEqual([undefined]);
    });

    afterEach(async () => {
        disconnectAll();
        await Onyx.clear();
        await flush();
    });

    describe.each(MERGE_VARIANTS)('%s OnyxMerge', (variant: MergeVariant) => {
        beforeEach(() => setMergeVariant(variant));

        it.each(SUSPECTED_BUG_CASES)('$name', async ({initial, changes, cache: expectedCache, storage: expectedStorage}) => {
            if (initial !== undefined) {
                await Onyx.set(KEYS.OBJECT, initial);
            }

            await Promise.all(changes.map((change) => Onyx.merge(KEYS.OBJECT, change)));
            await flush();

            expect(cache.get(KEYS.OBJECT)).toStrictEqual(expectedCache[variant]);
            expect(await readStored(KEYS.OBJECT)).toStrictEqual(expectedStorage[variant]);
        });
    });
});
