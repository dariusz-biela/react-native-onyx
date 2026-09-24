import type {OnyxKey} from '../../../../lib/types';
import {DEFAULT_MEMBER_KEY, KEYS, createRecorder, flush, loadOnyx, seedAccount} from './clearHarness';
import type {OnyxModules, Recorder} from './clearHarness';

const REPORT_1 = `${KEYS.COLLECTION.REPORT}1`;
const REPORT_2 = `${KEYS.COLLECTION.REPORT}2`;
const TEST_1 = `${KEYS.COLLECTION.TEST}1`;
const TEST_LEVEL_1 = `${KEYS.COLLECTION.TEST_LEVEL}1`;
const DEFAULTED_2 = `${KEYS.COLLECTION.DEFAULTED}2`;
const RAM_MEMBER_1 = `${KEYS.COLLECTION.RAM_ONLY_COLLECTION}1`;

const DEFAULT_SESSION = {loading: false, nested: {depth: 1}};
const DEFAULT_MEMBER = {name: 'default member'};

/** Connects a recorder, waits for its initial delivery and then forgets it, so only later deliveries are observed. */
async function subscribe(Onyx: OnyxModules['Onyx'], key: OnyxKey, recorder: Recorder = createRecorder()): Promise<Recorder> {
    Onyx.connect({key, callback: recorder.callback});
    await flush();
    recorder.reset();
    return recorder;
}

