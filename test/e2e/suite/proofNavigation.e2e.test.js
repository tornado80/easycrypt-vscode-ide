const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vscode = require('vscode');

async function configureMockEasyCrypt() {
  const mockPath = path.resolve(__dirname, '..', '..', 'fixtures', 'mock_easycrypt.js');
  try {
    await fs.chmod(mockPath, 0o755);
  } catch {
    // best-effort
  }

  const cfg = vscode.workspace.getConfiguration('easycrypt');
  await cfg.update('executablePath', mockPath, vscode.ConfigurationTarget.Global);
  await cfg.update('arguments', [], vscode.ConfigurationTarget.Global);
  await cfg.update('proverArgs', [], vscode.ConfigurationTarget.Global);
}

async function createTempEcFile(content, filename = 'proof.ec') {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-proofnav-e2e-'));
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

async function waitForExecutionOffset(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const offset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
    if (predicate(offset)) return offset;
    await new Promise((r) => setTimeout(r, 50));
  }
  return vscode.commands.executeCommand('easycrypt._getExecutionOffset');
}

describe('Interactive Proof Navigation E2E (mock easycrypt)', function () {
  this.timeout(60_000);

  before(async function () {
    await configureMockEasyCrypt();
    const ext = vscode.extensions.getExtension('tornado.easycrypt-vscode');
    assert.ok(ext, 'Extension tornado.easycrypt-vscode should be present');
    await ext.activate();
  });

  it('steps forward/backward and reports execution offsets', async function () {
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
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      // Ensure starting state is 0.
      const initialOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.equal(initialOffset, 0);

      const r1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(r1 && r1.success, `Expected stepForward success, got: ${JSON.stringify(r1)}`);
      assert.ok(typeof r1.executionOffset === 'number' && r1.executionOffset > 0);

      const verifiedRange1 = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
      assert.ok(verifiedRange1, 'Expected verified-region decoration to exist after stepForward');
      assert.ok(
        verifiedRange1.end.line > verifiedRange1.start.line ||
          (verifiedRange1.end.line === verifiedRange1.start.line && verifiedRange1.end.character > verifiedRange1.start.character),
        `Expected a non-empty verified range, got: ${JSON.stringify(verifiedRange1)}`
      );

      const r2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(r2 && r2.success);
      assert.ok(r2.executionOffset > r1.executionOffset);

      const verifiedRange2 = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
      assert.ok(verifiedRange2, 'Expected verified-region decoration to exist after second stepForward');

      const r3 = await vscode.commands.executeCommand('easycrypt.stepBackward');
      assert.ok(r3 && r3.success);
      assert.ok(typeof r3.executionOffset === 'number' && r3.executionOffset < r2.executionOffset);

      // Go to cursor somewhere mid-file.
      editor.selection = new vscode.Selection(new vscode.Position(3, 2), new vscode.Position(3, 2));
      const r4 = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(r4 && r4.success);
      assert.ok(typeof r4.executionOffset === 'number');

      // Sanity: execution offset should not go backwards here.
      assert.ok(r4.executionOffset >= r3.executionOffset);
    } finally {
      await cleanup();
    }
  });

  it('auto-retracts when editing inside the verified region', async function () {
    const { path: filePath, cleanup } = await createTempEcFile(
      [
        'require import A.',
        'require import B.',
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
      const editor = await vscode.window.showTextDocument(doc);

      // Step twice to create a non-empty verified region.
      const s1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(s1 && s1.success);
      const s2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(s2 && s2.success);

      const beforeEditOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(beforeEditOffset > 0);

      // Edit at top of file (definitely inside verified region).
      await editor.edit((eb) => {
        eb.insert(new vscode.Position(0, 0), ' ');
      });

      const afterEditOffset = await waitForExecutionOffset((o) => o < beforeEditOffset, 10_000);
      assert.ok(afterEditOffset < beforeEditOffset, `Expected auto-retraction. Before=${beforeEditOffset}, After=${afterEditOffset}`);
    } finally {
      await cleanup();
    }
  });

  it('stepBackward uses fast undo-to-state (no restart)', async function () {
    const { path: filePath, cleanup } = await createTempEcFile(
      [
        'require import A.',
        'require import B.',
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

      // Ensure a running REPL (awaited). This avoids races with stopProcess.
      await vscode.commands.executeCommand('easycrypt.startProcess');

      const s1 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(s1 && s1.success);
      const s2 = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(s2 && s2.success);

      const before = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(before > 0);

      const startsBefore = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');
      const sendsBefore = await vscode.commands.executeCommand('easycrypt._getSendCommandCount');
      assert.ok(typeof startsBefore === 'number');
      assert.ok(typeof sendsBefore === 'number');

      // Backward stepping should use fast undo-to-state (single undo command, no restart).
      const back = await vscode.commands.executeCommand('easycrypt.stepBackward');
      assert.ok(back && back.success, `Expected stepBackward success via undo-to-state, got: ${JSON.stringify(back)}`);
      assert.ok(typeof back.executionOffset === 'number');
      assert.ok(back.executionOffset < before, `Expected executionOffset to decrease. Before=${before}, After=${back.executionOffset}`);

      const startsAfter = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');
      const sendsAfter = await vscode.commands.executeCommand('easycrypt._getSendCommandCount');

      // With undo-to-state, we expect NO restart (delta=0) and exactly one undo command
      assert.equal(
        startsAfter - startsBefore,
        0,
        `Expected no process restart during stepBackward (undo-to-state); got delta=${startsAfter - startsBefore} (before=${startsBefore}, after=${startsAfter})`
      );
      assert.equal(
        sendsAfter - sendsBefore,
        1,
        `Expected exactly one sendCommand() for undo <uuid>.; got delta=${sendsAfter - sendsBefore} (before=${sendsBefore}, after=${sendsAfter})`
      );
    } finally {
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await cleanup();
    }
  });

  it('stepBackward falls back to restart+replay when undo-to-state fails', async function () {
    // Enable undo failure mode BEFORE spawning the process, so the mock
    // sees the env var at startup and fails on undo commands.
    process.env.MOCK_EC_UNDO_FAIL = '1';

    const { path: filePath, cleanup } = await createTempEcFile(
      [
        'require import A.',
        'require import B.',
        'require import C.',
        'require import D.',
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'fallback_replay.ec'
    );

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      // Stop any existing process and start a fresh one with MOCK_EC_UNDO_FAIL set.
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await vscode.commands.executeCommand('easycrypt.startProcess');

      // First, establish a non-zero verified prefix.
      // Forward stepping works normally even with MOCK_EC_UNDO_FAIL.
      editor.selection = new vscode.Selection(new vscode.Position(7, 0), new vscode.Position(7, 0));
      const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(forward && forward.success, `Expected forward goToCursor success, got: ${JSON.stringify(forward)}`);

      const before = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(before > 0);

      const startsBefore = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');
      const sendsBefore = await vscode.commands.executeCommand('easycrypt._getSendCommandCount');

      // Backward step first tries undo-to-state, which should fail due to MOCK_EC_UNDO_FAIL,
      // then falls back to restart + replay.
      const back = await vscode.commands.executeCommand('easycrypt.stepBackward');
      assert.ok(back && back.success, `Expected stepBackward success via fallback to restart+replay, got: ${JSON.stringify(back)}`);

      const after = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(after < before, `Expected executionOffset to decrease. Before=${before}, After=${after}`);

      const startsAfter = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');
      const sendsAfter = await vscode.commands.executeCommand('easycrypt._getSendCommandCount');

      // When undo fails, we should fall back to restart + replay.
      // We expect exactly one restart during the fallback.
      assert.equal(
        startsAfter - startsBefore,
        1,
        `Expected exactly one restart during fallback recovery; got delta=${startsAfter - startsBefore}`
      );

      // One failed undo attempt (1) + one batch replay after restart (1) => at least 2.
      const deltaSends = sendsAfter - sendsBefore;
      assert.ok(deltaSends >= 2, `Expected >=2 sendCommand() due to undo attempt + replay; got delta=${deltaSends}`);
    } finally {
      delete process.env.MOCK_EC_UNDO_FAIL;
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await cleanup();
    }
  });

  it('goToCursor succeeds when first statement is silent (prompt coalesced with next output)', async function () {
    // Enable deterministic reproduction in the mock.
    process.env.MOCK_EC_COALESCE_FIRST_PROMPT_WITH_NEXT_OUTPUT = '1';

    const { path: filePath, cleanup } = await createTempEcFile(
      [
        // Two statements are enough: the mock will hold the first prompt and emit it
        // right before the second statement's output.
        'require import A.',
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'silent_first_statement.ec'
    );

    try {
      // Ensure we spawn a fresh mock process that sees the env var.
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await vscode.commands.executeCommand('easycrypt.startProcess');

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      // Place cursor after the second statement so goToCursor batches at least 2 statements.
      editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
      const r = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(r && r.success, `Expected goToCursor success, got: ${JSON.stringify(r)}`);

      const offset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(typeof offset === 'number' && offset > 0);
    } finally {
      delete process.env.MOCK_EC_COALESCE_FIRST_PROMPT_WITH_NEXT_OUTPUT;
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await cleanup();
    }
  });

  it('backward goToCursor uses fast undo-to-state (no restart)', async function () {
    // This test verifies that backward goToCursor uses fast undo-to-state
    // instead of the historical restart+replay approach.

    // Ensure a running REPL (awaited). This avoids races with stopProcess.
    await vscode.commands.executeCommand('easycrypt.startProcess');

    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`require import M${i}.`);
    }
    lines.push('lemma t : true.');
    lines.push('proof.');
    lines.push('  trivial.');
    lines.push('qed.');
    lines.push('');

    const { path: filePath, cleanup } = await createTempEcFile(lines.join('\n'), 'backward_jump_regression.ec');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      // Move forward in one batch so we have a large verified prefix.
      // Place cursor near the end (past many statements).
      editor.selection = new vscode.Selection(new vscode.Position(18, 0), new vscode.Position(18, 0));

      const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(forward && forward.success, `Expected forward goToCursor success, got: ${JSON.stringify(forward)}`);

      const execAfterForward = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(execAfterForward > 0, 'Expected a non-zero execution offset after forward goToCursor');

      // Snapshot process start count before backward jump.
      const startsBefore = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');
      assert.ok(typeof startsBefore === 'number', `Expected numeric start counter, got: ${startsBefore}`);

      const sendsBefore = await vscode.commands.executeCommand('easycrypt._getSendCommandCount');
      assert.ok(typeof sendsBefore === 'number', `Expected numeric send counter, got: ${sendsBefore}`);

      // Now jump far backward (near the top). With undo-to-state, this should
      // send a single undo <uuid>. command with NO restart.
      editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));

      const backward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(backward && backward.success, `Expected backward goToCursor success, got: ${JSON.stringify(backward)}`);

      const startsAfter = await vscode.commands.executeCommand('easycrypt._getProcessStartCount');
      assert.ok(typeof startsAfter === 'number', `Expected numeric start counter, got: ${startsAfter}`);

      const sendsAfter = await vscode.commands.executeCommand('easycrypt._getSendCommandCount');
      assert.ok(typeof sendsAfter === 'number', `Expected numeric send counter, got: ${sendsAfter}`);

      const deltaStarts = startsAfter - startsBefore;
      // With undo-to-state, we expect NO restart (delta=0)
      assert.equal(
        deltaStarts,
        0,
        `Expected no process restart during backward goToCursor (undo-to-state); got delta=${deltaStarts} (before=${startsBefore}, after=${startsAfter})`
      );

      const deltaSends = sendsAfter - sendsBefore;
      // One undo <uuid>. command
      assert.equal(
        deltaSends,
        1,
        `Expected exactly one sendCommand() for backward goToCursor (undo <uuid>.); got delta=${deltaSends} (before=${sendsBefore}, after=${sendsAfter})`
      );
    } finally {
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await cleanup();
    }
  });

  describe('Batch Stepping (Efficient Proof Navigation)', function () {

    it('executes multiple statements efficiently with goToCursor', async function () {
      const { path: filePath, cleanup } = await createTempEcFile(
        [
          'require import A.',
          'require import B.',
          'require import C.',
          'require import D.',
          'require import E.',
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
        const editor = await vscode.window.showTextDocument(doc);

        // Ensure starting state is 0.
        const initialOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
        assert.equal(initialOffset, 0);

        // Place cursor at line 7 (proof.)
        editor.selection = new vscode.Selection(new vscode.Position(6, 0), new vscode.Position(6, 0));

        // Use goToCursor to batch execute multiple statements at once
        const startTime = Date.now();
        const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
        const elapsed = Date.now() - startTime;

        assert.ok(result && result.success, `Expected goToCursor success, got: ${JSON.stringify(result)}`);
        assert.ok(typeof result.executionOffset === 'number' && result.executionOffset > 0);

        // Verify we advanced past multiple statements
        const finalOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
        assert.ok(finalOffset > initialOffset, 'Should have advanced past initial position');

        // Verify the verified range was updated correctly
        const verifiedRange = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
        assert.ok(verifiedRange, 'Expected verified-region decoration after batch step');
        assert.ok(
          verifiedRange.end.line > 0,
          `Expected verified range to span multiple lines, got end line: ${verifiedRange.end.line}`
        );

        console.log(`  Batch executed to line 7 in ${elapsed}ms, final offset: ${finalOffset}`);
      } finally {
        await cleanup();
      }
    });

    it('does not spam proof state updates during batch goToCursor (UI suppression)', async function () {
      const { path: filePath, cleanup } = await createTempEcFile(
        [
          'require import A.',
          'require import B.',
          'require import C.',
          'require import D.',
          'require import E.',
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
        const editor = await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('easycrypt._resetProofStateChangeCount');

        // Cursor far enough to trigger a multi-statement batch.
        editor.selection = new vscode.Selection(new vscode.Position(6, 0), new vscode.Position(6, 0));
        const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
        assert.ok(result && result.success, `Expected goToCursor success, got: ${JSON.stringify(result)}`);

        const changeCount = await vscode.commands.executeCommand('easycrypt._getProofStateChangeCount');
        assert.ok(typeof changeCount === 'number', `Expected numeric changeCount, got: ${changeCount}`);

        // Expected: at most "processing on" + "final state".
        assert.ok(
          changeCount <= 2,
          `Expected <= 2 proof state changes during batch goToCursor, got ${changeCount}`
        );
      } finally {
        await cleanup();
      }
    });

    it('proof state view only updates twice during batch goToCursor (processing + final)', async function () {
      const { path: filePath, cleanup } = await createTempEcFile(
        [
          'require import A.',
          'require import B.',
          'require import C.',
          'require import D.',
          'require import E.',
          'lemma t : true.',
          'proof.',
          '  trivial.',
          'qed.',
          '',
        ].join('\n'),
        'proof_state_view_batch.ec'
      );

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
        const editor = await vscode.window.showTextDocument(doc);

        // Ensure the proof state view is created/resolved.
        await vscode.commands.executeCommand('easycrypt.proofStateView.focus');

        // Reset the webview update counter *after* creating the view.
        await vscode.commands.executeCommand('easycrypt._resetProofStateViewUpdateCount');

        // Trigger a multi-statement batch.
        editor.selection = new vscode.Selection(new vscode.Position(6, 0), new vscode.Position(6, 0));
        const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
        assert.ok(result && result.success, `Expected goToCursor success, got: ${JSON.stringify(result)}`);

        const viewUpdates = await vscode.commands.executeCommand('easycrypt._getProofStateViewUpdateCount');
        assert.ok(typeof viewUpdates === 'number', `Expected numeric viewUpdates, got: ${viewUpdates}`);

        // Exactly two updates are expected: processing, then final state.
        assert.ok(
          viewUpdates <= 2,
          `Expected <= 2 proof state view updates during batch goToCursor, got ${viewUpdates}`
        );
      } finally {
        await cleanup();
      }
    });

    it('batch stepping stops at first error', async function () {
      const { path: filePath, cleanup } = await createTempEcFile(
        [
          'require import A.',
          'require import B.',
          'require import undefined_symbol.',  // This should cause an error
          'require import C.',
          'lemma t : true.',
          '',
        ].join('\n')
      );

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
        const editor = await vscode.window.showTextDocument(doc);

        // Place cursor at end of file
        editor.selection = new vscode.Selection(new vscode.Position(5, 0), new vscode.Position(5, 0));

        // Batch step should stop at the error
        const result = await vscode.commands.executeCommand('easycrypt.goToCursor');

        // Should fail due to undefined_symbol
        assert.ok(!result.success, 'Expected goToCursor to fail on undefined_symbol');
        assert.ok(result.error, 'Expected error message');

        // Execution should have stopped before the failing statement
        const offset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
        
        // Should have executed first two statements successfully
        // The error is on line 3 (0-indexed: line 2)
        const verifiedRange = await vscode.commands.executeCommand('easycrypt._getVerifiedRange');
        if (verifiedRange) {
          // Verified region should not include the error line
          assert.ok(
            verifiedRange.end.line <= 2,
            `Verified range should stop before error, got end line: ${verifiedRange.end.line}`
          );
        }
      } finally {
        await cleanup();
      }
    });

    it('batch stepping from middle of file works correctly', async function () {
      const { path: filePath, cleanup } = await createTempEcFile(
        [
          'require import A.',
          'require import B.',
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
        const editor = await vscode.window.showTextDocument(doc);

        // First, step forward twice to establish a position
        const r1 = await vscode.commands.executeCommand('easycrypt.stepForward');
        assert.ok(r1 && r1.success);
        const r2 = await vscode.commands.executeCommand('easycrypt.stepForward');
        assert.ok(r2 && r2.success);

        const midOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');

        // Now place cursor at end and batch step remaining statements
        editor.selection = new vscode.Selection(new vscode.Position(5, 4), new vscode.Position(5, 4));

        const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
        assert.ok(result && result.success, `Expected batch step success, got: ${JSON.stringify(result)}`);

        const finalOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
        assert.ok(finalOffset > midOffset, `Should have advanced from ${midOffset} to ${finalOffset}`);
      } finally {
        await cleanup();
      }
    });

    it('batch stepping with single statement is efficient', async function () {
      const { path: filePath, cleanup } = await createTempEcFile(
        [
          'require import A.',
          'require import B.',
          '',
        ].join('\n')
      );

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
        const editor = await vscode.window.showTextDocument(doc);

        // Step forward once
        const r1 = await vscode.commands.executeCommand('easycrypt.stepForward');
        assert.ok(r1 && r1.success);

        const offset1 = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');

        // Place cursor to only advance by one statement
        editor.selection = new vscode.Selection(new vscode.Position(1, 17), new vscode.Position(1, 17));

        const result = await vscode.commands.executeCommand('easycrypt.goToCursor');
        assert.ok(result && result.success);

        const offset2 = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
        assert.ok(offset2 > offset1, 'Should have advanced by at least one statement');
      } finally {
        await cleanup();
      }
    });
  });

  it('does not spam proof state updates during recovery replay (UI suppression)', async function () {
    const { path: filePath, cleanup } = await createTempEcFile(
      [
        'require import A.',
        'require import B.',
        'require import C.',
        'require import D.',
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'recovery_proof_state_spam.ec'
    );

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      // Establish a non-zero verified prefix.
      editor.selection = new vscode.Selection(new vscode.Position(7, 0), new vscode.Position(7, 0));
      const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(forward && forward.success, `Expected initial goToCursor success, got: ${JSON.stringify(forward)}`);

      const before = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(before > 0);

      await vscode.commands.executeCommand('easycrypt._resetProofStateChangeCount');

      // Trigger recovery via stepBackward (uses restart + replay).
      const back = await vscode.commands.executeCommand('easycrypt.stepBackward');
      assert.ok(back && back.success, `Expected stepBackward success, got: ${JSON.stringify(back)}`);

      const changeCount = await vscode.commands.executeCommand('easycrypt._getProofStateChangeCount');
      assert.ok(typeof changeCount === 'number', `Expected numeric changeCount, got: ${changeCount}`);

      // Expected: reset-for-processing + final state.
      assert.ok(
        changeCount <= 2,
        `Expected <= 2 proof state changes during recovery replay, got ${changeCount}`
      );
    } finally {
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await cleanup();
    }
  });

  it('does not spam proof state *view* updates during bursty recovery replay (regression)', async function () {
    const { path: filePath, cleanup } = await createTempEcFile(
      [
        'require import A.',
        'require import B.',
        'require import C.',
        'require import D.',
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'recovery_bursty_view_updates.ec'
    );

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      const editor = await vscode.window.showTextDocument(doc);

      // Ensure the proof state view is created/resolved.
      await vscode.commands.executeCommand('easycrypt.proofStateView.focus');

      // Establish a non-zero verified prefix.
      editor.selection = new vscode.Selection(new vscode.Position(7, 0), new vscode.Position(7, 0));
      const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
      assert.ok(forward && forward.success, `Expected initial goToCursor success, got: ${JSON.stringify(forward)}`);

      const before = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
      assert.ok(before > 0);

      // Reset the webview update counter *after* reaching a stable forward state.
      await vscode.commands.executeCommand('easycrypt._resetProofStateViewUpdateCount');

      // Enable bursty prompt emission for the next spawned mock process.
      // This forces prompt-delimited output chunks to arrive with gaps > 60ms.
      process.env.MOCK_EC_BURSTY_PROMPTS = '1';
      process.env.MOCK_EC_BURST_DELAY_MS = '80';

      // Trigger recovery via stepBackward (uses restart + replay).
      const back = await vscode.commands.executeCommand('easycrypt.stepBackward');
      assert.ok(back && back.success, `Expected stepBackward success, got: ${JSON.stringify(back)}`);

      const viewUpdates = await vscode.commands.executeCommand('easycrypt._getProofStateViewUpdateCount');
      assert.ok(typeof viewUpdates === 'number', `Expected numeric viewUpdates, got: ${viewUpdates}`);

      // Expected: at most "processing on" + "final state".
      assert.ok(
        viewUpdates <= 2,
        `Expected <= 2 proof state view updates during bursty recovery replay, got ${viewUpdates}`
      );
    } finally {
      delete process.env.MOCK_EC_BURSTY_PROMPTS;
      delete process.env.MOCK_EC_BURST_DELAY_MS;
      await vscode.commands.executeCommand('easycrypt.stopProcess');
      await cleanup();
    }
  });

  describe('Proof State View - Prompt/Statement Sync', function () {

    it('does not resolve early when mock emits leading prompt (MOCK_EC_LEADING_PROMPT)', async function () {
      // This test verifies the fix for the PRG.ec repro scenario where:
      // - Batch send expects N prompts
      // - First chunk contains a "leading prompt" from previous command
      // - Without the fix, the extension would count the leading prompt as a response
      //   prompt and resolve early, causing the proof state view to miss the final output

      const { path: filePath, cleanup } = await createTempEcFile(
        [
          'require import A.',
          'require import B.',
          'require import C.',
          'require import D.',
          'require import E.',
          'lemma t : true.',
          'proof.',
          '  trivial.',
          'qed.',
          '',
        ].join('\n'),
        'leading_prompt_test.ec'
      );

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
        const editor = await vscode.window.showTextDocument(doc);

        // Enable leading prompt simulation in the mock.
        // When set, the mock emits a [0|check]> prompt before the first command's response.
        process.env.MOCK_EC_LEADING_PROMPT = '1';

        // Ensure we start fresh by stopping any existing process
        await vscode.commands.executeCommand('easycrypt.resetProof');

        // Place cursor at the end and execute goToCursor
        editor.selection = new vscode.Selection(new vscode.Position(8, 0), new vscode.Position(8, 0));
        const result = await vscode.commands.executeCommand('easycrypt.goToCursor');

        assert.ok(result && result.success, `Expected goToCursor success with leading prompt, got: ${JSON.stringify(result)}`);

        // Verify the proof state snapshot shows the correct final state
        const snapshot = await vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
        assert.ok(snapshot, 'Expected proof state snapshot to exist');
        assert.strictEqual(snapshot.isProcessing, false, 'Proof state should not be processing after completion');

        // The mock outputs "No more goals" for qed., so we should see isComplete=true
        // and the outputLines should contain the final output
        assert.ok(
          snapshot.outputLines && snapshot.outputLines.length > 0,
          `Expected outputLines to contain final output, got: ${JSON.stringify(snapshot.outputLines)}`
        );

        // Verify the execution offset is at the expected position (end of qed.)
        const execOffset = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
        assert.ok(execOffset > 0, 'Expected positive execution offset after batch');

      } finally {
        delete process.env.MOCK_EC_LEADING_PROMPT;
        await vscode.commands.executeCommand('easycrypt.stopProcess');
        await cleanup();
      }
    });

    it('goToCursor followed by stepBackward shows correct final output (PRG.ec repro scenario)', async function () {
      // This test simulates the exact PRG.ec repro scenario from the plan:
      // 1. goToCursor to a deep position
      // 2. stepBackward (triggers recovery + replay)
      // 3. Verify the proof state view shows the correct final output

      const lines = [];
      // Create a file with many statements to simulate PRG.ec scenario
      for (let i = 0; i < 50; i++) {
        lines.push(`require import M${i}.`);
      }
      lines.push('lemma t : true.');
      lines.push('proof.');
      lines.push('  trivial.');
      lines.push('qed.');
      lines.push('');

      const { path: filePath, cleanup } = await createTempEcFile(lines.join('\n'), 'prg_repro.ec');

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
        const editor = await vscode.window.showTextDocument(doc);

        // Enable leading prompt simulation
        process.env.MOCK_EC_LEADING_PROMPT = '1';

        // Reset to clean state
        await vscode.commands.executeCommand('easycrypt.resetProof');

        // Step 1: goToCursor to a deep position (like line 50 in PRG.ec)
        editor.selection = new vscode.Selection(new vscode.Position(50, 0), new vscode.Position(50, 0));
        const forward = await vscode.commands.executeCommand('easycrypt.goToCursor');
        assert.ok(forward && forward.success, `Expected forward goToCursor success, got: ${JSON.stringify(forward)}`);

        const offsetAfterForward = await vscode.commands.executeCommand('easycrypt._getExecutionOffset');
        assert.ok(offsetAfterForward > 0, 'Expected positive offset after forward');

        // Step 2: stepBackward (triggers recovery + replay)
        const back = await vscode.commands.executeCommand('easycrypt.stepBackward');
        assert.ok(back && back.success, `Expected stepBackward success, got: ${JSON.stringify(back)}`);

        // Step 3: Verify proof state shows correct final output
        // Wait briefly for state to settle
        await new Promise(r => setTimeout(r, 100));

        const snapshot = await vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
        assert.ok(snapshot, 'Expected proof state snapshot after stepBackward');
        assert.strictEqual(snapshot.isProcessing, false, 'Should not be processing after stepBackward completes');

        // The final output should contain the last processed statement's output
        // Not an early/truncated segment
        assert.ok(
          snapshot.outputLines && snapshot.outputLines.length > 0,
          `Expected non-empty outputLines after recovery, got: ${JSON.stringify(snapshot)}`
        );

      } finally {
        delete process.env.MOCK_EC_LEADING_PROMPT;
        await vscode.commands.executeCommand('easycrypt.stopProcess');
        await cleanup();
      }
    });

    it('PRG.ec => //. pattern: prompt marker stays in sync with proved statement count', async function () {
      // This test verifies the fix for the PRG.ec line 221 desync issue:
      // - The pattern `byequiv ... => //.` followed by `by do !sim.` and `qed.`
      // - Previously, // was treated as a line comment, causing the parser to merge
      //   statements incorrectly, leading to prompt/statement desync.
      // - After the fix, => //. is recognized as a statement terminator.

      // Simulate the PRG.ec lines 219-222 pattern
      const lines = [
        'require import A.',
        'lemma P : true.',
        'proof.',
        'byequiv (_: ={glob A} ==> ={res})=> //.',  // This line's // should NOT start a comment
        'by do !sim.',
        'qed.',
        '',
      ];

      const { path: filePath, cleanup } = await createTempEcFile(lines.join('\n'), 'prg_slash_slash.ec');

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
        const editor = await vscode.window.showTextDocument(doc);

        // Enable leading prompt simulation in the mock
        process.env.MOCK_EC_LEADING_PROMPT = '1';

        // Reset to clean state
        await vscode.commands.executeCommand('easycrypt.resetProof');

        // Place cursor at the end of qed. line (line 5, 0-indexed) and goToCursor
        // This should process 6 statements: require, lemma, proof, byequiv, by do, qed
        editor.selection = new vscode.Selection(new vscode.Position(5, 4), new vscode.Position(5, 4));
        const result = await vscode.commands.executeCommand('easycrypt.goToCursor');

        assert.ok(result && result.success, `Expected goToCursor success, got: ${JSON.stringify(result)}`);

        // Verify the proof state snapshot includes sync info
        const snapshot = await vscode.commands.executeCommand('easycrypt._getProofStateSnapshot');
        assert.ok(snapshot, 'Expected proof state snapshot to exist');
        assert.strictEqual(snapshot.isProcessing, false, 'Proof state should not be processing after completion');

        // Verify provedStatementCount is reported
        assert.ok(
          typeof snapshot.provedStatementCount === 'number',
          `Expected provedStatementCount to be a number, got: ${typeof snapshot.provedStatementCount}`
        );

        // If debugEmacsPromptMarker is present, verify it's compatible with provedStatementCount
        // Compatibility: promptNumber == provedStatementCount OR promptNumber == provedStatementCount + 1
        if (snapshot.debugEmacsPromptMarker) {
          const match = snapshot.debugEmacsPromptMarker.match(/\[(\d+)\|/);
          if (match) {
            const promptNumber = parseInt(match[1], 10);
            const proved = snapshot.provedStatementCount;
            const isCompatible = (promptNumber === proved) || (promptNumber === proved + 1);
            assert.ok(
              isCompatible,
              `Prompt/statement sync check failed: promptNumber=${promptNumber}, provedStatementCount=${proved}. ` +
              `Expected promptNumber to be ${proved} or ${proved + 1}.`
            );
          }
        }

        // The test passes if:
        // 1. goToCursor succeeds without hanging or early resolution
        // 2. The proof state shows a reasonable proved count (>= 4 statements)
        // 3. The prompt marker, if present, is compatible with the proved count
        assert.ok(
          snapshot.provedStatementCount >= 4,
          `Expected at least 4 statements proved (got ${snapshot.provedStatementCount}). ` +
          `This may indicate the parser merged statements due to // being treated as a comment.`
        );

      } finally {
        delete process.env.MOCK_EC_LEADING_PROMPT;
        await vscode.commands.executeCommand('easycrypt.stopProcess');
        await cleanup();
      }
    });

  });
});
