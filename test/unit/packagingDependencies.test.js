const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');

describe('VSIX packaging configuration', function () {
    it('does not exclude all node_modules from .vscodeignore', function () {
        const ignorePath = path.resolve(__dirname, '..', '..', '.vscodeignore');
        const raw = fs.readFileSync(ignorePath, 'utf8');
        const rules = raw
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith('#'));

        const excludesAllNodeModules = rules.some((rule) => (
            rule === 'node_modules/**'
            || rule === '/node_modules/**'
            || rule === '**/node_modules/**'
        ));

        assert.strictEqual(
            excludesAllNodeModules,
            false,
            '.vscodeignore excludes all node_modules. This strips runtime dependencies such as vscode-languageclient from the VSIX.'
        );
    });

    it('keeps vscode-languageclient as a production dependency', function () {
        const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

        assert.ok(
            packageJson.dependencies && packageJson.dependencies['vscode-languageclient'],
            'package.json must declare vscode-languageclient in dependencies for VSIX runtime.'
        );
    });
});
