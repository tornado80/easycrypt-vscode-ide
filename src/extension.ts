/**
 * EasyCrypt VS Code Extension
 * 
 * Main extension entry point. This module handles extension activation,
 * deactivation, and integration of all extension features.
 * 
 * @module extension
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { DiagnosticManager } from './diagnosticManager';
import { parseOutput } from './outputParser';
import { 
    ConfigurationManager, 
    getConfigurationManager, 
    disposeConfigurationManager 
} from './configurationManager';
import { ProcessManager } from './processManager';
import { ProofStateManager } from './proofStateManager';
import { ProofStateViewProvider, PROOF_STATE_VIEW_ID } from './proofStateViewProvider';
import { StepManager } from './stepManager';
import { EditorDecorator } from './editorDecorator';
import { Logger } from './logger';

/** The diagnostic manager instance */
let diagnosticManager: DiagnosticManager | undefined;

/** The configuration manager instance */
let configurationManager: ConfigurationManager | undefined;

/** The process manager instance */
let processManager: ProcessManager | undefined;

/** The proof state manager instance */
let proofStateManager: ProofStateManager | undefined;

/** The proof state view provider instance */
let proofStateViewProvider: ProofStateViewProvider | undefined;

/** Internal/testing: counts proof state change events */
let proofStateChangeCount = 0;

/** The step manager instance */
let stepManager: StepManager | undefined;

/** The editor decorator instance */
let editorDecorator: EditorDecorator | undefined;

/** Output channel for logging */
let outputChannel: vscode.OutputChannel | undefined;

/** Logger instance */
let logger: Logger | undefined;

/** Status bar item showing process state */
let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Logs a message to the output channel
 */
function log(message: string): void {
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
}

/**
 * Processes EasyCrypt output and updates diagnostics
 * 
 * This is the main integration point between the output parser and
 * the diagnostic manager. Call this function whenever you receive
 * output from the EasyCrypt process.
 * 
 * @param uri - The URI of the file being processed
 * @param output - The raw output from EasyCrypt
 * @returns The parsed result
 */
export function processEasyCryptOutput(uri: vscode.Uri, output: string) {
    if (!diagnosticManager) {
        log('Warning: DiagnosticManager not initialized');
        return null;
    }

    if (configurationManager && !configurationManager.isDiagnosticsEnabled()) {
        return null;
    }

    const result = parseOutput(output, {
        defaultFilePath: uri.fsPath,
        includeRawOutput: true
    });

    // Group diagnostics by their target URI. This matters when EasyCrypt reports
    // a canonicalized path (or an imported file) that differs from the editor URI.
    const errorsByUri = new Map<string, { uri: vscode.Uri; errors: typeof result.errors }>();

    for (const err of result.errors) {
        const targetUri = (() => {
            if (!err.filePath) {
                return uri;
            }
            // Prefer the context URI when the paths match after normalization.
            // This avoids missing squiggles due to minor path differences.
            try {
                const normalizedContext = path.resolve(uri.fsPath);
                const normalizedReported = path.resolve(err.filePath);
                if (normalizedContext === normalizedReported) {
                    return uri;
                }
            } catch {
                // Fall through to Uri.file
            }
            return vscode.Uri.file(err.filePath);
        })();

        const key = targetUri.toString();
        const entry = errorsByUri.get(key);
        if (entry) {
            entry.errors.push(err);
        } else {
            errorsByUri.set(key, { uri: targetUri, errors: [err] });
        }
    }

    // Keep diagnostics in sync with the latest parse result.
    // If there are no errors/warnings for the context URI, clear stale diagnostics.
    if (errorsByUri.size === 0) {
        diagnosticManager.setDiagnostics(uri, []);
        log(`Cleared diagnostics for ${uri.fsPath}`);
    } else {
        // First, clear context URI if it has no entries.
        if (!errorsByUri.has(uri.toString())) {
            diagnosticManager.setDiagnostics(uri, []);
        }
        for (const { uri: targetUri, errors } of errorsByUri.values()) {
            diagnosticManager.setDiagnostics(targetUri, errors);
            log(`Set ${errors.length} diagnostic(s) for ${targetUri.fsPath}`);
        }
    }

    // Helpful debug signal when parsing failed but EasyCrypt produced output.
    if (result.errors.length === 0 && result.remainingOutput.trim()) {
        log(`Unrecognized output (no diagnostics produced): ${result.remainingOutput}`);
    }

    return result;
}

