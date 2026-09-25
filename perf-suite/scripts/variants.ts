/**
 * Compares the variants of one scenario family side by side, for suites whose ids read
 * `<prefix>/<variant>/<operation>` (hooks/expense-list). The A/B report compares two Onyx builds on each row; this
 * table compares the rows with each other instead: one table per scale, an operation per line, a variant per
 * column, each cell the baseline arm's median and the renders the iteration counted. Writes the tables to
 * `variants-<prefix>.md` next to the run's report.json and prints them.
 *
 * Executed by node directly (node 26 strips the types), so this file must stay within erasable TS syntax.
 *
 * Usage: node perf-suite/scripts/variants.ts <run-id> <id-prefix>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

type ReportScenario = {id: string; scale: string; baseline: {median: number; n: number} | null};

type Report = {scales: string[]; scenarios: ReportScenario[]};

type SampleLine = {arm: string; id: string; scale: string; counters?: Record<string, number[]>};

type Cell = {medianMs: number; renders: number | undefined};

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function readRenders(runDir: string): Map<string, number> {
    const rendersByRow = new Map<string, number[]>();

    for (const file of fs.readdirSync(runDir).filter((name) => name.endsWith('.ndjson'))) {
        for (const line of fs.readFileSync(path.join(runDir, file), 'utf8').split('\n')) {
            if (!line) {
                continue;
            }
            const sample: SampleLine = JSON.parse(line);
            const renders = sample.counters?.renders;
            if (sample.arm !== 'baseline' || !renders) {
                continue;
            }
            const key = `${sample.id}@${sample.scale}`;
            rendersByRow.set(key, [...(rendersByRow.get(key) ?? []), ...renders]);
        }
    }

    return new Map([...rendersByRow].map(([key, renders]) => [key, median(renders)]));
}

function splitId(id: string, prefix: string): {variant: string; operation: string} | undefined {
    if (!id.startsWith(`${prefix}/`)) {
        return undefined;
    }
    const [variant, operation] = id.slice(prefix.length + 1).split('/');

    return variant && operation ? {variant, operation} : undefined;
}

function formatCell(cell: Cell | undefined, fastestMs: number): string {
    if (!cell) {
        return '-';
    }
    const renders = cell.renders === undefined ? '' : `, ${cell.renders} r`;
    const relative = cell.medianMs === fastestMs ? '**fastest**' : `+${((cell.medianMs / fastestMs - 1) * 100).toFixed(0)}%`;

    return `${cell.medianMs.toFixed(3)} ms${renders} (${relative})`;
}

function buildTable(report: Report, renders: Map<string, number>, prefix: string, scale: string): string {
    const cells = new Map<string, Cell>();
    const variants: string[] = [];
    const operations: string[] = [];

    for (const scenario of report.scenarios) {
        const parts = splitId(scenario.id, prefix);
        if (!parts || scenario.scale !== scale || !scenario.baseline) {
            continue;
        }
        if (!variants.includes(parts.variant)) {
            variants.push(parts.variant);
        }
        if (!operations.includes(parts.operation)) {
            operations.push(parts.operation);
        }
        cells.set(`${parts.operation}|${parts.variant}`, {medianMs: scenario.baseline.median, renders: renders.get(`${scenario.id}@${scale}`)});
    }

    variants.sort();
    const lines = [`### ${scale}`, '', `| operation | ${variants.join(' | ')} |`, `|---|${variants.map(() => '---').join('|')}|`];

    for (const operation of operations) {
        const row = variants.map((variant) => cells.get(`${operation}|${variant}`));
        const fastestMs = Math.min(...row.flatMap((cell) => (cell ? [cell.medianMs] : [])));
        lines.push(`| ${operation} | ${row.map((cell) => formatCell(cell, fastestMs)).join(' | ')} |`);
    }

    return lines.join('\n');
}

function main(): void {
    const [runId, prefix] = process.argv.slice(2);
    if (!runId || !prefix) {
        throw new Error('Usage: node perf-suite/scripts/variants.ts <run-id> <id-prefix>');
    }

    const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results', runId);
    const report: Report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
    const renders = readRenders(runDir);
    const header = `## ${prefix} (${runId})\n\nBaseline-arm median per iteration; \`r\` is the component renders one iteration counted.`;
    const tables = report.scales.map((scale) => buildTable(report, renders, prefix, scale));
    const markdown = `${[header, ...tables].join('\n\n')}\n`;

    fs.writeFileSync(path.join(runDir, `variants-${prefix.replaceAll('/', '-')}.md`), markdown, 'utf8');
    process.stdout.write(markdown);
}

main();
