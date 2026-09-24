/**
 * Shared Onyx setup for the merge contract tests: one key map, one init call, subscription recorders that
 * capture every delivered value, and a log capture for the alerts `Onyx.merge` raises.
 */
import type {Connection} from '../../../../../lib/OnyxConnectionManager';
import type {OnyxKey} from '../../../../../lib/types';

import Onyx from '../../../../../lib';

const KEYS = {
    OBJECT: 'obj',
    OTHER_OBJECT: 'obj2',
    STRING: 'str',
    ARRAY: 'arr',
    DEFAULT_OBJECT: 'defaultObj',
    RAM_ONLY: 'ramKey',
    PREFIX_TWIN: 'test',
    COLLECTION: {
        TEST: 'test_',
        TEST_POLICY: 'testPolicy_',
        NESTED: 'test_nested_',
        RAM_ONLY: 'ramColl_',
    },
} as const;

const DEFAULT_OBJECT_VALUE = {a: 1};

const SKIPPABLE_MEMBER_ID = 'skippable';

function initOnyxForMergeContracts(): void {
    Onyx.init({
        keys: KEYS,
        initialKeyStates: {[KEYS.DEFAULT_OBJECT]: DEFAULT_OBJECT_VALUE},
        ramOnlyKeys: [KEYS.RAM_ONLY, KEYS.COLLECTION.RAM_ONLY],
        skippableCollectionMemberIDs: [SKIPPABLE_MEMBER_ID],
    });
}

type Delivery = {value: unknown; key: OnyxKey};

type Recorder = {
    deliveries: Delivery[];
    /** The delivered values in order, without the key. */
    values: () => unknown[];
    /** Forgets everything delivered so far, usually the initial value sent on connect. */
    reset: () => void;
};

const openConnections: Connection[] = [];

/** Subscribes with a fresh (never shared) connection and records every delivered value. */
function record(key: OnyxKey): Recorder {
    const deliveries: Delivery[] = [];
    const connection = Onyx.connect({
        key,
        reuseConnection: false,
        callback: (value: unknown, matchedKey: OnyxKey) => {
            deliveries.push({value, key: matchedKey});
        },
    });
    openConnections.push(connection);
    return {
        deliveries,
        values: () => deliveries.map((delivery) => delivery.value),
        reset: () => {
            deliveries.length = 0;
        },
    };
}

function disconnectAll(): void {
    for (const connection of openConnections.splice(0)) {
        Onyx.disconnect(connection);
    }
}

type LogEntry = {message: string; level: string};

const logs: LogEntry[] = [];

function captureLogs(): LogEntry[] {
    logs.length = 0;
    Onyx.registerLogger(({message, level}) => {
        logs.push({message, level});
    });
    return logs;
}

function alertMessages(): string[] {
    return logs.filter((entry) => entry.level === 'alert').map((entry) => entry.message);
}

/** Resolves after every pending microtask and one macrotask, so fire-and-forget storage writes have landed. */
function flush(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

if (expect.getState().testPath === __filename) {
    describe('merge contract harness', () => {
        beforeAll(initOnyxForMergeContracts);
        afterEach(() => {
            disconnectAll();
            return Onyx.clear();
        });

        it('records values delivered to a subscriber', async () => {
            const recorder = record(KEYS.OBJECT);
            await flush();
            recorder.reset();
            await Onyx.merge(KEYS.OBJECT, {a: 1});
            expect(recorder.values()).toStrictEqual([{a: 1}]);
        });
    });
}

export type {Delivery, LogEntry, Recorder};
export {DEFAULT_OBJECT_VALUE, KEYS, SKIPPABLE_MEMBER_ID, alertMessages, captureLogs, disconnectAll, flush, initOnyxForMergeContracts, record};
