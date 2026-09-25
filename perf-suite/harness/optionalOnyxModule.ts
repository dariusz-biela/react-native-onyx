import {getActiveArm, getArmNames, isHotswapRun, setActiveArm} from './hotswap';

/**
 * Some suites measure an internal module that only exists in some builds of Onyx (ONYX-PR#834 removed
 * `OnyxConnectionManager`, `createMemoizedSelector`, `memoizedShallowEqual` and `OnyxSnapshotCache`).
 * A static import of such a module fails the whole file on an arm without it, so those suites load it
 * through here and pass the same path to `runScenarios` as `requiresOnyxModules`, which skips the
 * file's scenarios instead.
 */
function canLoadInActiveArm(relativePath: string): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const loaded: {default?: unknown} = require(`react-native-onyx/dist/${relativePath}`);

        // Behind a hot-swap shim the arm's file is only required on the first property read.
        return loaded.default !== undefined || Object.keys(loaded).length > 0;
    } catch {
        return false;
    }
}

/** Runs `probe` once per arm of this process (a classic run has one) and restores the active arm. */
function everyArm(probe: () => boolean): boolean {
    if (!isHotswapRun()) {
        return probe();
    }

    const previous = getActiveArm();
    const result = getArmNames().every((arm) => {
        setActiveArm(arm);
        return probe();
    });

    setActiveArm(previous);

    return result;
}

/** True when every arm of this process ships `react-native-onyx/dist/<relativePath>`. */
function hasOnyxModule(relativePath: string): boolean {
    return everyArm(() => canLoadInActiveArm(relativePath));
}

/** A stand-in for a missing module: `.default` returns the stand-in so the suite can load, anything else throws. */
function createMissingModuleStub<T extends object>(relativePath: string): T {
    const target: T = Object.create(null);
    const stub: T = new Proxy<T>(target, {
        get: (ignored, property) => {
            if (property === 'default' || property === '__esModule') {
                return stub;
            }

            throw new Error(`react-native-onyx/dist/${relativePath} is not part of this arm; the scenario reading "${String(property)}" should have been skipped.`);
        },
    });

    return stub;
}

/**
 * `react-native-onyx/dist/<relativePath>` when every arm has it, otherwise a stub the suite can still
 * destructure at load time. Pair it with `requiresOnyxModules` on `runScenarios`.
 */
function requireOnyxModule<T extends object>(relativePath: string): T {
    if (!hasOnyxModule(relativePath)) {
        return createMissingModuleStub<T>(relativePath);
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded: T = require(`react-native-onyx/dist/${relativePath}`);

    return loaded;
}

export default requireOnyxModule;
export {everyArm, hasOnyxModule};
