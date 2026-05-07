const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vscode = require('vscode');
const { configureRealEasyCrypt } = require('../../shared/realEasyCrypt');

const MODULE_NOT_FOUND_PATTERN = /module not found|unknown module|cannot find module|cannot load module|unbound module|cannot locate theory/i;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue !== undefined) {
      return lastValue;
    }
    await delay(intervalMs);
  }

  return lastValue;
}

function getErrorDiagnostics(uri) {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((diag) => diag.severity === vscode.DiagnosticSeverity.Error);
}

function hasModuleNotFoundDiagnostics(uri) {
  return getErrorDiagnostics(uri).some((diag) => MODULE_NOT_FOUND_PATTERN.test(diag.message));
}

async function openEasyCryptDocument(filePath) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
  const editor = await vscode.window.showTextDocument(doc);
  return { doc, editor };
}

async function revertDirtyEasyCryptDocuments() {
  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId !== 'easycrypt' || !document.isDirty) {
      continue;
    }

    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
}

async function createTempProject(filesByRelativePath) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-module-imports-e2e-'));

  for (const [relativePath, content] of Object.entries(filesByRelativePath)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
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
        // ignore cleanup failures
      }
    },
  };
}

describe('Module Imports Integration (real easycrypt)', function () {
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

  beforeEach(async function () {
    await revertDirtyEasyCryptDocuments();
    await vscode.commands.executeCommand('easycrypt.clearAllDiagnostics');
  });

  afterEach(async function () {
    await revertDirtyEasyCryptDocuments();
    await vscode.commands.executeCommand('easycrypt.stopProcess');
    await vscode.commands.executeCommand('easycrypt.clearAllDiagnostics');
  });

  after(async function () {
    await vscode.commands.executeCommand('easycrypt.stopProcess');
  });

  it('KEMDEM_lor.ec checkFile stays import-resolved', async function () {
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

    const { doc } = await openEasyCryptDocument(kemDemPath);
    await vscode.commands.executeCommand('easycrypt.checkFile');

    await waitFor(async () => {
      if (hasModuleNotFoundDiagnostics(doc.uri)) {
        return false;
      }
      return true;
    }, 15_000, 120);

    assert.equal(
      hasModuleNotFoundDiagnostics(doc.uri),
      false,
      `Expected no module-not-found diagnostics, got: ${JSON.stringify(getErrorDiagnostics(doc.uri).map((d) => d.message))}`
    );
  });

  it('reports diagnostics for missing imports', async function () {
    const project = await createTempProject({
      'missing_import.ec': [
        'require import Missing_local_module.',
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
    });

    try {
      const { doc } = await openEasyCryptDocument(project.pathFor('missing_import.ec'));
      await vscode.commands.executeCommand('easycrypt.checkFile');

      const diagnostics = await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        return errors.some((diag) => MODULE_NOT_FOUND_PATTERN.test(diag.message)) ? errors : undefined;
      }, 20_000, 120);

      assert.ok(Array.isArray(diagnostics) && diagnostics.length > 0, 'Expected missing-import diagnostics');
      assert.ok(
        diagnostics.some((diag) => MODULE_NOT_FOUND_PATTERN.test(diag.message)),
        `Expected module-not-found style diagnostics, got: ${JSON.stringify(diagnostics.map((d) => d.message))}`
      );
    } finally {
      await project.cleanup();
    }
  });

  it('checkFile diagnostics keep import resolution stable after edit', async function () {
    const project = await createTempProject({
      'HelperStable.ec': [
        'lemma helper_ok : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'main.ec': [
        'require import HelperStable.',
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
    });

    try {
      const { doc, editor } = await openEasyCryptDocument(project.pathFor('main.ec'));

      await editor.edit((editBuilder) => {
        editBuilder.insert(new vscode.Position(1, 0), 'syntax_error.\n');
      });

      await doc.save();

      await vscode.commands.executeCommand('easycrypt.checkFile');

      await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        return errors;
      }, 20_000, 120);

      const diagnostics = getErrorDiagnostics(doc.uri);
      assert.equal(
        diagnostics.some((diag) => MODULE_NOT_FOUND_PATTERN.test(diag.message)),
        false,
        `Expected no import-resolution diagnostics after syntax edit, got: ${JSON.stringify(diagnostics.map((d) => d.message))}`
      );
    } finally {
      await project.cleanup();
    }
  });

  it('latest checkFile diagnostics reflect latest buffer edit', async function () {
    const project = await createTempProject({
      'preemption.ec': [
        'lemma t : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
    });

    try {
      const { doc, editor } = await openEasyCryptDocument(project.pathFor('preemption.ec'));

      await editor.edit((editBuilder) => {
        editBuilder.insert(new vscode.Position(0, 0), 'syntax_error.\n');
      });

      await doc.save();

      await vscode.commands.executeCommand('easycrypt.checkFile');

      await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        return errors;
      }, 20_000, 120);

      await editor.edit((editBuilder) => {
        const firstLine = doc.lineAt(0).text;
        const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, firstLine.length));
        editBuilder.replace(range, 'require import Missing_local_module.');
      });

      await doc.save();

      await vscode.commands.executeCommand('easycrypt.checkFile');

      const diagnostics = await waitFor(async () => {
        const errors = getErrorDiagnostics(doc.uri);
        const hasParseLike = errors.some((diag) => /parse error|syntax error/i.test(diag.message));
        return hasParseLike ? undefined : errors;
      }, 25_000, 120);

      assert.ok(Array.isArray(diagnostics), `Expected diagnostics array, got: ${JSON.stringify(diagnostics)}`);
      assert.equal(
        diagnostics.some((diag) => /parse error|syntax error/i.test(diag.message)),
        false,
        `Expected latest diagnostics to replace prior parse/syntax result, got: ${JSON.stringify(diagnostics.map((d) => d.message))}`
      );
    } finally {
      await project.cleanup();
    }
  });

  it('stepForward succeeds through imports without module resolution errors', async function () {
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

    const { doc } = await openEasyCryptDocument(kemDemPath);

    await vscode.commands.executeCommand('easycrypt.resetProof');

    for (let i = 0; i < 3; i++) {
      const result = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(result && result.success, `Expected stepForward success at step ${i + 1}, got: ${JSON.stringify(result)}`);
    }

    assert.equal(
      hasModuleNotFoundDiagnostics(doc.uri),
      false,
      `Expected no module-not-found diagnostics after stepping, got: ${JSON.stringify(getErrorDiagnostics(doc.uri).map((d) => d.message))}`
    );
  });

  it('stepBackward keeps imports resolvable', async function () {
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

    const { doc } = await openEasyCryptDocument(kemDemPath);
    await vscode.commands.executeCommand('easycrypt.resetProof');

    const first = await vscode.commands.executeCommand('easycrypt.stepForward');
    const second = await vscode.commands.executeCommand('easycrypt.stepForward');
    assert.ok(first && first.success, `Expected initial stepForward success, got: ${JSON.stringify(first)}`);
    assert.ok(second && second.success, `Expected second stepForward success, got: ${JSON.stringify(second)}`);

    const backward = await vscode.commands.executeCommand('easycrypt.stepBackward');
    assert.ok(backward && backward.success, `Expected stepBackward success, got: ${JSON.stringify(backward)}`);

    assert.equal(
      hasModuleNotFoundDiagnostics(doc.uri),
      false,
      `Expected no module-not-found diagnostics after stepBackward, got: ${JSON.stringify(getErrorDiagnostics(doc.uri).map((d) => d.message))}`
    );
  });

  it('switching between directories rebinds session context for imports', async function () {
    const project = await createTempProject({
      'dir-a/Main_A.ec': [
        'require import Helper_A.',
        'lemma a_ok : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'dir-a/Helper_A.ec': [
        'lemma helper_a_ok : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'dir-b/Helper_B.ec': [
        'lemma helper_b_ok : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
      'dir-b/Main_B.ec': [
        'require import Helper_B.',
        'lemma b_ok : true.',
        'proof.',
        '  trivial.',
        'qed.',
        '',
      ].join('\n'),
    });

    try {
      await vscode.commands.executeCommand('easycrypt.resetProof');

      const first = await openEasyCryptDocument(project.pathFor('dir-a/Main_A.ec'));
      const firstStep = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(firstStep && firstStep.success, `Expected first directory step success, got: ${JSON.stringify(firstStep)}`);

      const second = await openEasyCryptDocument(project.pathFor('dir-b/Main_B.ec'));
      const secondStep = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(secondStep && secondStep.success, `Expected second directory step success, got: ${JSON.stringify(secondStep)}`);

      await vscode.window.showTextDocument(first.doc);
      const backToFirstStep = await vscode.commands.executeCommand('easycrypt.stepForward');
      assert.ok(backToFirstStep && backToFirstStep.success, `Expected re-step in first directory success, got: ${JSON.stringify(backToFirstStep)}`);

      assert.equal(
        hasModuleNotFoundDiagnostics(first.doc.uri),
        false,
        `Expected no module-not-found diagnostics in dir-a, got: ${JSON.stringify(getErrorDiagnostics(first.doc.uri).map((d) => d.message))}`
      );
      assert.equal(
        hasModuleNotFoundDiagnostics(second.doc.uri),
        false,
        `Expected no module-not-found diagnostics in dir-b, got: ${JSON.stringify(getErrorDiagnostics(second.doc.uri).map((d) => d.message))}`
      );
    } finally {
      await project.cleanup();
    }
  });
});
