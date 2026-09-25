import React from 'react';
import type OnyxDefault from '../../../../lib';
import type {OnyxKey, useOnyx as useOnyxHook} from '../../../../lib';
import type StorageMockDefault from '../../../../lib/storage/__mocks__';
import type {InitOptions} from '../../../../lib/types';
import type {UseOnyxSelector} from '../../../../lib/useOnyx';
import {createOnyxProbe, createRecorder, lastCommit, render, settle} from './harness';
import type {Recorder} from './harness';

const KEYS = {
    SESSION: 'session',
    OTHER: 'other',
    COLLECTION: {
        REPORT: 'report_',
        REPORT_DRAFT: 'report_draft_',
    },
} as const;

type FreshOnyx = {
    Onyx: typeof OnyxDefault;
    useOnyx: typeof useOnyxHook;
    storage: typeof StorageMockDefault;
};

/** Throws away the Onyx module graph, so every test starts with an uninitialised Onyx and an empty storage. */
function loadFreshOnyx(): FreshOnyx {
    jest.resetModules();
    // The fresh lib graph must share React with the renderer the harness imports.
    jest.doMock('react', () => React);

    const onyxModule: {default: typeof OnyxDefault; useOnyx: typeof useOnyxHook} = require('../../../../lib');
    const storageModule: {default: typeof StorageMockDefault} = require('../../../../lib/storage');

    return {Onyx: onyxModule.default, useOnyx: onyxModule.useOnyx, storage: storageModule.default};
}

function initOptions(): InitOptions {
    return {keys: KEYS, shouldSyncMultipleInstances: false, enableDevTools: false};
}

/** Seeds storage as a previous session would have left it, then runs init and waits for it. */
async function startWithStoredValues(fresh: FreshOnyx, storedValues: Record<string, unknown>): Promise<void> {
    fresh.storage.setMockStore(storedValues);
    fresh.Onyx.init(initOptions());
    await settle();
}

function clearStorageReads(fresh: FreshOnyx) {
    fresh.storage.getItem.mockClear();
    fresh.storage.multiGet.mockClear();
    fresh.storage.getAll.mockClear();
    fresh.storage.getAllKeys.mockClear();
}

