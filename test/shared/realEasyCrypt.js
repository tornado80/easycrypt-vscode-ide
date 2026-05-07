const { spawn } = require('node:child_process');

const vscode = require('vscode');

function which(cmd) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-lc', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out.trim());
      } else {
        resolve(undefined);
      }
    });
  });
}

async function resolveEasycryptPath() {
  return process.env.EASYCRYPT_PATH || process.env.EASYCRYPT_REAL_PATH || (await which('easycrypt'));
}

async function applyEasyCryptConfig(overrides) {
  const cfg = vscode.workspace.getConfiguration('easycrypt');
  for (const [key, value] of Object.entries(overrides)) {
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

async function configureRealEasyCrypt(options = {}) {
  const easycryptPath = await resolveEasycryptPath();
  if (!easycryptPath) {
    return undefined;
  }

  await applyEasyCryptConfig({
    executablePath: easycryptPath,
    arguments: [],
    proverArgs: [],
    ...options,
  });

  return easycryptPath;
}

module.exports = {
  configureRealEasyCrypt,
  resolveEasycryptPath,
};
