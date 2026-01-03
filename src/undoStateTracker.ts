/**
 * EasyCrypt Undo State Tracker
 * 
 * Tracks EasyCrypt interactive state numbers (uuids) to enable fast
 * backward navigation via `undo <uuid>.` instead of restart + replay.
 * 
 * This module provides a VS Code-aware wrapper around the core tracking logic.
 * 
 * Based on: Docs/Plan/undo-to-state-backward-navigation-implementation-plan.md
 * 
 * @module undoStateTracker
 */

import * as vscode from 'vscode';
import {
    PromptInfo,
    UndoStateSnapshot,
    PromptParseResult,
    EMACS_PROMPT_REGEX,
    parseEmacsPrompt,
    extractAllPrompts,
    UndoStateTrackerCore
} from './undoStateTrackerCore';

// Re-export core types and functions
export { 
    PromptInfo, 
    UndoStateSnapshot, 
    PromptParseResult, 
    EMACS_PROMPT_REGEX, 
    parseEmacsPrompt, 
    extractAllPrompts 
};

/**
 * Events emitted by the UndoStateTracker.
 */
export interface UndoStateTrackerEvents {
    /** Fired when the tracker becomes invalid (invariant violation) */
    onDidBecomeInvalid: vscode.Event<{ reason: string }>;
    /** Fired when the mapping is updated */
    onDidUpdateMapping: vscode.Event<UndoStateSnapshot>;
    /** Fired when the tracker is reset */
    onDidReset: vscode.Event<void>;
}

/**
 * VS Code-aware wrapper around UndoStateTrackerCore.
 * 
 * Tracks EasyCrypt state uuids for fast backward navigation.
 * Provides VS Code event emitters and disposal.
 * 
 * Usage:
 * 1. Call beforeStatementSend() before sending a statement
 * 2. Call afterStatementProcessed() with the new prompt uuid after success
 * 3. Use getUndoTarget() to get the uuid for retracting a statement
 * 
 * The tracker validates invariants and automatically invalidates itself
 * if inconsistencies are detected (e.g., non-monotonic uuid).
 */
export class UndoStateTracker implements vscode.Disposable {
    /** Core tracker logic */
    private readonly core: UndoStateTrackerCore;
    
    /** Event emitters */
    private readonly _onDidBecomeInvalid = new vscode.EventEmitter<{ reason: string }>();
    private readonly _onDidUpdateMapping = new vscode.EventEmitter<UndoStateSnapshot>();
    private readonly _onDidReset = new vscode.EventEmitter<void>();
    
    /** Public events */
    public readonly onDidBecomeInvalid = this._onDidBecomeInvalid.event;
    public readonly onDidUpdateMapping = this._onDidUpdateMapping.event;
    public readonly onDidReset = this._onDidReset.event;
    
    /** Disposables */
    private readonly disposables: vscode.Disposable[] = [];
    
    /**
     * Creates a new UndoStateTracker.
     * 
     * @param outputChannel - Optional output channel for logging
     * @param verbose - Whether to enable verbose logging
     */
    constructor(outputChannel?: vscode.OutputChannel, verbose: boolean = false) {
        // Create logger that uses VS Code output channel
        const logger = {
            log: (message: string) => {
                if (verbose && outputChannel) {
                    outputChannel.appendLine(`[UndoStateTracker] ${message}`);
                }
            },
            logImportant: (message: string) => {
                if (outputChannel) {
                    outputChannel.appendLine(`[UndoStateTracker] ${message}`);
                }
            }
        };
        
        this.core = new UndoStateTrackerCore(logger);
        
        // Wire up events from core to VS Code emitters
        this.core.setCallbacks({
            onInvalidated: (event) => this._onDidBecomeInvalid.fire(event),
            onMappingUpdated: (event) => this._onDidUpdateMapping.fire(event.snapshot),
            onReset: () => this._onDidReset.fire()
        });
    }
    
