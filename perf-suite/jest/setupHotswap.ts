/**
 * Every arm's own `storage` module has to be mocked before the arm loads: in a hot-swap run the module
 * name `react-native-onyx/dist/storage` points at a shim, so mocking the name (setupStorage.ts) would not
 * reach the arms. Each arm gets its own mock instance, so the two stores never see each other's rows.
 */
import {getArmFiles} from '../harness/hotswap/runtime';

const storageFiles = getArmFiles('storage/index.js');
const mockFiles = getArmFiles('storage/__mocks__/index.js');

/**
 * One mock per arm for the whole test file. `api/init` and `flows/boot` call `jest.resetModules()` and
 * require a fresh Onyx; without this the fresh arm got a fresh, empty mock store, so until 2026-09-23 their
 * cold boot hydrated the 7 initial keys instead of the seeded account. setupStorage.ts does the same for a
 * classic run.
 */
const mocksByFile = new Map<string, unknown>();

storageFiles.forEach((storageFile, index) => {
    const mockFile = mockFiles[index];

    jest.doMock(storageFile, () => {
        if (!mocksByFile.has(mockFile)) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            mocksByFile.set(mockFile, require(mockFile));
        }

        return mocksByFile.get(mockFile);
    });
});
