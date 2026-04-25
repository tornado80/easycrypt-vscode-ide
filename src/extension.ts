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
import { ActiveProofStateBridge } from './activeProofStateBridge';
import { DecorationProjectionService } from './decorationProjectionService';
import { DiagnosticManager } from './diagnosticManager';
import { EasyCryptFileSession } from './easyCryptFileSession';
import { parseOutput } from './outputParser';
import { 
    ConfigurationManager, 
    getConfigurationManager, 
    disposeConfigurationManager 
} from './configurationManager';
import { ProofStateViewProvider, PROOF_STATE_VIEW_ID } from './proofStateViewProvider';
import { EditorDecorator } from './editorDecorator';
import { Logger } from './logger';
import { SessionCommandRouter } from './sessionCommandRouter';
import { SessionRegistry } from './sessionRegistry';
import {
    VerificationContext,
    buildCompileArgs,
    resolveVerificationContext
} from './verificationContextResolver';

/** The diagnostic manager instance */
let diagnosticManager: DiagnosticManager | undefined;

/** The configuration manager instance */
let configurationManager: ConfigurationManager | undefined;

/** Per-file session registry */
let sessionRegistry: SessionRegistry<vscode.TextDocument, EasyCryptFileSession> | undefined;

/** Command router for active per-file sessions */
let sessionCommandRouter: SessionCommandRouter<EasyCryptFileSession> | undefined;

/** The proof state view provider instance */
let proofStateViewProvider: ProofStateViewProvider | undefined;

/** Bridges active session proof state into the single view provider */
let activeProofStateBridge: ActiveProofStateBridge | undefined;

/** Tracks proof-state subscriptions per session for instrumentation */
const proofStateSubscriptionBySessionKey = new Map<string, vscode.Disposable>();

/** Internal/testing: counts proof state change events */
let proofStateChangeCount = 0;

/** The editor decorator instance */
let editorDecorator: EditorDecorator | undefined;

/** URI-scoped decoration projection service */
let decorationProjectionService: DecorationProjectionService | undefined;

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

function getWorkspaceFolderPath(document: vscode.TextDocument): string | undefined {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) {
        return workspaceFolder.uri.fsPath;
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveVerificationContextForDocument(document: vscode.TextDocument): VerificationContext | undefined {
    if (!configurationManager) {
        return undefined;
    }

    const config = configurationManager.getConfig();
    return resolveVerificationContext({
        documentPath: document.uri.fsPath,
        workspaceFolderPath: getWorkspaceFolderPath(document),
        configArgs: config.arguments,
        proverArgs: config.proverArgs
    });
}

function getActiveEasyCryptEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'easycrypt') {
        return undefined;
    }

    return editor;
}

async function ensureActiveSessionForEditor(
    editor: vscode.TextEditor | undefined
): Promise<EasyCryptFileSession | undefined> {
    if (!editor || editor.document.languageId !== 'easycrypt' || !sessionRegistry) {
        return undefined;
    }

    return sessionRegistry.setActiveDocument(editor.document);
}

