const path = require('node:path');

const Mocha = require('mocha');

function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 60_000,
  });

  const testsRoot = __dirname;

  // Real EasyCrypt E2E suites only (no mock binary usage).
  mocha.addFile(path.resolve(testsRoot, 'easycrypt.e2e.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'proofNavigation.real.e2e.test.js'));
  mocha.addFile(path.resolve(testsRoot, '..', '..', 'integration', 'suite', 'moduleImports.integration.test.js'));
  mocha.addFile(path.resolve(testsRoot, '..', '..', 'integration', 'suite', 'proofNavigationButtons.integration.test.js'));
  mocha.addFile(path.resolve(testsRoot, '..', '..', 'integration', 'suite', 'perFileSessionIsolation.integration.test.js'));
  mocha.addFile(path.resolve(testsRoot, '..', '..', 'integration', 'suite', 'lspNoFallback.integration.test.js'));

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} E2E test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { run };
