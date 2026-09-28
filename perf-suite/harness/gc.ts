import type {MeasureOptions} from './measureOptions';

import nowMs from './clock';

/** Half of a semi-space of the young generation V8 grows to for this heap (32 MB), so its own scavenge stays out of the samples. */
const ADAPTIVE_GC_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** What a host running V8 with `--expose-gc` gives the collector: Node under Jest, or a Chromium page. */
type GcHost = {
    readUsedHeapBytes: () => number;

    /** The `gc()` V8 exposes under `--expose-gc`, with the same signature in Node and Chromium; undefined without the flag. */
    gc: typeof globalThis.gc;

    /** Runs before every collection, to drop what the host itself retains between iterations. */
    beforeCollect?: () => void;
};

type GarbageCollector = {
    /** The collection between two iterations, by `options.gcMode`; returns the milliseconds it took. */
    collectBetweenIterations: (options: MeasureOptions) => number;

    /** The collection between the warm-up and the samples. */
    settle: (options: MeasureOptions) => void;
};

function createGarbageCollector(host: GcHost): GarbageCollector {
    /** Heap size right after the last collection this collector asked for, the base `adaptive` mode measures growth from. */
    let heapBytesAfterLastCollection = 0;

    /** Twice by default: the first pass frees the iteration's garbage, the second collects what that pass made unreachable. */
    function collectFully(passes: number) {
        for (let pass = 0; pass < passes; pass++) {
            host.gc?.();
        }
    }

    function scavenge() {
        host.gc?.({type: 'minor'});
        heapBytesAfterLastCollection = host.readUsedHeapBytes();
    }

    return {
        collectBetweenIterations: (options) => {
            const startedAt = nowMs();
            host.beforeCollect?.();

            if (options.gcMode === 'adaptive') {
                if (host.readUsedHeapBytes() - heapBytesAfterLastCollection >= ADAPTIVE_GC_THRESHOLD_BYTES) {
                    scavenge();
                }
            } else if (options.gcMode === 'minor') {
                scavenge();
            } else if (options.gcMode === 'major') {
                collectFully(options.gcPasses);
            }

            return nowMs() - startedAt;
        },
        // A scavenge before the samples, so no lane starts with the warm-up's young garbage. The suite used to
        // run two full collections here, 50 to 150 ms each on the heap the App's modules make, which added up
        // to more than the measured work of a whole small-scale run. Dropping them (2026-09-23) left the
        // heavy-scale A/A as stable as before or better (p90 of the paired deltas 2.0% against 2.6%), since the
        // lanes are interleaved and a major collection that lands in the loop hits both arms alike.
        // ONYX_PERF_SETTLE_PASSES=N brings N full passes back.
        settle: (options) => {
            collectFully(options.settleGcPasses);
            scavenge();
        },
    };
}

export default createGarbageCollector;
export type {GarbageCollector, GcHost};
