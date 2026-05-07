const os = require('node:os');
const path = require('node:path');

const { runTests } = require('@vscode/test-electron');

function resolveUserDataDir() {
  const fromEnv = process.env.EASYCRYPT_UI_USER_DATA_DIR?.trim() || process.env.EASYCRYPT_E2E_USER_DATA_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  // Keep this path short to stay below platform IPC socket limits.
  if (process.platform === 'win32') {
    return path.join(os.tmpdir(), 'easycrypt-vscode-ui-user');
  }

  return '/tmp/easycrypt-vscode-ui-user';
}

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
    const userDataDir = resolveUserDataDir();

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--user-data-dir', userDataDir],
    });
  } catch (err) {
    console.error('Failed to run UI tests');
    console.error(err);
    process.exit(1);
  }
}

main();
