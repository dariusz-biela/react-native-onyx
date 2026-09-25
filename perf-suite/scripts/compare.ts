/**
 * Pools every round's NDJSON for a run, compares the two arms scenario by scenario and writes
 * REPORT.md + report.json next to the raw data.
 *
 * Executed by node directly (node 26 strips the types), so this file must stay within erasable TS
 * syntax and must import with explicit file extensions.
 *
 * Usage: node perf-suite/scripts/compare.ts <run-id>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {median, medianAbsoluteDeviation, percentile} from '../harness/stats.ts';

/** Flagging thresholds, as agreed in PLAN.md. */
const RELATIVE_FLOOR = 0.05;
const MAD_MULTIPLIER = 2;

const BASELINE_ARM = 'baseline';
const CANDIDATE_ARM = 'candidate';

/** Report order of the scale profiles, smallest first; an unknown name sorts last. */
const SCALE_ORDER = ['small', 'medium', 'large', 'heavy'];

type RealUsageAnchor = {file: string; line: number; note: string};

type ResultLine = {
    schema: number;
    runId: string;
    arm: string;
    round: number;
    scale: string;
    nodeVersion: string;
    platform: string;
    cpuModel: string;
    id: string;
    area: string;
    title: string;
    realUsage: RealUsageAnchor[];
    params: Record<string, number>;
    sizeIndependent?: string;
    samples: number[];
    counters: Record<string, number[]>;
    totalDurationMs: number;
    setupMs?: number;
    wallMs?: number;
};

type ArmSummary = {
    median: number;
    mad: number;
    p10: number;
    p90: number;
    n: number;
    rounds: number[];

    /** Median per round, so a delta can be required to hold in every round, not only in the pool. */
    medianByRound: Map<number, number>;
};

type Flag = 'faster' | 'slower' | 'noise' | 'missing';

/** The per-round view: each round's candidate median against the same round's baseline median. */
type PairedRounds = {
    /** Median of the per-round relative deltas, in percent. */
    medianDeltaPercent: number;
    /** Rounds whose delta has the sign of the paired median. */
    agreeingRounds: number;
    sharedRounds: number;
};

type ScenarioComparison = {
    id: string;
    scale: string;
    area: string;
    title: string;
    realUsage: RealUsageAnchor[];
    params: Record<string, number>;
    sizeIndependent?: string;
    baseline: ArmSummary | null;
    candidate: ArmSummary | null;
    deltaPercent: number;
    paired: PairedRounds | null;
    flag: Flag;
};

function readLines(runDir: string): ResultLine[] {
    const files = fs.readdirSync(runDir).filter((name) => name.endsWith('.ndjson'));
    const lines: ResultLine[] = [];

    for (const file of files) {
        const content = fs.readFileSync(path.join(runDir, file), 'utf8');

        for (const rawLine of content.split('\n')) {
            if (rawLine.trim().length === 0) {
                continue;
            }

            const parsed: ResultLine = JSON.parse(rawLine);

            if (parsed.schema !== 1) {
                throw new Error(`${file} was written with result schema ${parsed.schema}, this script reads schema 1.`);
            }

            lines.push(parsed);
        }
    }

    return lines;
}

function summarise(lines: ResultLine[]): ArmSummary {
    const samples = lines.flatMap((line) => line.samples);
    const medianByRound = new Map<number, number>();

    for (const line of lines) {
        medianByRound.set(line.round, median(line.samples));
    }

    return {
        medianByRound,
        median: median(samples),
        mad: medianAbsoluteDeviation(samples),
        p10: percentile(samples, 0.1),
        p90: percentile(samples, 0.9),
        n: samples.length,
        rounds: [...new Set(lines.map((line) => line.round))].sort((a, b) => a - b),
    };
}

/**
 * Two Jest processes running identical code differ by up to 20% on sub-millisecond scenarios (see
 * HANDOFF.md, A/A results), and the pooled MAD does not see that between-process spread. Requiring
 * the same direction in every ABBA round, each above the relative floor, filters it out.
 */
