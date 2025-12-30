/**
 * End-to-End Tests for EasyCrypt Diagnostics and Error Highlighting
 * 
 * These tests verify that error messages from EasyCrypt are correctly parsed
 * and displayed as diagnostics in VS Code (squiggles in the editor, Problems panel).
 * 
 * Test coverage:
 * - Error highlighting with inline squiggles
 * - Hover tooltip displays error message
 * - Problems panel integration
 * - Multiple error formats (compile, script, REPL)
 * - Diagnostic clearing on successful verification
 * - Cross-file error reporting
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vscode = require('vscode');

async function configureMockEasyCrypt() {
    const mockPath = path.resolve(__dirname, '..', '..', 'fixtures', 'mock_easycrypt.js');
    // Ensure executable bit is set (ConfigurationManager validates X_OK on macOS/Linux).
    try {
        await fs.chmod(mockPath, 0o755);
    } catch {
        // Best-effort; some environments may not allow chmod.
    }

    const cfg = vscode.workspace.getConfiguration('easycrypt');
    // Keep checks fast in e2e.
    await cfg.update('diagnostics.delay', 150, vscode.ConfigurationTarget.Global);
    await cfg.update('diagnostics.liveChecks', true, vscode.ConfigurationTarget.Global);
    await cfg.update('diagnostics.onChange', true, vscode.ConfigurationTarget.Global);
    await cfg.update('diagnostics.onSave', true, vscode.ConfigurationTarget.Global);
    await cfg.update('executablePath', mockPath, vscode.ConfigurationTarget.Global);
    await cfg.update('arguments', [], vscode.ConfigurationTarget.Global);
    await cfg.update('proverArgs', [], vscode.ConfigurationTarget.Global);
    await cfg.update('diagnostics.enabled', true, vscode.ConfigurationTarget.Global);
}

/**
 * Waits for diagnostics to appear on a document
 * @param {vscode.Uri} uri - The document URI to check
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @param {number} minCount - Minimum number of diagnostics expected
 * @returns {Promise<vscode.Diagnostic[]>} The diagnostics found
 */
async function waitForDiagnostics(uri, timeoutMs = 10_000, minCount = 1) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const diags = vscode.languages.getDiagnostics(uri);
        if (diags && diags.length >= minCount) {
            return diags;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return vscode.languages.getDiagnostics(uri);
}

/**
 * Waits for diagnostics to be cleared from a document
 * @param {vscode.Uri} uri - The document URI to check
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @returns {Promise<vscode.Diagnostic[]>} The remaining diagnostics (should be empty)
 */
