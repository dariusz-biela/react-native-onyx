import {build} from 'esbuild';
import {createRequire} from 'module';
import path from 'path';

/**
 * Runs the browser lanes (`browser/runner.ts`). Node strips the types of this file only, so the runner and the
 * harness it shares with the Jest lanes, written with extensionless imports, are bundled first.
 */
const perfSuiteDir = path.resolve(import.meta.dirname, '..');
const runnerFile = path.join(perfSuiteDir, '.build/browser/runner.cjs');

await build({
    entryPoints: [path.join(perfSuiteDir, 'browser/runner.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external',
    outfile: runnerFile,
    logLevel: 'error',
});

const runner: unknown = createRequire(import.meta.url)(runnerFile);

if (typeof runner !== 'object' || runner === null || !('default' in runner) || typeof runner.default !== 'function') {
    throw new Error(`${runnerFile} has no default export to run`);
}

await runner.default(perfSuiteDir);