function holdsInEveryRound(baseline: ArmSummary, candidate: ArmSummary, pooledDelta: number): boolean {
    const sharedRounds = [...baseline.medianByRound.keys()].filter((round) => candidate.medianByRound.has(round));

    if (sharedRounds.length < 2) {
        return true;
    }

    return sharedRounds.every((round) => {
        const baselineMedian = baseline.medianByRound.get(round) ?? 0;
        const candidateMedian = candidate.medianByRound.get(round) ?? 0;
        const roundDelta = candidateMedian - baselineMedian;

        return Math.sign(roundDelta) === Math.sign(pooledDelta) && Math.abs(roundDelta) > baselineMedian * RELATIVE_FLOOR;
    });
}

/**
 * In a hot-swap run every round is one back-to-back pair measured in the same process, so the
 * per-round delta is the statistic with the least noise in it. In a classic run it is the ABBA view
 * the flag rule already checks, made visible.
 */
function pairRounds(baseline: ArmSummary | null, candidate: ArmSummary | null): PairedRounds | null {
    if (!baseline || !candidate) {
        return null;
    }

    const deltas: number[] = [];

    for (const [round, baselineMedian] of baseline.medianByRound) {
        const candidateMedian = candidate.medianByRound.get(round);

        if (candidateMedian !== undefined && baselineMedian > 0) {
            deltas.push(((candidateMedian - baselineMedian) / baselineMedian) * 100);
        }
    }

    if (deltas.length === 0) {
        return null;
    }

    const medianDeltaPercent = median(deltas);
    const agreeingRounds = deltas.filter((delta) => Math.sign(delta) === Math.sign(medianDeltaPercent)).length;

    return {medianDeltaPercent, agreeingRounds, sharedRounds: deltas.length};
}

function classify(baseline: ArmSummary | null, candidate: ArmSummary | null): {deltaPercent: number; flag: Flag} {
    if (!baseline || !candidate) {
        return {deltaPercent: Number.NaN, flag: 'missing'};
    }

    const absoluteDelta = candidate.median - baseline.median;
    const deltaPercent = (absoluteDelta / baseline.median) * 100;

    const relativeThreshold = baseline.median * RELATIVE_FLOOR;
    const noiseThreshold = MAD_MULTIPLIER * Math.max(baseline.mad, candidate.mad);
    const isSignificant = Math.abs(absoluteDelta) > relativeThreshold && Math.abs(absoluteDelta) > noiseThreshold;

    if (!isSignificant || !holdsInEveryRound(baseline, candidate, absoluteDelta)) {
        return {deltaPercent, flag: 'noise'};
    }

    return {deltaPercent, flag: absoluteDelta < 0 ? 'faster' : 'slower'};
}

function scaleRank(scale: string): number {
    const rank = SCALE_ORDER.indexOf(scale);
    return rank === -1 ? SCALE_ORDER.length : rank;
}

function compareScales(a: string, b: string): number {
    return scaleRank(a) - scaleRank(b) || a.localeCompare(b);
}

function listScales(lines: ResultLine[]): string[] {
    return [...new Set(lines.map((line) => line.scale))].sort(compareScales);
}

/** One comparison per scenario and scale: a run with three scales reports every scenario three times. */
function compare(lines: ResultLine[]): ScenarioComparison[] {
    const byScenario = new Map<string, ResultLine[]>();

    for (const line of lines) {
        const groupKey = `${line.scale}\u0000${line.id}`;
        const existing = byScenario.get(groupKey) ?? [];
        existing.push(line);
        byScenario.set(groupKey, existing);
    }

    const comparisons: ScenarioComparison[] = [];

    for (const scenarioLines of byScenario.values()) {
        const baselineLines = scenarioLines.filter((line) => line.arm === BASELINE_ARM);
        const candidateLines = scenarioLines.filter((line) => line.arm === CANDIDATE_ARM);
        const baseline = baselineLines.length > 0 ? summarise(baselineLines) : null;
        const candidate = candidateLines.length > 0 ? summarise(candidateLines) : null;
        const first = scenarioLines[0];

        comparisons.push({
            id: first.id,
            scale: first.scale,
            area: first.area,
            title: first.title,
            realUsage: first.realUsage,
            params: first.params,
            sizeIndependent: first.sizeIndependent,
            baseline,
            candidate,
            paired: pairRounds(baseline, candidate),
            ...classify(baseline, candidate),
        });
    }

    return comparisons.sort((a, b) => a.id.localeCompare(b.id) || compareScales(a.scale, b.scale));
}