function storageReadCount(fresh: FreshOnyx): number {
    return fresh.storage.getItem.mock.calls.length + fresh.storage.multiGet.mock.calls.length + fresh.storage.getAll.mock.calls.length + fresh.storage.getAllKeys.mock.calls.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function selectField(field: string): UseOnyxSelector<OnyxKey, unknown> {
    return (data) => (isRecord(data) ? data[field] : undefined);
}

function framesOf(recorder: Recorder): unknown[] {
    return recorder.commits.map((frame) => [frame.value, frame.status]);
}

let fresh: FreshOnyx;
let Probe: ReturnType<typeof createOnyxProbe>;

beforeEach(() => {
    fresh = loadFreshOnyx();
    Probe = createOnyxProbe(fresh.useOnyx);
});

describe('useOnyx mount contract for keys persisted before init', () => {
    it('commits the stored value with loaded status on the very first frame and never shows loading', async () => {
        await startWithStoredValues(fresh, {[KEYS.SESSION]: {email: 'stored@b.c'}});
        const recorder = createRecorder();

        render(
            <Probe
                onyxKey={KEYS.SESSION}
                recorder={recorder}
            />,
        );

        expect(framesOf(recorder)).toEqual([[{email: 'stored@b.c'}, 'loaded']]);
        await settle();
        expect(framesOf(recorder)).toEqual([[{email: 'stored@b.c'}, 'loaded']]);
    });

    it('loads a stored collection member', async () => {
        await startWithStoredValues(fresh, {[`${KEYS.COLLECTION.REPORT}1`]: {reportID: '1'}});
        const recorder = createRecorder();

        render(
            <Probe
                onyxKey={`${KEYS.COLLECTION.REPORT}1`}
                recorder={recorder}
            />,
        );
        await settle();

        expect(framesOf(recorder)).toEqual([[{reportID: '1'}, 'loaded']]);
    });

    it('loads a stored collection root without members of a collection whose key starts with the same prefix', async () => {
        await startWithStoredValues(fresh, {
            [`${KEYS.COLLECTION.REPORT}1`]: {reportID: '1'},
            [`${KEYS.COLLECTION.REPORT}2`]: {reportID: '2'},
            [`${KEYS.COLLECTION.REPORT_DRAFT}1`]: {draft: true},
        });
        const reports = createRecorder();
        const drafts = createRecorder();

        render(
            <>
                <Probe
                    onyxKey={KEYS.COLLECTION.REPORT}
                    recorder={reports}
                />
                <Probe
                    onyxKey={KEYS.COLLECTION.REPORT_DRAFT}
                    recorder={drafts}
                />
            </>,
        );
        await settle();

        expect(framesOf(reports)).toEqual([[{[`${KEYS.COLLECTION.REPORT}1`]: {reportID: '1'}, [`${KEYS.COLLECTION.REPORT}2`]: {reportID: '2'}}, 'loaded']]);
        expect(framesOf(drafts)).toEqual([[{[`${KEYS.COLLECTION.REPORT_DRAFT}1`]: {draft: true}}, 'loaded']]);
        expect(Object.isFrozen(lastCommit(reports).value)).toBe(true);
    });

    it('delivers the stored value to many hooks mounted together, one commit each and one shared reference', async () => {
        await startWithStoredValues(fresh, {[KEYS.SESSION]: {email: 'shared@b.c'}});
        const recorders = Array.from({length: 20}, () => createRecorder());

        render(
            <>
                {recorders.map((recorder, index) => (
                    <Probe
                        // eslint-disable-next-line react/no-array-index-key
                        key={index}
                        onyxKey={KEYS.SESSION}
                        recorder={recorder}
                    />
                ))}
            </>,
        );
        await settle();

        const firstValue = lastCommit(recorders[0]).value;
        for (const recorder of recorders) {
            expect(framesOf(recorder)).toEqual([[{email: 'shared@b.c'}, 'loaded']]);
            expect(lastCommit(recorder).value).toBe(firstValue);
        }
    });

    it('lets a hook that mounts after the first one connected read the value without loading', async () => {
        await startWithStoredValues(fresh, {[KEYS.SESSION]: 'stored'});
        const first = createRecorder();
        const second = createRecorder();

        render(
            <Probe
                onyxKey={KEYS.SESSION}
                recorder={first}
            />,
        );
        await settle();
        render(
            <Probe
                onyxKey={KEYS.SESSION}
                recorder={second}
            />,
        );
        await settle();

        expect(framesOf(first)).toEqual([['stored', 'loaded']]);
        expect(framesOf(second)).toEqual([['stored', 'loaded']]);
    });

    it('applies the selector to the stored value on the first frame', async () => {
        await startWithStoredValues(fresh, {[KEYS.SESSION]: {email: 'stored@b.c', authToken: 'x'}});
        const recorder = createRecorder();

        render(
            <Probe
                onyxKey={KEYS.SESSION}
                recorder={recorder}
                options={{selector: selectField('email')}}
            />,
        );
        await settle();

        expect(framesOf(recorder)).toEqual([['stored@b.c', 'loaded']]);
    });

    it('reads nothing from storage when hooks mount on hydrated keys, missing keys and collection roots', async () => {
        await startWithStoredValues(fresh, {[KEYS.SESSION]: 'stored', [`${KEYS.COLLECTION.REPORT}1`]: {reportID: '1'}});
        clearStorageReads(fresh);

        render(
            <>
                <Probe
                    onyxKey={KEYS.SESSION}
                    recorder={createRecorder()}
                />
                <Probe
                    onyxKey={KEYS.OTHER}
                    recorder={createRecorder()}
                />
                <Probe
                    onyxKey={KEYS.COLLECTION.REPORT}
                    recorder={createRecorder()}
                />
                <Probe
                    onyxKey={`${KEYS.COLLECTION.REPORT}2`}
                    recorder={createRecorder()}
                />
            </>,
        );
        await settle();

        expect(storageReadCount(fresh)).toBe(0);
    });

    describe('current behaviour (#834 change)', () => {
        // On main a hook mounted before init committed loading and then the stored value once init resolved.
        it('leaves hooks mounted before init on undefined after init hydrates the stored values', async () => {
            fresh.storage.setMockStore({[KEYS.SESSION]: 'stored', [`${KEYS.COLLECTION.REPORT}1`]: {reportID: '1'}});
            const session = createRecorder();
            const reports = createRecorder();
            const member = createRecorder();

            render(
                <>
                    <Probe
                        onyxKey={KEYS.SESSION}
                        recorder={session}
                    />
                    <Probe
                        onyxKey={KEYS.COLLECTION.REPORT}
                        recorder={reports}
                    />
                    <Probe
                        onyxKey={`${KEYS.COLLECTION.REPORT}1`}
                        recorder={member}
                    />
                </>,
            );
            fresh.Onyx.init(initOptions());
            await settle();

            expect(framesOf(session)).toEqual([[undefined, 'loaded']]);
            expect(framesOf(reports)).toEqual([[undefined, 'loaded']]);
            expect(framesOf(member)).toEqual([[undefined, 'loaded']]);

            const remounted = createRecorder();
            render(
                <Probe
                    onyxKey={KEYS.SESSION}
                    recorder={remounted}
                />,
            );
            await settle();
            expect(framesOf(remounted)).toEqual([['stored', 'loaded']]);
        });

        // On main a hook mounted while init was reading storage committed loading and then the stored value.
        it('leaves a hook mounted while init is still reading storage on undefined', async () => {
            fresh.storage.setMockStore({[KEYS.SESSION]: 'stored'});
            fresh.Onyx.init(initOptions());
            const recorder = createRecorder();

            render(
                <Probe
                    onyxKey={KEYS.SESSION}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(framesOf(recorder)).toEqual([[undefined, 'loaded']]);
        });
    });
});