async function requireActiveSession(): Promise<EasyCryptFileSession | undefined> {
    const editor = getActiveEasyCryptEditor();
    if (!editor) {
        vscode.window.showWarningMessage('Open an EasyCrypt file first');
        return undefined;
    }

    const session = await ensureActiveSessionForEditor(editor);
    if (!session) {
        vscode.window.showErrorMessage('EasyCrypt: Failed to initialize file session');
        return undefined;
    }

    return session;
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
    const runRoutedStepCommand = async (
        routedName: 'stepForward' | 'stepBackward' | 'goToCursor' | 'resetProof' | 'forceRecovery',
        commandId: string,
        run: (session: EasyCryptFileSession) => Promise<any>
    ): Promise<any> => {
        if (!sessionCommandRouter) {
            vscode.window.showErrorMessage('EasyCrypt: Session command router not initialized');
            return undefined;
        }

        const session = await requireActiveSession();
        if (!session) {
            return undefined;
        }

        const editor = getActiveEasyCryptEditor();
        const cursorOffset = editor
            ? editor.document.offsetAt(editor.selection.active)
            : undefined;

        logger?.command(commandId, {
            sessionKey: session.key,
            executionOffset: session.stepManager.getExecutionOffset(),
            cursorOffset
        });

        try {
            const result = await sessionCommandRouter.runOnActiveSession(
                routedName,
                async (activeSession, token) => {
                    if (token.isCancellationRequested) {
                        throw new Error('Command cancelled');
                    }
                    return run(activeSession);
                }
            );

            logger?.commandComplete(commandId, Boolean(result?.success ?? true), {
                sessionKey: session.key,
                executionOffset: result?.executionOffset,
                error: result?.error
            });

            if (result?.success === false && result.error) {
                vscode.window.showWarningMessage(`EasyCrypt: ${result.error}`);
            }

            return result;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger?.commandComplete(commandId, false, {
                sessionKey: session.key,
                error: msg
            });

            if (msg !== 'No active EasyCrypt file') {
                vscode.window.showWarningMessage(`EasyCrypt: ${msg}`);
            }

            return undefined;
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.clearAllDiagnostics', () => {
            if (diagnosticManager) {
                diagnosticManager.clearAll();
                log('Cleared all diagnostics');
                vscode.window.showInformationMessage('EasyCrypt: Cleared all diagnostics');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.clearFileDiagnostics', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && diagnosticManager) {
                diagnosticManager.clearDiagnostics(editor.document.uri);
                log(`Cleared diagnostics for ${editor.document.uri.fsPath}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.showDiagnosticCount', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && diagnosticManager) {
                const counts = diagnosticManager.getDiagnosticCountsBySeverity(editor.document.uri);
                vscode.window.showInformationMessage(
                    `EasyCrypt Diagnostics: ${counts.errors} error(s), ${counts.warnings} warning(s)`
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.dev.simulateError', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'easycrypt') {
                vscode.window.showWarningMessage('Open an EasyCrypt file first');
                return;
            }

            const line = editor.selection.active.line + 1;
            const col = editor.selection.active.character + 1;
            const simulatedOutput = `[error-${line}-${col}] unknown symbol: test_symbol`;

            const result = processEasyCryptOutput(editor.document.uri, simulatedOutput);
            if (result && result.errors.length > 0) {
                vscode.window.showInformationMessage(`Simulated error at line ${line}, column ${col}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.checkFile', async () => {
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
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.startProcess', async () => {
            logger?.command('easycrypt.startProcess');

            if (!sessionRegistry) {
                vscode.window.showErrorMessage('EasyCrypt: Session registry not initialized');
                logger?.commandComplete('easycrypt.startProcess', false, { error: 'not initialized' });
                return;
            }

            let session = sessionRegistry.getActiveSession();
            if (!session) {
                const editor = getActiveEasyCryptEditor();
                if (editor) {
                    session = await ensureActiveSessionForEditor(editor);
                }
            }
            if (!session) {
                session = sessionRegistry.getAllSessions()[0];
            }

            if (!session) {
                vscode.window.showWarningMessage('Open an EasyCrypt file first');
                logger?.commandComplete('easycrypt.startProcess', false, { error: 'no active session' });
                return;
            }

            try {
                if (session.processManager.isRunning()) {
                    await session.restart();
                    logger?.commandComplete('easycrypt.startProcess', true, {
                        action: 'restart',
                        sessionKey: session.key
                    });
                    return;
                }

                await session.ensureStarted();
                vscode.window.showInformationMessage('EasyCrypt process started');
                logger?.commandComplete('easycrypt.startProcess', true, {
                    action: 'start',
                    sessionKey: session.key
                });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`EasyCrypt: Failed to start process - ${msg}`);
                logger?.commandComplete('easycrypt.startProcess', false, {
                    error: msg,
                    sessionKey: session.key
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.stopProcess', async () => {
            logger?.command('easycrypt.stopProcess');

            const session = sessionRegistry?.getActiveSession() ?? sessionRegistry?.getAllSessions()[0];
            if (!session) {
                vscode.window.showInformationMessage('EasyCrypt process is not running');
                logger?.commandComplete('easycrypt.stopProcess', false, { reason: 'not running' });
                return;
            }

            if (!session.processManager.isRunning()) {
                vscode.window.showInformationMessage('EasyCrypt process is not running');
                logger?.commandComplete('easycrypt.stopProcess', false, {
                    reason: 'not running',
                    sessionKey: session.key
                });
                return;
            }

            await session.stop('manual-stop');
            vscode.window.showInformationMessage('EasyCrypt process stopped');
            logger?.commandComplete('easycrypt.stopProcess', true, {
                sessionKey: session.key
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.stepForward', async () => {
            return runRoutedStepCommand('stepForward', 'easycrypt.stepForward', async (session) => {
                await session.ensureStarted();
                return session.stepManager.stepForward();
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.stepBackward', async () => {
            return runRoutedStepCommand('stepBackward', 'easycrypt.stepBackward', async (session) => {
                await session.ensureStarted();
                return session.stepManager.stepBackward();
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.goToCursor', async () => {
            return runRoutedStepCommand('goToCursor', 'easycrypt.goToCursor', async (session) => {
                await session.ensureStarted();
                return session.stepManager.goToCursor();
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.resetProof', async () => {
            const result = await runRoutedStepCommand('resetProof', 'easycrypt.resetProof', async (session) => {
                session.stepManager.reset();
                if (session.processManager.isRunning()) {
                    await session.restart();
                }
                return { success: true, executionOffset: session.stepManager.getExecutionOffset() };
            });

            if (result?.success) {
                vscode.window.showInformationMessage('EasyCrypt: Proof state reset');
            }

            return result;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.toggleVerboseLogging', async () => {
            const config = vscode.workspace.getConfiguration('easycrypt');
            const currentValue = config.get<boolean>('verboseLogging', false);
            const newValue = !currentValue;

            await config.update('verboseLogging', newValue, vscode.ConfigurationTarget.Global);

            const message = newValue
                ? 'EasyCrypt: Verbose logging enabled. Check the Output panel (EasyCrypt channel).'
                : 'EasyCrypt: Verbose logging disabled.';
            vscode.window.showInformationMessage(message);

            if (newValue) {
                outputChannel?.show(true);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._getExecutionOffset', () => {
            return sessionRegistry?.getActiveSession()?.stepManager.getExecutionOffset() ?? 0;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._getVerifiedRange', () => {
            const editor = getActiveEasyCryptEditor();
            if (!editor || !decorationProjectionService) {
                return null;
            }

            const range = decorationProjectionService.getVerifiedRange(editor.document.uri);
            if (!range) {
                return null;
            }

            return {
                start: { line: range.start.line, character: range.start.character },
                end: { line: range.end.line, character: range.end.character }
            };
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._getProcessStartCount', () => {
            return sessionRegistry?.getActiveSession()?.processManager.getProcessStartCount() ?? 0;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._getSendCommandCount', () => {
            return sessionRegistry?.getActiveSession()?.processManager.getSendCommandCount() ?? 0;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._getProofStateChangeCount', () => {
            return proofStateChangeCount;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._resetProofStateChangeCount', () => {
            proofStateChangeCount = 0;
            return true;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._getProofStateViewUpdateCount', () => {
            return proofStateViewProvider?.getPostedUpdateCount() ?? 0;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._resetProofStateViewUpdateCount', () => {
            proofStateViewProvider?.resetPostedUpdateCount();
            return true;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._simulateWebviewMessage', (message: any) => {
            proofStateViewProvider?.simulateMessage(message);
            return true;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt._getProofStateSnapshot', () => {
            const state = sessionRegistry?.getActiveSession()?.proofStateManager.state;
            if (!state) {
                return null;
            }

            return {
                isProcessing: state.isProcessing,
                isComplete: state.isComplete,
                outputLines: state.outputLines ?? [],
                messages: state.messages.map((message) => ({
                    severity: message.severity,
                    content: message.content
                })),
                goalsCount: state.goals.length,
                rawOutputLength: state.rawOutput?.length ?? 0,
                provedStatementCount: state.progress?.provedStatementCount,
                debugEmacsPromptMarker: state.debugEmacsPromptMarker
            };
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('easycrypt.forceRecovery', async () => {
            return runRoutedStepCommand('forceRecovery', 'easycrypt.forceRecovery', async (session) => {
                await session.ensureStarted();
                const result = await session.stepManager.forceRecovery();
                if (result.success) {
                    vscode.window.showInformationMessage('EasyCrypt: Proof state recovered successfully');
                } else {
                    vscode.window.showWarningMessage(`EasyCrypt: Recovery failed - ${result.error}`);
                }
                return result;
            });
        })
    );
}

/**
 * Checks a document with EasyCrypt and reports diagnostics
 * 
 * @param document - The document to check
 */
async function checkDocument(document: vscode.TextDocument): Promise<void> {
    if (!outputChannel) {
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
        const verificationContext = resolveVerificationContextForDocument(document);
        if (!verificationContext) {
            updateStatusBar('error');
            vscode.window.showErrorMessage('EasyCrypt: Failed to resolve verification context');
            return;
        }
        
        const { spawn } = await import('child_process');
        
        log(`Checking file: ${document.uri.fsPath}`);
        log(`Check context: cwd=${verificationContext.workingDirectory}`);
        log(`Check include roots: ${verificationContext.includeRoots.join(', ') || '<none>'}`);
        const args = buildCompileArgs(verificationContext, document.uri.fsPath);

        const child = spawn(execPath, args, {
            cwd: verificationContext.workingDirectory,
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

    // Initialize decoration renderer and projection service
    editorDecorator = new EditorDecorator();
    context.subscriptions.push(editorDecorator);

    decorationProjectionService = new DecorationProjectionService(editorDecorator);
    context.subscriptions.push(decorationProjectionService);

    sessionRegistry = new SessionRegistry<vscode.TextDocument, EasyCryptFileSession>({
        createSession: (document, key) => {
            if (!configurationManager || !diagnosticManager || !decorationProjectionService || !outputChannel) {
                throw new Error('EasyCrypt: Session dependencies are not initialized');
            }

            return new EasyCryptFileSession({
                key,
                documentUri: document.uri,
                configurationManager,
                diagnosticManager,
                decorationProjection: decorationProjectionService,
                outputChannel,
                logger
            });
        },
        managedLanguageId: 'easycrypt',
        log: (level, message, data) => {
            switch (level) {
                case 'debug':
                    logger?.debug('SessionRegistry', message, data);
                    break;
                case 'info':
                    logger?.info('SessionRegistry', message, data);
                    break;
                case 'warn':
                    logger?.warn('SessionRegistry', message, data);
                    break;
            }
        }
    });
    context.subscriptions.push(sessionRegistry);

    sessionCommandRouter = new SessionCommandRouter<EasyCryptFileSession>(
        () => sessionRegistry?.getActiveSession(),
        (level, message, data) => {
            switch (level) {
                case 'debug':
                    logger?.debug('SessionCommandRouter', message, data);
                    break;
                case 'info':
                    logger?.info('SessionCommandRouter', message, data);
                    break;
                case 'warn':
                    logger?.warn('SessionCommandRouter', message, data);
                    break;
            }
        }
    );
    context.subscriptions.push(sessionCommandRouter);

    context.subscriptions.push(
        sessionRegistry.onDidCreateSession((session) => {
            const disposable = session.proofStateManager.onDidChangeState((event) => {
                proofStateChangeCount += 1;
                logger?.proof('onDidChangeState', {
                    sessionKey: session.key,
                    isProcessing: event.state.isProcessing,
                    isComplete: event.state.isComplete,
                    goalsCount: event.state.goals.length,
                    messagesCount: event.state.messages.length,
                    outputLinesCount: event.state.outputLines?.length ?? 0
                });
            });

            proofStateSubscriptionBySessionKey.set(session.key, disposable);
        })
    );

    context.subscriptions.push(
        sessionRegistry.onDidDisposeSession(({ key }) => {
            proofStateSubscriptionBySessionKey.get(key)?.dispose();
            proofStateSubscriptionBySessionKey.delete(key);
        })
    );

    context.subscriptions.push(
        sessionRegistry.onDidChangeActiveSession((session) => {
            decorationProjectionService?.projectVisibleEditors(session?.documentUri);
        })
    );

    // Initialize proof state view provider + active-session bridge
    proofStateViewProvider = new ProofStateViewProvider(context.extensionUri);
    context.subscriptions.push(proofStateViewProvider);

    activeProofStateBridge = new ActiveProofStateBridge(sessionRegistry, proofStateViewProvider, logger);
    context.subscriptions.push(activeProofStateBridge);

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

    // Keep active session/projection in sync with editor focus.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (!sessionRegistry) {
                return;
            }

            await sessionRegistry.setActiveDocument(editor?.document);
            decorationProjectionService?.projectVisibleEditors(editor?.document.uri);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.languageId !== 'easycrypt') {
                return;
            }

            void sessionRegistry?.disposeSessionByUri(document.uri, 'file-close');
            decorationProjectionService?.clear(document.uri);
        })
    );

    await sessionRegistry.setActiveDocument(vscode.window.activeTextEditor?.document);
    decorationProjectionService.projectVisibleEditors(vscode.window.activeTextEditor?.document.uri);

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
export async function deactivate(): Promise<void> {
    log('EasyCrypt extension deactivating...');
    logger?.info('Extension', 'Deactivating EasyCrypt extension');

    if (sessionRegistry) {
        await sessionRegistry.disposeAll('shutdown');
        sessionRegistry = undefined;
    }

    proofStateSubscriptionBySessionKey.forEach((disposable) => disposable.dispose());
    proofStateSubscriptionBySessionKey.clear();

    sessionCommandRouter = undefined;
    activeProofStateBridge = undefined;
    decorationProjectionService = undefined;
    
    // Dispose configuration manager singleton
    disposeConfigurationManager();

    editorDecorator = undefined;
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
