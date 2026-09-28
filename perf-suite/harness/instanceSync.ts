import Storage from 'react-native-onyx/dist/storage';

import {initOnyxForPerf, waitForOnyx} from './onyx';

type OnStorageKeysChanged = Parameters<NonNullable<typeof Storage.keepInstancesSync>>[0];

/**
 * On web the App leaves `shouldSyncMultipleInstances` at its default, which is on wherever `localStorage`
 * exists, so every write another tab makes is applied here again: `Onyx.init` hands the storage layer a
 * handler that puts the changed pairs into the cache and notifies every subscriber, one `keysChanged` per
 * collection. The handler is a closure inside `Onyx.init`, so this runs the App's init once more with the
 * storage layer's `keepInstancesSync` swapped for a function that keeps it.
 */
async function captureInstanceSyncHandler(): Promise<OnStorageKeysChanged> {
    let captured: OnStorageKeysChanged | undefined;

    Storage.keepInstancesSync = (handler) => {
        captured = handler;
    };

    try {
        initOnyxForPerf();
        await waitForOnyx();
    } finally {
        // The mock storage's own `keepInstancesSync` is a bare `jest.fn()`, so a fresh one restores it. Reading
        // the original back would not: in a hot-swap run it comes out of the shim as a late-bound wrapper that
        // calls whatever the property holds, and put back it would call itself on the next init.
        Storage.keepInstancesSync = jest.fn();
    }

    if (!captured) {
        throw new Error('captureInstanceSyncHandler: Onyx.init did not register an instance sync handler; is localStorage missing from the environment?');
    }

    return captured;
}

export default captureInstanceSyncHandler;
export type {OnStorageKeysChanged};
