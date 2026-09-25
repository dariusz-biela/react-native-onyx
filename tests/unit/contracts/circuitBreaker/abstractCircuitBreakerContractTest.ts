import AbstractCircuitBreaker from '../../../../lib/CircuitBreaker/AbstractCircuitBreaker';
import {CIRCUIT_BREAKER_TRANSITIONS} from '../../../../lib/CircuitBreaker/types';
import type {CircuitBreakerOptions, CircuitBreakerState} from '../../../../lib/CircuitBreaker/types';

const DEFAULT_RESET_TIMEOUT_MS = 60_000;
const RESET_TIMEOUT_MS = 1_000;
const TRIP_AFTER = 3;

type HookCall = 'recordFailureInClosed' | 'recordSuccessInClosed' | 'resetFailureState';

type Event = {name: 'trip'; reason: string; stateSeen: CircuitBreakerState} | {name: 'close'; stateSeen: CircuitBreakerState};

/** A breaker that trips on the TRIP_AFTER-th consecutive failure and records every policy hook call. */
class CountingBreaker extends AbstractCircuitBreaker {
    failures = 0;

    readonly hookCalls: HookCall[] = [];

    reasonFor = (failures: number): string | null => (failures >= TRIP_AFTER ? `${failures} failures` : null);

    protected recordFailureInClosed(): string | null {
        this.hookCalls.push('recordFailureInClosed');
        this.failures += 1;
        return this.reasonFor(this.failures);
    }

    protected recordSuccessInClosed(): void {
        this.hookCalls.push('recordSuccessInClosed');
        this.failures = 0;
    }

    protected resetFailureState(): void {
        this.hookCalls.push('resetFailureState');
        this.failures = 0;
    }

    reset(): void {
        this.hardReset();
    }
}

let currentTime = 5_000_000;
let nowSpy: jest.SpiedFunction<typeof Date.now>;
let events: Event[] = [];

function advance(ms: number): void {
    currentTime += ms;
}

function createBreaker(options: CircuitBreakerOptions = {}): CountingBreaker {
    const breaker: CountingBreaker = new CountingBreaker({
        resetTimeoutMs: RESET_TIMEOUT_MS,
        onTrip: (reason) => events.push({name: 'trip', reason, stateSeen: breaker.peekState()}),
        onClose: () => events.push({name: 'close', stateSeen: breaker.peekState()}),
        ...options,
    });
    return breaker;
}

function tripOpen(breaker: CountingBreaker): void {
    for (let i = 0; i < TRIP_AFTER; i++) {
        breaker.recordFailure();
    }
    expect(breaker.peekState()).toBe('open');
}

function toHalfOpen(breaker: CountingBreaker): void {
    tripOpen(breaker);
    advance(RESET_TIMEOUT_MS);
    expect(breaker.isAllowed()).toBe(true);
    expect(breaker.peekState()).toBe('halfOpen');
}

beforeEach(() => {
    currentTime = 5_000_000;
    events = [];
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
});

afterEach(() => {
    nowSpy.mockRestore();
});

