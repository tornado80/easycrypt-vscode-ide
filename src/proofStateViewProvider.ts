/**
 * EasyCrypt Proof State View Provider
 * 
 * Implements a WebviewViewProvider to display the current proof state
 * (goals, hypotheses, messages) in a dedicated VS Code view.
 * 
 * Uses external assets (HTML/CSS/JS) for better maintainability and security.
 * 
 * @module proofStateViewProvider
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProofStateManager, ProofState } from './proofStateManager';
import { Logger } from './logger';

/**
 * View ID for the proof state view (must match package.json)
 */
export const PROOF_STATE_VIEW_ID = 'easycrypt.proofStateView';

/**
 * Serialized progress snapshot for the webview boundary
 */
export interface SerializedProofProgress {
    /** Number of statements in the proved/verified region */
    provedStatementCount: number;
    /** Full text of the last proved statement */
    lastProvedStatementText?: string;
}

/**
 * Serialized proof state for the webview boundary
 */
export interface SerializedProofState {
    goals: { hypotheses: string[]; conclusion: string }[];
    messages: { severity: 'info' | 'warning' | 'error'; content: string; timestamp: string }[];
    isProcessing: boolean;
    isComplete: boolean;
    /** All output lines not consumed by goal blocks (lossless) */
    outputLines: string[];
    /** Progress snapshot (proved count, last statement) */
    progress?: SerializedProofProgress;
    /** Debug-only emacs prompt marker (only included when setting is enabled) */
    debugEmacsPromptMarker?: string;
}

/**
 * Navigation action types for the proof state view toolbar
 */
export type ProofStateViewNavAction =
    | 'stepBackward'
    | 'stepForward'
    | 'goToCursor'
    | 'resetProof';

/**
 * Messages from the webview to the extension
 */
export type WebviewToExtensionMessage =
    | { type: 'ready' }
    | { type: 'nav'; action: ProofStateViewNavAction };

/**
 * Messages from the extension to the webview
 */
export type ExtensionToWebviewMessage = { type: 'updateState'; state: SerializedProofState };

/**
 * Provides a Webview-based view for displaying proof state.
 * 
 * Features:
 * - Displays current goals and hypotheses
 * - Shows messages (info, warnings, errors)
 * - Auto-updates when proof state changes
 * - Themed to match VS Code appearance
 * - Uses external assets with strict CSP
 * 
 * @example
 * ```typescript
 * const stateManager = new ProofStateManager();
 * const viewProvider = new ProofStateViewProvider(context.extensionUri, stateManager);
 * context.subscriptions.push(
 *     vscode.window.registerWebviewViewProvider(PROOF_STATE_VIEW_ID, viewProvider)
 * );
 * ```
 */
export class ProofStateViewProvider implements vscode.WebviewViewProvider {
    /** The webview view instance */
    private _view?: vscode.WebviewView;

    /** Whether we are currently in a processing window (UI suppression) */
    private inProcessingWindow = false;

    /** Internal/testing: counts how many state updates were posted to the webview */
    private postedUpdateCount = 0;

    /** 
     * Hash of the last posted state for deduplication.
     * Prevents posting identical states that would cause no-op webview updates.
     */
    private lastPostedStateHash: string | undefined;

    /** Disposables for cleanup */
    private readonly _disposables: vscode.Disposable[] = [];

    /** Path to the media assets directory */
    private readonly _mediaPath: vscode.Uri;

    /**
     * Creates a new ProofStateViewProvider
     * 
     * @param extensionUri - The URI of the extension directory
     * @param stateManager - The proof state manager to subscribe to
     */
    constructor(
        extensionUri: vscode.Uri,
        private readonly stateManager: ProofStateManager
    ) {
        this._mediaPath = vscode.Uri.joinPath(extensionUri, 'media', 'proofStateView');

        // Subscribe to state changes
        this._disposables.push(
            this.stateManager.onDidChangeState(event => {
                this.updateView(event.state);
            })
        );
    }