/**
 * Clears diagnostics for a file
 * 
 * Call this when:
 * - The user retracts proof steps
 * - The file is re-verified from the beginning
 * - The user manually clears diagnostics
 * 
 * @param uri - The URI of the file to clear diagnostics for
 */
export function clearDiagnostics(uri: vscode.Uri): void {
    if (diagnosticManager) {
        diagnosticManager.clearDiagnostics(uri);
        log(`Cleared diagnostics for ${uri.fsPath}`);
    }
}

/**
 * Clears diagnostics after a specific line
 * 
 * Call this when the user steps backwards in a proof.
 * 
 * @param uri - The URI of the file
 * @param line - The 0-indexed line number to clear after
 */
export function clearDiagnosticsAfterLine(uri: vscode.Uri, line: number): void {
    if (diagnosticManager) {
        diagnosticManager.clearDiagnosticsAfterLine(uri, line);
        log(`Cleared diagnostics after line ${line + 1} in ${uri.fsPath}`);
    }
}

/**
 * Gets the diagnostic manager instance
 * 
 * @returns The DiagnosticManager instance, or undefined if not initialized
 */
export function getDiagnosticManager(): DiagnosticManager | undefined {
    return diagnosticManager;
}

/**
 * Registers extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
    // Command to clear all diagnostics
    const clearAllDiagnostics = vscode.commands.registerCommand(
        'easycrypt.clearAllDiagnostics',
        () => {
            if (diagnosticManager) {
                diagnosticManager.clearAll();
                log('Cleared all diagnostics');
                vscode.window.showInformationMessage('EasyCrypt: Cleared all diagnostics');
            }
        }
    );
    context.subscriptions.push(clearAllDiagnostics);

    // Command to clear diagnostics for current file
    const clearFileDiagnostics = vscode.commands.registerCommand(
        'easycrypt.clearFileDiagnostics',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && diagnosticManager) {
                diagnosticManager.clearDiagnostics(editor.document.uri);
                log(`Cleared diagnostics for ${editor.document.uri.fsPath}`);
            }
        }
    );
    context.subscriptions.push(clearFileDiagnostics);

    // Command to show diagnostic count (for debugging/status bar)
    const showDiagnosticCount = vscode.commands.registerCommand(
        'easycrypt.showDiagnosticCount',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && diagnosticManager) {
                const counts = diagnosticManager.getDiagnosticCountsBySeverity(editor.document.uri);
                vscode.window.showInformationMessage(
                    `EasyCrypt Diagnostics: ${counts.errors} error(s), ${counts.warnings} warning(s)`
                );
            }
        }
    );
    context.subscriptions.push(showDiagnosticCount);

    // Development/testing command to simulate an error
    const simulateError = vscode.commands.registerCommand(
        'easycrypt.dev.simulateError',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'easycrypt') {
                vscode.window.showWarningMessage('Open an EasyCrypt file first');
                return;
            }

            const line = editor.selection.active.line + 1; // Convert to 1-indexed
            const col = editor.selection.active.character + 1;
            
            // Simulate an EasyCrypt error output
            const simulatedOutput = `[error-${line}-${col}] unknown symbol: test_symbol`;
            
            const result = processEasyCryptOutput(editor.document.uri, simulatedOutput);
            if (result && result.errors.length > 0) {
                vscode.window.showInformationMessage(
                    `Simulated error at line ${line}, column ${col}`
                );
            }
        }
    );
    context.subscriptions.push(simulateError);

    // Command to check the current file with EasyCrypt
    const checkFile = vscode.commands.registerCommand(
        'easycrypt.checkFile',
        async () => {
            const editor = vscode.window.activeTextEditor;
            logger?.command('easycrypt.checkFile', { 
                uri: editor?.document.uri.fsPath,
                languageId: editor?.document.languageId
            });
            if (!editor || editor.document.languageId !== 'easycrypt') {
                vscode.window.showWarningMessage('Open an EasyCrypt file first');
                logger?.commandComplete('easycrypt.checkFile', false, { error: 'no active EasyCrypt file' });
                return;
            }

            await checkDocument(editor.document);
            logger?.commandComplete('easycrypt.checkFile', true, { uri: editor.document.uri.fsPath });
        }
    );
    context.subscriptions.push(checkFile);

    // Command to start/restart the EasyCrypt process
    const startProcess = vscode.commands.registerCommand(
        'easycrypt.startProcess',
        async () => {
            logger?.command('easycrypt.startProcess');
            if (!processManager) {
                vscode.window.showErrorMessage('EasyCrypt: Process manager not initialized');
                logger?.commandComplete('easycrypt.startProcess', false, { error: 'not initialized' });
                return;
            }
            try {
                if (processManager.isRunning()) {
                    await processManager.restart();
                    logger?.commandComplete('easycrypt.startProcess', true, { action: 'restart' });
                } else {
                    await processManager.start();
                    vscode.window.showInformationMessage('EasyCrypt process started');
                    logger?.commandComplete('easycrypt.startProcess', true, { action: 'start' });
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`EasyCrypt: Failed to start process - ${msg}`);
                logger?.commandComplete('easycrypt.startProcess', false, { error: msg });
            }
        }
    );
    context.subscriptions.push(startProcess);

    // Command to stop the EasyCrypt process
    const stopProcess = vscode.commands.registerCommand(
        'easycrypt.stopProcess',
        () => {
            logger?.command('easycrypt.stopProcess');
            if (processManager?.isRunning()) {
                processManager.stop();
                vscode.window.showInformationMessage('EasyCrypt process stopped');
                logger?.commandComplete('easycrypt.stopProcess', true);
            } else {
                vscode.window.showInformationMessage('EasyCrypt process is not running');
                logger?.commandComplete('easycrypt.stopProcess', false, { reason: 'not running' });
            }
        }
    );
    context.subscriptions.push(stopProcess);

    // Command to step forward
    const stepForwardCmd = vscode.commands.registerCommand(
        'easycrypt.stepForward',
        async () => {
            logger?.command('easycrypt.stepForward', { 
                executionOffset: stepManager?.getExecutionOffset() 
            });
            if (!stepManager) {
                vscode.window.showErrorMessage('EasyCrypt: Step manager not initialized');
                logger?.commandComplete('easycrypt.stepForward', false, { error: 'not initialized' });
                return;
            }
            const result = await stepManager.stepForward();
            logger?.commandComplete('easycrypt.stepForward', result.success, {
                executionOffset: result.executionOffset,
                error: result.error
            });
            if (!result.success && result.error) {
                vscode.window.showWarningMessage(`EasyCrypt: ${result.error}`);
            }
            return result;
        }
    );
    context.subscriptions.push(stepForwardCmd);

    // Command to step backward
    const stepBackwardCmd = vscode.commands.registerCommand(
        'easycrypt.stepBackward',
        async () => {
            logger?.command('easycrypt.stepBackward', { 
                executionOffset: stepManager?.getExecutionOffset() 
            });
            if (!stepManager) {
                vscode.window.showErrorMessage('EasyCrypt: Step manager not initialized');
                logger?.commandComplete('easycrypt.stepBackward', false, { error: 'not initialized' });
                return;
            }
            const result = await stepManager.stepBackward();
            logger?.commandComplete('easycrypt.stepBackward', result.success, {
                executionOffset: result.executionOffset,
                error: result.error
            });
            if (!result.success && result.error) {
                vscode.window.showWarningMessage(`EasyCrypt: ${result.error}`);
            }
            return result;
        }
    );
    context.subscriptions.push(stepBackwardCmd);

    // Command to go to cursor
    const goToCursorCmd = vscode.commands.registerCommand(
        'easycrypt.goToCursor',
        async () => {
            const editor = vscode.window.activeTextEditor;
            const cursorOffset = editor ? editor.document.offsetAt(editor.selection.active) : undefined;
            logger?.command('easycrypt.goToCursor', { 
                executionOffset: stepManager?.getExecutionOffset(),
                cursorOffset
            });
            if (!stepManager) {
                vscode.window.showErrorMessage('EasyCrypt: Step manager not initialized');
                logger?.commandComplete('easycrypt.goToCursor', false, { error: 'not initialized' });
                return;
            }
            const result = await stepManager.goToCursor();
            logger?.commandComplete('easycrypt.goToCursor', result.success, {
                executionOffset: result.executionOffset,
                error: result.error
            });
            if (!result.success && result.error) {
                vscode.window.showWarningMessage(`EasyCrypt: ${result.error}`);
            }
            return result;
        }
    );
    context.subscriptions.push(goToCursorCmd);

    // Command to reset proof state
    const resetProofCmd = vscode.commands.registerCommand(
        'easycrypt.resetProof',
        async () => {
            logger?.command('easycrypt.resetProof');
            if (!stepManager || !processManager) {
                vscode.window.showErrorMessage('EasyCrypt: Extension not initialized');
                logger?.commandComplete('easycrypt.resetProof', false, { error: 'not initialized' });
                return;
            }
            stepManager.reset();
            if (processManager.isRunning()) {
                await processManager.restart();
            }
            vscode.window.showInformationMessage('EasyCrypt: Proof state reset');
            logger?.commandComplete('easycrypt.resetProof', true);
            return { success: true };
        }
    );
    context.subscriptions.push(resetProofCmd);

    // Command to toggle verbose logging
    const toggleVerboseLoggingCmd = vscode.commands.registerCommand(
        'easycrypt.toggleVerboseLogging',
        async () => {
            const config = vscode.workspace.getConfiguration('easycrypt');
            const currentValue = config.get<boolean>('verboseLogging', false);
            const newValue = !currentValue;
            
            await config.update('verboseLogging', newValue, vscode.ConfigurationTarget.Global);
            
            const message = newValue 
                ? 'EasyCrypt: Verbose logging enabled. Check the Output panel (EasyCrypt channel).'
                : 'EasyCrypt: Verbose logging disabled.';
            vscode.window.showInformationMessage(message);
            
            if (newValue) {
                // Show the output channel when enabling verbose logging
                outputChannel?.show(true);
            }
        }
    );
    context.subscriptions.push(toggleVerboseLoggingCmd);

    // Internal/testing command: query current execution offset.
    // Not contributed to the command palette, but useful for E2E tests.
    const getExecutionOffsetCmd = vscode.commands.registerCommand('easycrypt._getExecutionOffset', () => {
        return stepManager?.getExecutionOffset() ?? 0;
    });
    context.subscriptions.push(getExecutionOffsetCmd);

    // Internal/testing command: query current verified range decoration.
    // Returns a plain object so tests don't depend on VS Code class serialization.
    const getVerifiedRangeCmd = vscode.commands.registerCommand('easycrypt._getVerifiedRange', () => {
        const range = editorDecorator?.getVerifiedRange();
        if (!range) {
            return null;
        }
        return {
            start: { line: range.start.line, character: range.start.character },
            end: { line: range.end.line, character: range.end.character }
        };
    });
    context.subscriptions.push(getVerifiedRangeCmd);

    // Internal/testing command: query how many times the EasyCrypt process has started.
    // Useful for performance regressions (e.g., ensuring a backward jump triggers only one recovery).
    const getProcessStartCountCmd = vscode.commands.registerCommand('easycrypt._getProcessStartCount', () => {
        return processManager?.getProcessStartCount() ?? 0;
    });
    context.subscriptions.push(getProcessStartCountCmd);

    // Internal/testing command: query how many times sendCommand() was invoked.
    // Useful to assert one-shot batching (single send for multi-statement replay).
    const getSendCommandCountCmd = vscode.commands.registerCommand('easycrypt._getSendCommandCount', () => {
        return processManager?.getSendCommandCount() ?? 0;
    });
    context.subscriptions.push(getSendCommandCountCmd);

    // Internal/testing command: query number of proof state changes since last reset.
    const getProofStateChangeCountCmd = vscode.commands.registerCommand('easycrypt._getProofStateChangeCount', () => {
        return proofStateChangeCount;
    });
    context.subscriptions.push(getProofStateChangeCountCmd);

    // Internal/testing command: reset proof state change counter.
    const resetProofStateChangeCountCmd = vscode.commands.registerCommand('easycrypt._resetProofStateChangeCount', () => {
        proofStateChangeCount = 0;
        return true;
    });
    context.subscriptions.push(resetProofStateChangeCountCmd);

    // Internal/testing command: query how many updateState messages were posted to the Proof State webview.
    const getProofStateViewUpdateCountCmd = vscode.commands.registerCommand('easycrypt._getProofStateViewUpdateCount', () => {
        return proofStateViewProvider?.getPostedUpdateCount() ?? 0;
    });
    context.subscriptions.push(getProofStateViewUpdateCountCmd);

    // Internal/testing command: reset Proof State webview update counter.
    const resetProofStateViewUpdateCountCmd = vscode.commands.registerCommand('easycrypt._resetProofStateViewUpdateCount', () => {
        proofStateViewProvider?.resetPostedUpdateCount();
        return true;
    });
    context.subscriptions.push(resetProofStateViewUpdateCountCmd);

    // Internal/testing command: simulate a message from the webview.
    const simulateWebviewMessageCmd = vscode.commands.registerCommand('easycrypt._simulateWebviewMessage', (message: any) => {
        proofStateViewProvider?.simulateMessage(message);
        return true;
    });
    context.subscriptions.push(simulateWebviewMessageCmd);

    // Internal/testing command: get a snapshot of the current proof state.
    // Returns a plain object for deterministic test assertions against proof state content.
    // This allows tests to verify the correct "last output" is shown without depending on webview.
    // Includes provedStatementCount and debugEmacsPromptMarker for prompt/statement sync assertions.
    const getProofStateSnapshotCmd = vscode.commands.registerCommand('easycrypt._getProofStateSnapshot', () => {
        if (!proofStateManager) {
            return null;
        }
        const state = proofStateManager.state;
        return {
            isProcessing: state.isProcessing,
            isComplete: state.isComplete,
            outputLines: state.outputLines ?? [],
            messages: state.messages.map(m => ({
                severity: m.severity,
                content: m.content
            })),
            goalsCount: state.goals.length,
            rawOutputLength: state.rawOutput?.length ?? 0,
            // Progress and debug fields for prompt/statement sync assertions
            provedStatementCount: state.progress?.provedStatementCount,
            debugEmacsPromptMarker: state.debugEmacsPromptMarker
        };
    });
    context.subscriptions.push(getProofStateSnapshotCmd);

    // Command to force recovery of proof state
    // Useful when the user suspects the session is desynchronized
    const forceRecoveryCmd = vscode.commands.registerCommand(
        'easycrypt.forceRecovery',
        async () => {
            logger?.command('easycrypt.forceRecovery', {
                executionOffset: stepManager?.getExecutionOffset()
            });
            if (!stepManager) {
                vscode.window.showErrorMessage('EasyCrypt: Step manager not initialized');
                logger?.commandComplete('easycrypt.forceRecovery', false, { error: 'not initialized' });
                return;
            }
            
            const result = await stepManager.forceRecovery();
            logger?.commandComplete('easycrypt.forceRecovery', result.success, {
                executionOffset: result.executionOffset,
                error: result.error
            });
            if (result.success) {
                vscode.window.showInformationMessage('EasyCrypt: Proof state recovered successfully');
            } else {
                vscode.window.showWarningMessage(`EasyCrypt: Recovery failed - ${result.error}`);
            }
            return result;
        }
    );
    context.subscriptions.push(forceRecoveryCmd);
}

/**
 * Checks a document with EasyCrypt and reports diagnostics
 * 
 * @param document - The document to check
 */
