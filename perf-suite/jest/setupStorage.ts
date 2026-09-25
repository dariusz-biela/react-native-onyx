/**
 * The storage layer every arm ships as a manual mock, the same one Expensify/App's `jest/setup.ts` puts
 * behind `react-native-onyx/dist/storage`. A hot-swap run mocks each arm's own file instead, see setupHotswap.ts.
 *
 * The factory closes over one instance, so the fresh Onyx that `api/init` and `flows/boot` require after
 * `jest.resetModules()` hydrates from the rows seeded before the reset instead of an empty store.
 */
if (!process.env.ONYX_PERF_HOTSWAP_ARMS) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mockStorage: unknown = require('react-native-onyx/dist/storage/__mocks__');
    jest.mock('react-native-onyx/dist/storage', () => mockStorage);
}

jest.mock('react-native-device-info', () => ({getFreeDiskStorage: () => {}}));
jest.mock('react-native-nitro-sqlite', () => ({open: () => ({execute: () => {}})}));
