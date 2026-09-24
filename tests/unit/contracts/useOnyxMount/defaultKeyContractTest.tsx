import React from 'react';
import {act} from '@testing-library/react-native';
import Onyx from '../../../../lib';
import {OnyxProbe, actAndSettle, createRecorder, lastCommit, render, settle} from './harness';

const KEYS = {
    PREFERENCES: 'preferences',
    SESSION: 'session',
    REPORT: 'report_',
};

const DEFAULT_PREFERENCES = {theme: 'dark', locale: 'en'};

Onyx.init({
    keys: {PREFERENCES: KEYS.PREFERENCES, SESSION: KEYS.SESSION, COLLECTION: {REPORT: KEYS.REPORT}},
    initialKeyStates: {[KEYS.PREFERENCES]: DEFAULT_PREFERENCES},
});

beforeEach(async () => {
    await act(async () => {
        await Onyx.clear();
    });
});

describe('useOnyx contract with initialKeyStates', () => {
    it('returns the default value on the first frame in a single loaded commit', async () => {
        const recorder = createRecorder();
        render(
            <OnyxProbe
                onyxKey={KEYS.PREFERENCES}
                recorder={recorder}
            />,
        );
        await settle();

        expect(recorder.commits).toHaveLength(1);
        expect(lastCommit(recorder)).toMatchObject({value: DEFAULT_PREFERENCES, status: 'loaded'});
    });

    it('merges into the default value and restores it on clear', async () => {
        const recorder = createRecorder();
        render(
            <OnyxProbe
                onyxKey={KEYS.PREFERENCES}
                recorder={recorder}
            />,
        );
        await settle();

        await actAndSettle(() => Onyx.merge(KEYS.PREFERENCES, {locale: 'es'}));
        expect(lastCommit(recorder).value).toEqual({theme: 'dark', locale: 'es'});

        await actAndSettle(() => Onyx.clear());
        expect(lastCommit(recorder)).toMatchObject({value: DEFAULT_PREFERENCES, status: 'loaded'});
    });

    it('returns an empty loaded collection root when no member exists but default keys do', async () => {
        const recorder = createRecorder();
        render(
            <OnyxProbe
                onyxKey={KEYS.REPORT}
                recorder={recorder}
            />,
        );
        await settle();

        expect(lastCommit(recorder)).toMatchObject({value: {}, status: 'loaded'});
        expect(recorder.commits.length).toBeLessThanOrEqual(1);
    });
});
