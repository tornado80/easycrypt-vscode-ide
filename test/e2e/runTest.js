const path = require('node:path');

const { runTests } = require('@vscode/test-electron');

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [],
    });
  } catch (err) {
    console.error('Failed to run E2E tests');
    console.error(err);
    process.exit(1);
  }
}

main();