describe('AbstractCircuitBreaker contract', () => {
    describe('transition graph', () => {
        it('allows only closed to open, open to halfOpen and halfOpen to closed or open', () => {
            expect(CIRCUIT_BREAKER_TRANSITIONS).toEqual({
                closed: ['open'],
                open: ['halfOpen'],
                halfOpen: ['closed', 'open'],
            });
        });
    });

    describe('closed pass-through', () => {
        it('starts closed and admits every request without touching the failure policy', () => {
            const breaker = createBreaker();

            for (let i = 0; i < 1_000; i++) {
                expect(breaker.isAllowed()).toBe(true);
            }

            expect(breaker.peekState()).toBe('closed');
            expect(breaker.hookCalls).toEqual([]);
            expect(events).toEqual([]);
        });

        it('keeps admitting requests in closed no matter how much time passes', () => {
            const breaker = createBreaker();

            advance(RESET_TIMEOUT_MS * 10);

            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.peekState()).toBe('closed');
        });

        it('delegates a success in closed to recordSuccessInClosed only, without callbacks', () => {
            const breaker = createBreaker();

            breaker.recordSuccess();
            breaker.recordSuccess();

            expect(breaker.hookCalls).toEqual(['recordSuccessInClosed', 'recordSuccessInClosed']);
            expect(breaker.peekState()).toBe('closed');
            expect(events).toEqual([]);
        });

        it('returns false from recordFailure while the policy returns no reason, and stays closed', () => {
            const breaker = createBreaker();

            for (let i = 0; i < TRIP_AFTER - 1; i++) {
                expect(breaker.recordFailure()).toBe(false);
            }

            expect(breaker.peekState()).toBe('closed');
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.hookCalls).toEqual(['recordFailureInClosed', 'recordFailureInClosed']);
            expect(events).toEqual([]);
        });

        it('lets a success in closed reset the policy so failures must build up again', () => {
            const breaker = createBreaker();

            breaker.recordFailure();
            breaker.recordFailure();
            breaker.recordSuccess();

            expect(breaker.recordFailure()).toBe(false);
            expect(breaker.recordFailure()).toBe(false);
            expect(breaker.recordFailure()).toBe(true);
        });

        it('does not treat an empty trip reason as a trip', () => {
            const onTrip = jest.fn();
            const breaker = createBreaker({onTrip});
            breaker.reasonFor = () => '';

            for (let i = 0; i < 10; i++) {
                expect(breaker.recordFailure()).toBe(false);
            }

            expect(breaker.peekState()).toBe('closed');
            expect(onTrip).not.toHaveBeenCalled();
        });
    });

    describe('tripping', () => {
        it('opens on the failure whose policy returns a reason and reports it to onTrip once', () => {
            const breaker = createBreaker();

            breaker.recordFailure();
            breaker.recordFailure();
            expect(breaker.recordFailure()).toBe(true);

            expect(breaker.peekState()).toBe('open');
            expect(events).toEqual([{name: 'trip', reason: '3 failures', stateSeen: 'open'}]);
        });

        it('clears the failure state when it trips, after the policy returned its reason', () => {
            const breaker = createBreaker();

            tripOpen(breaker);

            expect(breaker.hookCalls).toEqual(['recordFailureInClosed', 'recordFailureInClosed', 'recordFailureInClosed', 'resetFailureState']);
            expect(breaker.failures).toBe(0);
        });

        it('rejects every request while open and returns true from recordFailure without consulting the policy', () => {
            const breaker = createBreaker();
            tripOpen(breaker);
            breaker.hookCalls.length = 0;

            for (let i = 0; i < 20; i++) {
                expect(breaker.isAllowed()).toBe(false);
                expect(breaker.recordFailure()).toBe(true);
            }

            expect(breaker.hookCalls).toEqual([]);
            expect(events).toHaveLength(1);
        });

        it('ignores a success while open', () => {
            const breaker = createBreaker();
            tripOpen(breaker);
            breaker.hookCalls.length = 0;

            breaker.recordSuccess();

            expect(breaker.peekState()).toBe('open');
            expect(breaker.isAllowed()).toBe(false);
            expect(breaker.hookCalls).toEqual([]);
            expect(events.filter((event) => event.name === 'close')).toEqual([]);
        });

        it('defaults the open window to 60 seconds', () => {
            const breaker = createBreaker({resetTimeoutMs: undefined});
            tripOpen(breaker);

            advance(DEFAULT_RESET_TIMEOUT_MS - 1);
            expect(breaker.isAllowed()).toBe(false);

            advance(1);
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.peekState()).toBe('halfOpen');
        });

        it('works without any callbacks', () => {
            const breaker = new CountingBreaker({resetTimeoutMs: RESET_TIMEOUT_MS});

            tripOpen(breaker);
            advance(RESET_TIMEOUT_MS);
            expect(breaker.isAllowed()).toBe(true);
            breaker.recordSuccess();

            expect(breaker.peekState()).toBe('closed');
        });
    });

    describe('open to halfOpen', () => {
        it('stays open until exactly resetTimeoutMs has elapsed since the trip', () => {
            const breaker = createBreaker();
            tripOpen(breaker);

            advance(RESET_TIMEOUT_MS - 1);
            expect(breaker.isAllowed()).toBe(false);
            expect(breaker.peekState()).toBe('open');

            advance(1);
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.peekState()).toBe('halfOpen');
        });

        it('does not advance the state from peekState, only from isAllowed', () => {
            const breaker = createBreaker();
            tripOpen(breaker);

            advance(RESET_TIMEOUT_MS * 5);

            expect(breaker.peekState()).toBe('open');
            expect(breaker.peekState()).toBe('open');
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.peekState()).toBe('halfOpen');
        });

        it('keeps recordFailure and recordSuccess on the open path after the window elapsed but before any admission', () => {
            const breaker = createBreaker();
            tripOpen(breaker);
            advance(RESET_TIMEOUT_MS);

            expect(breaker.recordFailure()).toBe(true);
            breaker.recordSuccess();

            expect(breaker.peekState()).toBe('open');
            expect(events).toHaveLength(1);
            // The failure recorded while open did not restart the window.
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.peekState()).toBe('halfOpen');
        });

        it('does not extend the open window when failures keep arriving while open', () => {
            const breaker = createBreaker();
            tripOpen(breaker);

            advance(RESET_TIMEOUT_MS / 2);
            breaker.recordFailure();
            advance(RESET_TIMEOUT_MS / 2);

            expect(breaker.isAllowed()).toBe(true);
        });

        it('admits exactly one probe in halfOpen and rejects everyone else until the probe resolves', () => {
            const breaker = createBreaker();
            tripOpen(breaker);
            advance(RESET_TIMEOUT_MS);

            expect(breaker.isAllowed()).toBe(true);
            for (let i = 0; i < 10; i++) {
                expect(breaker.isAllowed()).toBe(false);
            }
            advance(RESET_TIMEOUT_MS * 3);
            expect(breaker.isAllowed()).toBe(false);
            expect(breaker.peekState()).toBe('halfOpen');
        });

        it('does not consult the failure policy or callbacks on entering halfOpen', () => {
            const breaker = createBreaker();
            tripOpen(breaker);
            breaker.hookCalls.length = 0;

            advance(RESET_TIMEOUT_MS);
            breaker.isAllowed();

            expect(breaker.hookCalls).toEqual([]);
            expect(events).toHaveLength(1);
        });
    });

    describe('halfOpen recovery', () => {
        it('closes when the probe succeeds, clears failure state and calls onClose once', () => {
            const breaker = createBreaker();
            toHalfOpen(breaker);
            breaker.hookCalls.length = 0;

            breaker.recordSuccess();

            expect(breaker.peekState()).toBe('closed');
            expect(breaker.hookCalls).toEqual(['resetFailureState']);
            expect(events).toEqual([
                {name: 'trip', reason: '3 failures', stateSeen: 'open'},
                {name: 'close', stateSeen: 'closed'},
            ]);
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.isAllowed()).toBe(true);
        });

        it('closes only once when several successes arrive in halfOpen', () => {
            const breaker = createBreaker();
            tripOpen(breaker);
            advance(RESET_TIMEOUT_MS);
            breaker.isAllowed();

            breaker.recordSuccess();
            breaker.recordSuccess();

            expect(breaker.peekState()).toBe('closed');
            expect(events.filter((event) => event.name === 'close')).toHaveLength(1);
        });

        it('requires the full failure budget again after recovering', () => {
            const breaker = createBreaker();
            toHalfOpen(breaker);
            breaker.recordSuccess();

            expect(breaker.recordFailure()).toBe(false);
            expect(breaker.recordFailure()).toBe(false);
            expect(breaker.recordFailure()).toBe(true);
        });

        it('reopens when the probe fails, with an empty reason and without consulting the policy', () => {
            const breaker = createBreaker();
            toHalfOpen(breaker);
            breaker.hookCalls.length = 0;

            expect(breaker.recordFailure()).toBe(true);

            expect(breaker.peekState()).toBe('open');
            expect(breaker.hookCalls).toEqual(['resetFailureState']);
            expect(events).toEqual([
                {name: 'trip', reason: '3 failures', stateSeen: 'open'},
                {name: 'trip', reason: '', stateSeen: 'open'},
            ]);
            expect(breaker.isAllowed()).toBe(false);
        });

        it('restarts the open window from the moment the probe failed', () => {
            const breaker = createBreaker();
            tripOpen(breaker);
            advance(RESET_TIMEOUT_MS + 500);
            expect(breaker.isAllowed()).toBe(true);

            breaker.recordFailure();

            advance(RESET_TIMEOUT_MS - 1);
            expect(breaker.isAllowed()).toBe(false);
            advance(1);
            expect(breaker.isAllowed()).toBe(true);
        });

        it('admits a fresh probe after every reopen', () => {
            const breaker = createBreaker();
            tripOpen(breaker);

            for (let cycle = 0; cycle < 4; cycle++) {
                advance(RESET_TIMEOUT_MS);
                expect(breaker.isAllowed()).toBe(true);
                expect(breaker.isAllowed()).toBe(false);
                breaker.recordFailure();
                expect(breaker.isAllowed()).toBe(false);
            }

            advance(RESET_TIMEOUT_MS);
            expect(breaker.isAllowed()).toBe(true);
            breaker.recordSuccess();
            expect(breaker.peekState()).toBe('closed');
            expect(events.map((event) => event.name)).toEqual(['trip', 'trip', 'trip', 'trip', 'trip', 'close']);
        });

        it('trips again from closed after a recovery, with a new reason and a new window', () => {
            const breaker = createBreaker();
            toHalfOpen(breaker);
            breaker.recordSuccess();
            advance(123);

            tripOpen(breaker);
            advance(RESET_TIMEOUT_MS - 1);
            expect(breaker.isAllowed()).toBe(false);
            advance(1);
            expect(breaker.isAllowed()).toBe(true);
            expect(events.map((event) => event.name)).toEqual(['trip', 'close', 'trip']);
        });
    });

    describe('hardReset', () => {
        it.each([
            ['closed with failures', (breaker: CountingBreaker) => breaker.recordFailure()],
            ['open', (breaker: CountingBreaker) => tripOpen(breaker)],
            ['halfOpen with a probe in flight', (breaker: CountingBreaker) => toHalfOpen(breaker)],
        ])('returns to a fresh closed breaker from %s without calling onClose', (_, arrange) => {
            const breaker = createBreaker();
            arrange(breaker);
            const eventsBefore = events.length;

            breaker.reset();

            expect(breaker.peekState()).toBe('closed');
            expect(breaker.failures).toBe(0);
            expect(breaker.hookCalls.at(-1)).toBe('resetFailureState');
            expect(events).toHaveLength(eventsBefore);
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.isAllowed()).toBe(true);
            expect(breaker.recordFailure()).toBe(false);
            expect(breaker.recordFailure()).toBe(false);
            expect(breaker.recordFailure()).toBe(true);
        });

        it('gives the next trip a full window of its own', () => {
            const breaker = createBreaker();
            tripOpen(breaker);
            advance(RESET_TIMEOUT_MS - 10);
            breaker.reset();

            tripOpen(breaker);
            advance(10);

            expect(breaker.isAllowed()).toBe(false);
        });

        it('keeps separate breakers independent', () => {
            const first = createBreaker();
            const second = createBreaker();

            tripOpen(first);

            expect(second.peekState()).toBe('closed');
            expect(second.isAllowed()).toBe(true);
            expect(first.isAllowed()).toBe(false);
        });
    });
});
