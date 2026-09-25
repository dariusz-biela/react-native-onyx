import * as Logger from '../../../../lib/Logger';
import StorageCircuitBreaker from '../../../../lib/StorageCircuitBreaker';

const ROLLING_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 50;
const NO_PROGRESS_CAP = 5;

const RATE_ALERT = `Storage circuit breaker tripped: ${FAILURE_THRESHOLD + 1} capacity failures within 60s. Halting eviction/retry for 60s to stop a storage failure storm.`;
const NO_PROGRESS_ALERT = `Storage circuit breaker tripped: ${NO_PROGRESS_CAP} consecutive evictions freed no usable space. Halting eviction/retry for 60s to stop a storage failure storm.`;

let currentTime = 2_000_000;
let nowSpy: jest.SpiedFunction<typeof Date.now>;
let logAlertSpy: jest.SpiedFunction<typeof Logger.logAlert>;
let logInfoSpy: jest.SpiedFunction<typeof Logger.logInfo>;

function advance(ms: number): void {
    currentTime += ms;
}

function recordFailures(count: number): boolean[] {
    const results: boolean[] = [];
    for (let i = 0; i < count; i++) {
        results.push(StorageCircuitBreaker.recordCapacityFailure());
    }
    return results;
}

/** Records `count` cycles of a capacity failure followed by an eviction that is still awaiting its verdict. */
function recordFailedEvictionCycles(count: number): boolean[] {
    const results: boolean[] = [];
    for (let i = 0; i < count; i++) {
        results.push(StorageCircuitBreaker.recordCapacityFailure());
        StorageCircuitBreaker.recordEviction();
    }
    return results;
}

function tripByRate(): void {
    recordFailures(FAILURE_THRESHOLD + 1);
    expect(StorageCircuitBreaker.peekState()).toBe('open');
}

function admitProbe(): void {
    advance(ROLLING_WINDOW_MS);
    expect(StorageCircuitBreaker.isAllowed()).toBe(true);
    expect(StorageCircuitBreaker.peekState()).toBe('halfOpen');
}

function tripAlerts(): string[] {
    return logAlertSpy.mock.calls.map((call) => call[0]).filter((message) => message.startsWith('Storage circuit breaker tripped'));
}

beforeEach(() => {
    currentTime = 2_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    logAlertSpy = jest.spyOn(Logger, 'logAlert').mockReturnValue(undefined);
    logInfoSpy = jest.spyOn(Logger, 'logInfo').mockReturnValue(undefined);
    StorageCircuitBreaker.reset();
});

afterEach(() => {
    StorageCircuitBreaker.reset();
    nowSpy.mockRestore();
    logAlertSpy.mockRestore();
    logInfoSpy.mockRestore();
});

