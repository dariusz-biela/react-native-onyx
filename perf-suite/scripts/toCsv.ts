/**
 * Writes a run's report.json as `report.csv` next to it, one row per scenario and size, for a spreadsheet.
 *
 * Executed by node directly (node 26 strips the types), so this file must stay within erasable TS syntax.
 *
 * Usage: node perf-suite/scripts/toCsv.ts <run-id>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

type ArmSummary = {median: number; mad: number; p10: number; p90: number; n: number};

type ReportScenario = {
    id: string;
    scale: string;
    area: string;
    params: Record<string, number>;
    sizeIndependent?: string;
    baseline: ArmSummary | null;
    candidate: ArmSummary | null;
    deltaPercent: number;
    paired: {medianDeltaPercent: number; agreeingRounds: number; sharedRounds: number} | null;
    flag: string;
};

type Report = {runId: string; scenarios: ReportScenario[]};

type Cell = string | number | null | undefined;

const COLUMNS = [
    'id',
    'area',
    'scale',
    'params',
    'size_independent',
    'baseline_median_ms',
    'baseline_mad_ms',
    'baseline_p10_ms',
    'baseline_p90_ms',
    'baseline_n',
    'candidate_median_ms',
    'candidate_mad_ms',
    'candidate_p10_ms',
    'candidate_p90_ms',
    'candidate_n',
    'delta_percent',
    'paired_delta_percent',
    'paired_agreeing_rounds',
    'paired_shared_rounds',
    'flag',
];

function escapeCell(cell: Cell): string {
    if (cell === null || cell === undefined) {
        return '';
    }

    const text = String(cell);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatParams(params: Record<string, number>): string {
    return Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(' ');
}

function armCells(arm: ArmSummary | null): Cell[] {
    return [arm?.median, arm?.mad, arm?.p10, arm?.p90, arm?.n];
}

function toRow(scenario: ReportScenario): Cell[] {
    return [
        scenario.id,
        scenario.area,
        scenario.scale,
        formatParams(scenario.params),
        scenario.sizeIndependent ? 'yes' : 'no',
        ...armCells(scenario.baseline),
        ...armCells(scenario.candidate),
        scenario.deltaPercent,
        scenario.paired?.medianDeltaPercent,
        scenario.paired?.agreeingRounds,
        scenario.paired?.sharedRounds,
        scenario.flag,
    ];
}

function main(): void {
    const [runId] = process.argv.slice(2);
    if (!runId) {
        throw new Error('Usage: node perf-suite/scripts/toCsv.ts <run-id>');
    }

    const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results', runId);
    const report: Report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
    const lines = [COLUMNS, ...report.scenarios.map(toRow)].map((cells) => cells.map(escapeCell).join(','));
    const csvPath = path.join(runDir, 'report.csv');

    fs.writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8');
    process.stdout.write(`${csvPath}\n`);
}

main();
