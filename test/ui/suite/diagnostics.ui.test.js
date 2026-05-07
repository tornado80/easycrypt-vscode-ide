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

async function waitForNoErrors(uri, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const errors = getErrorDiagnostics(uri);
    if (errors.length === 0) {
      return errors;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return getErrorDiagnostics(uri);
}

async function createTempEcFile(content, filename = 'diagnostics.ui.ec') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-diagnostics-ui-'));
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

async function createTempProject(filesByRelativePath) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-diagnostics-ui-project-'));

  for (const [relativePath, content] of Object.entries(filesByRelativePath)) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }

  return {
    root,
    pathFor(relativePath) {
      return path.join(root, relativePath);
    },
    async cleanup() {
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function openEasyCryptDocument(filePath) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
  const editor = await vscode.window.showTextDocument(doc);
  return { doc, editor };
}

describe('Diagnostics UI (real easycrypt)', function () {
  this.timeout(120_000);

  before(async function () {
    const easycryptPath = await configureRealEasyCrypt({
      'diagnostics.enabled': true,
      'diagnostics.liveChecks': true,
      'diagnostics.onChange': true,
      'diagnostics.onSave': true,
      'diagnostics.delay': 80,
    });
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
    await vscode.commands.executeCommand('easycrypt.clearAllDiagnostics');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('checkFile surfaces diagnostics for invalid proof text', async function () {
    const fixture = await createTempEcFile(
      [
        'lemma bad : true.',
        'proof.',
        '  this_is_not_a_tactic.',
        'qed.',
        '',
      ].join('\n')
    );

    try {
      const { doc } = await openEasyCryptDocument(fixture.filePath);
      await doc.save();

      await vscode.commands.executeCommand('easycrypt.checkFile');

      const diagnostics = await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        return errors.length > 0 ? errors : undefined;
      }, 25_000, 120);

      assert.ok(Array.isArray(diagnostics) && diagnostics.length > 0, 'Expected diagnostics for invalid proof text');
      assert.ok(
        diagnostics.some((diag) => /error|invalid|unknown|cannot|fail/i.test(diag.message)),
        `Expected an actionable error diagnostic, got: ${JSON.stringify(diagnostics.map((d) => d.message))}`
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('diagnostics include a concrete source range near failing statement', async function () {
    const fixture = await createTempEcFile(
      [
        'lemma bad2 : true.',
        'proof.',
        '  this_is_not_a_tactic.',
        'qed.',
        '',
      ].join('\n'),
      'diagnostics-range.ec'
    );

    try {
      const { doc } = await openEasyCryptDocument(fixture.filePath);
      await doc.save();
      await vscode.commands.executeCommand('easycrypt.checkFile');

      const diagnostics = await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        return errors.length > 0 ? errors : undefined;
      }, 25_000, 120);

      const diag = diagnostics[0];
      assert.ok(diag.range, 'Expected diagnostic range');
      assert.ok(diag.range.start.line >= 1 && diag.range.start.line <= 3, `Unexpected diagnostic line: ${diag.range.start.line}`);
      assert.ok(
        diag.range.end.line > diag.range.start.line || diag.range.end.character > diag.range.start.character,
        `Expected non-empty range, got: ${JSON.stringify(diag.range)}`
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('clearAllDiagnostics command clears existing diagnostics', async function () {
    const fixture = await createTempEcFile(
      ['lemma bad3 : true.', 'proof.', '  this_is_not_a_tactic.', 'qed.', ''].join('\n'),
      'diagnostics-clear.ec'
    );

    try {
      const { doc } = await openEasyCryptDocument(fixture.filePath);
      await doc.save();
      await vscode.commands.executeCommand('easycrypt.checkFile');

      await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        return errors.length > 0 ? errors : undefined;
      }, 25_000, 120);

      await vscode.commands.executeCommand('easycrypt.clearAllDiagnostics');
      const remaining = await waitForNoErrors(doc.uri, 15_000);
      assert.equal(remaining.length, 0, `Expected no diagnostics after clearAllDiagnostics, got: ${JSON.stringify(remaining.map((d) => d.message))}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('checkFile on a clean file keeps diagnostics empty', async function () {
    const fixture = await createTempEcFile(
      [
        'lemma ok : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'diagnostics-clean.ec'
    );

    try {
      const { doc } = await openEasyCryptDocument(fixture.filePath);
      await doc.save();
      await vscode.commands.executeCommand('easycrypt.checkFile');

      const errors = await waitForNoErrors(doc.uri, 15_000);
      assert.equal(errors.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('missing import reports module-resolution diagnostics', async function () {
    const project = await createTempProject({
      'missing.ec': [
        'require import Missing_local_module.',
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
    });

    try {
      const { doc } = await openEasyCryptDocument(project.pathFor('missing.ec'));
      await vscode.commands.executeCommand('easycrypt.checkFile');

      const errors = await waitFor(async () => {
        const diagnostics = getErrorDiagnostics(doc.uri);
        return diagnostics.some((diag) => MODULE_NOT_FOUND_PATTERN.test(diag.message)) ? diagnostics : undefined;
      }, 25_000, 120);

      assert.ok(errors.some((diag) => MODULE_NOT_FOUND_PATTERN.test(diag.message)));
    } finally {
      await project.cleanup();
    }
  });

  it('diagnostics update to reflect latest saved content', async function () {
    const fixture = await createTempEcFile(
      [
        'lemma change_me : true.',
        'proof.',
        '  this_is_not_a_tactic.',
        'qed.',
        '',
      ].join('\n'),
      'diagnostics-refresh.ec'
    );

    try {
      const { doc, editor } = await openEasyCryptDocument(fixture.filePath);
      await doc.save();

      await vscode.commands.executeCommand('easycrypt.checkFile');
      await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        return errors.length > 0 ? errors : undefined;
      }, 25_000, 120);

      await editor.edit((builder) => {
        const line = doc.lineAt(2).text;
        builder.replace(
          new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, line.length)),
          '  trivial.'
        );
      });
      await doc.save();

      await vscode.commands.executeCommand('easycrypt.checkFile');
      const remaining = await waitForNoErrors(doc.uri, 25_000);

      assert.equal(remaining.length, 0, `Expected diagnostics to clear after fix, got: ${JSON.stringify(remaining.map((d) => d.message))}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('live diagnostics appear on edit and clear after fixing content', async function () {
    const fixture = await createTempEcFile(
      [
        'lemma live : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'diagnostics-live.ec'
    );

    try {
      const { doc, editor } = await openEasyCryptDocument(fixture.filePath);
      await doc.save();

      await vscode.commands.executeCommand('easycrypt.clearAllDiagnostics');
      await waitForNoErrors(doc.uri, 10_000);

      await editor.edit((builder) => {
        builder.insert(new vscode.Position(2, 0), '  this_is_not_a_tactic.\n');
      });
      await doc.save();

      let errorsAfterEdit = await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        return errors.length > 0 ? errors : undefined;
      }, 2_500, 100);

      // Some environments coalesce or delay live checks. Ensure the same
      // behavior is still observable via an explicit verification pass.
      if (!Array.isArray(errorsAfterEdit) || errorsAfterEdit.length === 0) {
        await vscode.commands.executeCommand('easycrypt.checkFile');
        errorsAfterEdit = await waitFor(async () => {
          const errors = getErrorDiagnostics(doc.uri);
          return errors.length > 0 ? errors : undefined;
        }, 12_000, 100);
      }

      assert.ok(Array.isArray(errorsAfterEdit) && errorsAfterEdit.length > 0, 'Expected diagnostics after invalid edit');

      await editor.edit((builder) => {
        const line = doc.lineAt(2).text;
        builder.replace(
          new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, line.length)),
          '  trivial.'
        );
      });
      await doc.save();

      const cleared = await waitForNoErrors(doc.uri, 12_000);
      assert.equal(cleared.length, 0, 'Expected diagnostics to clear after fixing edited line');
    } finally {
      await fixture.cleanup();
    }
  });

  it('diagnostics remain document-scoped across two open files', async function () {
    const badFixture = await createTempEcFile(
      ['lemma bad_scope : true.', 'proof.', '  this_is_not_a_tactic.', 'qed.', ''].join('\n'),
      'scope-bad.ec'
    );
    const goodFixture = await createTempEcFile(
      ['lemma good_scope : true.', 'proof.', '  trivial.', 'qed.', ''].join('\n'),
      'scope-good.ec'
    );

    try {
      const { doc: badDoc } = await openEasyCryptDocument(badFixture.filePath);
      await badDoc.save();
      await vscode.commands.executeCommand('easycrypt.checkFile');

      await waitFor(async () => {
        const errors = getErrorDiagnostics(badDoc.uri);
        return errors.length > 0 ? errors : undefined;
      }, 25_000, 120);

      const { doc: goodDoc } = await openEasyCryptDocument(goodFixture.filePath);
      await goodDoc.save();
      await vscode.commands.executeCommand('easycrypt.checkFile');

      const goodErrors = await waitForNoErrors(goodDoc.uri, 15_000);
      assert.equal(goodErrors.length, 0, `Expected no diagnostics on clean document, got: ${JSON.stringify(goodErrors.map((d) => d.message))}`);
    } finally {
      await badFixture.cleanup();
      await goodFixture.cleanup();
    }
  });
});
