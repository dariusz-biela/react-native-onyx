import type {LoadedOnyx, ProviderName} from './harness';
import {flush, loadOnyx, ONYX_KEYS} from './harness';
import type {OnyxKey} from '../../../../lib/types';

const BACKENDS: ProviderName[] = ['MemoryOnlyProvider', 'IDBKeyValProvider'];
const REPORT_1 = `${ONYX_KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${ONYX_KEYS.COLLECTION.REPORT}2`;
const REPORT_META_1 = `${ONYX_KEYS.COLLECTION.REPORT_META}1`;
const RAM_ONLY = 'ramOnly';
const PLAIN: OnyxKey = ONYX_KEYS.PLAIN;

/** Everything the backing store holds, read around Onyx through the provider. */
async function persisted({platformProvider}: LoadedOnyx): Promise<Record<string, unknown>> {
    return Object.fromEntries(await platformProvider.getAll());
}

/** Flushes until the condition holds, so storage engines with more internal hops still settle deterministically. */
async function flushUntil(condition: () => boolean, rounds = 50): Promise<void> {
    for (let round = 0; round < rounds && !condition(); round++) {
        await flush();
    }
}

function subscribe(onyx: LoadedOnyx, key: string): unknown[] {
    const values: unknown[] = [];
    onyx.Onyx.connect({key, callback: (value) => values.push(value)});
    return values;
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe.each(BACKENDS)('Onyx persistence over %s', (backend) => {
    it('Onyx.set persists the value without nested nulls', async () => {
        const onyx = await loadOnyx(backend);

        await onyx.Onyx.set(ONYX_KEYS.PLAIN, {a: 1, b: null, c: {d: null, e: 2}, list: [1, null]});

        expect(await persisted(onyx)).toEqual({[ONYX_KEYS.PLAIN]: {a: 1, c: {e: 2}, list: [1, null]}});
        expect(await onyx.Onyx.exportState()).toEqual({[ONYX_KEYS.PLAIN]: {a: 1, c: {e: 2}, list: [1, null]}});
    });

    it('Onyx.set to null removes the key from storage', async () => {
        const onyx = await loadOnyx(backend);
        await onyx.Onyx.set(ONYX_KEYS.PLAIN, 'value');
        await onyx.Onyx.set(ONYX_KEYS.OTHER, 'kept');

        await onyx.Onyx.set(ONYX_KEYS.PLAIN, null);

        expect(await persisted(onyx)).toEqual({[ONYX_KEYS.OTHER]: 'kept'});
    });

    it('Onyx.merge persists the merged value with removed properties gone', async () => {
        const onyx = await loadOnyx(backend);
        await onyx.Onyx.set(ONYX_KEYS.PLAIN, {a: 1, nested: {b: 1, keep: true}, list: [1, 2]});

        await onyx.Onyx.merge(ONYX_KEYS.PLAIN, {nested: {b: null, c: 2}, d: 3, list: [3]});

        expect(await persisted(onyx)).toEqual({[ONYX_KEYS.PLAIN]: {a: 1, nested: {keep: true, c: 2}, d: 3, list: [3]}});
    });

    it('merges issued in one tick persist their combined result', async () => {
        const onyx = await loadOnyx(backend);

        await Promise.all([
            onyx.Onyx.merge(ONYX_KEYS.PLAIN, {a: 1, nested: {b: 1}}),
            onyx.Onyx.merge(ONYX_KEYS.PLAIN, {nested: {c: 2}}),
            onyx.Onyx.merge(ONYX_KEYS.PLAIN, {a: null, d: {e: null}}),
        ]);

        expect(await persisted(onyx)).toEqual({[ONYX_KEYS.PLAIN]: {nested: {b: 1, c: 2}, d: {}}});
    });

    it('Onyx.merge of null removes the key from storage', async () => {
        const onyx = await loadOnyx(backend);
        await onyx.Onyx.set(ONYX_KEYS.PLAIN, {a: 1});

        await onyx.Onyx.merge(ONYX_KEYS.PLAIN, null);

        expect(await persisted(onyx)).toEqual({});
    });

    it('Onyx.mergeCollection persists existing and new members without touching a prefix-colliding collection', async () => {
        const onyx = await loadOnyx(backend);
        await onyx.Onyx.multiSet({[REPORT_1]: {id: 1, name: 'one', stale: true}, [REPORT_META_1]: {meta: true}});

        await onyx.Onyx.mergeCollection(ONYX_KEYS.COLLECTION.REPORT, {
            [REPORT_1]: {name: 'uno', stale: null},
            [REPORT_2]: {id: 2, nested: {a: null, b: 1}},
        });

        expect(await persisted(onyx)).toEqual({
            [REPORT_1]: {id: 1, name: 'uno'},
            [REPORT_2]: {id: 2, nested: {b: 1}},
            [REPORT_META_1]: {meta: true},
        });
    });

    it('Onyx.multiSet persists every pair and removes pairs set to null', async () => {
        const onyx = await loadOnyx(backend);
        await onyx.Onyx.set(ONYX_KEYS.OTHER, 'old');

        await onyx.Onyx.multiSet({[ONYX_KEYS.PLAIN]: {a: 1, b: null}, [ONYX_KEYS.OTHER]: null, [REPORT_1]: {id: 1}});

        expect(await persisted(onyx)).toEqual({[ONYX_KEYS.PLAIN]: {a: 1}, [REPORT_1]: {id: 1}});
    });

    it('Onyx.setCollection replaces the persisted members of that collection', async () => {
        const onyx = await loadOnyx(backend);
        await onyx.Onyx.multiSet({[REPORT_1]: {id: 1}, [ONYX_KEYS.OTHER]: 'kept'});

        await onyx.Onyx.setCollection(ONYX_KEYS.COLLECTION.REPORT, {[REPORT_2]: {id: 2}});

        expect(await persisted(onyx)).toEqual({[REPORT_2]: {id: 2}, [ONYX_KEYS.OTHER]: 'kept'});
    });

    it('Onyx.clear leaves only default key states and preserved keys in storage', async () => {
        const onyx = await loadOnyx(backend, {}, {initialKeyStates: {[ONYX_KEYS.WITH_DEFAULT]: 'default'}});
        await onyx.Onyx.multiSet({[ONYX_KEYS.PLAIN]: 'value', [ONYX_KEYS.OTHER]: 'preserved', [ONYX_KEYS.WITH_DEFAULT]: 'changed', [REPORT_1]: {id: 1}});

        await onyx.Onyx.clear([ONYX_KEYS.OTHER]);

        expect(await persisted(onyx)).toEqual({[ONYX_KEYS.OTHER]: 'preserved', [ONYX_KEYS.WITH_DEFAULT]: 'default'});
    });

    it('never persists RAM-only keys', async () => {
        const onyx = await loadOnyx(backend, {}, {ramOnlyKeys: [RAM_ONLY]});

        await onyx.Onyx.set(RAM_ONLY, 'in memory');
        await onyx.Onyx.merge(RAM_ONLY, 'merged');

        expect(await persisted(onyx)).toEqual({});
        expect(await onyx.Onyx.exportState()).toEqual({});
    });

    it('hydrates subscribers from values a previous session persisted', async () => {
        const onyx = await loadOnyx(backend, {[ONYX_KEYS.PLAIN]: {persisted: true}, [REPORT_1]: {id: 1}, [REPORT_META_1]: {meta: true}});

        const plainValues = subscribe(onyx, ONYX_KEYS.PLAIN);
        const reportValues: unknown[] = [];
        onyx.Onyx.connect({key: ONYX_KEYS.COLLECTION.REPORT, callback: (value) => reportValues.push(value)});
        await flushUntil(() => plainValues.length > 0 && reportValues.length > 0);

        expect(plainValues.at(-1)).toEqual({persisted: true});
        expect(reportValues.at(-1)).toEqual({[REPORT_1]: {id: 1}});
        expect(await onyx.Onyx.exportState()).toEqual({[ONYX_KEYS.PLAIN]: {persisted: true}, [REPORT_1]: {id: 1}, [REPORT_META_1]: {meta: true}});
    });

    it('keeps persisted properties of a key with a default state and adds the default properties', async () => {
        const onyx = await loadOnyx(backend, {[ONYX_KEYS.WITH_DEFAULT]: {user: 'persisted'}}, {initialKeyStates: {[ONYX_KEYS.WITH_DEFAULT]: {version: 2}}});

        const values = subscribe(onyx, ONYX_KEYS.WITH_DEFAULT);
        await flushUntil(() => values.length > 0);

        expect(values.at(-1)).toEqual({user: 'persisted', version: 2});
    });

    it('delivers a value another tab persisted to subscribers and the cache', async () => {
        const onyx = await loadOnyx(backend, {}, {shouldSyncMultipleInstances: true}, 'web');
        await onyx.Onyx.set(ONYX_KEYS.PLAIN, 'mine');
        const values = subscribe(onyx, ONYX_KEYS.PLAIN);
        await flushUntil(() => values.length > 0);

        await onyx.platformProvider.setItem(PLAIN, 'from another tab');
        window.dispatchEvent(new StorageEvent('storage', {key: 'SYNC_ONYX', newValue: JSON.stringify([ONYX_KEYS.PLAIN])}));
        await flushUntil(() => values.at(-1) === 'from another tab');

        expect(values.at(-1)).toBe('from another tab');
        expect(onyx.cache.get(ONYX_KEYS.PLAIN)).toBe('from another tab');
    });
});

describe('current behaviour (suspected bug)', () => {
    it.each(BACKENDS)('Onyx.setCollection over %s also deletes members of a prefix-colliding collection', async (backend) => {
        const onyx = await loadOnyx(backend);
        await onyx.Onyx.multiSet({[REPORT_1]: {id: 1}, [REPORT_META_1]: {meta: true}});

        await onyx.Onyx.setCollection(ONYX_KEYS.COLLECTION.REPORT, {[REPORT_2]: {id: 2}});

        expect(await persisted(onyx)).toEqual({[REPORT_2]: {id: 2}});
    });
});
