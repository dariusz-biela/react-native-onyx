/**
 * Lists the scenarios whose paired delta points the same way, above a threshold, in two runs. Run on two
 * A/A runs it finds rows that lean for a reason other than the arms; on two A/B runs, deltas that repeat.
 *
 * Executed by node directly (node 26 strips the types), so this file must stay within erasable TS syntax.
 *
 * Usage: node perf-suite/scripts/lean.ts <run-id> <run-id> [threshold-percent, default 2.5]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

type ReportScenario = {
    id: string;
    scale: string;
    baseline: {median: number; n: number} | null;
    paired: {medianDeltaPercent: number} | null;
};

type Report = {scenarios: ReportScenario[]};

type LeaningRow = {
    key: string;
    firstDelta: number;
    secondDelta: number;
    baselineMedianMs: number;
    samples: number;
};

const DEFAULT_THRESHOLD_PERCENT = 2.5;

function readReport(resultsDir: string, runId: string): Report {
    return JSON.parse(fs.readFileSync(path.join(resultsDir, runId, 'report.json'), 'utf8'));
}

function scenarioKey(scenario: ReportScenario): string {
    return `${scenario.id}@${scenario.scale}`;
}

function findLeaningRows(first: Report, second: Report, thresholdPercent: number): LeaningRow[] {
    const secondByKey = new Map(second.scenarios.map((scenario) => [scenarioKey(scenario), scenario]));
    const rows: LeaningRow[] = [];

    for (const scenario of first.scenarios) {
        const counterpart = secondByKey.get(scenarioKey(scenario));
        if (!scenario.paired || !scenario.baseline || !counterpart?.paired) {
            continue;
        }

        const firstDelta = scenario.paired.medianDeltaPercent;
        const secondDelta = counterpart.paired.medianDeltaPercent;
        const isSameDirection = Math.sign(firstDelta) === Math.sign(secondDelta);

        if (isSameDirection && Math.min(Math.abs(firstDelta), Math.abs(secondDelta)) > thresholdPercent) {
            rows.push({key: scenarioKey(scenario), firstDelta, secondDelta, baselineMedianMs: scenario.baseline.median, samples: scenario.baseline.n});
        }
    }

    return rows.sort((left, right) => left.baselineMedianMs - right.baselineMedianMs);
}

function main(): void {
    const [firstRunId, secondRunId, thresholdArgument] = process.argv.slice(2);
    if (!firstRunId || !secondRunId) {
        throw new Error('Usage: node perf-suite/scripts/lean.ts <run-id> <run-id> [threshold-percent]');
    }

    const thresholdPercent = thresholdArgument ? Number(thresholdArgument) : DEFAULT_THRESHOLD_PERCENT;
    const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results');
    const rows = findLeaningRows(readReport(resultsDir, firstRunId), readReport(resultsDir, secondRunId), thresholdPercent);

    for (const row of rows) {
        process.stdout.write(`${row.key}  ${row.firstDelta.toFixed(1)}%  ${row.secondDelta.toFixed(1)}%  median ${row.baselineMedianMs.toFixed(4)} ms  n=${row.samples}\n`);
    }
    process.stdout.write(`${rows.length} rows lean the same way beyond ${thresholdPercent}% in both runs\n`);
}

main();
