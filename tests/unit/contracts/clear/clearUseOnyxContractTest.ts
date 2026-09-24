import type {OnyxKey} from '../../../../lib/types';
import {DEFAULT_MEMBER_KEY, KEYS, cleanupRendered, flush, loadOnyx, seedAccount} from './clearHarness';
import type {OnyxModules} from './clearHarness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;

const DEFAULT_SESSION = {loading: false, nested: {depth: 1}};
const DEFAULT_MEMBER = {name: 'default member'};

type Render = {value: unknown; status: string};

/** Mounts useOnyx for a key and records the value and status of every render, in order. */
function mountUseOnyx(modules: OnyxModules, key: OnyxKey, selector?: (value: unknown) => unknown) {
    const renders: Render[] = [];
    const {result} = modules.rtl.renderHook(() => {
        const [value, metadata] = selector ? modules.useOnyx(key, {selector}) : modules.useOnyx(key);
        renders.push({value, status: metadata.status});
        return value;
    });
    return {result, renders};
}

/** Runs an async Onyx operation inside act() and lets every pending callback settle. */
async function settle(modules: OnyxModules, operation: () => Promise<unknown> = () => Promise.resolve()) {
    await modules.rtl.act(async () => {
        await operation();
        await flush();
    });
}

function loadedValues(renders: Render[]): unknown[] {
    return renders.filter((render) => render.status === 'loaded').map((render) => render.value);
}

