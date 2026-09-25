import storageCircuitBreaker from 'react-native-onyx/dist/StorageCircuitBreaker';

import runScenarios from '../../harness/runScenarios';
import defineScenario from '../../harness/scenario';

/**
 * `StorageCircuitBreaker` is consulted around every storage operation, and in a healthy session it is
 * always closed: `isAllowed()` returns true and `recordWriteSuccess()` is a no-op. That closed-state
 * pass-through is what this scenario measures, ten thousand operations at a time.
 */
type BreakerContext = {
    state: {allowed: number; revision: number};
};

const OPERATIONS = 10000;

const passThrough = defineScenario({
    id: 'internals/StorageCircuitBreaker/pass-through',
    title: 'ten thousand isAllowed plus recordWriteSuccess pairs through the closed breaker, the healthy-session storage path',
    realUsage: [
        {file: 'src/libs/actions/Report/index.ts', line: 1542, note: 'every write reaches the storage layer this breaker guards'},
        {file: 'src/setup/index.ts', line: 48, note: 'the evictable keys the breaker protects from a no-progress eviction storm'},
    ],
    scale: () => ({operations: OPERATIONS}),
    sizeIndependent: 'the closed breaker checks a state flag and resets a counter per operation, whatever the data behind the writes',
    setup: async (): Promise<BreakerContext> => {
        storageCircuitBreaker.reset();

        return {state: {allowed: 0, revision: 0}};
    },
    beforeEach: async (context) => {
        context.state.allowed = 0;
        context.state.revision++;

        // A previous iteration must never leave the breaker half-open, or the next one measures the
        // probe path instead of the pass-through.
        storageCircuitBreaker.reset();
    },
    run: async (context, params) => {
        for (let index = 0; index < OPERATIONS; index++) {
            if (storageCircuitBreaker.isAllowed()) {
                context.state.allowed++;
            }

            storageCircuitBreaker.recordWriteSuccess();
        }

        return {operations: params.operations, allowed: context.state.allowed};
    },
    teardown: async () => {
        storageCircuitBreaker.reset();
    },
});

runScenarios([passThrough]);
