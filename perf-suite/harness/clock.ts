/**
 * `performance.now()` is unusable under Jest: the `jest-expo` preset installs React Native's performance
 * polyfill, which returns whole milliseconds off `Date.now()`, so every sub-millisecond scenario measured as
 * exactly 0 or 1 ms. `process.hrtime.bigint()` is nanosecond-resolution and monotonic, and Jest leaves it
 * alone. A Chromium page has no `process.hrtime`, and there `performance.now()` is the real one, at 5 µs
 * once the page is cross-origin isolated (see `browser/runner.ts`).
 */
const hrtime = typeof process === 'object' && typeof process.hrtime?.bigint === 'function' ? process.hrtime : undefined;

function nowMs(): number {
    return hrtime ? Number(hrtime.bigint()) / 1e6 : performance.now();
}

export default nowMs;