function formatMs(value: number | undefined): string {
    if (value === undefined || Number.isNaN(value)) {
        return '-';
    }

    return `${value.toFixed(3)} ms`;
}

function formatArm(summary: ArmSummary | null): string {
    if (!summary) {
        return '-';
    }

    return `${formatMs(summary.median)} (MAD ${summary.mad.toFixed(3)}, p10 ${summary.p10.toFixed(3)}, p90 ${summary.p90.toFixed(3)}, n=${summary.n})`;
}

function formatPercent(value: number): string {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(1)}%`;
}

function formatDelta(comparison: ScenarioComparison): string {
    if (Number.isNaN(comparison.deltaPercent)) {
        return '-';
    }

    return formatPercent(comparison.deltaPercent);
}

function formatPaired(paired: PairedRounds | null): string {
    if (!paired) {
        return '-';
    }

    return `${formatPercent(paired.medianDeltaPercent)} (${paired.agreeingRounds}/${paired.sharedRounds})`;
}

function formatFlag(flag: Flag): string {
    if (flag === 'faster') {
        return 'FASTER';
    }
    if (flag === 'slower') {
        return 'SLOWER';
    }
    if (flag === 'missing') {
        return 'MISSING ARM';
    }
    return 'noise';
}

function formatAnchors(anchors: RealUsageAnchor[]): string {
    return anchors.map((anchor) => `\`${anchor.file}:${anchor.line}\` ${anchor.note}`).join('; ');
}

function formatSeconds(milliseconds: number): string {
    return `${(milliseconds / 1000).toFixed(1)} s`;
}

/** One cell of the overview matrix: the paired delta and the flag, or a dash when the scale has no row. */
function formatOverviewCell(comparison: ScenarioComparison | undefined): string {
    if (!comparison) {
        return '-';
    }

    const flag = comparison.flag === 'noise' ? '' : ` **${formatFlag(comparison.flag)}**`;
    return `${formatPaired(comparison.paired)}${flag}`;
}

/**
 * Wall clock per scale and the most expensive scenarios, so a run that drifts past its time budget
 * shows which rows to trim. `wallMs` is the whole Jest test (both arms, setup and resets included);
 * results written before it existed fall back to the measured loop only.
 */
function renderCost(lines: ResultLine[], scales: string[]): string[] {
    const wallByScenario = new Map<string, {id: string; scale: string; wallMs: number; setupMs: number}>();

    for (const line of lines) {
        const groupKey = `${line.scale}\u0000${line.id}`;
        const entry = wallByScenario.get(groupKey) ?? {id: line.id, scale: line.scale, wallMs: 0, setupMs: 0};
        const isHotswapBlock = line.wallMs !== undefined;

        // A hot-swap run writes the same wallMs on every block of every arm, a classic run one line per arm and round.
        entry.wallMs = isHotswapBlock ? Math.max(entry.wallMs, line.wallMs ?? 0) : entry.wallMs + line.totalDurationMs;
        entry.setupMs = Math.max(entry.setupMs, line.setupMs ?? 0);
        wallByScenario.set(groupKey, entry);
    }

    const entries = [...wallByScenario.values()];
    const out: string[] = [];
    out.push('## Cost');
    out.push('');
    out.push('| scale | scenarios | wall clock | setup (one arm) |');
    out.push('| --- | --- | --- | --- |');

    for (const scale of scales) {
        const ofScale = entries.filter((entry) => entry.scale === scale);
        const wall = ofScale.reduce((total, entry) => total + entry.wallMs, 0);
        const setup = ofScale.reduce((total, entry) => total + entry.setupMs, 0);
        out.push(`| ${scale} | ${ofScale.length} | ${formatSeconds(wall)} | ${formatSeconds(setup)} |`);
    }

    out.push('');
    out.push('Most expensive scenarios:');
    out.push('');

    for (const entry of [...entries].sort((a, b) => b.wallMs - a.wallMs).slice(0, 10)) {
        out.push(`- \`${entry.id}\` @ ${entry.scale}: ${formatSeconds(entry.wallMs)} (setup ${formatSeconds(entry.setupMs)})`);
    }

    out.push('');

    return out;
}

