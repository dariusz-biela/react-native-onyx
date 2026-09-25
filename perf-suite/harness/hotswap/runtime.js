'use strict';

/**
 * Hot-swap runtime: every module of `react-native-onyx` is served through a proxy that forwards to the
 * arm that is active right now, so one Jest process can measure both arms back to back. Plain CommonJS
 * and excluded from the transform, because the generated shims under `.hotswap/` require it too and
 * both sides have to end up with the same instance.
 *
 * Arms come from ONYX_PERF_HOTSWAP_ARMS, a JSON object of arm name to built directory. Modules are
 * loaded lazily and cached per arm, so a forwarded access costs a Map lookup and a property read.
 */
const path = require('path');

// Empty in a classic single-arm run, where the harness imports this module but never switches arms.
const arms = JSON.parse(process.env.ONYX_PERF_HOTSWAP_ARMS || '{}');
const armNames = Object.keys(arms);

/**
 * An optional third copy of Onyx that is active while Jest loads modules and runs the App's setup files,
 * and is never measured. Whatever arm is active then takes every import-time `Onyx.init` and
 * `connectWithoutView` of the App, and V8 records that traffic as type feedback on that arm's functions
 * only. Measured 2026-09-23 without it: in an A/A the arm loaded first ran the connect paths 15-25% slower
 * than its identical twin, and swapping the slots flipped the sign.
 */
const LOADER_ARM = 'loader';
const measuredArmNames = armNames.filter((name) => name !== LOADER_ARM);

/**
 * The active arm lives on the test file's global, not in this module: `api/init` and `flows/boot` call
 * `jest.resetModules()` and require a fresh Onyx, which re-evaluates this file too. With the arm in a
 * module variable the fresh copy started over at its default, so until 2026-09-23 both lanes of those
 * rows measured the same arm. The module cache below stays per copy on purpose: a fresh module graph
 * must load fresh arm modules.
 */
const SHARED_STATE_KEY = '__onyxPerfHotswapState';
const sharedState = globalThis[SHARED_STATE_KEY] || {activeArm: armNames.includes(LOADER_ARM) ? LOADER_ARM : armNames[0]};
globalThis[SHARED_STATE_KEY] = sharedState;

const modulesByArm = new Map(armNames.map((name) => [name, new Map()]));

/** The arms a scenario is measured on, the loader excluded. */
function getArmNames() {
    return [...measuredArmNames];
}

function getActiveArm() {
    return sharedState.activeArm;
}

function setActiveArm(name) {
    if (!arms[name]) {
        throw new Error(`Unknown hot-swap arm "${name}". Known arms: ${armNames.join(', ')}.`);
    }

    sharedState.activeArm = name;
}

/** Absolute path of `relativePath` inside every arm, the loader included, for the storage mocks the setup file registers. */
function getArmFiles(relativePath) {
    return armNames.map((name) => path.join(arms[name], relativePath));
}

function loadActive(relativePath) {
    const activeArm = sharedState.activeArm;
    const cache = modulesByArm.get(activeArm);
    let loaded = cache.get(relativePath);

    if (loaded === undefined) {
        loaded = require(path.join(arms[activeArm], relativePath));
        cache.set(relativePath, loaded);
    }

    return loaded;
}

/**
 * A method that looks its owner up on every call. Callers such as the App's `__mocks__/react-native-onyx.ts`
 * copy the `Onyx` object once (`{...Onyx}`), so a method bound at copy time would stick to whichever arm
 * was active then; this one follows every later swap.
 */
function createLateBoundMethod(getOwner, property) {
    return function hotSwappedMethod(...args) {
        const owner = getOwner();

        return Reflect.apply(owner[property], owner, args);
    };
}

/** Reads properties of the active owner; function values come back as one stable late-bound method per property. */
function createPropertyReader(getOwner) {
    const methods = new Map();

    return (property) => {
        const value = getOwner()[property];

        if (typeof value !== 'function') {
            return value;
        }

        let method = methods.get(property);

        if (!method) {
            method = createLateBoundMethod(getOwner, property);
            methods.set(property, method);
        }

        return method;
    };
}

function describeProperty(getOwner, read, property) {
    const descriptor = Reflect.getOwnPropertyDescriptor(getOwner(), property);

    if (!descriptor) {
        return undefined;
    }

    return {value: read(property), writable: true, enumerable: descriptor.enumerable, configurable: true};
}

/** A stable value whose every use resolves against the active arm: functions are called through, objects are read through. */
function createLateBoundValue(getValue) {
    const sample = getValue();
    const read = createPropertyReader(getValue);

    if (typeof sample === 'function') {
        return new Proxy(function hotSwapped() {}, {
            apply: (target, thisArg, args) => Reflect.apply(getValue(), thisArg, args),
            construct: (target, args) => Reflect.construct(getValue(), args),
            get: (target, property) => read(property),
            has: (target, property) => property in getValue(),
        });
    }

    return new Proxy(
        {},
        {
            get: (target, property) => read(property),
            set: (target, property, value) => {
                getValue()[property] = value;
                return true;
            },
            has: (target, property) => property in getValue(),
            ownKeys: () => Reflect.ownKeys(getValue()),
            getOwnPropertyDescriptor: (target, property) => describeProperty(getValue, read, property),
        },
    );
}

function isObjectLike(value) {
    return typeof value === 'function' || (value !== null && typeof value === 'object');
}

/**
 * The module a shim under `.hotswap/` exports for one `react-native-onyx` file. Object and function
 * exports are handed out once and stay late-bound; primitives are read live.
 */
function createModuleShim(relativePath) {
    const lateBound = new Map();

    function read(property) {
        if (property === '__esModule') {
            return true;
        }

        const value = loadActive(relativePath)[property];

        if (!isObjectLike(value)) {
            return value;
        }

        let bound = lateBound.get(property);

        if (!bound) {
            bound = createLateBoundValue(() => loadActive(relativePath)[property]);
            lateBound.set(property, bound);
        }

        return bound;
    }

    return new Proxy(
        {},
        {
            get: (target, property) => read(property),
            has: (target, property) => property === '__esModule' || property in loadActive(relativePath),
            ownKeys: () => [...new Set(['__esModule', ...Reflect.ownKeys(loadActive(relativePath))])],
            getOwnPropertyDescriptor: (target, property) => {
                if (property !== '__esModule' && !Reflect.has(loadActive(relativePath), property)) {
                    return undefined;
                }

                return {value: read(property), writable: false, enumerable: true, configurable: true};
            },
        },
    );
}

module.exports = {createModuleShim, getActiveArm, getArmFiles, getArmNames, setActiveArm};
