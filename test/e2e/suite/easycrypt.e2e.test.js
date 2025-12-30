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

function runEasycryptCompile(easycryptPath, filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(easycryptPath, ['compile', '-script', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr }));
  });
}

async function waitForDiagnostics(uri, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diags = vscode.languages.getDiagnostics(uri);
    if (diags && diags.length > 0) return diags;
    await new Promise((r) => setTimeout(r, 100));
  }
  return vscode.languages.getDiagnostics(uri);
}

describe('EasyCrypt E2E (with real easycrypt)', function () {
  this.timeout(90_000);

  it('spawns easycrypt compile and surfaces a VS Code diagnostic', async function () {
    const easycryptPath = process.env.EASYCRYPT_PATH || (await which('easycrypt'));
    if (!easycryptPath) {
      this.skip();
      return;
    }

    const ext = vscode.extensions.getExtension('tornado.easycrypt-vscode');
    assert.ok(ext, 'Extension tornado.easycrypt-vscode should be present');
    await ext.activate();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-vscode-e2e-'));
    const badFilePath = path.join(tmpDir, 'bad.ec');

    // Intentionally invalid file to force a parse error with a concrete location.
    const badContents = [
      '(* intentionally invalid *)',
      'lemma bad : true.',
      'proof.',
      '  this_is_not_a_tactic.',
      'qed.',
      '',
    ].join('\n');

    await fs.writeFile(badFilePath, badContents, 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(badFilePath));
    await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
    await vscode.window.showTextDocument(doc);

    const { stdout, stderr } = await runEasycryptCompile(easycryptPath, badFilePath);
    const combined = [stdout, stderr].filter(Boolean).join('\n');

    // Feed output into the extension's integration hook.
    const extensionApi = ext.exports;
    assert.ok(extensionApi && typeof extensionApi.processEasyCryptOutput === 'function');

    extensionApi.processEasyCryptOutput(doc.uri, combined);

    const diags = await waitForDiagnostics(doc.uri);
    assert.ok(diags.length > 0, `Expected diagnostics, got none. Output was:\n${combined}`);

    const errorDiag = diags.find((d) => d.severity === vscode.DiagnosticSeverity.Error) || diags[0];
    assert.ok(errorDiag.message.toLowerCase().includes('parse error') || errorDiag.message.toLowerCase().includes('error'));

    // The known error should point to line 4 (1-indexed), columns roughly 2-22.
    assert.equal(errorDiag.range.start.line, 3);
    assert.ok(errorDiag.range.end.character > errorDiag.range.start.character);

    // Now feed a clean output and ensure stale diagnostics are cleared.
    extensionApi.processEasyCryptOutput(doc.uri, 'Compilation successful');

    const cleared = await (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const current = vscode.languages.getDiagnostics(doc.uri);
        if (!current || current.length === 0) return current;
        await new Promise((r) => setTimeout(r, 100));
      }
      return vscode.languages.getDiagnostics(doc.uri);
    })();

    assert.equal(cleared.length, 0, 'Expected diagnostics to be cleared after successful output');
  });
});
