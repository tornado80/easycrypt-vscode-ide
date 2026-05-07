const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vscode = require('vscode');
const { configureRealEasyCrypt } = require('../../shared/realEasyCrypt');

const MODULE_NOT_FOUND_PATTERN = /module not found|unknown module|cannot find module|cannot load module|unbound module|cannot locate theory/i;

function getErrorDiagnostics(uri) {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((diag) => diag.severity === vscode.DiagnosticSeverity.Error);
}

async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return predicate();
}

async function waitForExecutionOffset(predicate, timeoutMs = 10_000) {
  return waitFor(async () => {
    const offset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
    return predicate(offset) ? offset : undefined;
  }, timeoutMs, 50);
}

async function waitForProofStateSettled(timeoutMs = 120_000) {
  return waitFor(async () => {
    const snapshot = await vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
    return snapshot && snapshot.isProcessing === false ? snapshot : undefined;
  }, timeoutMs, 100);
}

async function waitForProofStateViewSettled(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCount;
  let stableReadCount = 0;

  while (Date.now() < deadline) {
    const snapshot = await vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
    const viewUpdateCount = await vscode.commands.executeCommand('easycrypt._getProofStateViewUpdateCount');
    const isIdle = !!snapshot && snapshot.isProcessing === false;

    if (isIdle && lastCount === viewUpdateCount) {
      stableReadCount += 1;
      if (stableReadCount >= 2) {
        return viewUpdateCount;
      }
    } else {
      stableReadCount = 0;
      lastCount = viewUpdateCount;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return vscode.commands.executeCommand('easycrypt._getProofStateViewUpdateCount');
}

async function waitForNoErrorDiagnostics(uri, timeoutMs = 20_000) {
  return waitFor(async () => {
    const errors = getErrorDiagnostics(uri);
    return errors.length === 0 ? errors : undefined;
  }, timeoutMs, 100);
}

async function createTempEcFile(content, filename = 'proof-navigation.ui.ec') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-proofnav-ui-'));
  const filePath = path.join(root, filename);
  await fs.writeFile(filePath, content, 'utf8');

  return {
    filePath,
    async cleanup() {
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function createRealKemDemFixtureCopy(mutateSource) {
  const srcDir = path.resolve(__dirname, '..', '..', 'samples', 'kem-dem', 'left-or-right');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-proofnav-ui-kemdem-'));
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
    async cleanup() {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function buildMultiLemmaProgram(lemmaCount) {
  const lines = [];
  for (let i = 0; i < lemmaCount; i += 1) {
    lines.push(`lemma t${i} : true.`);
    lines.push('proof.');
    lines.push('  trivial.');
    lines.push('qed.');
    lines.push('');
  }
  return lines.join('\n');
}

describe('Proof Navigation UI (real easycrypt)', function () {
  this.timeout(180_000);

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
    await vscode.commands.executeCommand('easycrypt.stopProcess');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('steps forward/backward and reports execution offsets', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(1), 'offsets.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      const initialOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.equal(initialOffset, 0);

      const r1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(r1 && r1.success, `Expected stepForward success, got: ${JSON.stringify(r1)}`);

      const r2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(r2 && r2.success, `Expected second stepForward success, got: ${JSON.stringify(r2)}`);
      assert.ok(r2.executionOffset > r1.executionOffset);

      const r3 = await vscode.commands.executeCommand('easycrypt.stepBackward');
      assert.ok(r3 && r3.success, `Expected stepBackward success, got: ${JSON.stringify(r3)}`);
      assert.ok(r3.executionOffset < r2.executionOffset);

      editor.selection = new vscode.Selection(new vscode.Position(3, 0), new vscode.Position(3, 0));
      const r4 = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(r4 && r4.success, `Expected goToCursor success, got: ${JSON.stringify(r4)}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('auto-retracts when editing inside the verified region', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(2), 'proof-navigation-retract.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      const s1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      const s2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(s1 && s1.success);
      assert.ok(s2 && s2.success);

      const beforeEdit = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(beforeEdit > 0, 'Expected a non-zero execution offset before edit');

      await editor.edit((builder) => {
        builder.insert(new vscode.Position(0, 0), ' ');
      });

      const afterEdit = await waitForExecutionOffset((offset) => offset < beforeEdit, 12_000);
      assert.ok(afterEdit < beforeEdit, `Expected auto-retract to lower offset. before=${beforeEdit}, after=${afterEdit}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('stepBackward uses fast undo-to-state (no restart)', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(2), 'undo-fast.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('easycrypt.startProcess');

      const s1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      const s2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(s1 && s1.success);
      assert.ok(s2 && s2.success);

      const before = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      const startsBefore = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');
      const sendsBefore = await vscode.commands.executeCommand('easycrypt._getSendCommandCount');

      const back = await vscode.commands.executeCommand('easycrypt.stepBackward');
      assert.ok(back && back.success, `Expected stepBackward success, got: ${JSON.stringify(back)}`);
      assert.ok(back.executionOffset < before);

      const startsAfter = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');
      const sendsAfter = await vscode.commands.executeCommand('easycrypt._getSendCommandCount');

      assert.equal(startsAfter - startsBefore, 0, 'Expected no process restart during fast undo path');
      assert.ok(sendsAfter - sendsBefore >= 1, `Expected at least one command send for undo path, got delta=${sendsAfter - sendsBefore}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('backward goToCursor uses fast undo-to-state (no restart)', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(12), 'backward-jump.ui.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('easycrypt.startProcess');

      const endPosition = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(endPosition, endPosition);
      const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(forward && forward.success, `Expected forward goToCursor success, got: ${JSON.stringify(forward)}`);

      const offsetBefore = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      const startsBefore = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');

      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
      const backward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(backward && backward.success, `Expected backward goToCursor success, got: ${JSON.stringify(backward)}`);

      const offsetAfter = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      const startsAfter = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');

      assert.ok(offsetAfter < offsetBefore, `Expected offset to decrease. before=${offsetBefore}, after=${offsetAfter}`);
      assert.equal(startsAfter - startsBefore, 0, 'Expected no restart in backward goToCursor undo path');
    } finally {
      await fixture.cleanup();
    }
  });

  it('executes multiple statements efficiently with goToCursor', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(6), 'batch-efficient.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      const initialOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      const endPosition = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(endPosition, endPosition);

      const startTime = Date.now();
      const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
      const elapsed = Date.now() - startTime;

      assert.ok(result && result.success, `Expected goToCursor success, got: ${JSON.stringify(result)}`);
      const finalOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(finalOffset > initialOffset, `Expected offset to increase. initial=${initialOffset}, final=${finalOffset}`);
      assert.ok(elapsed < 15_000, `Expected batch stepping to finish promptly, elapsed=${elapsed}ms`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not spam proof state updates during batch goToCursor (UI suppression)', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(6), 'batch-proof-state-count.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('easycrypt._resetProofStateChangeCount');

      const endPosition = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(endPosition, endPosition);

      const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(result && result.success, `Expected goToCursor success, got: ${JSON.stringify(result)}`);

      const changeCount = await vscode.commands.executeCommand('easycrypt._getProofStateChangeCount');
      assert.ok(changeCount <= 2, `Expected <=2 proof-state changes during batch replay, got ${changeCount}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('proof state view only updates twice during batch goToCursor (processing + final)', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(6), 'batch-proof-view-count.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('easycrypt.proofStateView.focus');
      await waitForProofStateViewSettled(10_000);
      await vscode.commands.executeCommand('easycrypt._resetProofStateViewUpdateCount');
      const beforeBatchUpdates = await waitForProofStateViewSettled(10_000);

      const endPosition = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(endPosition, endPosition);

      const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(result && result.success, `Expected goToCursor success, got: ${JSON.stringify(result)}`);

      const afterBatchUpdates = await waitForProofStateViewSettled(10_000);
      const batchDelta = afterBatchUpdates - beforeBatchUpdates;
      assert.ok(batchDelta <= 2, `Expected <=2 proof-state view updates during batch replay, got ${batchDelta} (before=${beforeBatchUpdates}, after=${afterBatchUpdates})`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('replays latest proof state on webview ready without extra navigation', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(2), 'proof-view-ready.ui.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('easycrypt.proofStateView.focus');

      const step = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(step && step.success);

      const beforeReadyReplay = await waitForProofStateViewSettled(10_000);

      await vscode.commands.executeCommand('easycrypt._simulateWebviewMessage', { type: 'ready' });

      const afterReadyReplay = await waitForProofStateViewSettled(10_000);
      assert.ok(afterReadyReplay > beforeReadyReplay, `Expected ready replay to post at least one update. before=${beforeReadyReplay}, after=${afterReadyReplay}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('batch stepping stops at first error', async function () {
    const source = [
      'lemma ok1 : true.',
      'proof.',
      '  trivial.',
      'qed.',
      'lemma bad : true.',
      'proof.',
      '  this_is_not_a_tactic.',
      'qed.',
      'lemma ok2 : true.',
      'proof.',
      '  trivial.',
      'qed.',
      '',
    ].join('\n');
    const fixture = await createTempEcFile(source, 'batch-stop-first-error.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      const endPosition = doc.positionAt(source.length);
      editor.selection = new vscode.Selection(endPosition, endPosition);

      const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(result && result.success === false, `Expected goToCursor failure on first bad statement, got: ${JSON.stringify(result)}`);

      const failLine = source.slice(0, source.indexOf('this_is_not_a_tactic')).split('\n').length - 1;
      const verifiedRange = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
      assert.ok(verifiedRange, 'Expected partial verified range before failure');
      assert.ok(verifiedRange.end.line <= failLine, `Expected verified range to stop before failing line ${failLine}, got ${JSON.stringify(verifiedRange)}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('batch stepping from middle of file works correctly', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(3), 'batch-middle.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      const r1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      const r2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(r1 && r1.success);
      assert.ok(r2 && r2.success);

      const midOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');

      const endPosition = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(endPosition, endPosition);
      const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(result && result.success, `Expected goToCursor success from middle, got: ${JSON.stringify(result)}`);

      const finalOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(finalOffset > midOffset, `Expected offset to increase. middle=${midOffset}, final=${finalOffset}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('batch stepping with single statement is efficient', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(2), 'batch-single.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      const first = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(first && first.success);

      const offset1 = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');

      editor.selection = new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0));
      const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(result && result.success);

      const offset2 = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(offset2 > offset1, `Expected offset to increase by at least one statement. before=${offset1}, after=${offset2}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not spam proof state updates during forced recovery replay', async function () {
    const fixture = await createTempEcFile(buildMultiLemmaProgram(6), 'forced-recovery.ui.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      const endPosition = doc.positionAt(doc.getText().length);
      editor.selection = new vscode.Selection(endPosition, endPosition);

      const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(forward && forward.success, `Expected initial goToCursor success, got: ${JSON.stringify(forward)}`);

      await vscode.commands.executeCommand('easycrypt._resetProofStateChangeCount');

      const recovery = await vscode.commands.executeCommand('easycrypt.forceRecovery');
      if (typeof recovery === 'undefined') {
        this.skip();
        return;
      }
      assert.ok(recovery.success !== false, `Expected forceRecovery not to fail, got: ${JSON.stringify(recovery)}`);

      const changeCount = await vscode.commands.executeCommand('easycrypt._getProofStateChangeCount');
      assert.ok(changeCount <= 2, `Expected <=2 proof-state changes during recovery replay, got ${changeCount}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('goToCursor stops on first failing statement and reset keeps runtime usable', async function () {
    const mutateSource = (source) => {
      const needle = '  by sim.';
      const index = source.indexOf(needle);
      assert.ok(index >= 0, 'Expected a stable by sim. line in KEMDEM_lor.ec');
      return source.slice(0, index) + '  by this_is_not_a_tactic.' + source.slice(index + needle.length);
    };

    const fixture = await createRealKemDemFixtureCopy(mutateSource);

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      const failLine = fixture.source.slice(0, fixture.source.indexOf('this_is_not_a_tactic')).split('\n').length - 1;

      await vscode.commands.executeCommand('easycrypt.resetProof');

      const endPosition = doc.positionAt(fixture.source.length);
      editor.selection = new vscode.Selection(endPosition, endPosition);

      const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(result && result.success === false, `Expected goToCursor failure, got: ${JSON.stringify(result)}`);

      const verifiedRange = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
      assert.ok(verifiedRange, 'Expected verified range after partial replay');
      assert.ok(
        verifiedRange.end.line <= failLine,
        `Expected verified range to stop before failing line ${failLine}, got ${JSON.stringify(verifiedRange)}`
      );

      const reset = await vscode.commands.executeCommand('easycrypt.resetProof');
      assert.ok(reset && reset.success, `Expected resetProof success after failure, got: ${JSON.stringify(reset)}`);

      const stepAfterReset = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(stepAfterReset && stepAfterReset.success, `Expected stepForward success after reset, got: ${JSON.stringify(stepAfterReset)}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('KEMDEM and PRG stay healthy across directory switches', async function () {
    const kemDemPath = path.resolve(
      __dirname,
      '..',
      '..',
      'samples',
      'kem-dem',
      'left-or-right',
      'KEMDEM_lor.ec'
    );
    const prgPath = path.resolve(__dirname, '..', '..', 'samples', 'PRG.ec');

    const kemDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(kemDemPath));
    await vscode.languages.setTextDocumentLanguage(kemDoc, 'easycrypt');
    await vscode.window.showTextDocument(kemDoc);

    await vscode.commands.executeCommand('easycrypt.checkFile');
    const postCheckErrors = await waitForNoErrorDiagnostics(kemDoc.uri, 30_000);
    assert.equal(postCheckErrors.length, 0);

    const first = await vscode.commands.executeCommand('easycrypt.stepForward');
    const second = await vscode.commands.executeCommand('easycrypt.stepForward');
    assert.ok(first && first.success);
    assert.ok(second && second.success);

    const prgDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(prgPath));
    await vscode.languages.setTextDocumentLanguage(prgDoc, 'easycrypt');
    await vscode.window.showTextDocument(prgDoc);

    const prgStep = await vscode.commands.executeCommand('easycrypt.stepForward');
    assert.ok(prgStep && prgStep.success, `Expected PRG step success after switch, got: ${JSON.stringify(prgStep)}`);

    await vscode.window.showTextDocument(kemDoc);
    const stepAfterReturn = await vscode.commands.executeCommand('easycrypt.stepForward');
    assert.ok(stepAfterReturn && stepAfterReturn.success);

    const finalErrors = getErrorDiagnostics(kemDoc.uri);
    assert.equal(
      finalErrors.some((diag) => MODULE_NOT_FOUND_PATTERN.test(diag.message)),
      false,
      `Expected no import-resolution diagnostics after switches, got: ${JSON.stringify(finalErrors.map((d) => d.message))}`
    );
  });

  it('deep PRG navigation and stepBackward keep proof state settled', async function () {
    const prgPath = path.resolve(__dirname, '..', '..', 'samples', 'PRG.ec');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(prgPath));
    await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
    const editor = await vscode.window.showTextDocument(doc);

    const source = doc.getText();
    const anchor = source.indexOf('local lemma');
    if (anchor < 0) {
      this.skip();
      return;
    }

    await vscode.commands.executeCommand('easycrypt.resetProof');

    const targetPos = doc.positionAt(Math.min(anchor + 30, source.length - 1));
    editor.selection = new vscode.Selection(targetPos, targetPos);

    const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
    assert.ok(forward && forward.success, `Expected goToCursor success in PRG, got: ${JSON.stringify(forward)}`);

    const back = await vscode.commands.executeCommand('easycrypt.stepBackward');
    assert.ok(back && back.success, `Expected stepBackward success in PRG, got: ${JSON.stringify(back)}`);
    assert.ok(back.executionOffset < forward.executionOffset, `Expected backward offset decrease. forward=${forward.executionOffset}, backward=${back.executionOffset}`);

    const snapshot = await waitForProofStateSettled(120_000);
    assert.ok(snapshot && snapshot.isProcessing === false, `Expected settled proof snapshot, got: ${JSON.stringify(snapshot)}`);
    assert.ok(Array.isArray(snapshot.outputLines), 'Expected proof snapshot outputLines array');
  });
});