    /**
     * Called when the view is resolved (created or shown)
     */
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void | Thenable<void> {
        this._view = webviewView;

        // Configure webview options - restrict to media folder only
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._mediaPath]
        };

        // Set initial HTML content
        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => this.handleWebviewMessage(message),
            undefined,
            this._disposables
        );

        // Update view when it becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.updateView(this.stateManager.state);
            }
        }, undefined, this._disposables);
    }

    /**
     * Updates the webview with new proof state
     */
    private updateView(state: ProofState): void {
        if (this._view) {
            // UI suppression:
            // - When processing starts: send exactly one update (spinner).
            // - While processing: suppress intermediate updates.
            // - When processing ends: send exactly one update (final state).
            if (state.isProcessing) {
                if (this.inProcessingWindow) {
                    return;
                }
                this.inProcessingWindow = true;
            } else if (this.inProcessingWindow) {
                // First non-processing state after a processing window: deliver it.
                this.inProcessingWindow = false;
            }

            const serialized = this.serializeState(state);

            // Provider-side deduplication:
            // Skip posting if the serialized state is identical to the last posted state.
            // This prevents repeated "final" updates when late chunks trigger the same state.
            const stateHash = this.computeStateHash(serialized);
            if (stateHash === this.lastPostedStateHash) {
                return;
            }
            this.lastPostedStateHash = stateHash;

            const message: ExtensionToWebviewMessage = {
                type: 'updateState',
                state: serialized
            };
            this.postedUpdateCount += 1;
            this._view.webview.postMessage(message);
        }
    }

    /**
     * Internal/testing: simulates a message from the webview.
     * Useful for integration tests where the real webview cannot be clicked.
     */
    public simulateMessage(message: WebviewToExtensionMessage): void {
        this.handleWebviewMessage(message);
    }

    /**
     * Computes a simple hash of the serialized state for deduplication.
     * Uses a string representation since ProofState is relatively small.
     */
    private computeStateHash(state: SerializedProofState): string {
        // Create a deterministic string representation
        return JSON.stringify({
            isProcessing: state.isProcessing,
            isComplete: state.isComplete,
            outputLines: state.outputLines,
            messages: state.messages.map(m => ({ severity: m.severity, content: m.content })),
            progress: state.progress,
            debugEmacsPromptMarker: state.debugEmacsPromptMarker
        });
    }

    /**
     * Internal/testing: returns how many updateState messages were posted.
     */
    public getPostedUpdateCount(): number {
        return this.postedUpdateCount;
    }

    /**
     * Internal/testing: resets the posted update counter.
     */
    public resetPostedUpdateCount(): void {
        this.postedUpdateCount = 0;
        this.lastPostedStateHash = undefined;
    }

    /**
     * Checks if the debug emacs prompt marker setting is enabled.
     */
    private isShowEmacsPromptMarkerEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('easycrypt');
        return config.get<boolean>('proofStateView.debug.showEmacsPromptMarker', false);
    }

    /**
     * Serializes the proof state for sending to the webview
     */
    private serializeState(state: ProofState): SerializedProofState {
        // Only include debugEmacsPromptMarker if the setting is enabled
        const includePromptMarker = this.isShowEmacsPromptMarkerEnabled();
        
        return {
            goals: state.goals,
            messages: state.messages.map(m => ({
                severity: m.severity,
                content: m.content,
                timestamp: m.timestamp.toISOString()
            })),
            isProcessing: state.isProcessing,
            isComplete: state.isComplete,
            outputLines: state.outputLines ?? [],
            progress: state.progress,
            // Only include prompt marker when enabled
            debugEmacsPromptMarker: includePromptMarker ? state.debugEmacsPromptMarker : undefined
        };
    }

    /**
     * Maps navigation actions to VS Code command IDs
     */
    private static readonly NAV_ACTION_TO_COMMAND: Record<ProofStateViewNavAction, string> = {
        stepBackward: 'easycrypt.stepBackward',
        stepForward: 'easycrypt.stepForward',
        goToCursor: 'easycrypt.goToCursor',
        resetProof: 'easycrypt.resetProof'
    };

    /**
     * Handles messages from the webview
     */
    private handleWebviewMessage(message: WebviewToExtensionMessage): void {
        switch (message.type) {
            case 'ready':
                // Webview is ready, send current state
                this.updateView(this.stateManager.state);
                break;
            case 'nav':
                this.handleNavigationAction(message.action);
                break;
        }
    }

    /**
     * Handles navigation action from the webview toolbar.
     * Suppresses navigation while processing to respect backpressure.
     */
    private async handleNavigationAction(action: ProofStateViewNavAction): Promise<void> {
        const logger = this.tryGetLogger();
        const isProcessing = this.stateManager.state.isProcessing;
        const hasContext = !!this.stateManager.state.progress;

        // Log the toolbar click (verbose only)
        logger?.event('toolbar-nav-click', {
            action,
            suppressed: isProcessing,
            hasContext
        });

        // Guard: suppress navigation while processing
        if (isProcessing) {
            return;
        }

        // Guard: require active proof context
        if (!hasContext) {
            vscode.window.showInformationMessage(
                'Open an EasyCrypt file to use proof navigation.'
            );
            return;
        }

        const commandId = ProofStateViewProvider.NAV_ACTION_TO_COMMAND[action];
        if (!commandId) {
            logger?.warn('ProofStateViewProvider', `Unknown navigation action: ${action}`);
            return;
        }

        try {
            await vscode.commands.executeCommand(commandId);
        } catch (err) {
            logger?.error('ProofStateViewProvider', `Navigation command failed: ${commandId}`, {
                error: String(err)
            });
        }
    }

    /**
     * Safely retrieves the Logger instance (may not be initialized in tests)
     */
    private tryGetLogger(): Logger | undefined {
        try {
            return Logger.getInstance();
        } catch {
            return undefined;
        }
    }

    /**
     * Generates the HTML content for the webview using external assets
     */
    private getHtmlContent(webview: vscode.Webview): string {
        const nonce = this.getNonce();

        // Get URIs for external assets
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._mediaPath, 'styles.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._mediaPath, 'main.js')
        );

        // Read and process the HTML template
        const templatePath = path.join(this._mediaPath.fsPath, 'index.html');
        let html: string;

        try {
            html = fs.readFileSync(templatePath, 'utf-8');
        } catch {
            // Fallback if template file cannot be read
            return this.getFallbackHtml(webview, nonce, styleUri, scriptUri);
        }

        // Replace placeholders in the template
        html = html
            .replace(/\$\{cspSource\}/g, webview.cspSource)
            .replace(/\$\{nonce\}/g, nonce)
            .replace(/\$\{styleUri\}/g, styleUri.toString())
            .replace(/\$\{scriptUri\}/g, scriptUri.toString());

        return html;
    }

    /**
     * Generates fallback HTML if the template file cannot be read
     */
    private getFallbackHtml(
        webview: vscode.Webview,
        nonce: string,
        styleUri: vscode.Uri,
        scriptUri: vscode.Uri
    ): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>EasyCrypt Proof State</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="app">
        <!-- Content will be rendered by JavaScript -->
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    /**
     * Generates a nonce for Content Security Policy
     */
    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * Reveals the proof state view
     */
    public async reveal(): Promise<void> {
        if (this._view) {
            this._view.show(true);
        } else {
            // If view not yet created, use command to reveal it
            await vscode.commands.executeCommand(`${PROOF_STATE_VIEW_ID}.focus`);
        }
    }

    /**
     * Disposes of the provider
     */
    public dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }
}
