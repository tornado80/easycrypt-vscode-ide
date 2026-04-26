const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vscode = require('vscode');

async function createTempEcFile(content, filename = 'lsp-no-fallback.ec') {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-lsp-nofallback-e2e-'));
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, content, 'utf8');

  return {
    path: filePath,
    cleanup: async () => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function applyEasyCryptOverrides(overrides) {
  const cfg = vscode.workspace.getConfiguration('easycrypt');
  const previous = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = cfg.get(key);
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  }

  return async () => {
    for (const [key, value] of Object.entries(previous)) {
      await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    }
  };
}

describe('LSP Channel E2E (no fallback)', function () {
  this.timeout(60_000);

  it('does not auto-switch to emacs when LSP startup fails', async function () {
    const ext = vscode.extensions.getExtension('tornado.easycrypt-vscode');
    assert.ok(ext, 'Extension tornado.easycrypt-vscode should be present');
    await ext.activate();

    const mockPath = path.resolve(__dirname, '..', '..', 'fixtures', 'mock_easycrypt.js');
    try {
      await fs.chmod(mockPath, 0o755);
    } catch {
      // best-effort
    }

    const restoreConfig = await applyEasyCryptOverrides({
      executablePath: mockPath,
      arguments: [],
      proverArgs: [],
      'communication.channel': 'lsp',
      'lsp.serverArgs': [],
      'lsp.requestTimeoutMs': 2_000,
    });

    const { path: filePath, cleanup } = await createTempEcFile(
      [
        'require import A.',
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n')
    );

    try {
      await vscode.commands.executeCommand('easycrypt.stopProcess');

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      const beforeOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.equal(beforeOffset, 0);

      const result = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(!result || result.success === false, `Expected LSP stepForward failure, got: ${JSON.stringify(result)}`);

      const afterOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.equal(afterOffset, 0, `Expected execution offset to stay at 0 after LSP failure; got ${afterOffset}`);

      const verifiedRange = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
      assert.equal(
        verifiedRange,
        null,
        `Expected no verified range after failed LSP stepForward. Got: ${JSON.stringify(verifiedRange)}`
      );
    } finally {
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await cleanup();
      await restoreConfig();
    }
  });
});