describe('StorageCircuitBreaker contract', () => {
    describe('healthy pass-through', () => {
        it('admits ten thousand isAllowed plus recordWriteSuccess pairs and stays closed without logging', () => {
            let allowed = 0;
            for (let i = 0; i < 10_000; i++) {
                if (StorageCircuitBreaker.isAllowed()) {
                    allowed++;
                }
                StorageCircuitBreaker.recordWriteSuccess();
            }

            expect(allowed).toBe(10_000);
            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(logAlertSpy).not.toHaveBeenCalled();
            expect(logInfoSpy).not.toHaveBeenCalled();
        });

        it('treats a plain write success as a no-op that keeps the no-progress streak', () => {
            recordFailedEvictionCycles(NO_PROGRESS_CAP - 1);
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);

            StorageCircuitBreaker.recordWriteSuccess();
            StorageCircuitBreaker.recordWriteSuccess();
            StorageCircuitBreaker.recordEviction();

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
            expect(tripAlerts()).toEqual([NO_PROGRESS_ALERT]);
        });

        it('treats a plain write success as a no-op that keeps the rolling failure count', () => {
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                StorageCircuitBreaker.recordCapacityFailure();
                StorageCircuitBreaker.recordWriteSuccess();
            }

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });

        it('lets a successful post-eviction write clear the no-progress streak but not the rolling count', () => {
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
                StorageCircuitBreaker.recordEviction();
                StorageCircuitBreaker.recordWriteSuccess();
            }

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
            expect(tripAlerts()).toEqual([RATE_ALERT]);
        });
    });

    describe('rolling-window policy', () => {
        it('returns false for the first 50 failures and true for the 51st, with one exact alert', () => {
            const results = recordFailures(FAILURE_THRESHOLD + 1);

            expect(results.slice(0, FAILURE_THRESHOLD).every((result) => result === false)).toBe(true);
            expect(results.at(-1)).toBe(true);
            expect(logAlertSpy.mock.calls).toEqual([[RATE_ALERT]]);
        });

        it('counts a failure that is 59999 ms old', () => {
            recordFailures(FAILURE_THRESHOLD);
            advance(ROLLING_WINDOW_MS - 1);

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });

        it('drops a failure that is exactly 60000 ms old', () => {
            recordFailures(FAILURE_THRESHOLD);
            advance(ROLLING_WINDOW_MS);

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
            expect(recordFailures(FAILURE_THRESHOLD - 1).every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });

        it('expires failures one by one as the window slides', () => {
            recordFailures(25);
            advance(ROLLING_WINDOW_MS / 2);
            recordFailures(25);
            advance(ROLLING_WINDOW_MS / 2);

            expect(recordFailures(25).every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });

        it('reports the rate reason when both policies cross their limit on the same failure', () => {
            recordFailures(FAILURE_THRESHOLD + 1 - (NO_PROGRESS_CAP + 1));
            const results = recordFailedEvictionCycles(NO_PROGRESS_CAP);

            expect(results.every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
            expect(tripAlerts()).toEqual([RATE_ALERT]);
        });
    });

    describe('no-progress policy', () => {
        it('trips on the failure that sees the fifth consecutive no-progress eviction, with one exact alert', () => {
            const results = recordFailedEvictionCycles(NO_PROGRESS_CAP);

            expect(results.every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
            expect(logAlertSpy.mock.calls).toEqual([[NO_PROGRESS_ALERT]]);
        });

        it('counts repeated recordEviction calls before one failure as a single no-progress cycle', () => {
            for (let i = 0; i < NO_PROGRESS_CAP - 1; i++) {
                StorageCircuitBreaker.recordCapacityFailure();
                StorageCircuitBreaker.recordEviction();
                StorageCircuitBreaker.recordEviction();
                StorageCircuitBreaker.recordEviction();
            }

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
            StorageCircuitBreaker.recordEviction();
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });

        it('keeps the streak across more than a window while the window never empties', () => {
            for (let i = 0; i < NO_PROGRESS_CAP; i++) {
                expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
                StorageCircuitBreaker.recordEviction();
                advance(ROLLING_WINDOW_MS / 2);
            }

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
            expect(tripAlerts()).toEqual([NO_PROGRESS_ALERT]);
        });

        it('starts a fresh streak when the window empties, ignoring a stale pending eviction', () => {
            recordFailedEvictionCycles(NO_PROGRESS_CAP);
            advance(ROLLING_WINDOW_MS);

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
            for (let i = 0; i < NO_PROGRESS_CAP - 1; i++) {
                StorageCircuitBreaker.recordEviction();
                expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
            }
            StorageCircuitBreaker.recordEviction();
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });

        it('restarts the streak after a successful post-eviction write', () => {
            recordFailedEvictionCycles(NO_PROGRESS_CAP);
            StorageCircuitBreaker.recordWriteSuccess();

            const results = recordFailedEvictionCycles(NO_PROGRESS_CAP);

            expect(results.every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });

        it('does not count an eviction that was never followed by a failure', () => {
            StorageCircuitBreaker.recordEviction();
            StorageCircuitBreaker.recordEviction();

            expect(recordFailures(NO_PROGRESS_CAP + 1).every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.peekState()).toBe('closed');
        });
    });

    describe('open', () => {
        it('returns true from every capacity and probe failure while open without re-alerting or extending the window', () => {
            tripByRate();

            advance(ROLLING_WINDOW_MS / 2);
            expect(recordFailures(100).every((result) => result === true)).toBe(true);
            StorageCircuitBreaker.recordProbeFailure();
            StorageCircuitBreaker.recordEviction();
            StorageCircuitBreaker.recordWriteSuccess();

            expect(StorageCircuitBreaker.peekState()).toBe('open');
            advance(ROLLING_WINDOW_MS / 2 - 1);
            expect(StorageCircuitBreaker.isAllowed()).toBe(false);
            advance(1);
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
            expect(tripAlerts()).toHaveLength(1);
        });

        it('stays open for capacity failures after the window elapsed until someone asks isAllowed', () => {
            tripByRate();
            advance(ROLLING_WINDOW_MS);

            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
            expect(StorageCircuitBreaker.peekState()).toBe('open');
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
        });

        it('clears the failure counters on trip so a recovered breaker needs a full storm again', () => {
            tripByRate();
            admitProbe();
            StorageCircuitBreaker.recordCapacityFailure();
            StorageCircuitBreaker.recordEviction();
            StorageCircuitBreaker.recordWriteSuccess();
            expect(StorageCircuitBreaker.peekState()).toBe('closed');

            expect(recordFailures(FAILURE_THRESHOLD).every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });
    });

    describe('halfOpen probe', () => {
        it('lets every capacity failure through in halfOpen without recording it', () => {
            tripByRate();
            admitProbe();

            expect(recordFailures(FAILURE_THRESHOLD * 2).every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.peekState()).toBe('halfOpen');
            expect(StorageCircuitBreaker.isAllowed()).toBe(false);
        });

        it('closes only on a write success that follows an eviction', () => {
            tripByRate();
            admitProbe();

            StorageCircuitBreaker.recordWriteSuccess();
            expect(StorageCircuitBreaker.peekState()).toBe('halfOpen');

            StorageCircuitBreaker.recordEviction();
            StorageCircuitBreaker.recordWriteSuccess();
            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
        });

        it('forgets the probe eviction when the probe fails, so a plain write in the next halfOpen does not close', () => {
            tripByRate();
            admitProbe();
            StorageCircuitBreaker.recordCapacityFailure();
            StorageCircuitBreaker.recordEviction();
            StorageCircuitBreaker.recordProbeFailure();
            expect(StorageCircuitBreaker.peekState()).toBe('open');

            admitProbe();
            StorageCircuitBreaker.recordWriteSuccess();

            expect(StorageCircuitBreaker.peekState()).toBe('halfOpen');
        });

        it('starts the closed circuit with an empty no-progress streak after a successful probe', () => {
            recordFailedEvictionCycles(NO_PROGRESS_CAP);
            StorageCircuitBreaker.recordCapacityFailure();
            admitProbe();
            StorageCircuitBreaker.recordCapacityFailure();
            StorageCircuitBreaker.recordEviction();
            StorageCircuitBreaker.recordWriteSuccess();

            expect(recordFailedEvictionCycles(NO_PROGRESS_CAP).every((result) => result === false)).toBe(true);
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });

        it('reopens on a probe failure for a full new window', () => {
            tripByRate();
            advance(ROLLING_WINDOW_MS + 700);
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);

            StorageCircuitBreaker.recordProbeFailure();

            expect(StorageCircuitBreaker.peekState()).toBe('open');
            advance(ROLLING_WINDOW_MS - 1);
            expect(StorageCircuitBreaker.isAllowed()).toBe(false);
            advance(1);
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
        });
    });

    describe('alerts', () => {
        it('alerts once per incident across any number of failed probes', () => {
            tripByRate();
            for (let cycle = 0; cycle < 3; cycle++) {
                admitProbe();
                StorageCircuitBreaker.recordProbeFailure();
            }

            expect(tripAlerts()).toEqual([RATE_ALERT]);
        });

        it('alerts again for a new incident after the circuit recovered', () => {
            tripByRate();
            admitProbe();
            StorageCircuitBreaker.recordEviction();
            StorageCircuitBreaker.recordWriteSuccess();

            recordFailedEvictionCycles(NO_PROGRESS_CAP);
            StorageCircuitBreaker.recordCapacityFailure();

            expect(tripAlerts()).toEqual([RATE_ALERT, NO_PROGRESS_ALERT]);
        });

        it('alerts again after reset', () => {
            tripByRate();
            StorageCircuitBreaker.reset();
            tripByRate();

            expect(tripAlerts()).toEqual([RATE_ALERT, RATE_ALERT]);
        });
    });

    describe('reset', () => {
        it('returns to a closed breaker with empty counters from every state', () => {
            recordFailedEvictionCycles(NO_PROGRESS_CAP - 1);
            recordFailures(FAILURE_THRESHOLD - NO_PROGRESS_CAP);
            StorageCircuitBreaker.recordEviction();
            StorageCircuitBreaker.reset();

            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(false);
            expect(recordFailures(FAILURE_THRESHOLD - 1).every((result) => result === false)).toBe(true);

            StorageCircuitBreaker.reset();
            tripByRate();
            admitProbe();
            StorageCircuitBreaker.reset();

            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
            expect(StorageCircuitBreaker.isAllowed()).toBe(true);
            expect(logAlertSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('current behaviour (suspected bug)', () => {
        it('counts recordProbeFailure while closed as a capacity failure, although its doc calls it harmless there', () => {
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                StorageCircuitBreaker.recordProbeFailure();
            }

            expect(StorageCircuitBreaker.peekState()).toBe('closed');
            expect(StorageCircuitBreaker.recordCapacityFailure()).toBe(true);
        });
    });
});
