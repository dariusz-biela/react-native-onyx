import type {Plugin} from 'esbuild';

import {build} from 'esbuild';
import path from 'path';

type BundlePageInput = {
    perfSuiteDir: string;

    /** The built Onyx dist of the arm (`scripts/build-arm.sh`), which `react-native-onyx` resolves to. */
    armDir: string;
    suiteFiles: readonly string[];
    outFile: string;
};

/**
 * Resolves the aliases `jest.config.js` maps for the Jest lanes, onto the same targets: Onyx onto the arm's
 * dist, `@app/*` onto the App copy, and React onto the suite's own React 19.
 */
function createAliasPlugin({perfSuiteDir, armDir}: Pick<BundlePageInput, 'perfSuiteDir' | 'armDir'>): Plugin {
    const reactDir = path.join(perfSuiteDir, 'node_modules/react');

    return {
        name: 'onyx-perf-aliases',
        setup(pluginBuild) {
            pluginBuild.onResolve({filter: /^react-native-onyx(\/dist)?(\/.*)?$/}, async (args) => {
                const subPath = args.path.replace(/^react-native-onyx(\/dist)?\/?/, '');
                const resolved = await pluginBuild.resolve(`./${subPath || 'index'}`, {kind: args.kind, resolveDir: armDir});

                // A module only some arms have is loaded with a guarded `require` (see `harness/onyx.ts`); left
                // external, it throws at run time inside that guard, the way a missing module does under Jest.
                if (resolved.errors.length > 0 && args.kind === 'require-call') {
                    return {path: args.path, external: true};
                }

                return resolved;
            });
            pluginBuild.onResolve({filter: /^@app\//}, (args) => pluginBuild.resolve(`./${args.path.slice('@app/'.length)}`, {kind: args.kind, resolveDir: path.join(perfSuiteDir, 'app')}));
            pluginBuild.onResolve({filter: /^react-native$/}, () => ({path: path.join(perfSuiteDir, 'app/reactNative.ts')}));
            pluginBuild.onResolve({filter: /^react(\/.*)?$/}, (args) =>
                pluginBuild.resolve(`./${args.path.slice('react'.length).replace(/^\//, '') || 'index.js'}`, {kind: args.kind, resolveDir: reactDir}),
            );
        },
    };
}

function buildEntry(perfSuiteDir: string, suiteFiles: readonly string[]): string {
    const imports = suiteFiles.map((file, index) => `import suite${index} from ${JSON.stringify(file)};`);
    const suites = suiteFiles.map((file, index) => `...suite${index}`).join(', ');

    return [`import registerScenarios from ${JSON.stringify(path.join(perfSuiteDir, 'browser/page/api.ts'))};`, ...imports, `registerScenarios([${suites}]);`].join('\n');
}

/**
 * One page bundle per arm: the arm's Onyx as the web build of the App gets it (`.web.js` files first, so
 * `InstanceSync` is the `localStorage` one and storage is `IDBKeyValProvider`), the harness, and the given
 * `.browser.ts` suite files.
 */
async function bundlePage(input: BundlePageInput): Promise<void> {
    await build({
        stdin: {contents: buildEntry(input.perfSuiteDir, input.suiteFiles), resolveDir: input.perfSuiteDir, loader: 'ts', sourcefile: 'onyx-perf-page.ts'},
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'chrome120',
        outfile: input.outFile,
        logLevel: 'error',
        resolveExtensions: ['.web.js', '.web.ts', '.web.tsx', '.js', '.ts', '.tsx', '.json'],
        define: {
            'process.env.NODE_ENV': '"production"',
            global: 'globalThis',
            __DEV__: 'false',
        },
        plugins: [createAliasPlugin(input)],
    });
}

export default bundlePage;
