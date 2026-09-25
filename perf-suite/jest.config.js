const fs = require('fs');
const path = require('path');

const armDir = process.env.ONYX_PERF_ARM_DIR;
if (!armDir) {
    throw new Error('ONYX_PERF_ARM_DIR is not set. Run the suite through perf-suite/scripts/run-arm.sh or ab.sh.');
}

const resolvedArmDir = path.resolve(__dirname, armDir);
if (!fs.existsSync(path.join(resolvedArmDir, 'index.js'))) {
    throw new Error(`ONYX_PERF_ARM_DIR "${resolvedArmDir}" has no index.js. Build the arm first (scripts/build-arm.sh).`);
}

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Hot-swap mode (the ab.sh default): every arm lives in one process behind generated shims, see harness/hotswap/.
const hotswapArms = process.env.ONYX_PERF_HOTSWAP_ARMS ? JSON.parse(process.env.ONYX_PERF_HOTSWAP_ARMS) : null;
const hotswapArmDirs = hotswapArms ? Object.values(hotswapArms).map((dir) => path.resolve(__dirname, dir)) : [];
const hotswapShimDir = path.join(__dirname, '.hotswap');

for (const dir of hotswapArmDirs) {
    if (!fs.existsSync(path.join(dir, 'index.js'))) {
        throw new Error(`Hot-swap arm "${dir}" has no index.js.`);
    }
}

if (hotswapArms) {
    require('./harness/hotswap/generateShims')(hotswapArmDirs, hotswapShimDir);
}

const onyxDir = hotswapArms ? hotswapShimDir : resolvedArmDir;

// The arms are plain CommonJS tsc output and stay untransformed, the way Expensify/App loads Onyx from
// node_modules: babel-jest would otherwise hand `useOnyx` to the React Compiler, which rewrites the very
// function under measurement.
const untransformedDirs = hotswapArms ? [...hotswapArmDirs, hotswapShimDir, path.join(__dirname, 'harness/hotswap/runtime.js')] : [resolvedArmDir];

module.exports = {
    rootDir: __dirname,
    // Only the entry files are crawled. The arms under .build/ carry `storage/__mocks__` folders that
    // jest-haste-map would register as duplicate manual mocks; every other file resolves through the file system.
    roots: ['<rootDir>/entry'],
    // The suite files are loaded by the entry files, see harness/loadSuites.ts.
    testMatch: ['<rootDir>/entry/*.perf.ts'],
    testEnvironment: '<rootDir>/jest/environment.js',
    // Expensify/App runs its Jest suite on the jest-expo iOS preset, so Onyx resolves its `.native` files there
    // (`OnyxMerge/index.native.js`, the native storage platform) and does here too.
    haste: {defaultPlatform: 'ios', platforms: ['android', 'ios', 'native']},
    globals: {
        __DEV__: true,
    },
    transform: {
        '\\.[jt]sx?$': ['babel-jest', {configFile: path.join(__dirname, 'babel.config.js')}],
    },
    transformIgnorePatterns: ['/node_modules/(?!(@ngneat/falso|uuid)/)', ...untransformedDirs.map(escapeForRegExp)],
    moduleNameMapper: {
        '^react-native-onyx$': path.join(onyxDir, 'index.js'),
        '^react-native-onyx/dist/(.*)$': path.join(onyxDir, '$1'),
        '^@app/(.*)$': '<rootDir>/app/$1',
        '^react-native$': '<rootDir>/app/reactNative.ts',
        // One React for everything: packages resolved from the repo root (`use-sync-external-store`, which an arm
        // may import) would otherwise load the root's React 18 next to the suite's React 19.
        '^react$': path.join(__dirname, 'node_modules/react/index.js'),
        '^react/(.*)$': path.join(__dirname, 'node_modules/react/$1'),
    },
    // Real timers everywhere: the harness measures wall-clock time and Onyx notifies on timers and microtasks.
    fakeTimers: {enableGlobally: false},
    setupFiles: [...(hotswapArms ? ['<rootDir>/jest/setupHotswap.ts'] : []), '<rootDir>/jest/setupStorage.ts'],
    setupFilesAfterEnv: ['<rootDir>/jest/setupHarness.ts'],
    cacheDirectory: '<rootDir>/.jest-cache',
    // run-arm.sh runs one worker and recycles it past this limit, see the comment there.
    ...(process.env.ONYX_PERF_WORKER_MEMORY && process.env.ONYX_PERF_WORKER_MEMORY !== '0' ? {workerIdleMemoryLimit: process.env.ONYX_PERF_WORKER_MEMORY} : {}),
    testSequencer: '<rootDir>/jest/sequencer.js',
};
