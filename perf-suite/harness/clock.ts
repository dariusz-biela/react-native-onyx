/**
 * `performance.now()` is unusable in this environment: the `jest-expo` preset installs React Native's
 * performance polyfill, which returns whole milliseconds off `Date.now()`, so every sub-millisecond
 * scenario measured as exactly 0 or 1 ms. `process.hrtime.bigint()` is nanosecond-resolution and
 * monotonic, and Jest leaves it alone.
 */
function nowMs(): number {
    return Number(process.hrtime.bigint()) / 1e6;
}

export default nowMs;
