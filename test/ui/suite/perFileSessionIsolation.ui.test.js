const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vscode = require('vscode');
const { configureRealEasyCrypt } = require('../../shared/realEasyCrypt');

async function createTempEcFile(content, filename) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-per-file-session-e2e-'));
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, content, 'utf8');

  return {
    uri: vscode.Uri.file(filePath),
    cleanup: async () => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };
}

async function showEasyCryptDocument(uri) {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
  return vscode.window.showTextDocument(doc);
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return predicate();
}

describe('Per-File Session Isolation UI', function () {
  this.timeout(90_000);

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

  afterEach(async function () {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('does not paint verified region in a different file', async function () {
    const fileA = await createTempEcFile(
      ['lemma ta_marker : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'isolation-A.ec'
    );
    const fileB = await createTempEcFile(
      ['lemma tb_marker : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'isolation-B.ec'
    );

    try {
      await showEasyCryptDocument(fileA.uri);
      const stepResult = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(stepResult && stepResult.success, `Expected stepForward success in file A, got ${JSON.stringify(stepResult)}`);

      const rangeInA = await waitFor(
        () => vscode.commands.executeCommand('easycrypt._getVerifiedRange'),
        10_000
      );
      assert.ok(rangeInA, 'Expected verified range in file A after stepping');

      await showEasyCryptDocument(fileB.uri);

      const rangeInB = await waitFor(
        async () => {
          const range = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
          return range === null ? range : undefined;
        },
        10_000
      );

      assert.strictEqual(rangeInB, null, 'Expected no verified range in file B before stepping');
    } finally {
      await fileA.cleanup();
      await fileB.cleanup();
    }
  });

  it('preserves independent execution offsets per file', async function () {
    const fileA = await createTempEcFile(
      ['lemma ta : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'offset-A.ec'
    );
    const fileB = await createTempEcFile(
      ['lemma tb : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'offset-B.ec'
    );

    try {
      await showEasyCryptDocument(fileA.uri);
      const a1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      const a2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(a1 && a1.success);
      assert.ok(a2 && a2.success);
      const offsetA = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(offsetA > 0, 'Expected non-zero offset for file A');

      await showEasyCryptDocument(fileB.uri);
      const offsetBBefore = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.strictEqual(offsetBBefore, 0, 'Expected fresh session offset=0 for file B before stepping');

      const b1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(b1 && b1.success);
      const offsetB = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(offsetB > 0, 'Expected non-zero offset for file B after stepping');

      await showEasyCryptDocument(fileA.uri);
      const offsetAAfterSwitch = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.strictEqual(offsetAAfterSwitch, offsetA, 'Expected file A offset to be restored on tab switch');

      await showEasyCryptDocument(fileB.uri);
      const offsetBAfterSwitch = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.strictEqual(offsetBAfterSwitch, offsetB, 'Expected file B offset to be restored on tab switch');
    } finally {
      await fileA.cleanup();
      await fileB.cleanup();
    }
  });

  it('keeps proof-state snapshots stable across file session switches', async function () {
    const fileA = await createTempEcFile(
      ['lemma ta_ctx : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'context-A.ec'
    );
    const fileB = await createTempEcFile(
      ['lemma tb_ctx : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'context-B.ec'
    );

    try {
      await showEasyCryptDocument(fileA.uri);
      const stepA = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(stepA && stepA.success);

      const snapA = await waitFor(() => vscode.commands.executeCommand('easycrypt._getProofStateSnapshot'), 10_000);
      assert.ok(snapA && snapA.isProcessing === false, `Expected settled proof snapshot for file A, got ${JSON.stringify(snapA)}`);
      assert.ok(typeof snapA.provedStatementCount === 'number' && snapA.provedStatementCount >= 1);

      await showEasyCryptDocument(fileB.uri);
      const stepB = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(stepB && stepB.success);

      const snapB = await waitFor(() => vscode.commands.executeCommand('easycrypt._getProofStateSnapshot'), 10_000);
      assert.ok(snapB && snapB.isProcessing === false, `Expected settled proof snapshot for file B, got ${JSON.stringify(snapB)}`);
      assert.ok(typeof snapB.provedStatementCount === 'number' && snapB.provedStatementCount >= 1);
    } finally {
      await fileA.cleanup();
      await fileB.cleanup();
    }
  });

  it('stopping file A session does not break stepping in file B', async function () {
    const fileA = await createTempEcFile(
      ['lemma ta_stop : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'stop-A.ec'
    );
    const fileB = await createTempEcFile(
      ['lemma tb_stop : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'stop-B.ec'
    );

    try {
      await showEasyCryptDocument(fileA.uri);
      const stepA = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(stepA && stepA.success);

      await vscode.commands.executeCommand('easycrypt.stopProcess');

      await showEasyCryptDocument(fileB.uri);
      const stepB = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(stepB && stepB.success, `Expected stepping in B to succeed after stopping A, got ${JSON.stringify(stepB)}`);
    } finally {
      await fileA.cleanup();
      await fileB.cleanup();
    }
  });
});