describe('Onyx.clear subscriber contract', () => {
    describe('plain key subscribers', () => {
        it('deliver undefined once for a cleared key', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const plain = await subscribe(Onyx, KEYS.PLAIN);

            await Onyx.clear();

            expect(plain.values()).toEqual([undefined]);
            expect(plain.deliveries.at(0)?.key).toBe(KEYS.PLAIN);
        });

        it('deliver the initial state for a key that has one', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const session = await subscribe(Onyx, KEYS.SESSION);
            const locale = await subscribe(Onyx, KEYS.PREFERRED_LOCALE);
            const ramDefault = await subscribe(Onyx, KEYS.RAM_ONLY_DEFAULT);

            await Onyx.clear();

            expect(session.values()).toEqual([DEFAULT_SESSION]);
            expect(locale.values()).toEqual(['en']);
            expect(ramDefault.values()).toEqual(['ramDefault']);
        });

        it('deliver the initial state for a key with one that was removed with null', async () => {
            const {Onyx} = await loadOnyx();
            await Onyx.set(KEYS.PREFERRED_LOCALE, null);
            const locale = await subscribe(Onyx, KEYS.PREFERRED_LOCALE);

            await Onyx.clear();

            expect(locale.values()).toEqual(['en']);
        });

        it('are not called for a key that never held a value', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const never = await subscribe(Onyx, 'neverWritten');

            await Onyx.clear();

            expect(never.deliveries).toEqual([]);
        });

        it('are not called for a key that was already removed', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            await Onyx.set(KEYS.PLAIN, null);
            const plain = await subscribe(Onyx, KEYS.PLAIN);

            await Onyx.clear();

            expect(plain.deliveries).toEqual([]);
        });

        it('are not called for a primitive key already at its initial state', async () => {
            const {Onyx} = await loadOnyx();
            const offline = await subscribe(Onyx, KEYS.IS_OFFLINE);
            const locale = await subscribe(Onyx, KEYS.PREFERRED_LOCALE);

            await Onyx.clear();

            expect(offline.deliveries).toEqual([]);
            expect(locale.deliveries).toEqual([]);
        });

        it('are called at most once for an untouched object key with an initial state, with an equal value', async () => {
            const {Onyx} = await loadOnyx();
            const session = await subscribe(Onyx, KEYS.SESSION);

            await Onyx.clear();

            expect(session.deliveries.length).toBeLessThanOrEqual(1);
            for (const value of session.values()) {
                expect(value).toEqual(DEFAULT_SESSION);
            }
        });

        it('are not called at all by a second clear with nothing written in between', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            await Onyx.clear();
            const recorders = await Promise.all([KEYS.SESSION, KEYS.PLAIN, KEYS.IS_OFFLINE, REPORT_1, KEYS.COLLECTION.REPORT, KEYS.COLLECTION.DEFAULTED].map((key) => subscribe(Onyx, key)));

            await Onyx.clear();

            for (const recorder of recorders) {
                expect(recorder.deliveries).toEqual([]);
            }
        });

        it('are not called for preserved keys', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const plain = await subscribe(Onyx, KEYS.PLAIN);
            const session = await subscribe(Onyx, KEYS.SESSION);
            const ramOnly = await subscribe(Onyx, KEYS.RAM_ONLY);

            await Onyx.clear([KEYS.PLAIN, KEYS.SESSION, KEYS.RAM_ONLY]);

            expect(plain.deliveries).toEqual([]);
            expect(session.deliveries).toEqual([]);
            expect(ramOnly.deliveries).toEqual([]);
        });

        it('are called for a key that only shares a prefix with a preserved key', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const extended = await subscribe(Onyx, KEYS.PLAIN_EXTENDED);

            await Onyx.clear([KEYS.PLAIN]);

            expect(extended.values()).toEqual([undefined]);
        });

        it('are all notified when several connections share one key', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const first = await subscribe(Onyx, KEYS.PLAIN);
            const second = await subscribe(Onyx, KEYS.PLAIN);
            const collectionFirst = await subscribe(Onyx, KEYS.COLLECTION.REPORT);
            const collectionSecond = await subscribe(Onyx, KEYS.COLLECTION.REPORT);

            await Onyx.clear();

            expect(first.values()).toEqual([undefined]);
            expect(second.values()).toEqual([undefined]);
            expect(collectionFirst.values()).toEqual([{}]);
            expect(collectionSecond.values()).toEqual([{}]);
        });

        it('are not called once disconnected', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const plain = createRecorder();
            const connection = Onyx.connect({key: KEYS.PLAIN, callback: plain.callback});
            const collection = createRecorder();
            const collectionConnection = Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: collection.callback});
            await flush();
            plain.reset();
            collection.reset();
            Onyx.disconnect(connection);
            Onyx.disconnect(collectionConnection);

            await Onyx.clear();

            expect(plain.deliveries).toEqual([]);
            expect(collection.deliveries).toEqual([]);
        });
    });

    describe('collection member subscribers', () => {
        it('deliver undefined for a cleared member and are not called for a preserved sibling', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const first = await subscribe(Onyx, REPORT_1);
            const second = await subscribe(Onyx, REPORT_2);

            await Onyx.clear([REPORT_2]);

            expect(first.values()).toEqual([undefined]);
            expect(first.deliveries.at(0)?.key).toBe(REPORT_1);
            expect(second.deliveries).toEqual([]);
        });

        it('deliver the initial state for a member that has one', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const member = await subscribe(Onyx, DEFAULT_MEMBER_KEY);
            const sibling = await subscribe(Onyx, DEFAULTED_2);

            await Onyx.clear();

            expect(member.values()).toEqual([DEFAULT_MEMBER]);
            expect(sibling.values()).toEqual([undefined]);
        });

        it('deliver undefined for cleared RAM-only members', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const ramMember = await subscribe(Onyx, RAM_MEMBER_1);

            await Onyx.clear();

            expect(ramMember.values()).toEqual([undefined]);
        });

        it('are not called for members of a preserved collection', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const member = await subscribe(Onyx, REPORT_1);

            await Onyx.clear([KEYS.COLLECTION.REPORT]);

            expect(member.deliveries).toEqual([]);
        });
    });

    describe('collection subscribers', () => {
        it('deliver the collection without its cleared members once, keyed by the collection key', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const reports = await subscribe(Onyx, KEYS.COLLECTION.REPORT);
            const defaulted = await subscribe(Onyx, KEYS.COLLECTION.DEFAULTED);

            await Onyx.clear();

            expect(reports.values()).toEqual([{}]);
            expect(reports.deliveries.at(0)?.key).toBe(KEYS.COLLECTION.REPORT);
            expect(defaulted.values()).toEqual([{[DEFAULT_MEMBER_KEY]: DEFAULT_MEMBER}]);
            expect(defaulted.deliveries.at(0)?.key).toBe(KEYS.COLLECTION.DEFAULTED);
        });

        it('deliver the preserved members of a partially preserved collection', async () => {
            const {Onyx} = await loadOnyx();
            const account = await seedAccount(Onyx);
            const reports = await subscribe(Onyx, KEYS.COLLECTION.REPORT);

            await Onyx.clear([REPORT_2]);

            expect(reports.values()).toEqual([{[REPORT_2]: account[REPORT_2]}]);
        });

        it('deliver a frozen snapshot that later writes do not change', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const reports = await subscribe(Onyx, KEYS.COLLECTION.DEFAULTED);

            await Onyx.clear();
            const delivered = reports.last();
            await Onyx.set(DEFAULTED_2, {name: 'after clear'});

            expect(Object.isFrozen(delivered)).toBe(true);
            expect(delivered).toEqual({[DEFAULT_MEMBER_KEY]: DEFAULT_MEMBER});
            expect(reports.last()).toEqual({[DEFAULT_MEMBER_KEY]: DEFAULT_MEMBER, [DEFAULTED_2]: {name: 'after clear'}});
        });

        it('are not called for a preserved collection', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const reports = await subscribe(Onyx, KEYS.COLLECTION.REPORT);

            await Onyx.clear([KEYS.COLLECTION.REPORT]);

            expect(reports.deliveries).toEqual([]);
        });

        it('are not called for a collection with no members', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const empty = await subscribe(Onyx, 'emptyCollection_');

            await Onyx.clear();

            expect(empty.deliveries).toEqual([]);
        });

        it('of a parent collection are not called when only a colliding nested collection held values', async () => {
            const {Onyx} = await loadOnyx();
            await Onyx.set(TEST_LEVEL_1, {id: 'nested'});
            const parent = await subscribe(Onyx, KEYS.COLLECTION.TEST);
            const nested = await subscribe(Onyx, KEYS.COLLECTION.TEST_LEVEL);

            await Onyx.clear();

            expect(parent.deliveries).toEqual([]);
            expect(nested.values()).toEqual([{}]);
        });

        it('of a parent collection only see their own members when both colliding collections are cleared', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const parent = await subscribe(Onyx, KEYS.COLLECTION.TEST);
            const nested = await subscribe(Onyx, KEYS.COLLECTION.TEST_LEVEL);

            await Onyx.clear();

            expect(parent.values()).toEqual([{}]);
            expect(nested.values()).toEqual([{}]);
        });

        it('keep every delivered snapshot internally consistent with the member deliveries', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const reports = await subscribe(Onyx, KEYS.COLLECTION.REPORT);
            const member = await subscribe(Onyx, REPORT_1);

            await Onyx.clear([REPORT_2]);

            expect(member.values()).toEqual([undefined]);
            for (const snapshot of reports.values()) {
                expect(snapshot).not.toHaveProperty(REPORT_1);
            }
        });
    });

    describe('notification timing', () => {
        it('has delivered every notification by the time the clear promise resolves', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const plain = await subscribe(Onyx, KEYS.PLAIN);
            const member = await subscribe(Onyx, REPORT_1);
            const reports = await subscribe(Onyx, KEYS.COLLECTION.REPORT);
            let deliveredWhenResolved: number[] = [];

            await Onyx.clear().then(() => {
                deliveredWhenResolved = [plain.deliveries.length, member.deliveries.length, reports.deliveries.length];
            });

            expect(deliveredWhenResolved).toEqual([1, 1, 1]);
        });

        it('does not notify anyone synchronously inside the clear call', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const plain = await subscribe(Onyx, KEYS.PLAIN);

            const promise = Onyx.clear();
            const deliveredSynchronously = plain.deliveries.length;
            await promise;

            expect(deliveredSynchronously).toBe(0);
            expect(plain.values()).toEqual([undefined]);
        });

        it('has already cleared the whole cache and storage when the first subscriber is notified', async () => {
            const {Onyx, cache, StorageMock} = await loadOnyx();
            await seedAccount(Onyx);
            const observed: Array<Record<string, unknown>> = [];
            const snapshotStore = () => {
                observed.push({
                    plain: cache.get(KEYS.PLAIN),
                    report: cache.get(REPORT_1),
                    test: cache.get(TEST_1),
                    session: cache.get(KEYS.SESSION),
                    storedPlain: StorageMock.getMockStore()[KEYS.PLAIN],
                    storedReport: StorageMock.getMockStore()[REPORT_1],
                });
            };
            await subscribe(Onyx, KEYS.PLAIN, createRecorder(snapshotStore));
            await subscribe(Onyx, REPORT_1, createRecorder(snapshotStore));
            await subscribe(Onyx, KEYS.COLLECTION.TEST, createRecorder(snapshotStore));
            observed.length = 0;

            await Onyx.clear();

            expect(observed.length).toBeGreaterThanOrEqual(3);
            for (const state of observed) {
                expect(state).toEqual({plain: undefined, report: undefined, test: undefined, session: DEFAULT_SESSION, storedPlain: undefined, storedReport: undefined});
            }
        });

        it('keeps notifying the other subscribers when one throws', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const throwAfterInitial = createRecorder(() => {
                throw new Error('subscriber failure');
            });
            Onyx.connect({key: KEYS.PLAIN_EXTENDED, callback: throwAfterInitial.callback});
            Onyx.connect({key: KEYS.COLLECTION.TEST, callback: throwAfterInitial.callback});
            await flush();
            const plain = await subscribe(Onyx, KEYS.PLAIN);
            const reports = await subscribe(Onyx, KEYS.COLLECTION.REPORT);
            const member = await subscribe(Onyx, REPORT_1);

            await expect(Onyx.clear()).resolves.toBeUndefined();

            expect(plain.values()).toEqual([undefined]);
            expect(reports.values()).toEqual([{}]);
            expect(member.values()).toEqual([undefined]);
        });
    });

    describe('reconnecting after clear', () => {
        it('gives a new connection to a cleared key undefined, even while an old connection stays open', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            await subscribe(Onyx, KEYS.PLAIN);
            await subscribe(Onyx, REPORT_1);

            await Onyx.clear();
            const plain = createRecorder();
            const member = createRecorder();
            Onyx.connect({key: KEYS.PLAIN, callback: plain.callback});
            Onyx.connect({key: REPORT_1, callback: member.callback});
            await flush();

            expect(plain.values()).toEqual([undefined]);
            expect(member.values()).toEqual([undefined]);
        });

        it('gives new connections exactly what they would get from a store that never held the cleared data', async () => {
            const keys = [KEYS.PLAIN, KEYS.SESSION, KEYS.IS_OFFLINE, REPORT_1, DEFAULT_MEMBER_KEY, KEYS.COLLECTION.REPORT, KEYS.COLLECTION.DEFAULTED, 'neverWritten'];
            const connectAll = async (Onyx: OnyxModules['Onyx']) => {
                const recorders = keys.map((key) => {
                    const recorder = createRecorder();
                    Onyx.connect({key, callback: recorder.callback});
                    return recorder;
                });
                await flush();
                return recorders.map((recorder) => recorder.deliveries);
            };
            const fresh = await loadOnyx();
            const expected = await connectAll(fresh.Onyx);

            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            await connectAll(Onyx);
            await Onyx.clear();

            expect(await connectAll(Onyx)).toEqual(expected);
        });

        it('gives a new connection to a key with an initial state that state', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            await subscribe(Onyx, KEYS.SESSION);

            await Onyx.clear();
            const session = createRecorder();
            Onyx.connect({key: KEYS.SESSION, callback: session.callback});
            await flush();

            expect(session.values()).toEqual([DEFAULT_SESSION]);
        });

        it('gives a new connection to an emptied collection no members, even while an old connection stays open', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            await subscribe(Onyx, KEYS.COLLECTION.REPORT);

            await Onyx.clear();
            const reports = createRecorder();
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: reports.callback});
            await flush();

            expect(reports.deliveries.length).toBeLessThanOrEqual(1);
            for (const value of reports.values()) {
                expect(value ?? {}).toEqual({});
            }
        });

        it('gives a new collection connection the members left by a partial clear', async () => {
            const {Onyx} = await loadOnyx();
            const account = await seedAccount(Onyx);
            await subscribe(Onyx, KEYS.COLLECTION.REPORT);

            await Onyx.clear([REPORT_2]);
            const reports = createRecorder();
            Onyx.connect({key: KEYS.COLLECTION.REPORT, callback: reports.callback});
            await flush();

            expect(reports.values()).toEqual([{[REPORT_2]: account[REPORT_2]}]);
        });

        it('delivers writes made after clear to both old and new connections', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            const oldPlain = await subscribe(Onyx, KEYS.PLAIN);
            const oldReports = await subscribe(Onyx, KEYS.COLLECTION.REPORT);
            await Onyx.clear();
            const newPlain = await subscribe(Onyx, KEYS.PLAIN);
            const newReports = await subscribe(Onyx, KEYS.COLLECTION.REPORT);
            oldPlain.reset();
            oldReports.reset();

            await Onyx.set(KEYS.PLAIN, 'next session');
            await Onyx.set(REPORT_1, {reportID: 'next'});

            expect(oldPlain.values()).toEqual(['next session']);
            expect(newPlain.values()).toEqual(['next session']);
            expect(oldReports.last()).toEqual({[REPORT_1]: {reportID: 'next'}});
            expect(newReports.last()).toEqual({[REPORT_1]: {reportID: 'next'}});
        });

        it('gives a connection opened while clear is in flight a value no older than the cleared state', async () => {
            const {Onyx} = await loadOnyx();
            await seedAccount(Onyx);
            await subscribe(Onyx, KEYS.PLAIN);

            const clearing = Onyx.clear();
            const plain = createRecorder();
            Onyx.connect({key: KEYS.PLAIN, callback: plain.callback});
            await clearing;
            await flush();

            expect(plain.last()).toBeUndefined();
        });

        it('does not revive a key cleared from a connection that stays open when the key is read again', async () => {
            const {Onyx, cache} = await loadOnyx();
            await seedAccount(Onyx);
            await subscribe(Onyx, KEYS.UNDERSCORE_KEY);

            await Onyx.clear();
            const priority = createRecorder();
            Onyx.connect({key: KEYS.UNDERSCORE_KEY, callback: priority.callback});
            await flush();

            expect(priority.last()).toBeUndefined();
            expect(cache.get(KEYS.UNDERSCORE_KEY)).toBeUndefined();
            expect(cache.get(TEST_LEVEL_1)).toBeUndefined();
        });
    });
});
