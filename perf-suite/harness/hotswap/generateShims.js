'use strict';

/**
 * Mirrors every `.js` file of the arms into `outDir`, each one a shim that forwards to the active arm
 * through `runtime.js`. Called from jest.config.js before Jest resolves anything, so the shim tree exists
 * when moduleNameMapper points `react-native-onyx/dist/<file>` at it.
 */
const fs = require('fs');
const path = require('path');

function listJsFiles(dir, prefix = '') {
    const files = [];

    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const relative = path.join(prefix, entry.name);

        if (entry.isDirectory()) {
            files.push(...listJsFiles(path.join(dir, entry.name), relative));
        } else if (entry.name.endsWith('.js')) {
            files.push(relative);
        }
    }

    return files;
}

function generateShims(armDirs, outDir) {
    const runtimePath = path.join(__dirname, 'runtime.js');
    const relativePaths = new Set(armDirs.flatMap((dir) => listJsFiles(dir)));

    fs.rmSync(outDir, {recursive: true, force: true});

    for (const relativePath of relativePaths) {
        const shimPath = path.join(outDir, relativePath);
        fs.mkdirSync(path.dirname(shimPath), {recursive: true});
        fs.writeFileSync(shimPath, `module.exports = require(${JSON.stringify(runtimePath)}).createModuleShim(${JSON.stringify(relativePath)});\n`, 'utf8');
    }

    return [...relativePaths];
}

module.exports = generateShims;
