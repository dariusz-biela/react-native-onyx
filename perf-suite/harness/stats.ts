/** Order-statistics helpers shared by the in-process harness and the offline comparison script. */

function sorted(samples: readonly number[]): number[] {
    return [...samples].sort((a, b) => a - b);
}

/** Linear-interpolated percentile, `fraction` in [0, 1]. */
function percentile(samples: readonly number[], fraction: number): number {
    if (samples.length === 0) {
        return Number.NaN;
    }

    const values = sorted(samples);
    const position = (values.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);

    if (lower === upper) {
        return values[lower];
    }

    return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

function median(samples: readonly number[]): number {
    return percentile(samples, 0.5);
}

/** Median absolute deviation: the spread measure that survives the outliers a warm JIT produces. */
function medianAbsoluteDeviation(samples: readonly number[]): number {
    if (samples.length === 0) {
        return Number.NaN;
    }

    const center = median(samples);
    return median(samples.map((sample) => Math.abs(sample - center)));
}

function mean(samples: readonly number[]): number {
    if (samples.length === 0) {
        return Number.NaN;
    }

    return samples.reduce((total, sample) => total + sample, 0) / samples.length;
}

export {mean, median, medianAbsoluteDeviation, percentile};
