import type {BrowserContext, Page} from 'playwright-core';

import fs from 'fs';
import os from 'os';
import path from 'path';
import {chromium} from 'playwright-core';

import type {LaneDriver} from '../harness/laneLoop';
import type {MeasureOptions} from '../harness/measureOptions';
import type {PageScenario} from './page/api';

/** Any origin works, the runner answers every request itself; `localhost` counts as a secure context. */
const ORIGIN = 'http://localhost:9000';

/**
 * `performance.now()` is coarsened to 100µs on a page that is not cross-origin isolated, and to 5µs on one
 * that is; the rows measure single-digit milliseconds, so the page is always served isolated.
 */
const ISOLATION_HEADERS = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
};

const CHROMIUM_ARGS = [
    '--js-flags=--expose-gc',
    '--enable-precise-memory-info',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
];

const PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/bundle.js"></script></body></html>';

type Lane = {
    arm: string;
    page: Page;
    close: () => Promise<void>;
};

/** The `ONYX_PERF_*` variables the page's harness reads through `process.env`, e.g. the scale profile. */
function collectPageEnv(): Record<string, string> {
    const env: Record<string, string> = {NODE_ENV: 'production'};

    for (const [name, value] of Object.entries(process.env)) {
        if (name.startsWith('ONYX_PERF_') && value !== undefined) {
            env[name] = value;
        }
    }

    return env;
}

async function serveBundle(context: BrowserContext, bundleFile: string): Promise<void> {
    const bundle = fs.readFileSync(bundleFile);

    await context.route(`${ORIGIN}/**`, (route) => {
        const {pathname} = new URL(route.request().url());

        if (pathname === '/') {
            return route.fulfill({status: 200, headers: {...ISOLATION_HEADERS, 'Content-Type': 'text/html'}, body: PAGE_HTML});
        }

        if (pathname === '/bundle.js') {
            return route.fulfill({status: 200, headers: {...ISOLATION_HEADERS, 'Content-Type': 'text/javascript'}, body: bundle});
        }

        return route.fulfill({status: 404});
    });
}

function forwardPageErrors(arm: string, page: Page): void {
    page.on('pageerror', (error) => console.error(`[${arm}] page error: ${error.stack ?? error.message}`));
    page.on('console', (message) => {
        if (message.type() === 'error') {
            console.error(`[${arm}] console: ${message.text()}`);
        }
    });
}

/**
 * One arm in a Chromium of its own, on a fresh persistent profile: an incognito context may keep IndexedDB in
 * memory, and the rows exist to measure the disk-backed store the App gets. Every scenario opens new lanes,
 * so no scenario inherits another one's database, heap or compiled code.
 */
async function openLane(arm: string, bundleFile: string): Promise<Lane> {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-perf-'));
    const context = await chromium.launchPersistentContext(userDataDir, {headless: true, args: CHROMIUM_ARGS});
    const close = async () => {
        await context.close();
        fs.rmSync(userDataDir, {recursive: true, force: true});
    };

    try {
        await serveBundle(context, bundleFile);
        await context.addInitScript((env) => {
            Reflect.set(globalThis, 'process', {env});
        }, collectPageEnv());

        const page = context.pages().at(0) ?? (await context.newPage());
        forwardPageErrors(arm, page);

        await page.goto(`${ORIGIN}/`);
        await page.waitForFunction(() => 'onyxPerf' in globalThis);

        const {isIsolated, hasGc} = await page.evaluate(() => ({isIsolated: globalThis.crossOriginIsolated, hasGc: typeof globalThis.gc === 'function'}));

        if (!isIsolated) {
            throw new Error(`[${arm}] the page is not cross-origin isolated, so its timers are coarsened to 100µs`);
        }

        if (!hasGc) {
            throw new Error(`[${arm}] the page has no gc(), so the collections between iterations would silently not run`);
        }

        return {arm, page, close};
    } catch (error) {
        await close();
        throw error;
    }
}

function listScenarios(lane: Lane): Promise<PageScenario[]> {
    return lane.page.evaluate(() => globalThis.onyxPerf.list());
}

function setUpScenario(lane: Lane, id: string): Promise<number> {
    return lane.page.evaluate((scenarioId) => globalThis.onyxPerf.setup(scenarioId), id);
}

function settleLane(lane: Lane, options: MeasureOptions): Promise<void> {
    return lane.page.evaluate((measureOptions) => globalThis.onyxPerf.settle(measureOptions), options);
}

/** Every step is one `page.evaluate`; its timing is taken inside the page, so the CDP round trip stays out of it. */
function toDriver(lane: Lane): LaneDriver {
    return {
        iterate: () => lane.page.evaluate(() => globalThis.onyxPerf.iterate()),
        collectGarbage: (options) => lane.page.evaluate((measureOptions) => globalThis.onyxPerf.collectGarbage(measureOptions), options),
        readHeapMb: () => lane.page.evaluate(() => globalThis.onyxPerf.readHeapMb()),
        teardown: () => lane.page.evaluate(() => globalThis.onyxPerf.teardown()),
    };
}

export {listScenarios, openLane, settleLane, setUpScenario, toDriver};
export type {Lane};
