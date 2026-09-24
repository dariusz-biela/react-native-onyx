import React, {useLayoutEffect} from 'react';
import {act, render} from '@testing-library/react-native';
import {useOnyx} from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {FetchStatus, UseOnyxOptions, UseOnyxResult} from '../../../../lib/useOnyx';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

type Frame = {
    value: unknown;
    status: FetchStatus;
    result: UseOnyxResult<unknown>;
};

/** Collects what a probe rendered (including discarded renders) and what React actually committed. */
type Recorder = {
    renders: Frame[];
    commits: Frame[];
};

function createRecorder(): Recorder {
    return {renders: [], commits: []};
}

function toFrame(result: UseOnyxResult<unknown>): Frame {
    return {value: result[0], status: result[1].status, result};
}

/** Records every render and, through a layout effect without dependencies, every committed frame. */
function useRecordFrames(recorder: Recorder, result: UseOnyxResult<unknown>) {
    recorder.renders.push(toFrame(result));
    useLayoutEffect(() => {
        recorder.commits.push(toFrame(result));
    });
}

type ProbeProps = {
    onyxKey: OnyxKey;
    recorder: Recorder;
    options?: UseOnyxOptions<OnyxKey, unknown>;
};

function OnyxProbe({onyxKey, recorder, options}: ProbeProps) {
    const result = useOnyx<OnyxKey, unknown>(onyxKey, options);
    useRecordFrames(recorder, result);
    return null;
}

/** Drains the Onyx promise chains and flushes every React update they schedule. */
async function settle(): Promise<void> {
    await act(async () => {
        await waitForPromisesToResolve();
        await waitForPromisesToResolve();
    });
}

/** Runs a write (or several) inside act and drains everything it scheduled. */
async function actAndSettle(write: () => unknown): Promise<void> {
    await act(async () => {
        await write();
        await waitForPromisesToResolve();
        await waitForPromisesToResolve();
    });
}

function lastCommit(recorder: Recorder): Frame {
    const frame = recorder.commits.at(-1);
    if (!frame) {
        throw new Error('The probe has not committed any frame yet');
    }
    return frame;
}

function commitValues(recorder: Recorder): unknown[] {
    return recorder.commits.map((frame) => frame.value);
}

/**
 * Asserts that the committed values form an in-order subsequence of the allowed states: values may be
 * skipped (batched away) but never repeated out of order, invented or stale after a newer one.
 */
function expectOrderedSubsequence(values: unknown[], allowedStates: unknown[]) {
    let cursor = 0;
    for (const value of values) {
        let index = cursor;
        while (index < allowedStates.length && JSON.stringify(allowedStates[index]) !== JSON.stringify(value)) {
            index++;
        }
        if (index === allowedStates.length) {
            throw new Error(`Committed value ${JSON.stringify(value)} is not a valid state at or after position ${cursor} of ${JSON.stringify(allowedStates)}`);
        }
        cursor = index;
    }
}

export {OnyxProbe, actAndSettle, commitValues, createRecorder, expectOrderedSubsequence, lastCommit, render, settle, useRecordFrames};
export type {Frame, ProbeProps, Recorder};

// Other contract files import this module, so its own self-check only registers when Jest runs this file.
const isHarnessFileUnderTest = expect.getState().testPath?.endsWith('harness.tsx') ?? false;

if (isHarnessFileUnderTest) {
    describe('contract harness', () => {
        it('records one commit per committed render and exposes the committed result tuple', async () => {
            const recorder = createRecorder();
            render(
                <OnyxProbe
                    onyxKey="harness_missing"
                    recorder={recorder}
                />,
            );
            await settle();

            expect(recorder.commits.length).toBeGreaterThanOrEqual(1);
            expect(lastCommit(recorder).result[1].status).toBe(lastCommit(recorder).status);
        });

        it('accepts ordered subsequences and rejects values out of order', () => {
            expect(() => expectOrderedSubsequence([1, 3], [1, 2, 3])).not.toThrow();
            expect(() => expectOrderedSubsequence([3, 1], [1, 2, 3])).toThrow();
            expect(() => expectOrderedSubsequence([4], [1, 2, 3])).toThrow();
        });
    });
}
