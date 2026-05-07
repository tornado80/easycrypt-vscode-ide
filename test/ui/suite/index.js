const path = require('node:path');

const Mocha = require('mocha');

function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 90_000,
  });

  const testsRoot = __dirname;

  mocha.addFile(path.resolve(testsRoot, 'diagnostics.ui.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'diagnosticsApiParity.ui.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'proofNavigation.ui.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'moduleImports.ui.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'proofNavigationButtons.ui.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'perFileSessionIsolation.ui.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'lspNoFallback.ui.test.js'));

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} UI test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { run };