/**
 * Every scenario is meant to run on three data sizes. One whose scale parameters are the same at every
 * scale of the run measured the same thing several times, unless it says why its work cannot depend on
 * the data (`sizeIndependent`).
 */
function renderSizeCheck(comparisons: ScenarioComparison[], scales: string[]): string[] {
    if (scales.length < 2) {
        return [];
    }

    const flat: string[] = [];
    const declared: string[] = [];

    for (const id of [...new Set(comparisons.map((comparison) => comparison.id))].sort()) {
        const ofId = comparisons.filter((comparison) => comparison.id === id);
        const distinctParams = new Set(ofId.map((comparison) => JSON.stringify(comparison.params)));

        if (ofId[0].sizeIndependent) {
            declared.push(`- \`${id}\`: ${ofId[0].sizeIndependent}`);
        } else if (distinctParams.size < ofId.length) {
            const params = ofId.map((comparison) => `${comparison.scale} ${JSON.stringify(comparison.params)}`).join(', ');
            flat.push(`- \`${id}\`: ${params}`);
        }
    }

    const out: string[] = ['## Size check', ''];

    if (flat.length > 0) {
        out.push(`**${flat.length} scenarios have the same scale parameters at two or more scales**, so those scales measured the same work:`, '', ...flat, '');
    } else {
        out.push('Every scenario ran with different scale parameters at every scale.', '');
    }

    if (declared.length > 0) {
        out.push('Size-independent by design:', '', ...declared, '');
    }

    return out;
}