describe('Onyx.clear useOnyx contract', () => {
    afterEach(() => {
        cleanupRendered();
    });

    it('returns undefined for a cleared plain key, after the old value', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        const plain = mountUseOnyx(modules, KEYS.PLAIN);
        await settle(modules);

        await settle(modules, () => modules.Onyx.clear());

        expect(plain.result.current).toBeUndefined();
        expect(plain.renders.at(-1)).toEqual({value: undefined, status: 'loaded'});
        expect(loadedValues(plain.renders).at(0)).toEqual({value: 'plain'});
    });

    it('returns the initial state for a key with one and never undefined in between', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        const session = mountUseOnyx(modules, KEYS.SESSION);
        await settle(modules);
        const rendersBeforeClear = session.renders.length;

        await settle(modules, () => modules.Onyx.clear());

        expect(session.result.current).toEqual(DEFAULT_SESSION);
        const rendersFromClear = session.renders.slice(rendersBeforeClear);
        expect(rendersFromClear.length).toBeGreaterThanOrEqual(1);
        for (const render of rendersFromClear) {
            expect(render).toEqual({value: DEFAULT_SESSION, status: 'loaded'});
        }
    });

    it('does not rerender for a primitive key already at its initial state or an untouched key', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        await modules.Onyx.set(KEYS.IS_OFFLINE, false);
        const offline = mountUseOnyx(modules, KEYS.IS_OFFLINE);
        const untouched = mountUseOnyx(modules, 'neverWritten');
        await settle(modules);
        const offlineRenders = offline.renders.length;
        const untouchedRenders = untouched.renders.length;

        await settle(modules, () => modules.Onyx.clear());

        expect(offline.renders.length).toBe(offlineRenders);
        expect(untouched.renders.length).toBe(untouchedRenders);
        expect(offline.result.current).toBe(false);
        expect(untouched.result.current).toBeUndefined();
    });

    it('keeps the same reference and does not rerender for a preserved key', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        const plain = mountUseOnyx(modules, KEYS.PLAIN);
        const reports = mountUseOnyx(modules, KEYS.COLLECTION.REPORT);
        await settle(modules);
        const plainBefore = plain.result.current;
        const reportsBefore = reports.result.current;
        const plainRenders = plain.renders.length;
        const reportRenders = reports.renders.length;

        await settle(modules, () => modules.Onyx.clear([KEYS.PLAIN, KEYS.COLLECTION.REPORT]));

        expect(plain.result.current).toBe(plainBefore);
        expect(reports.result.current).toBe(reportsBefore);
        expect(plain.renders.length).toBe(plainRenders);
        expect(reports.renders.length).toBe(reportRenders);
    });

    it('returns a collection without its cleared members', async () => {
        const modules = await loadOnyx();
        const account = await seedAccount(modules.Onyx);
        const reports = mountUseOnyx(modules, KEYS.COLLECTION.REPORT);
        const defaulted = mountUseOnyx(modules, KEYS.COLLECTION.DEFAULTED);
        const partial = mountUseOnyx(modules, KEYS.COLLECTION.TEST);
        await settle(modules);

        await settle(modules, () => modules.Onyx.clear([`${KEYS.COLLECTION.TEST}1`]));

        expect(reports.result.current ?? {}).toEqual({});
        expect(defaulted.result.current).toEqual({[DEFAULT_MEMBER_KEY]: DEFAULT_MEMBER});
        expect(partial.result.current).toEqual({[`${KEYS.COLLECTION.TEST}1`]: account[`${KEYS.COLLECTION.TEST}1`]});
        expect(reports.renders.at(-1)?.status).toBe('loaded');
    });

    it('returns undefined for a cleared member and the initial state for a member with one', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        const member = mountUseOnyx(modules, REPORT_1);
        const defaultMember = mountUseOnyx(modules, DEFAULT_MEMBER_KEY);
        await settle(modules);

        await settle(modules, () => modules.Onyx.clear());

        expect(member.renders.at(-1)).toEqual({value: undefined, status: 'loaded'});
        expect(defaultMember.renders.at(-1)).toEqual({value: DEFAULT_MEMBER, status: 'loaded'});
    });

    it('recomputes selectors against the cleared value', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        const selectToken = (value: unknown) => (typeof value === 'object' && value !== null && 'authToken' in value ? value.authToken : 'signed out');
        const countReports = (value: unknown) => Object.keys(typeof value === 'object' && value !== null ? value : {}).length;
        const token = mountUseOnyx(modules, KEYS.SESSION, selectToken);
        const reportCount = mountUseOnyx(modules, KEYS.COLLECTION.REPORT, countReports);
        await settle(modules);
        expect(token.result.current).toBe('token');
        expect(reportCount.result.current).toBe(2);

        await settle(modules, () => modules.Onyx.clear());

        expect(token.result.current).toBe('signed out');
        expect(reportCount.result.current).toBe(0);
    });

    it('gives a hook mounted after clear with the same selector the cleared result', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        const selectToken = (value: unknown) => (typeof value === 'object' && value !== null && 'authToken' in value ? value.authToken : 'signed out');
        mountUseOnyx(modules, KEYS.SESSION, selectToken);
        await settle(modules);

        await settle(modules, () => modules.Onyx.clear());
        const late = mountUseOnyx(modules, KEYS.SESSION, selectToken);
        await settle(modules);

        expect(late.result.current).toBe('signed out');
        for (const render of late.renders) {
            expect(render.value).not.toBe('token');
        }
    });

    it('moves a hook mounted while clear is in flight from the value cached at mount to undefined, never back', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        mountUseOnyx(modules, KEYS.PLAIN);
        await settle(modules);

        const clearing = modules.Onyx.clear();
        const late = mountUseOnyx(modules, KEYS.PLAIN);
        await settle(modules, () => clearing);

        expect(late.renders.at(-1)).toEqual({value: undefined, status: 'loaded'});
        const values = late.renders.map((render) => render.value);
        const firstCleared = values.indexOf(undefined);
        expect(values.slice(0, firstCleared).every((value) => JSON.stringify(value) === JSON.stringify({value: 'plain'}))).toBe(true);
        expect(values.slice(firstCleared).every((value) => value === undefined)).toBe(true);
    });

    it('reports loaded right away for a hook mounted during clear on a key that is not cached', async () => {
        const modules = await loadOnyx();
        await modules.StorageMock.setItem(KEYS.PLAIN, 'only in storage');

        const clearing = modules.Onyx.clear();
        const late = mountUseOnyx(modules, KEYS.PLAIN);
        await settle(modules, () => clearing);

        expect(late.renders.at(0)).toEqual({value: undefined, status: 'loaded'});
        expect(late.renders.every((render) => render.value === undefined && render.status === 'loaded')).toBe(true);
    });

    it('reaches loaded for a hook mounted after clear on a key an open connection still holds, and then follows writes', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        modules.Onyx.connect({key: KEYS.PLAIN, callback: jest.fn()});
        modules.Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: jest.fn()});
        await settle(modules);

        await settle(modules, () => modules.Onyx.clear());
        const plain = mountUseOnyx(modules, KEYS.PLAIN);
        const reports = mountUseOnyx(modules, KEYS.COLLECTION.REPORT);
        await settle(modules);

        expect(plain.renders.at(-1)).toEqual({value: undefined, status: 'loaded'});
        expect(reports.renders.at(-1)?.status).toBe('loaded');
        expect(reports.result.current ?? {}).toEqual({});

        await settle(modules, () => modules.Onyx.set(KEYS.PLAIN, 'next session'));
        await settle(modules, () => modules.Onyx.set(REPORT_2, {reportID: 'next'}));

        expect(plain.renders.at(-1)).toEqual({value: 'next session', status: 'loaded'});
        expect(reports.result.current).toEqual({[REPORT_2]: {reportID: 'next'}});
    });

    it('never renders a value from before clear once the clear has resolved', async () => {
        const modules = await loadOnyx();
        await seedAccount(modules.Onyx);
        const plain = mountUseOnyx(modules, KEYS.PLAIN);
        const member = mountUseOnyx(modules, REPORT_1);
        await settle(modules);

        await settle(modules, () => modules.Onyx.clear());
        const plainRenders = plain.renders.length;
        const memberRenders = member.renders.length;
        await settle(modules);

        expect(plain.renders.slice(plainRenders).every((render) => render.value === undefined)).toBe(true);
        expect(member.renders.slice(memberRenders).every((render) => render.value === undefined)).toBe(true);
    });
});
