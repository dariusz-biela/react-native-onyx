import React, {useLayoutEffect} from 'react';
import type {ReactNode} from 'react';
import {act, render} from '@testing-library/react-native';
import Onyx, {useOnyx} from '../../../../lib';
import type {OnyxKey} from '../../../../lib';
import type {UseOnyxResult, UseOnyxSelector} from '../../../../lib/useOnyx';
import waitForPromisesToResolve from '../../../utils/waitForPromisesToResolve';

// Jest treats every file under tests/unit as a suite, so this harness carries its own sanity checks, registered only when Jest runs this file directly.

const KEYS = {
    PLAIN: 'plain',
    OTHER: 'other',
    WITH_DEFAULT: 'withDefault',
    COLLECTION: {
        ITEM: 'item_',
        ITEM_META: 'itemMeta_',
    },
} as const;

const DEFAULT_VALUE = {name: 'default', count: 0};

function initContractOnyx(): void {
    Onyx.init({
        keys: KEYS,
        initialKeyStates: {[KEYS.WITH_DEFAULT]: DEFAULT_VALUE},
    });
}

type ProbeRecorder<TValue> = {
    /** Stable identity used as the React key, so a probe keeps its hook instance when siblings are removed. */
    id: number;
    /** Every result the hook returned during a render, including renders React later discarded. */
    renders: Array<UseOnyxResult<TValue>>;
    /** Every result that reached a committed tree, in commit order. A commit that kept the previous result reference is not recorded again. */
    commits: Array<UseOnyxResult<TValue>>;
};

let nextRecorderID = 0;

function createRecorder<TValue>(): ProbeRecorder<TValue> {
    nextRecorderID++;
    return {id: nextRecorderID, renders: [], commits: []};
}

function createRecorders<TValue>(count: number): Array<ProbeRecorder<TValue>> {
    return Array.from({length: count}, () => createRecorder<TValue>());
}

function renderCounts<TValue>(recorders: Array<ProbeRecorder<TValue>>): number[] {
    return recorders.map((recorder) => recorder.renders.length);
}

function lastCommit<TValue>(recorder: ProbeRecorder<TValue>): UseOnyxResult<TValue> {
    const commit = recorder.commits.at(-1);
    if (!commit) {
        throw new Error('The probe has not committed yet');
    }
    return commit;
}

function committedValues<TValue>(recorder: ProbeRecorder<TValue>): Array<TValue | undefined> {
    return recorder.commits.map(([value]) => value);
}

type SelectorProbeProps<TValue> = {
    onyxKey: OnyxKey;
    selector?: UseOnyxSelector<OnyxKey, TValue>;
    recorder: ProbeRecorder<TValue>;
};

function SelectorProbe<TValue>({onyxKey, selector, recorder}: SelectorProbeProps<TValue>) {
    const result = useOnyx(onyxKey, {selector});
    recorder.renders.push(result);

    useLayoutEffect(() => {
        if (recorder.commits.at(-1) === result) {
            return;
        }
        recorder.commits.push(result);
    });

    return null;
}

type SelectorProbeListProps<TValue> = {
    onyxKey: OnyxKey;
    selector?: UseOnyxSelector<OnyxKey, TValue>;
    recorders: Array<ProbeRecorder<TValue>>;
};

/** Renders one SelectorProbe per recorder, all on the same key and selector. */
function SelectorProbeList<TValue>({onyxKey, selector, recorders}: SelectorProbeListProps<TValue>) {
    return recorders.map((recorder) => (
        <SelectorProbe
            key={recorder.id}
            onyxKey={onyxKey}
            selector={selector}
            recorder={recorder}
        />
    ));
}

type ErrorBoundaryProps = {
    children: ReactNode;
    onError: (error: unknown) => void;
};

type ErrorBoundaryState = {
    hasError: boolean;
};

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = {hasError: false};
    }

    static getDerivedStateFromError(): ErrorBoundaryState {
        return {hasError: true};
    }

    componentDidCatch(error: unknown): void {
        this.props.onError(error);
    }

    render() {
        return this.state.hasError ? null : this.props.children;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readField(value: unknown, field: string): unknown {
    return isRecord(value) ? value[field] : undefined;
}

function entriesOf(value: unknown): Array<[string, unknown]> {
    return isRecord(value) ? Object.entries(value) : [];
}

/** Settles every pending Onyx promise and React update. */
async function settle(): Promise<void> {
    await act(async () => waitForPromisesToResolve());
}

/** Runs an Onyx write inside act and waits until Onyx and React have settled. */
async function write(operation: () => Promise<unknown>): Promise<void> {
    await act(async () => {
        await operation();
        await waitForPromisesToResolve();
    });
}

/** Asserts that `values` walks forward through `validStates` without going back and ends on the last one. */
function expectOrderedSubsequence(values: unknown[], validStates: unknown[]): void {
    let stateIndex = 0;
    for (const value of values) {
        while (stateIndex < validStates.length && !isDeepEqual(validStates[stateIndex], value)) {
            stateIndex++;
        }
        if (stateIndex === validStates.length) {
            throw new Error(`Value ${JSON.stringify(value)} is not a valid next state in ${JSON.stringify(validStates)} (sequence ${JSON.stringify(values)})`);
        }
    }
    expect(values.at(-1)).toEqual(validStates.at(-1));
}

function isDeepEqual(left: unknown, right: unknown): boolean {
    try {
        expect(left).toEqual(right);
        return true;
    } catch {
        return false;
    }
}

export {
    DEFAULT_VALUE,
    ErrorBoundary,
    KEYS,
    SelectorProbe,
    SelectorProbeList,
    committedValues,
    createRecorder,
    createRecorders,
    entriesOf,
    expectOrderedSubsequence,
    initContractOnyx,
    isRecord,
    lastCommit,
    readField,
    renderCounts,
    settle,
    write,
};
export type {ProbeRecorder};

function registerHarnessSanityTests(): void {
    describe('useOnyx selector contract harness', () => {
        beforeEach(async () => {
            await Onyx.clear();
        });

        it('records one render and one commit per committed result', async () => {
            await Onyx.set(KEYS.PLAIN, {name: 'a'});
            const recorder = createRecorder<unknown>();

            render(
                <SelectorProbe
                    onyxKey={KEYS.PLAIN}
                    selector={(value) => readField(value, 'name')}
                    recorder={recorder}
                />,
            );
            await settle();

            expect(committedValues(recorder)).toEqual(['a']);
            expect(recorder.renders).toHaveLength(1);
        });

        it('accepts ordered subsequences and rejects values that go back', () => {
            expect(() => expectOrderedSubsequence([1, 3], [1, 2, 3])).not.toThrow();
            expect(() => expectOrderedSubsequence([3, 1], [1, 2, 3])).toThrow();
            expect(() => expectOrderedSubsequence([1, 2], [1, 2, 3])).toThrow();
            expect(() => expectOrderedSubsequence([4], [1, 2, 3])).toThrow();
        });
    });
}

if (expect.getState().testPath === __filename) {
    initContractOnyx();
    registerHarnessSanityTests();
}
