const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { configureRealEasyCrypt } = require('../../shared/realEasyCrypt');

async function createTempEcFile(content, filename = 'buttons.ec') {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-buttons-e2e-'));
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

async function waitForProofStateSnapshot(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
    if (predicate(snap)) return snap;
    await new Promise((r) => setTimeout(r, 50));
  }
  return vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
}

async function waitForExecutionOffset(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const offset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
    if (predicate(offset)) return offset;
    await new Promise((r) => setTimeout(r, 50));
  }
  return vscode.commands.executeCommand('easycrypt._getExecutionOffset');
}

describe('Proof Navigation Buttons UI', function () {
  this.timeout(60_000);

  before(async function () {
    const easycryptPath = await configureRealEasyCrypt();
    if (!easycryptPath) {
      this.skip();
      return;
    }

    const ext = vscode.extensions.getExtension('tornado.easycrypt-vscode');
    assert.ok(ext, 'Extension tornado.easycrypt-vscode should be present');
    await ext.activate();
  });

  it('navigates using simulated webview messages', async function () {
    const { path: filePath, cleanup } = await createTempEcFile(
      [
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n')
    );

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      // Ensure starting state is 0.
      let offset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.equal(offset, 0);

      // 1. Simulate "Step Forward" button click
      // Note: The first step might take a moment to start the process
      await vscode.commands.executeCommand('easycrypt._simulateWebviewMessage', {
        type: 'nav',
        action: 'stepForward'
      });

      offset = await waitForExecutionOffset((value) => typeof value === 'number' && value > 0, 10_000);
      assert.ok(offset > 0, 'Offset should increase after Step Forward button click');
      const offsetAfterStep1 = offset;

      // 2. Simulate "Step Forward" again
      await vscode.commands.executeCommand('easycrypt._simulateWebviewMessage', {
        type: 'nav',
        action: 'stepForward'
      });

      offset = await waitForExecutionOffset((value) => typeof value === 'number' && value > offsetAfterStep1, 10_000);
      assert.ok(offset > offsetAfterStep1, 'Offset should increase again');
      const offsetAfterStep2 = offset;

      // 3. Simulate "Step Backward"
      await vscode.commands.executeCommand('easycrypt._simulateWebviewMessage', {
        type: 'nav',
        action: 'stepBackward'
      });

      offset = await waitForExecutionOffset((value) => value === offsetAfterStep1, 10_000);
      assert.equal(offset, offsetAfterStep1, 'Offset should return to previous step');

      // 4. Simulate "Reset"
      await vscode.commands.executeCommand('easycrypt._simulateWebviewMessage', {
        type: 'nav',
        action: 'resetProof'
      });

      offset = await waitForExecutionOffset((value) => value === 0, 10_000);
      assert.equal(offset, 0, 'Offset should be 0 after Reset');

      // 5. Verify buttons still work after Reset (Bug Fix Verification)
      // If the bug exists, the webview would disable buttons and this command would be ignored
      // (Wait, the provider ignores it if !hasContext. The bug was that hasContext became false).
      
      // We can't check the webview UI state directly, but we can check if the action works.
      // If hasContext is false, the provider logs a warning/info and returns early.
      
      await vscode.commands.executeCommand('easycrypt._simulateWebviewMessage', {
        type: 'nav',
        action: 'stepForward'
      });

      offset = await waitForExecutionOffset((value) => typeof value === 'number' && value > 0, 10_000);
      assert.ok(offset > 0, 'Step Forward should work after Reset (context should be preserved)');

    } finally {
      await cleanup();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