    /**
     * Gets the current snapshot of the undo state.
     */
    public getSnapshot(): UndoStateSnapshot {
        return this.core.getSnapshot();
    }
    
    /**
     * Checks if the tracker is valid for this session.
     */
    public isValid(): boolean {
        return this.core.isValid();
    }
    
    /**
     * Gets the number of tracked statements.
     */
    public getTrackedStatementCount(): number {
        return this.core.getTrackedStatementCount();
    }
    
    /**
     * Gets the current uuid.
     */
    public getCurrentUuid(): number {
        return this.core.getCurrentUuid();
    }
    
    /**
     * Initializes the tracker with a startup uuid (typically 0).
     * Call this when the EasyCrypt process starts and emits its first prompt.
     * 
     * @param startupUuid - The uuid from the startup prompt (usually 0)
     */
    public initialize(startupUuid: number): void {
        this.core.initialize(startupUuid);
    }
    
    /**
     * Resets the tracker. Call this on process restart/recovery.
     */
    public reset(): void {
        this.core.reset();
    }
    
    /**
     * Called before sending a statement to EasyCrypt.
     * Captures the current uuid as the pre-state for this statement.
     * 
     * @param statementIndex - The 0-based index of the statement being sent
     */
    public beforeStatementSend(statementIndex: number): void {
        this.core.beforeStatementSend(statementIndex);
    }
    
    /**
     * Called after a statement is successfully processed.
     * Updates the mapping with the new prompt uuid.
     * 
     * @param statementIndex - The 0-based index of the statement that was processed
     * @param newPromptInfo - The prompt info from the response
     * @returns Whether the update was successful
     */
    public afterStatementProcessed(statementIndex: number, newPromptInfo: PromptInfo): boolean {
        return this.core.afterStatementProcessed(statementIndex, newPromptInfo);
    }
    
    /**
     * Called after a batch of statements is successfully processed.
     * Updates the mapping for all statements in the batch.
     * 
     * @param startStatementIndex - The 0-based index of the first statement in the batch
     * @param statementCount - Number of statements in the batch
     * @param promptInfos - Array of prompt infos from the batch responses (one per statement)
     * @returns Whether the update was successful
     */
    public afterBatchProcessed(
        startStatementIndex: number,
        statementCount: number,
        promptInfos: PromptInfo[]
    ): boolean {
        return this.core.afterBatchProcessed(startStatementIndex, statementCount, promptInfos);
    }
    
    /**
     * Gets the target uuid to undo to in order to retract a statement.
     * 
     * @param statementIndex - The 0-based index of the statement to retract
     * @returns The target uuid, or undefined if not available
     */
    public getUndoTarget(statementIndex: number): number | undefined {
        return this.core.getUndoTarget(statementIndex);
    }
    
    /**
     * Gets the target uuid to undo to for backward navigation.
     * This is the uuid to retract all statements from currentCount down to targetCount.
     * 
     * @param currentStatementCount - Current number of processed statements
     * @param targetStatementCount - Target number of statements after undo
     * @returns The target uuid, or undefined if not available
     */
    public getUndoTargetForBackwardJump(
        currentStatementCount: number,
        targetStatementCount: number
    ): number | undefined {
        return this.core.getUndoTargetForBackwardJump(currentStatementCount, targetStatementCount);
    }
    
    /**
     * Truncates the mapping after a successful undo.
     * Call this after `undo <uuid>.` succeeds to update the tracker state.
     * 
     * @param newStatementCount - The new number of statements after undo
     * @param newUuid - The uuid from the undo response prompt
     */
    public afterUndoSucceeded(newStatementCount: number, newUuid: number): void {
        this.core.afterUndoSucceeded(newStatementCount, newUuid);
    }
    
    /**
     * Disposes of the tracker.
     */
    public dispose(): void {
        this._onDidBecomeInvalid.dispose();
        this._onDidUpdateMapping.dispose();
        this._onDidReset.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
