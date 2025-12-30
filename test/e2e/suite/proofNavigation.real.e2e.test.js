const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const vscode = require('vscode');

function which(cmd) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-lc', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else resolve(undefined);
    });
  });
}

async function configureRealEasyCrypt(easycryptPath) {
  const cfg = vscode.workspace.getConfiguration('easycrypt');
  await cfg.update('executablePath', easycryptPath, vscode.ConfigurationTarget.Global);
  await cfg.update('arguments', [], vscode.ConfigurationTarget.Global);
  await cfg.update('proverArgs', [], vscode.ConfigurationTarget.Global);
}

async function waitForProofStateSettled(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
    if (snapshot && snapshot.isProcessing === false) return snapshot;
    await new Promise((r) => setTimeout(r, 100));
  }
  return vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
}

describe('Interactive Proof Navigation E2E (real easycrypt)', function () {
  this.timeout(240_000);

  it('PRG.ec goToCursor then stepBackward preserves final tail output in proof state snapshot', async function () {
    // This test is intentionally opt-in: it requires a real EasyCrypt binary and
    // is too heavyweight / environment-specific for default CI runs.
    const easycryptPath = process.env.EASYCRYPT_REAL_PATH;
    if (!easycryptPath) {
      this.skip();
      return;
    }

    await configureRealEasyCrypt(easycryptPath);

    const ext = vscode.extensions.getExtension('tornado.easycrypt-vscode');
    assert.ok(ext, 'Extension tornado.easycrypt-vscode should be present');
    await ext.activate();

    const prgPath = path.resolve(__dirname, '..', '..', '..', 'test', 'PRG.ec');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(prgPath));
    await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
    const editor = await vscode.window.showTextDocument(doc);

    try {
      // Start from a known state.
      await vscode.commands.executeCommand('easycrypt.resetProof');

      // Repro setup: place the cursor *inside* the statement right after `inv`.
      // In test/PRG.ec, `local lemma Plog_Psample ...` starts at ~6195 and ends at 6367.
      // Using positionAt avoids depending on exact line numbers.
      const targetPos = doc.positionAt(6205);
      editor.selection = new vscode.Selection(targetPos, targetPos);

      const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(forward && forward.success, `Expected goToCursor success, got: ${JSON.stringify(forward)}`);
      assert.ok(typeof forward.executionOffset === 'number' && forward.executionOffset > 0, 'Expected goToCursor to return an executionOffset');
      assert.equal(
        forward.executionOffset,
        6367,
        `Expected goToCursor to land at end of Plog_Psample (6367). got=${forward.executionOffset}`
      );

      const back = await vscode.commands.executeCommand('easycrypt.stepBackward');
      assert.ok(back && back.success, `Expected stepBackward success, got: ${JSON.stringify(back)}`);
      assert.ok(typeof back.executionOffset === 'number' && back.executionOffset > 0, 'Expected stepBackward to return an executionOffset');

      // The known statement boundary in test/PRG.ec: inv statement ends at offset 6191.
      // This matches the user repro where stepBackward triggers recovery + replay to this point.
      assert.equal(
        back.executionOffset,
        6191,
        `Expected stepBackward to land on inv statement end (6191). goToCursor=${forward.executionOffset}, stepBackward=${back.executionOffset}`
      );

      const snapshot = await waitForProofStateSettled(180_000);
      assert.ok(snapshot, 'Expected proof state snapshot after recovery');
      assert.equal(snapshot.isProcessing, false, 'Expected proof state to be settled');

      const text = Array.isArray(snapshot.outputLines) ? snapshot.outputLines.join('\n') : '';

      // This marker is the specific tail output from the reported repro.
      // Accept a stable substring to reduce version sensitivity.
      assert.ok(
        /added predicate\s+inv/i.test(text),
        `Expected final tail output to include "added predicate inv". Got:\n${text.slice(-2000)}`
      );
    } finally {
      await vscode.commands.executeCommand('easycrypt.stopProcess');
    }
  });
});
