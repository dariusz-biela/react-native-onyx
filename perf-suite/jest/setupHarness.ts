/**
 * Guards the invariants every perf run depends on.
 */

if (typeof global.gc !== 'function') {
    throw new Error('global.gc is missing. Run the suite with NODE_OPTIONS="--expose-gc" (scripts/run-arm.sh does this).');
}

if (!process.env.ONYX_PERF_ARM) {
    throw new Error('ONYX_PERF_ARM is not set. Run the suite through scripts/run-arm.sh.');
}

// The React Native Jest preset sets the first flag and RTL the second; without them React warns on every
// update outside `act` and react-test-renderer forces its deprecation warning.
Object.assign(globalThis, {IS_REACT_NATIVE_TEST_ENVIRONMENT: true, IS_REACT_ACT_ENVIRONMENT: true});

// Scenarios iterate for a time budget each, so a suite file can legitimately run for minutes.
jest.setTimeout(600000);
