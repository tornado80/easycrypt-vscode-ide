/**
 * EasyCrypt Diagnostic Manager
 * 
 * This module manages VS Code diagnostics (errors/warnings) for EasyCrypt files.
 * It wraps the VS Code DiagnosticCollection API and provides lifecycle management
 * for diagnostics based on proof state changes.
 * 
 * It also integrates with the SyntaxChecker to provide live syntax checking
 * as the user types.
 * 
 * @module DiagnosticManager
 */

import * as vscode from 'vscode';
import { ParsedError, createDiagnostic } from './types';
import { SyntaxChecker, SyntaxCheckResult } from './syntaxChecker';
import { ConfigurationManager } from './configurationManager';

/**
 * Configuration options for the DiagnosticManager
 */
export interface DiagnosticManagerOptions {
    /** Whether to automatically clear diagnostics when file content changes */
    clearOnEdit?: boolean;
    
    /** Maximum number of diagnostics to show per file */
    maxDiagnosticsPerFile?: number;
    
    /** Configuration manager for live check settings */
    configManager?: ConfigurationManager;
    
    /** Output channel for logging */
    outputChannel?: vscode.OutputChannel;
}

/**
 * Manages VS Code diagnostics for EasyCrypt files.
 * 
 * This class provides:
 * - Lifecycle management for diagnostics (creation, updates, clearing)
 * - Integration with proof stepping (clear diagnostics on retraction)
 * - Document change tracking for diagnostic invalidation
 * 
 * @example
 * ```typescript
 * const manager = new DiagnosticManager();
 * 
 * // Set diagnostics for a file
 * manager.setDiagnostics(document.uri, [error1, error2]);
 * 
 * // Clear diagnostics when proof state changes
 * manager.clearDiagnostics(document.uri);
 * 
 * // Dispose when extension deactivates
 * manager.dispose();
 * ```
 */
export class DiagnosticManager implements vscode.Disposable {
    /** The VS Code diagnostic collection */
    private readonly diagnosticCollection: vscode.DiagnosticCollection;
    
    /** Stores the last set of diagnostics per file for comparison */
    private readonly diagnosticsPerFile: Map<string, vscode.Diagnostic[]>;
    
    /** Configuration options */
    private readonly options: Required<Pick<DiagnosticManagerOptions, 'clearOnEdit' | 'maxDiagnosticsPerFile'>>;
    
    /** Subscriptions to dispose */
    private readonly disposables: vscode.Disposable[];
    
    /** Tracks documents that have been modified since last diagnostic update */
    private readonly modifiedDocuments: Set<string>;
    
    /** Configuration manager for settings */
    private readonly configManager: ConfigurationManager | undefined;
    
    /** Output channel for logging */
    private readonly outputChannel: vscode.OutputChannel | undefined;
    
    /** Syntax checker for live checks */
    private readonly syntaxChecker: SyntaxChecker | undefined;
    
    /** Debounce timers per document */
    private readonly debounceTimers: Map<string, NodeJS.Timeout>;
    
    /** Event emitter for when live check starts */
    private readonly _onDidStartCheck = new vscode.EventEmitter<vscode.Uri>();
    
    /** Event emitter for when live check completes */
    private readonly _onDidCompleteCheck = new vscode.EventEmitter<{ uri: vscode.Uri; result: SyntaxCheckResult }>();
    
    /** Public event for check start */
    public readonly onDidStartCheck: vscode.Event<vscode.Uri> = this._onDidStartCheck.event;
    
    /** Public event for check completion */
    public readonly onDidCompleteCheck: vscode.Event<{ uri: vscode.Uri; result: SyntaxCheckResult }> = this._onDidCompleteCheck.event;

    /**
     * Creates a new DiagnosticManager
     * 
     * @param name - The name for the diagnostic collection (default: 'easycrypt')
     * @param options - Configuration options
     */
    constructor(
        name: string = 'easycrypt',
        options: DiagnosticManagerOptions = {}
    ) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection(name);
        this.diagnosticsPerFile = new Map();
        this.modifiedDocuments = new Set();
        this.debounceTimers = new Map();
        this.disposables = [];
        
        this.options = {
            clearOnEdit: options.clearOnEdit ?? false,
            maxDiagnosticsPerFile: options.maxDiagnosticsPerFile ?? 100
        };
        