function renderMarkdown(runId: string, lines: ResultLine[], comparisons: ScenarioComparison[]): string {
    const first = lines[0];
    const scales = listScales(lines);
    const areas = [...new Set(comparisons.map((comparison) => comparison.area))].sort();
    const ids = [...new Set(comparisons.map((comparison) => comparison.id))].sort();
    const flagged = comparisons.filter((comparison) => comparison.flag === 'faster' || comparison.flag === 'slower');
    const findComparison = (id: string, scale: string) => comparisons.find((comparison) => comparison.id === id && comparison.scale === scale);

    const out: string[] = [];
    out.push(`# Onyx perf report - ${runId}`);
    out.push('');
    out.push(`- Scales: ${scales.map((scale) => `\`${scale}\``).join(', ')}`);
    out.push(`- Rounds: ${[...new Set(lines.map((line) => line.round))].sort((a, b) => a - b).join(', ')}`);
    out.push(`- Arms: ${[...new Set(lines.map((line) => line.arm))].sort().join(' vs ')}`);
    out.push(`- Node ${first.nodeVersion} on ${first.platform}, ${first.cpuModel}`);
    out.push(`- Flag rule: pooled median delta above ${(RELATIVE_FLOOR * 100).toFixed(0)}% and above ${MAD_MULTIPLIER}x the larger MAD, with the same direction in every round`);
    out.push(`- Flagged: ${flagged.length} of ${comparisons.length} scenario-scale rows (${ids.length} scenarios)`);
    out.push('- Paired: median of the per-round deltas, with the number of rounds whose delta has that sign over the rounds both arms share');
    out.push('');

    out.push('## Flagged');
    out.push('');

    if (flagged.length === 0) {
        out.push('Nothing flagged.');
    }

    for (const comparison of flagged) {
        out.push(
            `- **${formatFlag(comparison.flag)}** \`${comparison.id}\` @ ${comparison.scale}: ${formatMs(comparison.baseline?.median)} -> ${formatMs(
                comparison.candidate?.median,
            )}, paired ${formatPaired(comparison.paired)}`,
        );
    }

    out.push('');

    for (const area of areas) {
        const areaIds = ids.filter((id) => comparisons.some((comparison) => comparison.id === id && comparison.area === area));

        out.push(`## ${area}`);
        out.push('');
        out.push(`| scenario | ${scales.join(' | ')} |`);
        out.push(`| --- | ${scales.map(() => '---').join(' | ')} |`);

        for (const id of areaIds) {
            out.push(`| \`${id}\` | ${scales.map((scale) => formatOverviewCell(findComparison(id, scale))).join(' | ')} |`);
        }

        out.push('');
        out.push('<details><summary>medians per scale</summary>');
        out.push('');
        out.push('| scenario | scale | baseline median | candidate median | delta | paired | flag |');
        out.push('| --- | --- | --- | --- | --- | --- | --- |');

        for (const comparison of comparisons.filter((entry) => entry.area === area)) {
            out.push(
                `| \`${comparison.id}\` | ${comparison.scale} | ${formatArm(comparison.baseline)} | ${formatArm(comparison.candidate)} | ${formatDelta(comparison)} | ${formatPaired(
                    comparison.paired,
                )} | ${formatFlag(comparison.flag)} |`,
            );
        }

        out.push('');
        out.push('</details>');
        out.push('');
    }

    out.push(...renderSizeCheck(comparisons, scales));
    out.push(...renderCost(lines, scales));

    out.push('## Scenario titles, scale and real usage');
    out.push('');

    for (const id of ids) {
        const ofId = scales.map((scale) => findComparison(id, scale)).filter((comparison) => comparison !== undefined);
        const params = ofId
            .map((comparison) => {
                const values = Object.entries(comparison.params)
                    .map(([name, value]) => `${name}=${value}`)
                    .join(', ');
                return `${comparison.scale}: ${values || 'no scale parameters'}`;
            })
            .join('; ');
        out.push(`- \`${id}\` - ${ofId[0]?.title ?? ''} (${params}). ${formatAnchors(ofId[0]?.realUsage ?? [])}`);
    }

    out.push('');

    return out.join('\n');
}

function updateLatestSymlink(resultsDir: string, runId: string): void {
    const latest = path.join(resultsDir, 'latest');

    if (fs.existsSync(latest) || fs.lstatSync(latest, {throwIfNoEntry: false})) {
        fs.rmSync(latest, {recursive: true, force: true});
    }

    fs.symlinkSync(runId, latest, 'dir');
}

function main(): void {
    const runId = process.argv[2];

    if (!runId) {
        throw new Error('Usage: node perf-suite/scripts/compare.ts <run-id>');
    }

    const here = path.dirname(fileURLToPath(import.meta.url));
    const resultsDir = path.join(here, '..', 'results');
    const runDir = path.join(resultsDir, runId);

    if (!fs.existsSync(runDir)) {
        throw new Error(`No results directory at ${runDir}`);
    }

    const lines = readLines(runDir);

    if (lines.length === 0) {
        throw new Error(`No NDJSON result lines found in ${runDir}`);
    }

    const comparisons = compare(lines);
    const reportPath = path.join(runDir, 'REPORT.md');

    fs.writeFileSync(reportPath, renderMarkdown(runId, lines, comparisons), 'utf8');
    fs.writeFileSync(
        path.join(runDir, 'report.json'),
        `${JSON.stringify(
            {
                runId,
                scales: listScales(lines),
                nodeVersion: lines[0].nodeVersion,
                platform: lines[0].platform,
                cpuModel: lines[0].cpuModel,
                relativeFloor: RELATIVE_FLOOR,
                madMultiplier: MAD_MULTIPLIER,
                scenarios: comparisons,
            },
            null,
            4,
        )}\n`,
        'utf8',
    );

    updateLatestSymlink(resultsDir, runId);

    process.stdout.write(`${reportPath}\n`);
}

main();
