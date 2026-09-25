const {TestEnvironment} = require('jest-environment-jsdom');

/**
 * jsdom, like Expensify/App's Jest setup, plus the Node `structuredClone` that `fake-indexeddb` needs
 * (https://github.com/jsdom/jsdom/issues/3363) and Node's real `setImmediate`, which jsdom leaves out. The App
 * gets a `setImmediate` from its global fake timers; the suite runs on real timers, so it takes Node's.
 */
class PerfSuiteEnvironment extends TestEnvironment {
    constructor(...args) {
        super(...args);
        this.global.structuredClone = structuredClone;
        this.global.setImmediate = setImmediate;
        this.global.clearImmediate = clearImmediate;
    }
}

module.exports = PerfSuiteEnvironment;
