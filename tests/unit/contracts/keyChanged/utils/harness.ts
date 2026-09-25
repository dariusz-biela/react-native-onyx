import type {Connection} from '../../../../../lib/OnyxConnectionManager';
import type StorageMockDefault from '../../../../../lib/storage/__mocks__';
import type {OnyxKey} from '../../../../../lib/types';
import waitForPromisesToResolve from '../../../../utils/waitForPromisesToResolve';
import type {OnyxModules, StartOptions} from '../../connect/utils/freshOnyx';
import {KEYS, startOnyx} from '../../connect/utils/freshOnyx';

const REPORT = KEYS.COLLECTION.REPORT;
const R1 = `${REPORT}1`;
const R2 = `${REPORT}2`;
const R3 = `${REPORT}3`;
const R10 = `${REPORT}10`;
const NESTED_1 = `${KEYS.COLLECTION.REPORT_NESTED}1`;
const ACTIONS_1 = `${KEYS.COLLECTION.REPORT_ACTIONS}1`;
const EMPTY_1 = `${KEYS.COLLECTION.EMPTY}1`;

type Delivery = {name: string; value: unknown; key: unknown};

type Harness = OnyxModules & {
    /** Every delivery to every subscriber made through this harness, in the order they happened. */
    log: Delivery[];
    /** Connects through Onyx.connect with its own subscription and logs each delivery under `name`. */
    connect: (name: string, key: OnyxKey, onDelivery?: (value: unknown) => void) => Connection;
    /** Subscribes through OnyxUtils.subscribeToKey and returns the subscription ID. */
    subscribe: (name: string, key: OnyxKey, onDelivery?: (value: unknown) => void) => number;
    /** Waits for pending first deliveries and writes, then empties the log. */
    settle: () => Promise<void>;
};

async function startHarness(options: StartOptions = {}): Promise<Harness> {
    const modules = await startOnyx(options);
    const log: Delivery[] = [];

    const logUnder = (name: string, onDelivery?: (value: unknown) => void) => (value: unknown, key: unknown) => {
        log.push({name, value, key});
        onDelivery?.(value);
    };

    return {
        ...modules,
        log,
        connect: (name, key, onDelivery) => modules.Onyx.connect({key, callback: logUnder(name, onDelivery), reuseConnection: false}),
        subscribe: (name, key, onDelivery) => modules.OnyxUtils.subscribeToKey({key, callback: logUnder(name, onDelivery)}),
        settle: async () => {
            await waitForPromisesToResolve();
            log.length = 0;
        },
    };
}

function namesOf(log: Delivery[]): string[] {
    return log.map(({name}) => name);
}

function valuesFor(log: Delivery[], name: string): unknown[] {
    return log.filter((delivery) => delivery.name === name).map(({value}) => value);
}

function countFor(log: Delivery[], name: string): number {
    return valuesFor(log, name).length;
}

/** Returns the handler Onyx.init registered with the storage mock for writes made by other instances. */
function instanceSyncHandler(): (pairs: Array<[OnyxKey, unknown]>) => void {
    const storageModule: {default: typeof StorageMockDefault} = require('../../../../../lib/storage');
    return storageModule.default.keepInstancesSync.mock.calls[0][0];
}

/** Names that received at least one delivery, sorted, so routing checks ignore order and counts. */
function receiverNames(log: Delivery[]): string[] {
    return [...new Set(namesOf(log))].sort();
}

export {REPORT, R1, R2, R3, R10, NESTED_1, ACTIONS_1, EMPTY_1, startHarness, namesOf, valuesFor, countFor, receiverNames, instanceSyncHandler};
export type {Delivery, Harness};

// Jest collects every file under tests/unit as a suite, so this helper checks itself only when run as the suite.
if (expect.getState().testPath === __filename) {
    describe('startHarness', () => {
        it('logs deliveries from both subscribe routes under their names and settle empties the log', async () => {
            const {Onyx, log, connect, subscribe, settle} = await startHarness();
            connect('connected', KEYS.PLAIN);
            subscribe('subscribed', KEYS.PLAIN);
            await settle();

            await Onyx.set(KEYS.PLAIN, 'value');

            expect(log).toEqual([
                {name: 'connected', value: 'value', key: KEYS.PLAIN},
                {name: 'subscribed', value: 'value', key: KEYS.PLAIN},
            ]);
            await settle();
            expect(log).toEqual([]);
        });
    });
}
