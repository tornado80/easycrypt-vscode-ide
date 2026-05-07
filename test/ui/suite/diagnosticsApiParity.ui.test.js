const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vscode = require('vscode');

async function waitForDiagnostics(uri, timeoutMs = 10_000, minCount = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics && diagnostics.length >= minCount) {
      return diagnostics;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return vscode.languages.getDiagnostics(uri);
}

async function waitForNoDiagnostics(uri, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (!diagnostics || diagnostics.length === 0) {
      return diagnostics || [];
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return vscode.languages.getDiagnostics(uri);
}

async function createTempEcFile(content, filename = 'diagnostics-api.ui.ec') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-diag-api-ui-'));
  const filePath = path.join(root, filename);
  await fs.writeFile(filePath, content, 'utf8');

  return {
    filePath,
    async cleanup() {
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    },
  };
}

describe('Diagnostics API Parity UI', function () {
  this.timeout(60_000);

  let extensionApi;

  before(async function () {
    const ext = vscode.extensions.getExtension('tornado.easycrypt-vscode');
    assert.ok(ext, 'Extension tornado.easycrypt-vscode should be present');
    extensionApi = await ext.activate();
    assert.ok(extensionApi, 'Expected extension API exports');

    const cfg = vscode.workspace.getConfiguration('easycrypt');
    await cfg.update('diagnostics.enabled', true, vscode.ConfigurationTarget.Global);
    await cfg.update('diagnostics.delay', 40, vscode.ConfigurationTarget.Global);
  });

  afterEach(async function () {
    await vscode.commands.executeCommand('easycrypt.clearAllDiagnostics');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('parses basic error tag and places an error diagnostic', async function () {
    const fixture = await createTempEcFile('lemma t : true.\nproof.\n  trivial.\nqed.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, '[error-3-3] unknown tactic');
      const diagnostics = await waitForDiagnostics(doc.uri);

      assert.ok(diagnostics.length > 0, 'Expected at least one diagnostic');
      const error = diagnostics.find((diag) => diag.severity === vscode.DiagnosticSeverity.Error) || diagnostics[0];
      assert.equal(error.range.start.line, 2);
      assert.equal(error.range.start.character, 2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('parses range error tag and preserves start/end', async function () {
    const fixture = await createTempEcFile('op x : int = 0.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, '[error-1-1-1-12] parse error');
      const diagnostics = await waitForDiagnostics(doc.uri);

      const error = diagnostics[0];
      assert.equal(error.range.start.line, 0);
      assert.equal(error.range.end.line, 0);
      assert.ok(error.range.end.character > error.range.start.character);
    } finally {
      await fixture.cleanup();
    }
  });

  it('parses compile critical format', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      const out = `[critical] [${fixture.filePath}: line 2 (3-9)] parse error`;
      extensionApi.processEasyCryptOutput(doc.uri, out);
      const diagnostics = await waitForDiagnostics(doc.uri);

      assert.equal(diagnostics[0].range.start.line, 1);
      assert.equal(diagnostics[0].range.start.character, 2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('parses script critical format with trailing progress segment', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      const out = `E critical ${fixture.filePath}: line 2 (3-9) parse error P 4 53 0.64634 -1.00 -1.00`;
      extensionApi.processEasyCryptOutput(doc.uri, out);
      const diagnostics = await waitForDiagnostics(doc.uri);

      assert.equal(diagnostics[0].range.start.line, 1);
      assert.ok(/parse error/i.test(diagnostics[0].message));
    } finally {
      await fixture.cleanup();
    }
  });

  it('parses warning severity and sets warning diagnostic', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, '[warning-2-1] deprecated feature');
      const diagnostics = await waitForDiagnostics(doc.uri);

      const warning = diagnostics.find((diag) => diag.severity === vscode.DiagnosticSeverity.Warning);
      assert.ok(warning, 'Expected warning diagnostic');
      assert.equal(warning.range.start.line, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('extracts location from message at line and column format', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, 'error: at line 15, column 8: undefined variable');
      const diagnostics = await waitForDiagnostics(doc.uri);

      assert.equal(diagnostics[0].range.start.line, 14);
      assert.equal(diagnostics[0].range.start.character, 7);
    } finally {
      await fixture.cleanup();
    }
  });

  it('extracts explicit range from message location format', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, 'error: at line 20, column 5 to line 20, column 30: invalid expression');
      const diagnostics = await waitForDiagnostics(doc.uri);

      assert.equal(diagnostics[0].range.start.line, 19);
      assert.equal(diagnostics[0].range.start.character, 4);
      assert.equal(diagnostics[0].range.end.line, 19);
      assert.equal(diagnostics[0].range.end.character, 29);
    } finally {
      await fixture.cleanup();
    }
  });

  it('clears diagnostics on successful output', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, '[error-2-1] first error');
      await waitForDiagnostics(doc.uri);

      extensionApi.processEasyCryptOutput(doc.uri, 'No more goals');
      const cleared = await waitForNoDiagnostics(doc.uri);
      assert.equal(cleared.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('replaces old diagnostics with newest run output', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, '[error-5-1] first error');
      const first = await waitForDiagnostics(doc.uri);
      assert.equal(first.length, 1);

      extensionApi.processEasyCryptOutput(doc.uri, '[error-10-1] second error');
      const second = await waitForDiagnostics(doc.uri);
      assert.equal(second.length, 1);
      assert.ok(second[0].message.includes('second error'));
      assert.equal(second[0].range.start.line, 9);
    } finally {
      await fixture.cleanup();
    }
  });

  it('supports multiple diagnostics in a single output batch', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(
        doc.uri,
        ['[error-3-1] first error', '[warning-5-1] warning item', '[error-10-5] second error'].join('\n')
      );
      const diagnostics = await waitForDiagnostics(doc.uri, 10_000, 3);

      assert.equal(diagnostics.length, 3);
      const errors = diagnostics.filter((diag) => diag.severity === vscode.DiagnosticSeverity.Error);
      const warnings = diagnostics.filter((diag) => diag.severity === vscode.DiagnosticSeverity.Warning);
      assert.equal(errors.length, 2);
      assert.equal(warnings.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('parses anomaly output as error diagnostic', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, 'anomaly: internal error in proof engine');
      const diagnostics = await waitForDiagnostics(doc.uri);

      assert.ok(/anomaly/i.test(diagnostics[0].message));
      assert.equal(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses non-empty fallback range for locationless errors', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.processEasyCryptOutput(doc.uri, 'type error: expected int, got bool');
      const diagnostics = await waitForDiagnostics(doc.uri);

      const diag = diagnostics[0];
      assert.equal(diag.range.start.line, 0);
      assert.ok(
        diag.range.end.character > diag.range.start.character || diag.range.end.line > diag.range.start.line,
        'Expected fallback range to be non-empty'
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores progress-only output and keeps diagnostics empty', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      extensionApi.clearDiagnostics(doc.uri);
      await waitForNoDiagnostics(doc.uri);

      extensionApi.processEasyCryptOutput(
        doc.uri,
        ['P 1 100 0.5 -1.00 -1.00', 'P 2 100 0.8 -1.00 -1.00', 'P 3 100 1.0 -1.00 -1.00'].join('\n')
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      assert.equal(diagnostics.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('exposes and applies clearDiagnostics API', async function () {
    const fixture = await createTempEcFile('lemma t : true.\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      assert.equal(typeof extensionApi.clearDiagnostics, 'function');

      extensionApi.processEasyCryptOutput(doc.uri, '[error-1-1] some error');
      await waitForDiagnostics(doc.uri);

      extensionApi.clearDiagnostics(doc.uri);
      const diagnostics = await waitForNoDiagnostics(doc.uri);
      assert.equal(diagnostics.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('exposes getDiagnosticManager API', async function () {
    assert.equal(typeof extensionApi.getDiagnosticManager, 'function');
    const manager = extensionApi.getDiagnosticManager();
    assert.ok(manager, 'Expected DiagnosticManager from extension API');
  });

  it('exposes clearDiagnosticsAfterLine API and trims trailing diagnostics', async function () {
    const fixture = await createTempEcFile('line 1\nline 2\nline 3\nline 4\nline 5\n');

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filePath));
      await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
      await vscode.window.showTextDocument(doc);

      assert.equal(typeof extensionApi.clearDiagnosticsAfterLine, 'function');

      extensionApi.processEasyCryptOutput(doc.uri, '[error-1-1] Error 1\n[error-5-1] Error 2');
      await waitForDiagnostics(doc.uri, 10_000, 2);

      extensionApi.clearDiagnosticsAfterLine(doc.uri, 2);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const remaining = vscode.languages.getDiagnostics(doc.uri);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].range.start.line, 0);
    } finally {
      await fixture.cleanup();
    }
  });
});