        this.configManager = options.configManager;
        this.outputChannel = options.outputChannel;
        
        // Initialize syntax checker if configuration manager is provided
        if (this.configManager) {
            this.syntaxChecker = new SyntaxChecker(
                this.configManager,
                this.outputChannel
            );
            this.disposables.push(this.syntaxChecker);
        }

        // Register document change listener
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(this.onDocumentChange.bind(this))
        );

        // Register document close listener to clean up
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(this.onDocumentClose.bind(this))
        );
        
        // Register document save listener for on-save checks
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(this.onDocumentSave.bind(this))
        );
        
        // Register event emitter for disposal
        this.disposables.push(this._onDidStartCheck);
        this.disposables.push(this._onDidCompleteCheck);
        
        // Listen for configuration changes
        if (this.configManager) {
            this.disposables.push(
                this.configManager.onDidChangeConfiguration(() => {
                    this.log('Configuration changed');
                })
            );
        }
    }
    
    /**
     * Logs a message to the output channel
     */
    private log(message: string): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[DiagnosticManager] ${message}`);
        }
    }

    /**
     * Handles document text changes
     */
    private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        if (event.document.languageId !== 'easycrypt') {
            return;
        }

        const uriString = event.document.uri.toString();
        this.modifiedDocuments.add(uriString);

        if (this.options.clearOnEdit && event.contentChanges.length > 0) {
            // Optionally clear diagnostics on edit
            this.clearDiagnostics(event.document.uri);
        }
        
        // Trigger live syntax check if enabled
        if (this.shouldRunLiveCheck() && event.contentChanges.length > 0) {
            this.scheduleLiveCheck(event.document);
        }
    }
    
    /**
     * Handles document save events
     */
    private onDocumentSave(document: vscode.TextDocument): void {
        if (document.languageId !== 'easycrypt') {
            return;
        }
        
        // Run syntax check on save if enabled
        if (this.configManager?.isCheckOnSaveEnabled() && this.configManager?.isLiveChecksEnabled()) {
            this.log(`Running check on save for ${document.uri.fsPath}`);
            this.runLiveCheck(document);
        }
    }
    
    /**
     * Checks if live syntax checking should run
     */
    private shouldRunLiveCheck(): boolean {
        if (!this.configManager || !this.syntaxChecker) {
            return false;
        }
        return this.configManager.isLiveChecksEnabled() && 
               this.configManager.isCheckOnChangeEnabled();
    }
    
    /**
     * Schedules a live syntax check with debouncing
     * 
     * @param document - The document to check
     */
    private scheduleLiveCheck(document: vscode.TextDocument): void {
        const uriString = document.uri.toString();
        
        // Clear existing timer for this document
        const existingTimer = this.debounceTimers.get(uriString);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        
        // Get delay from configuration
        const delay = this.configManager?.getLiveCheckDelay() ?? 500;
        
        // Schedule new check
        const timer = setTimeout(() => {
            this.debounceTimers.delete(uriString);
            this.runLiveCheck(document);
        }, delay);
        
        this.debounceTimers.set(uriString, timer);
    }
    
    /**
     * Runs a live syntax check on a document
     * 
     * @param document - The document to check
     */
    private async runLiveCheck(document: vscode.TextDocument): Promise<void> {
        if (!this.syntaxChecker) {
            return;
        }
        
        // Ensure document is still open
        const openDocument = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === document.uri.toString()
        );
        if (!openDocument) {
            return;
        }
        
        this.log(`Starting live check for ${document.uri.fsPath}`);
        this._onDidStartCheck.fire(document.uri);
        
        try {
            const result = await this.syntaxChecker.check(openDocument);
            
            if (result.completed) {
                // Update diagnostics with the result
                this.setDiagnostics(document.uri, result.errors);
                this.log(`Live check completed: ${result.errors.length} error(s) in ${result.duration}ms`);
            } else {
                this.log(`Live check was cancelled or failed`);
            }
            
            this._onDidCompleteCheck.fire({ uri: document.uri, result });
        } catch (error) {
            this.log(`Live check error: ${error}`);
        }
    }
    
    /**
     * Triggers an immediate syntax check for a document
     * 
     * @param document - The document to check
     * @returns Promise resolving to the check result
     */
    public async triggerCheck(document: vscode.TextDocument): Promise<SyntaxCheckResult | undefined> {
        if (!this.syntaxChecker) {
            return undefined;
        }
        
        // Cancel any pending debounced check
        const uriString = document.uri.toString();
        const existingTimer = this.debounceTimers.get(uriString);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.debounceTimers.delete(uriString);
        }
        
        this._onDidStartCheck.fire(document.uri);
        
        try {
            const result = await this.syntaxChecker.check(document);
            
            if (result.completed) {
                this.setDiagnostics(document.uri, result.errors);
            }
            
            this._onDidCompleteCheck.fire({ uri: document.uri, result });
            return result;
        } catch (error) {
            this.log(`Trigger check error: ${error}`);
            return undefined;
        }
    }
    
    /**
     * Cancels any pending or running syntax checks for a document
     * 
     * @param uri - The URI of the document
     */
    public cancelCheck(uri: vscode.Uri): void {
        const uriString = uri.toString();
        
        // Clear debounce timer
        const timer = this.debounceTimers.get(uriString);
        if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(uriString);
        }
        
        // Cancel running check
        this.syntaxChecker?.cancel();
    }

    /**
     * Handles document close events
     */
    private onDocumentClose(document: vscode.TextDocument): void {
        const uriString = document.uri.toString();
        this.diagnosticsPerFile.delete(uriString);
        this.modifiedDocuments.delete(uriString);
        this.diagnosticCollection.delete(document.uri);
    }

    /**
     * Sets diagnostics for a file from parsed errors
     * 
     * @param uri - The URI of the file
     * @param errors - Array of parsed errors from EasyCrypt output
     */
    public setDiagnostics(uri: vscode.Uri, errors: ParsedError[]): void {
        const diagnostics = errors
            .slice(0, this.options.maxDiagnosticsPerFile)
            .map(error => createDiagnostic(error));

        this.diagnosticCollection.set(uri, diagnostics);
        this.diagnosticsPerFile.set(uri.toString(), diagnostics);
        this.modifiedDocuments.delete(uri.toString());
    }

    /**
     * Adds a single diagnostic to an existing set for a file
     * 
     * @param uri - The URI of the file
     * @param error - The parsed error to add
     */
    public addDiagnostic(uri: vscode.Uri, error: ParsedError): void {
        const uriString = uri.toString();
        const existing = this.diagnosticsPerFile.get(uriString) ?? [];
        
        if (existing.length >= this.options.maxDiagnosticsPerFile) {
            return; // Don't exceed max
        }

        const newDiagnostic = createDiagnostic(error);
        const updated = [...existing, newDiagnostic];
        
        this.diagnosticCollection.set(uri, updated);
        this.diagnosticsPerFile.set(uriString, updated);
    }

    /**
     * Clears all diagnostics for a specific file
     * 
     * @param uri - The URI of the file to clear diagnostics for
     */
    public clearDiagnostics(uri: vscode.Uri): void {
        this.diagnosticCollection.delete(uri);
        this.diagnosticsPerFile.delete(uri.toString());
    }

    /**
     * Clears diagnostics within a specific range
     * 
     * This is useful when a proof step is retracted - we want to clear
     * diagnostics that were associated with that step.
     * 
     * @param uri - The URI of the file
     * @param range - The range to clear diagnostics from
     */
    public clearDiagnosticsInRange(uri: vscode.Uri, range: vscode.Range): void {
        const uriString = uri.toString();
        const existing = this.diagnosticsPerFile.get(uriString);
        
        if (!existing) {
            return;
        }

        // Filter out diagnostics that intersect with the given range
        const filtered = existing.filter(diag => !diag.range.intersection(range));
        
        if (filtered.length === existing.length) {
            return; // Nothing changed
        }

        if (filtered.length === 0) {
            this.clearDiagnostics(uri);
        } else {
            this.diagnosticCollection.set(uri, filtered);
            this.diagnosticsPerFile.set(uriString, filtered);
        }
    }

    /**
     * Clears diagnostics after a specific line
     * 
     * This is useful when stepping backwards in a proof - diagnostics
     * after the current point should be cleared.
     * 
     * @param uri - The URI of the file
     * @param line - The line number (0-indexed) after which to clear diagnostics
     */
    public clearDiagnosticsAfterLine(uri: vscode.Uri, line: number): void {
        const uriString = uri.toString();
        const existing = this.diagnosticsPerFile.get(uriString);
        
        if (!existing) {
            return;
        }

        const filtered = existing.filter(diag => diag.range.start.line <= line);
        
        if (filtered.length === existing.length) {
            return; // Nothing changed
        }

        if (filtered.length === 0) {
            this.clearDiagnostics(uri);
        } else {
            this.diagnosticCollection.set(uri, filtered);
            this.diagnosticsPerFile.set(uriString, filtered);
        }
    }

    /**
     * Clears all diagnostics for all files
     */
    public clearAll(): void {
        this.diagnosticCollection.clear();
        this.diagnosticsPerFile.clear();
    }

    /**
     * Gets current diagnostics for a file
     * 
     * @param uri - The URI of the file
     * @returns Array of diagnostics for the file, or undefined if none
     */
    public getDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] | undefined {
        return this.diagnosticsPerFile.get(uri.toString());
    }

    /**
     * Checks if a file has any errors (not warnings)
     * 
     * @param uri - The URI of the file
     * @returns true if the file has error-level diagnostics
     */
    public hasErrors(uri: vscode.Uri): boolean {
        const diagnostics = this.diagnosticsPerFile.get(uri.toString());
        if (!diagnostics) {
            return false;
        }
        return diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Error);
    }

    /**
     * Checks if a file has been modified since the last diagnostic update
     * 
     * @param uri - The URI of the file
     * @returns true if the document has been modified
     */
    public isDocumentModified(uri: vscode.Uri): boolean {
        return this.modifiedDocuments.has(uri.toString());
    }

    /**
     * Gets the count of diagnostics for a file
     * 
     * @param uri - The URI of the file
     * @returns The number of diagnostics
     */
    public getDiagnosticCount(uri: vscode.Uri): number {
        return this.diagnosticsPerFile.get(uri.toString())?.length ?? 0;
    }

    /**
     * Gets diagnostic counts by severity for a file
     * 
     * @param uri - The URI of the file
     * @returns Object with counts per severity level
     */
    public getDiagnosticCountsBySeverity(uri: vscode.Uri): {
        errors: number;
        warnings: number;
        info: number;
        hints: number;
    } {
        const diagnostics = this.diagnosticsPerFile.get(uri.toString()) ?? [];
        
        return {
            errors: diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length,
            warnings: diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length,
            info: diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Information).length,
            hints: diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Hint).length
        };
    }

    /**
     * Updates diagnostics to shift line numbers after edits
     * 
     * This is useful when lines are inserted or deleted, and we want to
     * keep existing diagnostics aligned with the new content.
     * 
     * @param uri - The URI of the file
     * @param startLine - The line where the edit started
     * @param lineDelta - The number of lines added (positive) or removed (negative)
     */
    public shiftDiagnostics(uri: vscode.Uri, startLine: number, lineDelta: number): void {
        const uriString = uri.toString();
        const existing = this.diagnosticsPerFile.get(uriString);
        
        if (!existing || lineDelta === 0) {
            return;
        }

        const updated = existing.map(diag => {
            if (diag.range.start.line < startLine) {
                return diag;
            }

            const newRange = new vscode.Range(
                diag.range.start.line + lineDelta,
                diag.range.start.character,
                diag.range.end.line + lineDelta,
                diag.range.end.character
            );

            const newDiag = new vscode.Diagnostic(
                newRange,
                diag.message,
                diag.severity
            );
            newDiag.source = diag.source;
            newDiag.code = diag.code;
            return newDiag;
        });

        this.diagnosticCollection.set(uri, updated);
        this.diagnosticsPerFile.set(uriString, updated);
    }

    /**
     * Disposes of the diagnostic manager and all resources
     */
    public dispose(): void {
        // Clear all debounce timers
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        
        // Cancel any running syntax check
        this.syntaxChecker?.cancel();
        
        this.diagnosticCollection.dispose();
        this.diagnosticsPerFile.clear();
        this.modifiedDocuments.clear();
        
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }
}
