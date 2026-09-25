import type {SharedProvider, SyncBus, Tab} from './syncHarness';
import {KEYS, createSyncBus, openTab, readShared, record, resetSharedStorage, settle, spyOnSharedWrites} from './syncHarness';

let provider: SharedProvider;
let bus: SyncBus;
let tab: Tab;

beforeEach(async () => {
    provider = resetSharedStorage();
    bus = createSyncBus();
    tab = await openTab({ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.COLLECTION.RAM_ONLY]});
    bus.drain();
});

afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
});

/** Connects after `await settle()` so each recorder starts with its initial delivery already counted. */
async function recordSettled(key: string) {
    const recorder = record(tab, key);
    await settle();
    return {recorder, calls: () => recorder.values.length, start: recorder.values.length};
}

describe('Onyx.init instance sync handler', () => {
    describe('plain keys', () => {
        it('puts the remote value in the cache and notifies the key subscriber with it', async () => {
            const plain = await recordSettled(KEYS.PLAIN);

            tab.applyRemote([[KEYS.PLAIN, 'remote']]);

            expect(tab.cache.get(KEYS.PLAIN)).toBe('remote');
            expect(plain.recorder.values.slice(plain.start)).toEqual(['remote']);
            expect(plain.recorder.keys.at(-1)).toBe(KEYS.PLAIN);
        });

        it('notifies synchronously, within the handler call', async () => {
            const plain = await recordSettled(KEYS.PLAIN);
            const member = await recordSettled('test_1');

            tab.applyRemote([
                [KEYS.PLAIN, 'remote'],
                ['test_1', {id: 1}],
            ]);

            expect(plain.calls()).toBeGreaterThan(plain.start);
            expect(member.calls()).toBeGreaterThan(member.start);
        });

        it('does not notify again when the same primitive is applied twice', async () => {
            await tab.Onyx.set(KEYS.PLAIN, 'same');
            const plain = await recordSettled(KEYS.PLAIN);

            tab.applyRemote([[KEYS.PLAIN, 'same']]);
            await settle();
            const afterFirst = plain.calls();
            tab.applyRemote([[KEYS.PLAIN, 'same']]);
            await settle();

            expect(afterFirst - plain.start).toBeLessThanOrEqual(1);
            expect(plain.calls()).toBe(afterFirst);
            expect(plain.recorder.values.at(-1)).toBe('same');
        });

        it('does not notify for a remote value equal to the one a local write already delivered', async () => {
            const plain = await recordSettled(KEYS.PLAIN);
            await tab.Onyx.set(KEYS.PLAIN, 'same');
            await settle();
            const afterLocal = plain.calls();

            tab.applyRemote([[KEYS.PLAIN, 'same']]);
            await settle();

            expect(plain.calls()).toBe(afterLocal);
        });

        it('notifies each plain key of the batch with its own value', async () => {
            const plain = await recordSettled(KEYS.PLAIN);
            const other = await recordSettled(KEYS.OTHER);
            const object = await recordSettled(KEYS.OBJECT);

            tab.applyRemote([
                [KEYS.PLAIN, 'p'],
                [KEYS.OTHER, 0],
                [KEYS.OBJECT, {nested: {deep: true}}],
            ]);

            expect(plain.recorder.values.slice(plain.start)).toEqual(['p']);
            expect(other.recorder.values.slice(other.start)).toEqual([0]);
            expect(object.recorder.values.slice(object.start)).toEqual([{nested: {deep: true}}]);
        });

        it('removes a plain key applied as undefined', async () => {
            await tab.Onyx.set(KEYS.PLAIN, 'local');
            const plain = await recordSettled(KEYS.PLAIN);

            tab.applyRemote([[KEYS.PLAIN, undefined]]);

            expect(tab.cache.get(KEYS.PLAIN) ?? undefined).toBeUndefined();
            expect(plain.recorder.values.slice(plain.start)).toEqual([undefined]);
        });

        it('updates what the key last delivered, so a later local write of the old value notifies again', async () => {
            await tab.Onyx.set(KEYS.PLAIN, 'x');
            const plain = await recordSettled(KEYS.PLAIN);

            tab.applyRemote([[KEYS.PLAIN, 'y']]);
            await tab.Onyx.set(KEYS.PLAIN, 'x');
            await settle();

            expect(plain.recorder.values.slice(plain.start)).toEqual(['y', 'x']);
        });

        it('serves the applied value to a later connection from the cache, not from storage', async () => {
            await provider.setItem<string>(KEYS.PLAIN, 'stale in storage');

            tab.applyRemote([[KEYS.PLAIN, 'remote']]);
            const late = record(tab, KEYS.PLAIN);
            await settle();

            expect(late.values).toEqual(['remote']);
        });
    });

    describe('collection members', () => {
        it('notifies the member subscriber and the collection subscriber', async () => {
            await tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}});
            const member = await recordSettled('test_2');
            const collection = await recordSettled(KEYS.COLLECTION.TEST);

            tab.applyRemote([['test_2', {id: 2}]]);

            expect(tab.cache.get('test_2')).toEqual({id: 2});
            expect(member.recorder.values.slice(member.start)).toEqual([{id: 2}]);
            expect(member.recorder.keys.at(-1)).toBe('test_2');
            expect(collection.recorder.values.at(-1)).toEqual({test_1: {id: 1}, test_2: {id: 2}});
            expect(collection.recorder.keys.at(-1)).toBe(KEYS.COLLECTION.TEST);
        });

        it('notifies the collection subscriber exactly once for a batch of many members', async () => {
            const collection = await recordSettled(KEYS.COLLECTION.TEST);
            const pairs: Array<[string, {id: number}]> = Array.from({length: 25}, (unused, index) => [`test_${index}`, {id: index}]);

            tab.applyRemote(pairs);
            await settle();

            expect(collection.calls() - collection.start).toBe(1);
            expect(collection.recorder.values.at(-1)).toEqual(Object.fromEntries(pairs));
        });

        it('keeps untouched members by reference in the collection snapshot', async () => {
            await tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}, test_2: {id: 2}});
            const untouched = tab.cache.get('test_1');
            const collection = await recordSettled(KEYS.COLLECTION.TEST);

            tab.applyRemote([['test_2', {id: 22}]]);

            const snapshot = collection.recorder.values.at(-1);
            expect(snapshot).toEqual({test_1: {id: 1}, test_2: {id: 22}});
            expect(typeof snapshot === 'object' && snapshot !== null && 'test_1' in snapshot ? snapshot.test_1 : undefined).toBe(untouched);
        });

        it('does not notify member subscribers whose member the batch did not change', async () => {
            await tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}, test_2: 'two'});
            const untouched = await recordSettled('test_1');
            const sameValue = await recordSettled('test_2');
            const changed = await recordSettled('test_3');

            tab.applyRemote([
                ['test_2', 'two'],
                ['test_3', {id: 3}],
            ]);
            await settle();

            expect(untouched.calls()).toBe(untouched.start);
            expect(sameValue.calls()).toBe(sameValue.start);
            expect(changed.recorder.values.slice(changed.start)).toEqual([{id: 3}]);
        });

        it.each([
            ['undefined', undefined],
            ['null', null],
        ])('removes a member applied as %s and delivers undefined to its subscriber', async (name, removed) => {
            await tab.Onyx.mergeCollection(KEYS.COLLECTION.TEST, {test_1: {id: 1}, test_2: {id: 2}});
            const member = await recordSettled('test_1');
            const collection = await recordSettled(KEYS.COLLECTION.TEST);

            tab.applyRemote([['test_1', removed]]);

            expect(tab.cache.get('test_1') ?? undefined).toBeUndefined();
            expect(member.recorder.values.slice(member.start)).toEqual([undefined]);
            expect(collection.recorder.values.at(-1)).toEqual({test_2: {id: 2}});
        });

        it('notifies the collection subscriber at most once when no member of the batch changed', async () => {
            await tab.Onyx.set('test_1', 'same');
            const collection = await recordSettled(KEYS.COLLECTION.TEST);

            tab.applyRemote([['test_1', 'same']]);
            await settle();

            expect(collection.calls() - collection.start).toBeLessThanOrEqual(1);
            expect(collection.recorder.values.at(-1)).toEqual({test_1: 'same'});
        });

        it('notifies nobody for a member that was absent and stays absent', async () => {
            const member = await recordSettled('test_1');

            tab.applyRemote([['test_1', null]]);
            await settle();

            expect(member.calls()).toBe(member.start);
        });

        it('includes an applied member in a collection connection made later', async () => {
            tab.applyRemote([['test_9', {id: 9}]]);
            const late = record(tab, KEYS.COLLECTION.TEST);
            const lateMember = record(tab, 'test_9');
            await settle();

            expect(late.values.at(-1)).toEqual({test_9: {id: 9}});
            expect(lateMember.values).toEqual([{id: 9}]);
        });

        it('updates what a member last delivered, so a later local write of the old value notifies again', async () => {
            await tab.Onyx.set('test_1', 'x');
            const member = await recordSettled('test_1');

            tab.applyRemote([['test_1', 'y']]);
            await tab.Onyx.set('test_1', 'x');
            await settle();

            expect(member.recorder.values.slice(member.start)).toEqual(['y', 'x']);
        });
    });

    describe('duplicates in one batch', () => {
        it('ends with the last value of a member listed twice', async () => {
            const member = await recordSettled('test_1');
            const collection = await recordSettled(KEYS.COLLECTION.TEST);

            tab.applyRemote([
                ['test_1', 'first'],
                ['test_1', 'last'],
            ]);
            await settle();

            expect(tab.cache.get('test_1')).toBe('last');
            expect(member.recorder.values.at(-1)).toBe('last');
            expect(member.calls() - member.start).toBe(1);
            expect(collection.recorder.values.at(-1)).toEqual({test_1: 'last'});
            expect(collection.calls() - collection.start).toBe(1);
        });

        it('does not notify a member whose value ends where it started', async () => {
            await tab.Onyx.set('test_1', 'original');
            const member = await recordSettled('test_1');

            tab.applyRemote([
                ['test_1', 'interim'],
                ['test_1', 'original'],
            ]);
            await settle();

            expect(tab.cache.get('test_1')).toBe('original');
            expect(member.calls()).toBe(member.start);
        });

        it('ends with the last value of a plain key listed twice', async () => {
            const plain = await recordSettled(KEYS.PLAIN);

            tab.applyRemote([
                [KEYS.PLAIN, 'first'],
                [KEYS.PLAIN, 'last'],
            ]);
            await settle();

            expect(tab.cache.get(KEYS.PLAIN)).toBe('last');
            expect(plain.recorder.values.at(-1)).toBe('last');
            expect(plain.calls() - plain.start).toBeLessThanOrEqual(2);
        });
    });

    describe('prefix-colliding collections', () => {
        it('groups a member under its longest matching collection key only', async () => {
            const test = await recordSettled(KEYS.COLLECTION.TEST);
            const level = await recordSettled(KEYS.COLLECTION.TEST_LEVEL);

            tab.applyRemote([['test_level_1', {id: 1}]]);
            await settle();

            expect(level.recorder.values.at(-1)).toEqual({test_level_1: {id: 1}});
            expect(level.calls() - level.start).toBe(1);
            expect(test.calls()).toBe(test.start);
            expect(tab.OnyxUtils.getCachedCollection(KEYS.COLLECTION.TEST)).toEqual({});
        });

        it('notifies each collection once for a batch that mixes both', async () => {
            const test = await recordSettled(KEYS.COLLECTION.TEST);
            const level = await recordSettled(KEYS.COLLECTION.TEST_LEVEL);

            tab.applyRemote([
                ['test_1', {id: 1}],
                ['test_level_1', {id: 2}],
                ['test_2', {id: 3}],
                ['test_level_2', {id: 4}],
            ]);
            await settle();

            expect(test.calls() - test.start).toBe(1);
            expect(level.calls() - level.start).toBe(1);
            expect(test.recorder.values.at(-1)).toEqual({test_1: {id: 1}, test_2: {id: 3}});
            expect(level.recorder.values.at(-1)).toEqual({test_level_1: {id: 2}, test_level_2: {id: 4}});
        });

        it('treats a key that only shares a prefix with no collection as a plain key', async () => {
            const nvp = await recordSettled(KEYS.NVP);
            const test = await recordSettled(KEYS.COLLECTION.TEST);

            tab.applyRemote([[KEYS.NVP, 'nvp']]);
            await settle();

            expect(nvp.recorder.values.slice(nvp.start)).toEqual(['nvp']);
            expect(test.calls()).toBe(test.start);
        });
    });

    describe('RAM-only keys', () => {
        it('ignores remote values for RAM-only keys and members of RAM-only collections', async () => {
            await tab.Onyx.set(KEYS.RAM_ONLY, 'local');
            await tab.Onyx.mergeCollection(KEYS.COLLECTION.RAM_ONLY, {ramCollection_1: {id: 'local'}});
            const ram = await recordSettled(KEYS.RAM_ONLY);
            const ramMember = await recordSettled('ramCollection_1');
            const ramCollection = await recordSettled(KEYS.COLLECTION.RAM_ONLY);
            const plain = await recordSettled(KEYS.PLAIN);

            tab.applyRemote([
                [KEYS.RAM_ONLY, 'stale'],
                ['ramCollection_1', {id: 'stale'}],
                ['ramCollection_2', {id: 'stale'}],
                [KEYS.PLAIN, 'applied'],
            ]);
            await settle();

            expect(tab.cache.get(KEYS.RAM_ONLY)).toBe('local');
            expect(tab.cache.get('ramCollection_1')).toEqual({id: 'local'});
            expect(tab.cache.get('ramCollection_2')).toBeUndefined();
            expect(ram.calls()).toBe(ram.start);
            expect(ramMember.calls()).toBe(ramMember.start);
            expect(ramCollection.calls()).toBe(ramCollection.start);
            expect(plain.recorder.values.at(-1)).toBe('applied');
        });
    });

    describe('side effects', () => {
        it('does not write to storage or raise a sync event', async () => {
            await tab.Onyx.multiSet({[KEYS.PLAIN]: 'local', test_1: {id: 1}});
            await settle();
            bus.drain();
            record(tab, KEYS.PLAIN);
            record(tab, KEYS.COLLECTION.TEST);
            await settle();
            const stored = readShared();
            const writes = spyOnSharedWrites();

            tab.applyRemote([
                [KEYS.PLAIN, 'remote'],
                [KEYS.OTHER, null],
                ['test_1', null],
                ['test_2', {id: 2}],
                ['test_level_1', {id: 3}],
            ]);
            await settle();

            expect(writes.count()).toBe(0);
            expect(bus.drain()).toEqual([]);
            expect(readShared()).toEqual(stored);
        });

        it('notifies nobody for an empty batch', async () => {
            const plain = await recordSettled(KEYS.PLAIN);
            const collection = await recordSettled(KEYS.COLLECTION.TEST);

            tab.applyRemote([]);
            await settle();

            expect(plain.calls()).toBe(plain.start);
            expect(collection.calls()).toBe(collection.start);
        });

        it('lets a subscriber write while it is being notified and still delivers the rest of the batch', async () => {
            const plainValues: unknown[] = [];
            tab.Onyx.connect({
                key: KEYS.PLAIN,
                callback: (value) => {
                    plainValues.push(value);
                    if (Object.is(value, 'remote')) {
                        tab.Onyx.set(KEYS.OTHER, 'derived');
                    }
                },
            });
            const member = await recordSettled('test_1');
            const other = await recordSettled(KEYS.OTHER);
            bus.drain();

            tab.applyRemote([
                [KEYS.PLAIN, 'remote'],
                ['test_1', {id: 1}],
            ]);
            await settle();

            expect(plainValues.at(-1)).toBe('remote');
            expect(member.recorder.values.at(-1)).toEqual({id: 1});
            expect(other.recorder.values.at(-1)).toBe('derived');
            expect(readShared()).toEqual({[KEYS.OTHER]: 'derived'});
            expect(bus.drain()).toEqual([KEYS.OTHER]);
        });

        it('lets a local write that follows the batch win over the applied value', async () => {
            const plain = await recordSettled(KEYS.PLAIN);

            tab.applyRemote([[KEYS.PLAIN, 'remote']]);
            await tab.Onyx.set(KEYS.PLAIN, 'local');
            await settle();

            expect(tab.cache.get(KEYS.PLAIN)).toBe('local');
            expect(plain.recorder.values.at(-1)).toBe('local');
        });

        it('keeps delivering when one subscriber throws', async () => {
            tab.Onyx.connect({
                key: KEYS.COLLECTION.TEST,
                callback: () => {
                    throw new Error('subscriber failed');
                },
            });
            await settle();
            const member = await recordSettled('test_1');
            const collection = await recordSettled(KEYS.COLLECTION.TEST);

            tab.applyRemote([['test_1', {id: 1}]]);
            await settle();

            expect(member.recorder.values.at(-1)).toEqual({id: 1});
            expect(collection.recorder.values.at(-1)).toEqual({test_1: {id: 1}});
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('delivers null, not undefined, to a plain key subscriber when the remote value is null', async () => {
            await tab.Onyx.set(KEYS.PLAIN, 'local');
            const plain = await recordSettled(KEYS.PLAIN);

            tab.applyRemote([[KEYS.PLAIN, null]]);

            expect(plain.recorder.values.slice(plain.start)).toEqual([null]);
        });

        it('delivers undefined for the same removal made locally, so the two paths disagree', async () => {
            await tab.Onyx.set(KEYS.PLAIN, 'local');
            const plain = await recordSettled(KEYS.PLAIN);

            await tab.Onyx.set(KEYS.PLAIN, null);
            await settle();

            expect(plain.recorder.values.slice(plain.start)).toEqual([undefined]);
        });
    });
});