async function waitForNoDiagnostics(uri, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const diags = vscode.languages.getDiagnostics(uri);
        if (!diags || diags.length === 0) {
            return diags || [];
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return vscode.languages.getDiagnostics(uri);
}

/**
 * Creates a temporary .ec file with the given content
 * @param {string} content - The file content
 * @param {string} filename - Optional filename (default: 'test.ec')
 * @returns {Promise<{path: string, cleanup: () => Promise<void>}>}
 */
async function createTempEcFile(content, filename = 'test.ec') {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easycrypt-diag-e2e-'));
    const filePath = path.join(tmpDir, filename);
    await fs.writeFile(filePath, content, 'utf8');
    
    return {
        path: filePath,
        cleanup: async () => {
            try {
                await fs.rm(tmpDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    };
}

describe('EasyCrypt Diagnostics E2E Tests', function () {
    this.timeout(60_000);

    /** @type {typeof import('../../../out/extension')} */
    let extensionApi;
    
    /** @type {vscode.Extension<any>} */
    let extension;

    before(async function () {
        // Configure mock binary BEFORE activating, so activation-time validation does not pop UI.
        await configureMockEasyCrypt();

        // Get and activate the extension
        extension = vscode.extensions.getExtension('tornado.easycrypt-vscode');
        assert.ok(extension, 'Extension tornado.easycrypt-vscode should be present');
        extensionApi = await extension.activate();
        assert.ok(extensionApi, 'Extension should export an API');
        assert.ok(typeof extensionApi.processEasyCryptOutput === 'function', 
            'Extension should export processEasyCryptOutput');
    });

    describe('Error Tag Format [error-LINE-COL]', function () {
        
        it('should display inline squiggle for basic error tag', async function () {
            const fileContent = `(* Test file *)
lemma test : true.
proof.
  invalid_tactic.
qed.
`;
            const { path: filePath, cleanup } = await createTempEcFile(fileContent);
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // Simulate EasyCrypt error output
                const errorOutput = '[error-4-3] unknown tactic: invalid_tactic';
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Expected at least one diagnostic');
                
                const errorDiag = diags.find(d => d.severity === vscode.DiagnosticSeverity.Error);
                assert.ok(errorDiag, 'Expected an error-level diagnostic');
                
                // Line 4 (1-indexed) = line 3 (0-indexed)
                assert.equal(errorDiag.range.start.line, 3, 'Error should be on line 4 (0-indexed: 3)');
                assert.equal(errorDiag.range.start.character, 2, 'Error should start at column 3 (0-indexed: 2)');
                assert.ok(errorDiag.message.includes('invalid_tactic'), 'Message should mention the tactic');
                assert.equal(errorDiag.source, 'EasyCrypt', 'Source should be EasyCrypt');
            } finally {
                await cleanup();
            }
        });

        it('should display squiggle for range error [error-L1-C1-L2-C2]', async function () {
            const fileContent = `(* Test file *)
op bad_op : int =
  some_long_expression_that_spans_multiple_lines
    + more_stuff.
`;
            const { path: filePath, cleanup } = await createTempEcFile(fileContent);
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // Error spanning lines 3-4
                const errorOutput = '[error-3-3-4-14] type error: expected int';
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Expected at least one diagnostic');
                
                const errorDiag = diags[0];
                assert.equal(errorDiag.range.start.line, 2, 'Should start at line 3 (0-indexed: 2)');
                assert.equal(errorDiag.range.end.line, 3, 'Should end at line 4 (0-indexed: 3)');
            } finally {
                await cleanup();
            }
        });
    });

    describe('Compile Output Format', function () {

        it('should parse [critical] format from easycrypt compile', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                const errorOutput = `[critical] [${filePath}: line 5 (10-25)] parse error: unexpected token`;
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Expected at least one diagnostic');
                
                const errorDiag = diags[0];
                assert.equal(errorDiag.range.start.line, 4, 'Line 5 (0-indexed: 4)');
                assert.equal(errorDiag.range.start.character, 9, 'Column 10 (0-indexed: 9)');
                assert.equal(errorDiag.range.end.character, 24, 'End column 25 (0-indexed: 24)');
                assert.ok(errorDiag.message.toLowerCase().includes('parse error'));
            } finally {
                await cleanup();
            }
        });

        it('should parse E critical format from easycrypt compile -script', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // Script format with trailing progress info
                const errorOutput = `E critical ${filePath}: line 3 (5-15) unknown symbol: foo P 3 100 0.5 -1.00 -1.00`;
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Expected at least one diagnostic');
                
                const errorDiag = diags[0];
                assert.equal(errorDiag.range.start.line, 2, 'Line 3 (0-indexed: 2)');
                assert.equal(errorDiag.range.start.character, 4, 'Column 5 (0-indexed: 4)');
                assert.ok(errorDiag.message.toLowerCase().includes('unknown symbol'));
            } finally {
                await cleanup();
            }
        });
    });

    describe('Warning Messages', function () {

        it('should display warning with yellow severity', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                const warningOutput = '[warning-10-1] unused variable: x';
                extensionApi.processEasyCryptOutput(doc.uri, warningOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Expected at least one diagnostic');
                
                const warningDiag = diags.find(d => d.severity === vscode.DiagnosticSeverity.Warning);
                assert.ok(warningDiag, 'Expected a warning-level diagnostic');
                assert.equal(warningDiag.range.start.line, 9, 'Line 10 (0-indexed: 9)');
            } finally {
                await cleanup();
            }
        });
    });

    describe('Message-Embedded Location Format', function () {

        it('should extract location from "at line X, column Y" format', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                const errorOutput = 'error: at line 15, column 8: undefined variable';
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Expected at least one diagnostic');
                
                const errorDiag = diags[0];
                assert.equal(errorDiag.range.start.line, 14, 'Line 15 (0-indexed: 14)');
                assert.equal(errorDiag.range.start.character, 7, 'Column 8 (0-indexed: 7)');
            } finally {
                await cleanup();
            }
        });

        it('should extract range from "at line X, column Y to line Z, column W"', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                const errorOutput = 'error: at line 20, column 5 to line 20, column 30: invalid expression';
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Expected at least one diagnostic');
                
                const errorDiag = diags[0];
                assert.equal(errorDiag.range.start.line, 19, 'Start line 20 (0-indexed: 19)');
                assert.equal(errorDiag.range.start.character, 4, 'Start column 5 (0-indexed: 4)');
                assert.equal(errorDiag.range.end.line, 19, 'End line 20 (0-indexed: 19)');
                assert.equal(errorDiag.range.end.character, 29, 'End column 30 (0-indexed: 29)');
            } finally {
                await cleanup();
            }
        });
    });

    describe('Diagnostic Lifecycle', function () {

        it('should clear diagnostics when verification succeeds', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // First, set an error
                const errorOutput = '[error-5-1] some error';
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diagsBefore = await waitForDiagnostics(doc.uri);
                assert.ok(diagsBefore.length > 0, 'Should have diagnostics after error');

                // Now, simulate successful verification (no errors in output)
                extensionApi.processEasyCryptOutput(doc.uri, 'No more goals');

                const diagsAfter = await waitForNoDiagnostics(doc.uri);
                assert.equal(diagsAfter.length, 0, 'Diagnostics should be cleared after success');
            } finally {
                await cleanup();
            }
        });

        it('should replace old diagnostics with new ones', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // First error
                extensionApi.processEasyCryptOutput(doc.uri, '[error-5-1] first error');
                const diagsFirst = await waitForDiagnostics(doc.uri);
                assert.equal(diagsFirst.length, 1);
                assert.ok(diagsFirst[0].message.includes('first error'));

                // Second error replaces the first
                extensionApi.processEasyCryptOutput(doc.uri, '[error-10-1] second error');
                const diagsSecond = await waitForDiagnostics(doc.uri);
                assert.equal(diagsSecond.length, 1, 'Should only have the new diagnostic');
                assert.ok(diagsSecond[0].message.includes('second error'));
                assert.equal(diagsSecond[0].range.start.line, 9, 'New error at line 10');
            } finally {
                await cleanup();
            }
        });

        it('should handle multiple errors in single output', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                const multiErrorOutput = `[error-3-1] first error
[warning-5-1] a warning
[error-10-5] second error`;
                extensionApi.processEasyCryptOutput(doc.uri, multiErrorOutput);

                const diags = await waitForDiagnostics(doc.uri, 10_000, 3);
                
                assert.equal(diags.length, 3, 'Should have 3 diagnostics');
                
                const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
                
                assert.equal(errors.length, 2, 'Should have 2 errors');
                assert.equal(warnings.length, 1, 'Should have 1 warning');
            } finally {
                await cleanup();
            }
        });
    });

    describe('Edge Cases and Fallbacks', function () {

        it('should handle anomaly errors', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                const anomalyOutput = 'anomaly: internal error in proof engine';
                extensionApi.processEasyCryptOutput(doc.uri, anomalyOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Should have diagnostic for anomaly');
                assert.ok(diags[0].message.toLowerCase().includes('anomaly'));
                assert.equal(diags[0].severity, vscode.DiagnosticSeverity.Error);
            } finally {
                await cleanup();
            }
        });

        it('should create fallback range when location is missing', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // Error without location info
                const errorOutput = 'type error: expected int, got bool';
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Should have diagnostic even without location');
                
                // Fallback should be line 1 with non-empty range
                const diag = diags[0];
                assert.equal(diag.range.start.line, 0, 'Fallback to line 1 (0-indexed: 0)');
                assert.ok(
                    diag.range.end.character > diag.range.start.character ||
                    diag.range.end.line > diag.range.start.line,
                    'Range should be non-empty for squiggle to appear'
                );
            } finally {
                await cleanup();
            }
        });

        it('should ignore progress-only output', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // First clear any existing diagnostics
                extensionApi.clearDiagnostics(doc.uri);
                await waitForNoDiagnostics(doc.uri);

                // Progress-only output should not create diagnostics
                const progressOutput = `P 1 100 0.5 -1.00 -1.00
P 2 100 0.8 -1.00 -1.00
P 3 100 1.0 -1.00 -1.00`;
                extensionApi.processEasyCryptOutput(doc.uri, progressOutput);

                // Wait a bit and ensure no diagnostics appeared
                await new Promise(r => setTimeout(r, 500));
                const diags = vscode.languages.getDiagnostics(doc.uri);
                assert.equal(diags.length, 0, 'Progress output should not create diagnostics');
            } finally {
                await cleanup();
            }
        });
    });

    describe('Diagnostic Manager API', function () {

        it('should expose clearDiagnostics function', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // Set an error
                extensionApi.processEasyCryptOutput(doc.uri, '[error-1-1] test');
                await waitForDiagnostics(doc.uri);

                // Clear diagnostics via exposed API
                assert.ok(typeof extensionApi.clearDiagnostics === 'function');
                extensionApi.clearDiagnostics(doc.uri);

                const diags = await waitForNoDiagnostics(doc.uri);
                assert.equal(diags.length, 0, 'Diagnostics should be cleared');
            } finally {
                await cleanup();
            }
        });

        it('should expose getDiagnosticManager function', function () {
            assert.ok(typeof extensionApi.getDiagnosticManager === 'function');
            const manager = extensionApi.getDiagnosticManager();
            assert.ok(manager, 'DiagnosticManager should be available');
        });

        it('should expose clearDiagnosticsAfterLine function', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('line 1\nline 2\nline 3\nline 4\nline 5');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                // Set multiple errors
                // Error on line 1 (0-indexed: 0)
                // Error on line 5 (0-indexed: 4)
                const output = `[error-1-1] Error 1
[error-5-1] Error 2`;
                extensionApi.processEasyCryptOutput(doc.uri, output);
                
                const diags = await waitForDiagnostics(doc.uri, 10000, 2);
                assert.equal(diags.length, 2, 'Should have 2 diagnostics');

                // Clear after line 3 (0-indexed: 2)
                // This should remove Error 2 (line 5) but keep Error 1 (line 1)
                assert.ok(typeof extensionApi.clearDiagnosticsAfterLine === 'function');
                extensionApi.clearDiagnosticsAfterLine(doc.uri, 2);

                // Wait a bit for update
                await new Promise(r => setTimeout(r, 500));
                
                const remainingDiags = vscode.languages.getDiagnostics(doc.uri);
                assert.equal(remainingDiags.length, 1, 'Should have 1 diagnostic remaining');
                assert.ok(remainingDiags[0].range.start.line === 0, 'Remaining diagnostic should be on line 1');
                
            } finally {
                await cleanup();
            }
        });
    });

    describe('Hover Tooltip Verification', function () {

        it('diagnostic message should be suitable for hover tooltip', async function () {
            const { path: filePath, cleanup } = await createTempEcFile('test content');
            
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                await vscode.window.showTextDocument(doc);

                const errorMessage = 'variable "x" is not declared in current scope';
                const errorOutput = `[error-5-10] ${errorMessage}`;
                extensionApi.processEasyCryptOutput(doc.uri, errorOutput);

                const diags = await waitForDiagnostics(doc.uri);
                
                assert.ok(diags.length > 0, 'Expected diagnostic');
                
                // The message should be human-readable and complete
                assert.ok(
                    diags[0].message.includes('variable') && 
                    diags[0].message.includes('not declared'),
                    'Diagnostic message should preserve the full error text'
                );
                
                // Message should not be empty or just whitespace
                assert.ok(diags[0].message.trim().length > 0, 'Message should not be empty');
            } finally {
                await cleanup();
            }
        });
    });

    describe('Live Diagnostics (on type)', function () {

        it('should run live checks on edit and update diagnostics', async function () {
            const fileContent = `(* live check *)\nlemma test : true.\nproof.\n  trivial.\nqed.\n`;
            const { path: filePath, cleanup } = await createTempEcFile(fileContent, 'live.ec');

            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.languages.setTextDocumentLanguage(doc, 'easycrypt');
                const editor = await vscode.window.showTextDocument(doc);

                // Ensure no stale diagnostics.
                extensionApi.clearDiagnostics(doc.uri);
                await waitForNoDiagnostics(doc.uri);

                // Introduce an error trigger recognized by the mock binary.
                await editor.edit((edit) => {
                    edit.insert(new vscode.Position(3, 0), '  syntax_error.\n');
                });

                const diags = await waitForDiagnostics(doc.uri, 15_000, 1);
                assert.ok(diags.length > 0, 'Expected diagnostics after live check');
                const err = diags.find((d) => d.severity === vscode.DiagnosticSeverity.Error) || diags[0];
                assert.ok(err.message.toLowerCase().includes('syntax error') || err.message.toLowerCase().includes('error'));
                assert.ok(!err.message.toLowerCase().includes('unknown option'), 'Should not report EasyCrypt CLI option errors');

                // Now fix the file and ensure diagnostics clear.
                const fullText = doc.getText();
                const fixedText = fullText.replace('  syntax_error.\n', '');
                const fullRange = new vscode.Range(
                    doc.positionAt(0),
                    doc.positionAt(fullText.length)
                );

                await editor.edit((edit) => {
                    edit.replace(fullRange, fixedText);
                });

                const cleared = await waitForNoDiagnostics(doc.uri, 15_000);
                assert.equal(cleared.length, 0, 'Expected diagnostics to clear after fixing file');
            } finally {
                await cleanup();
            }
        });
    });
});
