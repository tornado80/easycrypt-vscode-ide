const path = require('node:path');

const Mocha = require('mocha');

function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 60_000,
  });

  const testsRoot = __dirname;
  
  // Add all e2e test files
  mocha.addFile(path.resolve(testsRoot, 'easycrypt.e2e.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'diagnostics.e2e.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'proofNavigation.e2e.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'proofNavigation.real.e2e.test.js'));
  mocha.addFile(path.resolve(testsRoot, 'proofNavigationButtons.e2e.test.js'));

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
