const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
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

async function resolveEasycryptPath() {
  return process.env.EASYCRYPT_PATH || process.env.EASYCRYPT_REAL_PATH || (await which('easycrypt'));
}

function getErrorDiagnostics(uri) {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((diag) => diag.severity === vscode.DiagnosticSeverity.Error);
}

async function waitForNoErrorDiagnostics(uri, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const errors = getErrorDiagnostics(uri);
    if (errors.length === 0) {
      return errors;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return getErrorDiagnostics(uri);
}

async function createRealKemDemFixtureCopy(mutateSource) {
  const srcDir = path.resolve(__dirname, '..', '..', 'kem-dem', 'left-or-right');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-proofnav-real-kemdem-'));
  const dstDir = path.join(tmpDir, 'left-or-right');
  await fs.cp(srcDir, dstDir, { recursive: true });

  const filePath = path.join(dstDir, 'KEMDEM_lor.ec');
  let source = await fs.readFile(filePath, 'utf8');
  if (typeof mutateSource === 'function') {
    source = mutateSource(source);
    await fs.writeFile(filePath, source, 'utf8');
  }

  return {
    filePath,
    source,
    cleanup: async () => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };
}

describe('Interactive Proof Navigation E2E (real easycrypt)', function () {
  this.timeout(240_000);

  const optInPrgRecoveryEasycryptPath = process.env.EASYCRYPT_REAL_PATH;
  const optInStopOnFirstError = process.env.EASYCRYPT_REAL_STOP_ON_FIRST_ERROR;

  if (optInPrgRecoveryEasycryptPath) {
    it('PRG.ec goToCursor then stepBackward preserves final tail output in proof state snapshot', async function () {
      const easycryptPath = optInPrgRecoveryEasycryptPath;

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
  }

  if (optInStopOnFirstError) {
    it('KEMDEM_lor.ec goToCursor stops on first failing statement and runtime remains usable', async function () {
      const easycryptPath = await resolveEasycryptPath();
      if (!easycryptPath) {
        this.skip();
        return;
      }

      await configureRealEasyCrypt(easycryptPath);

      const ext = vscode.extensions.getExtension('tornado.easycrypt-vscode');
      assert.ok(ext, 'Extension tornado.easycrypt-vscode should be present');
      await ext.activate();

      const mutateSource = (source) => {
        const needle = '  by sim.';
        const index = source.indexOf(needle);
        assert.ok(index >= 0, 'Expected a stable by sim. line in KEMDEM_lor.ec');
        return source.slice(0, index) + '  by this_is_not_a_tactic.' + source.slice(index + needle.length);
      };

      const { filePath, source, cleanup } = await createRealKemDemFixtureCopy(mutateSource);

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
        const editor = await vscode.window.showTextDocument(doc);

        const failLine = source.slice(0, source.indexOf('this_is_not_a_tactic')).split('\n').length - 1;

        await vscode.commands.executeCommand('easycrypt.resetProof');

        const endPosition = doc.positionAt(source.length);
        editor.selection = new vscode.Selection(endPosition, endPosition);

        const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
        assert.ok(forward && forward.success === false, `Expected goToCursor failure, got: ${JSON.stringify(forward)}`);

        const verifiedRange = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
        assert.ok(verifiedRange, 'Expected a verified range after partial replay');
        assert.ok(
          verifiedRange.end.line <= failLine,
          `Expected verified range to stop before failing line ${failLine}, got ${JSON.stringify(verifiedRange)}`
        );

        const snapshot = await waitForProofStateSettled(120_000);
        const text = Array.isArray(snapshot?.outputLines) ? snapshot.outputLines.join('\n') : '';
        assert.ok(
          /current goal|goal/i.test(text),
          `Expected snapshot to contain a real goal block, got: ${text.slice(-2000)}`
        );
        assert.ok(
          /error|cannot|unknown|invalid|fail/i.test(text),
          `Expected snapshot to include a real error text, got: ${text.slice(-2000)}`
        );

        const reset = await vscode.commands.executeCommand('easycrypt.resetProof');
        assert.ok(reset && reset.success, `Expected resetProof success after failure, got: ${JSON.stringify(reset)}`);

        const step = await vscode.commands.executeCommand('easycrypt.stepForward');
        assert.ok(step && step.success, `Expected stepForward success after resetProof, got: ${JSON.stringify(step)}`);
      } finally {
        await vscode.commands.executeCommand('easycrypt.stopProcess');
        await cleanup();
      }
    });
  }

  it('KEMDEM_lor.ec check and stepping remain import-resolved across directory switch', async function () {
    const easycryptPath = await resolveEasycryptPath();
    if (!easycryptPath) {
      this.skip();
      return;
    }

    await configureRealEasyCrypt(easycryptPath);

    const ext = vscode.extensions.getExtension('tornado.easycrypt-vscode');
    assert.ok(ext, 'Extension tornado.easycrypt-vscode should be present');
    await ext.activate();

    const kemDemPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'test',
      'kem-dem',
      'left-or-right',
      'KEMDEM_lor.ec'
    );
    const prgPath = path.resolve(__dirname, '..', '..', '..', 'test', 'PRG.ec');

    const kemDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(kemDemPath));
    await vscode.languages.setTextDocumentLanguage(kemDoc, 'easycrypt');
    await vscode.window.showTextDocument(kemDoc);

    try {
      await vscode.commands.executeCommand('easycrypt.clearAllDiagnostics');
      await vscode.commands.executeCommand('easycrypt.checkFile');
      await new Promise((r) => setTimeout(r, 600));

      const postCheckErrors = await waitForNoErrorDiagnostics(kemDoc.uri, 30_000);
      assert.equal(
        postCheckErrors.length,
        0,
        `Expected no error diagnostics after checkFile on KEMDEM_lor.ec, got: ${JSON.stringify(postCheckErrors.map((d) => d.message))}`
      );

      await vscode.commands.executeCommand('easycrypt.resetProof');

      const step1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      const step2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(step1 && step1.success, `Expected first KEMDEM stepForward success, got: ${JSON.stringify(step1)}`);
      assert.ok(step2 && step2.success, `Expected second KEMDEM stepForward success, got: ${JSON.stringify(step2)}`);

      const prgDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(prgPath));
      await vscode.languages.setTextDocumentLanguage(prgDoc, 'easycrypt');
      await vscode.window.showTextDocument(prgDoc);

      const prgStep = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(prgStep && prgStep.success, `Expected PRG stepForward success after switch, got: ${JSON.stringify(prgStep)}`);

      await vscode.window.showTextDocument(kemDoc);
      const stepAfterReturn = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(
        stepAfterReturn && stepAfterReturn.success,
        `Expected KEMDEM stepForward success after returning from PRG, got: ${JSON.stringify(stepAfterReturn)}`
      );

      const finalErrors = getErrorDiagnostics(kemDoc.uri);
      assert.equal(
        finalErrors.length,
        0,
        `Expected no KEMDEM error diagnostics after stepping and directory switch, got: ${JSON.stringify(finalErrors.map((d) => d.message))}`
      );
    } finally {
      await vscode.commands.executeCommand('easycrypt.stopProcess');
    }
  });
});