async function checkDocument(document: vscode.TextDocument): Promise<void> {
    if (!processManager || !outputChannel) {
        vscode.window.showErrorMessage('EasyCrypt: Extension not fully initialized');
        return;
    }

    // Clear existing diagnostics for this file
    if (diagnosticManager) {
        diagnosticManager.clearDiagnostics(document.uri);
    }

    // Update status bar
    updateStatusBar('checking');

    try {
        // Use easycrypt compile for one-shot file checking
        const config = configurationManager?.getConfig();

        // Resolve and validate executable path (don't rely on raw config string).
        if (!configurationManager) {
            updateStatusBar('error');
            vscode.window.showErrorMessage('EasyCrypt: Configuration manager not initialized');
            return;
        }

        const validation = await configurationManager.validateExecutablePath();
        if (!validation.valid) {
            updateStatusBar('error');
            await configurationManager.showConfigurationError(
                validation.error || 'EasyCrypt executable not found'
            );
            return;
        }

        const execPath = validation.resolvedPath || configurationManager.getExecutablePath();
        
        const { spawn } = await import('child_process');
        
        log(`Checking file: ${document.uri.fsPath}`);
        
        const args: string[] = ['compile', '-script'];

        // Add user arguments and prover args *before* the file path (typical CLI convention).
        if (config?.arguments?.length) {
            args.push(...config.arguments);
        }
        if (config?.proverArgs?.length) {
            args.push(...config.proverArgs);
        }

        args.push(document.uri.fsPath);

        const child = spawn(execPath, args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString('utf8');
        });

        child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString('utf8');
        });

        child.on('error', (error) => {
            log(`Compile error: ${error.message}`);
            updateStatusBar('error');
            vscode.window.showErrorMessage(`EasyCrypt: ${error.message}`);
        });

        child.on('close', (code) => {
            const combined = [stdout, stderr].filter(Boolean).join('\n');
            log(`Compile finished (exit code: ${code})`);
            log(`Output: ${combined}`);

            const result = processEasyCryptOutput(document.uri, combined);
            
            if (result && result.errors.length > 0) {
                updateStatusBar('error');
                vscode.window.showWarningMessage(
                    `EasyCrypt: Found ${result.errors.length} issue(s) in ${document.fileName}`
                );
            } else if (code === 0) {
                updateStatusBar('ok');
                vscode.window.showInformationMessage(
                    `EasyCrypt: ${document.fileName} checked successfully`
                );
            } else {
                updateStatusBar('error');
                // Non-zero exit but no parsed errors - show raw output
                if (combined.trim()) {
                    log(`Unparsed output: ${combined}`);
                }
            }
        });

    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Check failed: ${msg}`);
        updateStatusBar('error');
        vscode.window.showErrorMessage(`EasyCrypt: ${msg}`);
    }
}

/**
 * Updates the status bar item
 */
function updateStatusBar(state: 'idle' | 'checking' | 'ok' | 'error'): void {
    if (!statusBarItem) return;

    switch (state) {
        case 'idle':
            statusBarItem.text = '$(beaker) EasyCrypt';
            statusBarItem.tooltip = 'EasyCrypt - Click to check file';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'checking':
            statusBarItem.text = '$(sync~spin) EasyCrypt';
            statusBarItem.tooltip = 'EasyCrypt - Checking...';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'ok':
            statusBarItem.text = '$(check) EasyCrypt';
            statusBarItem.tooltip = 'EasyCrypt - No errors';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'error':
            statusBarItem.text = '$(error) EasyCrypt';
            statusBarItem.tooltip = 'EasyCrypt - Errors found';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            break;
    }
}

/**
 * Registers configuration change handlers
 */
function registerConfigurationHandlers(context: vscode.ExtensionContext): void {
    if (!configurationManager) {
        return;
    }

    // Listen for configuration changes via ConfigurationManager
    const configHandler = configurationManager.onDidChangeConfiguration(async () => {
        if (!configurationManager) {
            return;
        }

        const config = configurationManager.getConfig();
        
        // Handle diagnostics enabled/disabled
        if (!config.diagnosticsEnabled && diagnosticManager) {
            diagnosticManager.clearAll();
            log('Diagnostics disabled - cleared all diagnostics');
        }
        log(`Configuration updated - diagnostics: ${config.diagnosticsEnabled}`);
    });
    context.subscriptions.push(configHandler);
}

/**
 * Extension activation handler
 * 
 * This function is called when the extension is activated, which happens
 * when an EasyCrypt file is opened (based on activationEvents in package.json).
 * 
 * @param context - The extension context provided by VS Code
 */
export interface EasyCryptExtensionApi {
    processEasyCryptOutput: typeof processEasyCryptOutput;
    clearDiagnostics: typeof clearDiagnostics;
    clearDiagnosticsAfterLine: typeof clearDiagnosticsAfterLine;
    getDiagnosticManager: typeof getDiagnosticManager;
}

export async function activate(context: vscode.ExtensionContext): Promise<EasyCryptExtensionApi> {
    // Create output channel
    outputChannel = vscode.window.createOutputChannel('EasyCrypt');
    context.subscriptions.push(outputChannel);

    // Initialize logger
    logger = Logger.initialize(outputChannel);
    context.subscriptions.push(logger);

    log('EasyCrypt extension activating...');
    logger.info('Extension', 'Activating EasyCrypt extension');

    // Initialize configuration manager (first, as other components depend on it)
    configurationManager = getConfigurationManager();
    context.subscriptions.push(configurationManager);

    // Log configuration changes
    context.subscriptions.push(
        configurationManager.onDidChangeConfiguration(() => {
            logger?.event('onDidChangeConfiguration', { section: 'easycrypt' });
        })
    );

    // Validate executable path on startup
    await validateExecutableOnStartup();

    // Initialize diagnostic manager with configuration for live checks
    diagnosticManager = new DiagnosticManager('easycrypt', {
        clearOnEdit: false, // Proof assistant pattern: diagnostics persist until re-verified
        maxDiagnosticsPerFile: 100,
        configManager: configurationManager,
        outputChannel: outputChannel
    });
    context.subscriptions.push(diagnosticManager);
    
    // Log live check events for debugging
    const checkStartHandler = diagnosticManager.onDidStartCheck((uri) => {
        log(`Live check started: ${uri.fsPath}`);
        logger?.event('onDidStartCheck', { uri: uri.fsPath });
        updateStatusBar('checking');
    });
    context.subscriptions.push(checkStartHandler);
    
    const checkCompleteHandler = diagnosticManager.onDidCompleteCheck(({ uri, result }) => {
        log(`Live check completed: ${uri.fsPath} (${result.errors.length} errors, ${result.duration}ms)`);
        logger?.event('onDidCompleteCheck', { 
            uri: uri.fsPath, 
            errorCount: result.errors.length, 
            durationMs: result.duration 
        });
        updateStatusBar(result.errors.length > 0 ? 'error' : 'idle');
    });
    context.subscriptions.push(checkCompleteHandler);

    // Initialize process manager
    processManager = new ProcessManager(configurationManager, outputChannel);
    context.subscriptions.push(processManager);

    // Log process events
    context.subscriptions.push(
        processManager.onDidStart(() => {
            logger?.event('onDidStart', { component: 'ProcessManager' });
        })
    );
    context.subscriptions.push(
        processManager.onDidStop(({ code, signal }) => {
            logger?.event('onDidStop', { component: 'ProcessManager', code, signal });
        })
    );
    context.subscriptions.push(
        processManager.onError((error) => {
            logger?.event('onError', { component: 'ProcessManager', error: error.message });
        })
    );

    // Initialize proof state manager
    proofStateManager = new ProofStateManager();
    context.subscriptions.push(proofStateManager);

    // Track proof state changes (used by deterministic E2E tests)
    context.subscriptions.push(
        proofStateManager.onDidChangeState((event) => {
            proofStateChangeCount += 1;
            logger?.proof('onDidChangeState', {
                isProcessing: event.state.isProcessing,
                isComplete: event.state.isComplete,
                goalsCount: event.state.goals.length,
                messagesCount: event.state.messages.length,
                outputLinesCount: event.state.outputLines?.length ?? 0
            });
        })
    );

    // Wire up process output to diagnostics and proof state
    // Note: StepManager handles proofStateManager updates when stepping
    const outputHandler = processManager.onOutput((output) => {
        logger?.process('onOutput', {
            rawLength: output.raw?.length ?? 0,
            errorCount: output.parsed.errors.length,
            fileUri: output.fileUri?.fsPath
        });

        // Only update proof state if:
        // 1. Not stepping (StepManager handles it during steps)
        // 2. Not recovering (StepManager handles it during recovery)
        // 3. No active transaction (multi-statement operations use transactions)
        // 4. Not within the grace period after a transaction finalized (late-chunk safety)
        // This prevents late output chunks from spamming the Proof State view.
        const hasActiveTransaction = proofStateManager?.getActiveTransaction() !== undefined;
        const isWithinGrace = proofStateManager?.isWithinGracePeriod() ?? false;
        if (!stepManager?.isStepping() && !stepManager?.isRecovering() && !hasActiveTransaction && !isWithinGrace) {
            proofStateManager?.handleProcessOutput(output);
        }

        if (!output.fileUri) {
            return;
        }

        // Keep diagnostics in sync with process output.
        diagnosticManager?.setDiagnostics(output.fileUri, output.parsed.errors);
        if (output.parsed.errors.length > 0) {
            log(`ProcessManager reported ${output.parsed.errors.length} error(s)`);
        }
    });
    context.subscriptions.push(outputHandler);

    // Initialize editor decorator
    editorDecorator = new EditorDecorator();
    context.subscriptions.push(editorDecorator);

    // Initialize step manager
    stepManager = new StepManager(processManager, proofStateManager, editorDecorator, outputChannel);
    context.subscriptions.push(stepManager);

    // Initialize proof state view provider
    proofStateViewProvider = new ProofStateViewProvider(context.extensionUri, proofStateManager);
    context.subscriptions.push(proofStateViewProvider);

    // Register the webview view provider
    const viewProviderRegistration = vscode.window.registerWebviewViewProvider(
        PROOF_STATE_VIEW_ID,
        proofStateViewProvider
    );
    context.subscriptions.push(viewProviderRegistration);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'easycrypt.checkFile';
    updateStatusBar('idle');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register commands
    registerCommands(context);

    // Register configuration handlers
    registerConfigurationHandlers(context);

    // Auto-start the EasyCrypt REPL when an EasyCrypt editor becomes active.
    // This is best-effort and avoids popping configuration UI on failure.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (!editor || editor.document.languageId !== 'easycrypt') {
                return;
            }

            if (!processManager || !configurationManager) {
                return;
            }

            if (processManager.isRunning()) {
                return;
            }

            try {
                const validation = await configurationManager.validateExecutablePath();
                if (!validation.valid) {
                    log(`Auto-start skipped: ${validation.error ?? 'invalid executable path'}`);
                    return;
                }
                await processManager.start();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`Auto-start failed: ${msg}`);
            }
        })
    );

    log('EasyCrypt extension activated successfully');
    
    // Show activation message in development
    if (process.env.VSCODE_DEBUG_MODE === 'true') {
        vscode.window.showInformationMessage('EasyCrypt extension activated');
    }

    return {
        processEasyCryptOutput,
        clearDiagnostics,
        clearDiagnosticsAfterLine,
        getDiagnosticManager
    };
}

/**
 * Validates the EasyCrypt executable path on startup
 * Shows an error notification if validation fails
 */
async function validateExecutableOnStartup(): Promise<void> {
    if (!configurationManager) {
        return;
    }

    const validation = await configurationManager.validateExecutablePath();
    
    if (!validation.valid) {
        log(`Executable validation failed: ${validation.error}`);
        await configurationManager.showConfigurationError(
            validation.error || 'EasyCrypt executable not found'
        );
    } else {
        const resolvedPath = validation.resolvedPath || configurationManager.getExecutablePath();
        log(`Executable validated: ${resolvedPath}`);
    }
}

/**
 * Extension deactivation handler
 * 
 * This function is called when the extension is deactivated.
 * Clean up any resources here.
 */
export function deactivate(): void {
    log('EasyCrypt extension deactivating...');
    logger?.info('Extension', 'Deactivating EasyCrypt extension');
    
    // Stop process manager
    if (processManager) {
        processManager.stop();
        processManager = undefined;
    }
    
    // Dispose configuration manager singleton
    disposeConfigurationManager();
    
    // Clean up proof state components
    stepManager = undefined;
    editorDecorator = undefined;
    proofStateManager = undefined;
    proofStateViewProvider = undefined;
    
    // DiagnosticManager and ConfigurationManager are disposed via context.subscriptions
    configurationManager = undefined;
    diagnosticManager = undefined;
    statusBarItem = undefined;
    
    // Dispose logger
    Logger.disposeInstance();
    logger = undefined;
    
    outputChannel = undefined;
}

// Re-export types and parser for external use
export { parseOutput, parseError } from './outputParser';
export type { ParsedError } from './types';
export { DiagnosticManager } from './diagnosticManager';
export { SyntaxChecker } from './syntaxChecker';
export type { SyntaxCheckResult, SyntaxCheckerOptions } from './syntaxChecker';
export { ConfigurationManager, getConfigurationManager } from './configurationManager';
export type { EasyCryptConfig, ValidationResult } from './configurationManager';
export { ProofStateManager } from './proofStateManager';
export type { ProofState, ProofGoal, ProofMessage } from './proofStateManager';
export { ProofStateViewProvider, PROOF_STATE_VIEW_ID } from './proofStateViewProvider';
export { StepManager } from './stepManager';
export type { StepResult } from './stepManager';
export { EditorDecorator } from './editorDecorator';
export { Logger } from './logger';
export type { LogLevel, LoggerConfig } from './logger';
export * from './types';
