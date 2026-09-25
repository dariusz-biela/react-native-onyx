import fs from 'fs';
import path from 'path';

const SUITES_DIR = path.resolve(__dirname, '../suites');

/**
 * Suites that call `jest.resetModules()` in their iterations. In a shared registry that would hand every
 * later lazy `require` a second copy of Onyx, so each of them keeps a Jest file, and a registry, of its own.
 */
const ISOLATED_SUITES = ['api/init.perf.ts', 'flows/boot.perf.ts'];

function listSuiteFiles(directory: string): string[] {
    return fs
        .readdirSync(directory, {withFileTypes: true})
        .flatMap((entry) => {
            const entryPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                return listSuiteFiles(entryPath);
            }

            return /\.perf\.tsx?$/.test(entry.name) ? [entryPath] : [];
        })
        .sort((a, b) => a.localeCompare(b));
}

function toSuiteId(file: string): string {
    return path.relative(SUITES_DIR, file);
}

/** Every suite file that can share one module registry with the others, in path order. */
function getSharedSuiteFiles(): string[] {
    return listSuiteFiles(SUITES_DIR).filter((file) => !ISOLATED_SUITES.includes(toSuiteId(file)));
}

function getSuiteFile(suiteId: string): string {
    return path.join(SUITES_DIR, suiteId);
}

/**
 * Registers the given suite files inside one Jest test file, each under a `describe` named after it, so
 * the `beforeAll` a suite registers still runs right before that suite's own scenarios. Jest builds a
 * test file's environment, runs the App's setup files and loads the App's module graph once per file,
 * about half a second each time, which over 56 files was a third of a small-scale run.
 *
 * ONYX_PERF_FILES narrows the files the way `jest --testPathPattern` did: a regular expression tested
 * against each suite file's absolute path.
 */
function loadSuites(files: readonly string[]): void {
    const pattern = process.env.ONYX_PERF_FILES ? new RegExp(process.env.ONYX_PERF_FILES) : undefined;
    const selected = files.filter((file) => !pattern || pattern.test(file));

    if (selected.length === 0) {
        it.skip(`no suite file here matches ONYX_PERF_FILES="${process.env.ONYX_PERF_FILES ?? ''}"`, () => {});
        return;
    }

    for (const file of selected) {
        describe(toSuiteId(file), () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require(file);
        });
    }
}

export {getSharedSuiteFiles, getSuiteFile, loadSuites};
