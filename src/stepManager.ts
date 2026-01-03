/**
 * EasyCrypt Step Manager
 * 
 * Central controller for interactive proof navigation. Manages stepping
 * through proof scripts, tracking the execution position, and coordinating
 * with the ProcessManager and EditorDecorator.
 * 
 * Supports fast backward navigation via `undo <uuid>.` when the UndoStateTracker
 * has a valid mapping. Falls back to restart + replay when the tracker is invalid
 * or when undo fails.
 * 
 * @module stepManager
 */

import * as vscode from 'vscode';
import { ProcessManager, ProcessOutput } from './processManager';
import { ProofStateManager, ProofProgressSnapshot } from './proofStateManager';
import { EditorDecorator } from './editorDecorator';
import { findNextStatement, findPreviousStatementEnd, Statement } from './statementParser';
import { StatementIndex } from './statementIndex';
import { parseOutput } from './outputParser';
import { EmacsPromptCounter } from './emacsPromptCounter';
import { Logger } from './logger';
import { UndoStateTracker, extractAllPrompts, PromptInfo } from './undoStateTracker';

/**
 * Result of a step operation
 */
export interface StepResult {
    /** Whether the step succeeded */
    success: boolean;
    /** Error message if failed */
    error?: string;
    /** The statement that was processed */
    statement?: Statement;
    /** Raw output from EasyCrypt */
    output?: string;
    /** Execution offset after the operation */
    executionOffset?: number;
}

/**
 * Events emitted by the StepManager
 */
export interface StepManagerEvents {
    /** Fired when the execution position changes */
    onDidChangePosition: vscode.Event<vscode.Position>;
    /** Fired when stepping starts */
    onDidStartStep: vscode.Event<void>;
    /** Fired when stepping completes */
    onDidCompleteStep: vscode.Event<StepResult>;
}

/**
 * Manages interactive proof navigation.
 * 
 * Responsibilities:
 * - Track execution position (boundary between verified/unverified code)
 * - Handle stepForward, stepBackward, goToCursor commands
 * - Coordinate with ProcessManager for REPL communication
 * - Update EditorDecorator for visual feedback
 * - Auto-retract on edits in verified region
 */
export class StepManager implements vscode.Disposable {
    /** Current execution position (end of last verified statement) */
    private executionOffset: number = 0;
    
    /** The document being stepped through */
    private document: vscode.TextDocument | undefined;
    
    /** Whether a step operation is in progress */
    private stepping: boolean = false;
    
    /** Pending command awaiting output */
    private pendingCommand:
        | {
                            fileUri: vscode.Uri | undefined;
              chunks: ProcessOutput[];
                            /** How many emacs prompt markers we expect before considering the response complete */
                            expectedPromptCount: number;
                            /** Prompt counter for robust completion detection (handles leading prompts) */
                            promptCounter: EmacsPromptCounter;
                                                        /** Debounce handle to avoid resolving before trailing stdout arrives */
                                                        completionDebounceHandle?: NodeJS.Timeout;
              resolve: (output: ProcessOutput) => void;
              reject: (error: Error) => void;
              timeoutHandle: NodeJS.Timeout;
          }
        | undefined;

    /** Whether auto-retraction is running */
    private retracting: boolean = false;

    /** Smallest requested retraction offset (if any) */
    private pendingRetractOffset: number | undefined;

    /** Whether recovery is in progress */
    private recovering: boolean = false;

    /** Cached statement index for efficient cursor-to-statement mapping */
    private statementIndex: StatementIndex = new StatementIndex();

    /** Undo state tracker for fast backward navigation via `undo <uuid>.` */
    private undoStateTracker: UndoStateTracker;
    
    /** Event emitters */
    private readonly _onDidChangePosition = new vscode.EventEmitter<vscode.Position>();
    private readonly _onDidStartStep = new vscode.EventEmitter<void>();
    private readonly _onDidCompleteStep = new vscode.EventEmitter<StepResult>();
    
    /** Public events */
    public readonly onDidChangePosition = this._onDidChangePosition.event;
    public readonly onDidStartStep = this._onDidStartStep.event;
    public readonly onDidCompleteStep = this._onDidCompleteStep.event;
    
    /** Disposables */
    private disposables: vscode.Disposable[] = [];
    
    /** Output channel for logging */
    private outputChannel: vscode.OutputChannel | undefined;

    /**
     * Creates a new StepManager
     */
    constructor(
        private readonly processManager: ProcessManager,
        private readonly proofStateManager: ProofStateManager,
        private readonly decorator: EditorDecorator,
        outputChannel?: vscode.OutputChannel
    ) {
        this.outputChannel = outputChannel;
        
        // Initialize undo state tracker for fast backward navigation
        this.undoStateTracker = new UndoStateTracker(outputChannel, true);
        this.disposables.push(this.undoStateTracker);
        
        // Log when undo state tracker becomes invalid
        this.disposables.push(
            this.undoStateTracker.onDidBecomeInvalid(({ reason }) => {
                this.log(`UndoStateTracker invalidated: ${reason}. Falling back to restart+replay for backward navigation.`);
            })
        );
        
        // Listen for process output to resolve pending step operations
        this.disposables.push(
            this.processManager.onOutput(output => {
                this.handleProcessOutput(output);
            })
        );
        
        // Listen for document changes to handle auto-retraction
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                this.handleDocumentChange(event);
            })
        );
        
        // Listen for process stop to reset state
        this.disposables.push(
            this.processManager.onDidStop(() => {
                // During recovery we intentionally stop/start the process.
                // Resetting here would clear the recovery flags and re-enable
                // incremental proof-state updates from the global output handler.
                if (this.recovering) {
                    this.log('Process stopped during recovery; skipping automatic reset.');
                    return;
                }
                this.reset();
            })
        );
    }

    private handleProcessOutput(output: ProcessOutput): void {
        if (!this.pendingCommand) {
            return;
        }

        const pending = this.pendingCommand;
        pending.chunks.push(output);

        // Protocol-driven completion:
        // In `easycrypt cli -emacs` mode, EasyCrypt prints prompt markers like:
        //   [99|check]>
        // Each processed statement typically results in one such prompt.
        // For batched sends (multiple statements joined with newlines), we must
        // wait for *all* expected prompts to arrive, otherwise we may "finish"
        // early and allow late chunks to update the Proof State view (flicker).
        //
        // Use EmacsPromptCounter for robust prompt counting that handles:
        // - Leading prompts coalesced from previous commands
        // - Multiple prompts in one chunk
        const chunkResult = pending.promptCounter.ingestChunk(output.raw ?? '');
        const seenResponsePrompts = pending.promptCounter.getTotalResponsePrompts();

        this.log(`Prompt counting: chunk has ${chunkResult.responsePrompts}/${chunkResult.totalPrompts} response/total prompts, ` +
            `total seen: ${seenResponsePrompts}/${pending.expectedPromptCount}, ` +
            `counter: ${pending.promptCounter.getDebugSummary()}`);

        if (seenResponsePrompts >= pending.expectedPromptCount) {
            // Important: even after the last prompt we care about arrives, EasyCrypt may emit
            // trailing output/prompts in a subsequent stdout chunk (OS buffering, chunking).
            // If we resolve immediately, we can truncate the tail and the Proof State view will
            // show stale "last output".
            //
            // Debounce completion briefly: each new chunk postpones finalization, ensuring we
            // include any immediate trailing output.
            // Single statements should feel snappy; batched replay/goToCursor is less latency-sensitive
            // and benefits from a longer settle window to capture trailing prompt-delimited output.
            const debounceMs = pending.expectedPromptCount > 1 ? 75 : 25;

            if (pending.completionDebounceHandle) {
                clearTimeout(pending.completionDebounceHandle);
            }

            pending.completionDebounceHandle = setTimeout(() => {
                // If another command has started, do nothing.
                if (this.pendingCommand !== pending) {
                    return;
                }

                const finalSeen = pending.promptCounter.getTotalResponsePrompts();
                if (finalSeen < pending.expectedPromptCount) {
                    return;
                }

                this.pendingCommand = undefined;
                clearTimeout(pending.timeoutHandle);
                if (pending.completionDebounceHandle) {
                    clearTimeout(pending.completionDebounceHandle);
                    pending.completionDebounceHandle = undefined;
                }

                const raw = pending.chunks.map(chunk => chunk.raw).filter(Boolean).join('\n');
                const parsed = parseOutput(raw, {
                    defaultFilePath: pending.fileUri?.fsPath,
                    includeRawOutput: true
                });

                this.log(`Command complete: expected=${pending.expectedPromptCount}, seen=${finalSeen}, ` +
                    `ignoredLeading=${pending.promptCounter.hasIgnoredLeadingPrompt()}`);

                pending.resolve({
                    raw,
                    parsed,
                    fileUri: pending.fileUri
                });
            }, debounceMs);
        }
    }

    /**
     * Logs a message
     */
    private log(message: string): void {
        this.outputChannel?.appendLine(`[StepManager] ${message}`);
    }

    /**
     * Gets the current execution position as a VS Code Position
     */
    public getExecutionPosition(): vscode.Position {
        if (!this.document) {
            return new vscode.Position(0, 0);
        }
        return this.document.positionAt(this.executionOffset);
    }

    /**
     * Checks if recovery is currently in progress
     */
    public isRecovering(): boolean {
        return this.recovering;
    }

    /**
     * Manually triggers state recovery.
     * 
     * This can be called when the user suspects the proof state is
     * desynchronized. It will reset the EasyCrypt session and re-execute
     * all statements up to the current execution offset.
     * 
     * @returns Result of the recovery operation
     */
    public async forceRecovery(): Promise<StepResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'easycrypt') {
            return { success: false, error: 'No active EasyCrypt file' };
        }

        if (this.stepping || this.retracting || this.recovering) {
            return { success: false, error: 'Operation already in progress' };
        }

        this.setDocument(editor.document);
        const currentOffset = this.executionOffset;

        this.log(`Force recovery requested. Will re-verify to offset ${currentOffset}`);

        // If at start, nothing to recover
        if (currentOffset === 0) {
            this.reset();
            return { success: true, executionOffset: 0 };
        }

        return await this.recoverState(currentOffset, editor);
    }

    /**
     * Gets the current execution offset
     */
    public getExecutionOffset(): number {
        return this.executionOffset;
    }

    /**
     * Computes the progress snapshot for the current execution state.
     * 
     * Rules for computing the last proved statement:
     * - The last proved statement is the statement whose endOffset === executionOffset.
     * - If no statement ends exactly at executionOffset, select the greatest statement
     *   with endOffset < executionOffset (covers rare off-by-one or whitespace situations).
     * - If no such statement exists, the proved region is empty.
     * 
     * @returns The progress snapshot with proved count and last statement text
     */
    private computeProgressSnapshot(): ProofProgressSnapshot {
        if (!this.document) {
            return { provedStatementCount: 0 };
        }

        const text = this.document.getText();
        this.statementIndex.update(text, this.document.version);
        const statements = this.statementIndex.getStatementsUpTo(this.executionOffset);
        const provedStatementCount = statements.length;

        let lastProvedStatementText: string | undefined;
        if (provedStatementCount > 0) {
            // Find the statement that ends exactly at executionOffset
            let lastStatement = statements[statements.length - 1];
            
            // Check if the last statement ends exactly at executionOffset
            if (lastStatement.endOffset === this.executionOffset) {
                lastProvedStatementText = lastStatement.text;
            } else {
                // Fallback: find the greatest statement with endOffset < executionOffset
                for (let i = statements.length - 1; i >= 0; i--) {
                    if (statements[i].endOffset <= this.executionOffset) {
                        lastProvedStatementText = statements[i].text;
                        break;
                    }
                }
            }
        }

        this.log(`Progress snapshot: ${provedStatementCount} statements, lastStatement=${lastProvedStatementText?.substring(0, 30)}...`);
        return { provedStatementCount, lastProvedStatementText };
    }

    /**
     * Checks if currently stepping
     */
    public isStepping(): boolean {
        return this.stepping;
    }

    /**
     * Sets the active document for stepping
     */
    public setDocument(document: vscode.TextDocument): void {
        if (this.document?.uri.toString() !== document.uri.toString()) {
            // Different document, reset state
            this.executionOffset = 0;
            this.document = document;
            this.updateDecorations();
        }
    }

    /**
     * Steps forward by one statement
     * 
     * @returns Result of the step operation
     */
    public async stepForward(): Promise<StepResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'easycrypt') {
            return { success: false, error: 'No active EasyCrypt file' };
        }
        
        if (this.stepping || this.retracting) {
            return { success: false, error: 'Step already in progress' };
        }
        
        this.setDocument(editor.document);
        const text = editor.document.getText();
        
        // Update statement index and find next statement
        this.statementIndex.update(text, editor.document.version);
        
        // Find next statement using the parser (more precise for single steps)
        const statement = findNextStatement(text, this.executionOffset);
        if (!statement) {
            return { success: false, error: 'No more statements' };
        }
        
        // Get the statement index for undo tracking
        const statementsBeforeThis = this.statementIndex.getStatementsUpTo(this.executionOffset);
        const statementIndex = statementsBeforeThis.length;
        
        this.log(`Stepping forward: "${statement.text.substring(0, 50)}..." (statementIndex=${statementIndex})`);
        
        // Ensure process is running
        if (!this.processManager.isRunning()) {
            try {
                await this.processManager.start();
                // Initialize undo tracker when process starts
                this.undoStateTracker.initialize(0);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { success: false, error: `Failed to start process: ${msg}` };
            }
        }
        
        this.stepping = true;
        this._onDidStartStep.fire();
        this.proofStateManager.setProcessing(true);
        
        // Show processing decoration
        const processingRange = new vscode.Range(
            editor.document.positionAt(statement.startOffset),
            editor.document.positionAt(statement.endOffset)
        );
        this.decorator.setProcessingRange(editor, processingRange);
        
        // Track undo state: capture pre-state uuid before sending
        this.undoStateTracker.beforeStatementSend(statementIndex);
        
        try {
            // Send statement to process and wait for output
            const output = await this.sendAndWait(statement.text, editor.document.uri);
            
            // Check if output indicates an error
            const hasError = output.parsed.errors.length > 0;
            
            if (hasError) {
                this.log(`Step failed: ${output.parsed.errors[0]?.message}`);
                // Publish proof state once (final output only) with current progress
                const progress = this.computeProgressSnapshot();
                this.proofStateManager.handleProcessOutput(output, progress);
                const result: StepResult = {
                    success: false,
                    error: output.parsed.errors[0]?.message || 'Unknown error',
                    statement,
                    output: output.raw,
                    executionOffset: this.executionOffset
                };
                this._onDidCompleteStep.fire(result);
                return result;
            }
            
            // Success - advance execution position
            this.executionOffset = statement.endOffset;
            this.updateDecorations();
            this._onDidChangePosition.fire(this.getExecutionPosition());
            
            // Track undo state: record the post-state uuid
            const prompts = extractAllPrompts(output.raw ?? '');
            if (prompts.length > 0) {
                const lastPrompt = prompts[prompts.length - 1];
                this.undoStateTracker.afterStatementProcessed(statementIndex, lastPrompt.promptInfo);
            } else {
                this.log(`Warning: No prompt found in output, undo tracking may be incomplete`);
            }

            // Publish proof state once (final output only) with updated progress
            const progress = this.computeProgressSnapshot();
            this.proofStateManager.handleProcessOutput(output, progress);
            
            this.log(`Step succeeded, new position: ${this.executionOffset}`);
            
            const result: StepResult = {
                success: true,
                statement,
                output: output.raw,
                executionOffset: this.executionOffset
            };
            this._onDidCompleteStep.fire(result);
            return result;
            
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Step error: ${msg}`);
            const result: StepResult = {
                success: false,
                error: msg,
                statement,
                executionOffset: this.executionOffset
            };
            this._onDidCompleteStep.fire(result);
            return result;
            
        } finally {
            this.stepping = false;
            this.proofStateManager.setProcessing(false);
            this.decorator.setProcessingRange(editor, undefined);
        }
    }

    /**
     * Steps backward by one statement
     * 
     * Implements fast backward navigation via `undo <uuid>.` when the
     * UndoStateTracker has a valid mapping. Falls back to restart + replay
     * when the tracker is invalid or when undo fails.
     * 
     * @param internal - Whether this is an internal call (e.g., from retraction)
     * @returns Result of the step operation
     */
    public async stepBackward(internal: boolean = false): Promise<StepResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'easycrypt') {
            return { success: false, error: 'No active EasyCrypt file' };
        }
        
        if (this.stepping || (!internal && this.retracting)) {
            return { success: false, error: 'Step already in progress' };
        }
        
        if (this.executionOffset === 0) {
            return { success: false, error: 'Already at start' };
        }
        
        this.setDocument(editor.document);
        const text = editor.document.getText();
        
        // Find previous statement end
        const prevEnd = findPreviousStatementEnd(text, this.executionOffset);
        const newOffset = prevEnd !== null ? prevEnd : 0;
        
        // Compute current and target statement counts
        this.statementIndex.update(text, editor.document.version);
        const currentStatements = this.statementIndex.getStatementsUpTo(this.executionOffset);
        const targetStatements = this.statementIndex.getStatementsUpTo(newOffset);
        const currentCount = currentStatements.length;
        const targetCount = targetStatements.length;
        
        this.log(`Stepping backward from ${this.executionOffset} to ${newOffset} (statements: ${currentCount} -> ${targetCount})`);

        this.stepping = true;
        this._onDidStartStep.fire();

        try {
            // Try fast undo-to-state if tracker is valid
            if (this.undoStateTracker.isValid() && this.processManager.isRunning()) {
                const undoResult = await this.tryUndoToState(targetCount, currentCount, editor);
                if (undoResult.success) {
                    this.log(`Fast undo-to-state succeeded`);
                    const result: StepResult = {
                        success: true,
                        output: undoResult.output,
                        executionOffset: this.executionOffset
                    };
                    this._onDidCompleteStep.fire(result);
                    return result;
                }
                // Undo failed, fall back to recovery
                this.log(`Fast undo-to-state failed: ${undoResult.error}. Falling back to restart+replay.`);
            } else {
                this.log(`Undo-to-state not available (tracker valid: ${this.undoStateTracker.isValid()}, process running: ${this.processManager.isRunning()}). Using restart+replay.`);
            }
            
            // Fallback: restart + replay
            const recoveryResult = await this.recoverState(newOffset, editor);
            const result: StepResult = {
                success: recoveryResult.success,
                error: recoveryResult.error,
                output: recoveryResult.output,
                executionOffset: this.executionOffset
            };
            this._onDidCompleteStep.fire(result);
            return result;
        } finally {
            this.stepping = false;
        }
    }

    /**
     * Attempts fast backward navigation via `undo <uuid>.`
     * 
     * This is the Proof General-style undo: instead of N incremental undo commands
     * or a full restart + replay, we send a single `undo <targetUuid>.` command
     * to jump back to the target state.
     * 
     * @param targetStatementCount - Target number of statements after undo
     * @param currentStatementCount - Current number of processed statements
     * @param editor - The active text editor
     * @returns Result of the undo attempt
     */
    private async tryUndoToState(
        targetStatementCount: number,
        currentStatementCount: number,
        editor: vscode.TextEditor
    ): Promise<StepResult> {
        const targetUuid = this.undoStateTracker.getUndoTargetForBackwardJump(
            currentStatementCount,
            targetStatementCount
        );
        
        if (targetUuid === undefined) {
            return { 
                success: false, 
                error: 'No undo target available',
                executionOffset: this.executionOffset
            };
        }
        
        this.log(`Attempting undo to uuid=${targetUuid} (target ${targetStatementCount} statements)`);
        
        // EasyCrypt `undo <uuid>.` command
        // Source citation (EasyCrypt, commit 4fc8b636e76ee1689c97089282809532cc4d3c5c):
        // - src/ec.ml: routes parsed `P_Undo i` to `EcCommands.undo i`
        // - src/ecCommands.ml: implements `undo (olduuid : int)` by repeated `pop_context`
        const undoCommand = `undo ${targetUuid}.`;
        
        try {
            const output = await this.sendAndWait(undoCommand, editor.document.uri);
            
            // Check for errors
            if (output.parsed.errors.length > 0) {
                const errorMsg = output.parsed.errors[0]?.message || 'Undo command failed';
                this.log(`Undo command returned error: ${errorMsg}`);
                // Invalidate tracker since undo failed
                return { 
                    success: false, 
                    error: errorMsg,
                    output: output.raw,
                    executionOffset: this.executionOffset
                };
            }
            
            // Verify the new uuid from the response prompt
            const prompts = extractAllPrompts(output.raw ?? '');
            if (prompts.length === 0) {
                this.log(`Warning: No prompt in undo response, cannot verify uuid`);
                // Proceed cautiously
            } else {
                const lastPrompt = prompts[prompts.length - 1];
                const responseUuid = lastPrompt.promptInfo.uuid;
                
                if (responseUuid !== targetUuid) {
                    this.log(`Undo uuid mismatch: expected ${targetUuid}, got ${responseUuid}`);
                    // This is unexpected but not necessarily fatal
                    // Continue and update tracker with actual uuid
                }
                
                // Update tracker state
                this.undoStateTracker.afterUndoSucceeded(targetStatementCount, responseUuid);
            }
            
            // Success - update execution offset
            const text = editor.document.getText();
            this.statementIndex.update(text, editor.document.version);
            const targetStatements = this.statementIndex.getStatementsUpTo(Infinity).slice(0, targetStatementCount);
            
            if (targetStatementCount === 0) {
                this.executionOffset = 0;
            } else if (targetStatements.length > 0) {
                this.executionOffset = targetStatements[targetStatements.length - 1].endOffset;
            } else {
                this.executionOffset = 0;
            }
            
            this.updateDecorations();
            this._onDidChangePosition.fire(this.getExecutionPosition());
            
            // Update proof state
            const progress = this.computeProgressSnapshot();
            this.proofStateManager.handleProcessOutput(output, progress);
            
            this.log(`Undo succeeded, new offset: ${this.executionOffset}`);
            
            return {
                success: true,
                output: output.raw,
                executionOffset: this.executionOffset
            };
            
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Undo command threw: ${msg}`);
            return { 
                success: false, 
                error: msg,
                executionOffset: this.executionOffset
            };
        }
    }

    /**
     * Recovers the proof state by resetting and fast-forwarding.
     * 
     * This is the Smart Recovery mechanism: when undo fails or the session
     * is desynchronized, we reset the EasyCrypt session and re-execute
     * all statements from the start up to the target offset.
     * 
     * UI Suppression: During recovery, the verified range is NOT updated
     * incrementally. Instead, a "verifying" range is shown for the pending
     * region, and the verified range is updated only once at completion.
     * Uses transactional proof-state updates to prevent flicker.
     * 
     * @param targetOffset - The offset to recover to
     * @param editor - The active text editor
     * @returns Result of the recovery operation
     */
    private async recoverState(targetOffset: number, editor: vscode.TextEditor): Promise<StepResult> {
        if (this.recovering) {
            return { success: false, error: 'Recovery already in progress' };
        }

        this.recovering = true;
        this.log(`Starting recovery to offset ${targetOffset}...`);

        // Begin transaction for UI suppression
        const tx = this.proofStateManager.beginTransaction('recovery');

        // Show status message to user
        const statusMessage = vscode.window.setStatusBarMessage('$(sync~spin) Recovering proof state...');

        // Show verifying range for the target region (UI suppression)
        const verifyingRange = new vscode.Range(
            new vscode.Position(0, 0),
            editor.document.positionAt(targetOffset)
        );
        this.decorator.setVerifyingRange(editor, verifyingRange);

        try {
            // Step 1: Reset the EasyCrypt session.
            // In some EasyCrypt versions, `reset.` is not a supported REPL command in cli/emacs mode
            // (it returns a parse error). The most reliable reset is a full process restart.
            await this.restartProcessForRecovery();

            // Step 2: Reset internal state (but don't update decorations yet - UI suppression)
            this.executionOffset = 0;

            // Step 3: Fast-forward to target offset (prefer one-shot batch).
            const text = editor.document.getText();
            
            // Update statement index for efficient access
            this.statementIndex.update(text, editor.document.version);
            const statements = this.statementIndex.getStatementsUpTo(targetOffset);

            if (statements.length === 0) {
                this.executionOffset = 0;
                this.updateDecorations();
                this._onDidChangePosition.fire(this.getExecutionPosition());
                // End transaction with empty output and progress
                const progress = this.computeProgressSnapshot();
                this.proofStateManager.endTransaction(tx, { raw: '', parsed: { errors: [], success: true, proofCompleted: false, remainingOutput: '' } }, progress);
                this.log('Recovery complete (no statements to replay).');
                return { success: true, executionOffset: this.executionOffset };
            }

            const batchedText = statements.map(stmt => stmt.text).join('\n');
            const batchedOutput = await this.sendAndWait(batchedText, editor.document.uri, statements.length);

            if (batchedOutput.parsed.errors.length === 0) {
                // Success: update verified range once at the end
                this.executionOffset = statements[statements.length - 1].endOffset;
                this.updateDecorations();
                this._onDidChangePosition.fire(this.getExecutionPosition());
                
                // Rebuild undo state tracking from the batch output prompts
                this.rebuildUndoStateFromBatch(batchedOutput.raw ?? '', statements.length);
                
                // End transaction with final output and progress
                const progress = this.computeProgressSnapshot();
                this.proofStateManager.endTransaction(tx, batchedOutput, progress);
                this.log(`Recovery complete (batched). Replayed ${statements.length} statements. Final offset: ${this.executionOffset}`);
                return { success: true, executionOffset: this.executionOffset, output: batchedOutput.raw };
            }

            this.log('Batched replay produced an error; attempting sequential fallback replay.');

            // Sequential fallback: re-run statements one by one so batch-only failures can recover.
            // We keep the already restarted process (single restart semantics).
            // UI suppression: still don't update verified range incrementally
            // Track undo state during sequential replay
            let lastOutput: ProcessOutput | undefined;
            this.executionOffset = 0;
            // Reset undo tracker since we're starting fresh after failed batch
            this.undoStateTracker.reset();
            this.undoStateTracker.initialize(0);
            
            for (let i = 0; i < statements.length; i++) {
                const statement = statements[i];
                
                // Track undo state: capture pre-state
                this.undoStateTracker.beforeStatementSend(i);
                
                lastOutput = await this.sendAndWait(statement.text, editor.document.uri);

                if (lastOutput.parsed.errors.length > 0) {
                    const message = lastOutput.parsed.errors[0]?.message ?? 'Unknown EasyCrypt error';
                    this.log(`Recovery stopped at offset ${this.executionOffset}: ${message}`);
                    // Update verified range only at the end
                    this.updateDecorations();
                    this._onDidChangePosition.fire(this.getExecutionPosition());
                    // End transaction with error output and progress
                    const progress = this.computeProgressSnapshot();
                    this.proofStateManager.endTransaction(tx, lastOutput, progress);
                    return {
                        success: false,
                        error: `Recovery stopped: ${message}`,
                        statement,
                        output: lastOutput.raw,
                        executionOffset: this.executionOffset
                    };
                }
                
                // Track undo state: record post-state
                const prompts = extractAllPrompts(lastOutput.raw ?? '');
                if (prompts.length > 0) {
                    const lastPrompt = prompts[prompts.length - 1];
                    this.undoStateTracker.afterStatementProcessed(i, lastPrompt.promptInfo);
                }

                this.executionOffset = statement.endOffset;
            }

            // Success: update verified range once at the end
            this.updateDecorations();
            this._onDidChangePosition.fire(this.getExecutionPosition());
            if (lastOutput) {
                // End transaction with final output and progress
                const progress = this.computeProgressSnapshot();
                this.proofStateManager.endTransaction(tx, lastOutput, progress);
            } else {
                // Shouldn't happen, but handle gracefully
                const progress = this.computeProgressSnapshot();
                this.proofStateManager.endTransaction(tx, { raw: '', parsed: { errors: [], success: true, proofCompleted: false, remainingOutput: '' } }, progress);
            }
            this.log(`Recovery complete (sequential fallback). Replayed ${statements.length} statements. Final offset: ${this.executionOffset}`);
            return { success: true, executionOffset: this.executionOffset, output: lastOutput?.raw };

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Recovery failed: ${msg}`);
            // Fail transaction with error
            this.proofStateManager.failTransaction(tx, `Recovery failed: ${msg}`);
            return {
                success: false,
                error: `Recovery failed: ${msg}`,
                executionOffset: this.executionOffset
            };
        } finally {
            this.recovering = false;
            // Clear verifying range
            this.decorator.setVerifyingRange(editor, undefined);
            statusMessage.dispose();
        }
    }

    private async restartProcessForRecovery(): Promise<void> {
        await this.processManager.stopAndWait(4000);
        await this.processManager.start();
        // Reset undo state tracker after process restart
        this.undoStateTracker.initialize(0);
    }

    /**
     * Rebuilds the undo state tracking from batch output prompts.
     * 
     * After a successful batch execution, we need to reconstruct the
     * statement -> uuid mapping from the prompts in the output.
     * 
     * @param rawOutput - The raw batch output containing prompts
     * @param statementCount - Number of statements in the batch
     */
    private rebuildUndoStateFromBatch(rawOutput: string, statementCount: number): void {
        const prompts = extractAllPrompts(rawOutput);
        
        // Filter out the startup prompt [0|check]> if present
        const responsePrompts = prompts.filter(p => p.promptInfo.uuid > 0);
        
        if (responsePrompts.length < statementCount) {
            this.log(
                `Warning: Not enough prompts to rebuild undo state. ` +
                `Expected ${statementCount}, got ${responsePrompts.length}. ` +
                `Undo-to-state will not be available for this session.`
            );
            // Don't invalidate - just don't update. The tracker was initialized at 0,
            // and we can't reliably map statements to uuids.
            return;
        }
        
        // Build the mapping: for each statement i, preStateUuid[i] = uuid before statement i
        // After the batch, we have prompts [1, 2, 3, ...] for statements [0, 1, 2, ...]
        // So preStateUuid[0] = 0, preStateUuid[1] = 1, etc.
        const promptInfos: PromptInfo[] = [];
        for (let i = 0; i < statementCount; i++) {
            promptInfos.push(responsePrompts[i].promptInfo);
        }
        
        // Use afterBatchProcessed to update the tracker
        const success = this.undoStateTracker.afterBatchProcessed(0, statementCount, promptInfos);
        if (!success) {
            this.log(`Failed to rebuild undo state from batch`);
        } else {
            this.log(`Successfully rebuilt undo state for ${statementCount} statements`);
        }
    }

    /**
     * Updates the undo state tracking from batch output prompts.
     * 
     * Unlike rebuildUndoStateFromBatch, this appends to the existing mapping
     * rather than replacing it (used for forward batch stepping).
     * 
     * @param rawOutput - The raw batch output containing prompts
     * @param startStatementIndex - The starting statement index
     * @param statementCount - Number of statements in the batch
     */
    private updateUndoStateFromBatch(rawOutput: string, startStatementIndex: number, statementCount: number): void {
        const prompts = extractAllPrompts(rawOutput);
        
        // Filter out the startup prompt [0|check]> if present
        const responsePrompts = prompts.filter(p => p.promptInfo.uuid > 0);
        
        if (responsePrompts.length < statementCount) {
            this.log(
                `Warning: Not enough prompts to update undo state. ` +
                `Expected ${statementCount}, got ${responsePrompts.length}.`
            );
            return;
        }
        
        // Build the mapping for this batch
        const promptInfos: PromptInfo[] = [];
        for (let i = 0; i < statementCount; i++) {
            promptInfos.push(responsePrompts[i].promptInfo);
        }
        
        // Use afterBatchProcessed to update the tracker
        const success = this.undoStateTracker.afterBatchProcessed(startStatementIndex, statementCount, promptInfos);
        if (!success) {
            this.log(`Failed to update undo state from batch`);
        } else {
            this.log(`Successfully updated undo state for ${statementCount} statements starting at index ${startStatementIndex}`);
        }
    }

    /**
     * Steps to the cursor position
     * 
     * Implements Smart Recovery: If stepping backward fails, automatically
     * falls back to full recovery (reset + fast-forward).
     * 
     * Uses StatementIndex for efficient cursor-to-statement mapping.
     * UI Suppression: For multi-statement operations, shows a "verifying" range
     * and updates the verified range only once at completion.
     * 
     * For backward navigation, first attempts fast undo-to-state if the
     * UndoStateTracker has a valid mapping.
     * 
     * @returns Result of the operation
     */
    public async goToCursor(): Promise<StepResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'easycrypt') {
            return { success: false, error: 'No active EasyCrypt file' };
        }
        
        if (this.stepping || this.retracting || this.recovering) {
            return { success: false, error: 'Step already in progress' };
        }
        
        this.setDocument(editor.document);
        const text = editor.document.getText();
        const cursorOffset = editor.document.offsetAt(editor.selection.active);
        
        // Update statement index
        this.statementIndex.update(text, editor.document.version);
        
        // Use StatementIndex to find target offset efficiently
        const targetOffset = this.statementIndex.getTargetEndOffset(cursorOffset);
        
        this.log(`Go to cursor: cursor=${cursorOffset}, current=${this.executionOffset}, target=${targetOffset}`);
        
        if (targetOffset <= this.executionOffset) {
            // Backward navigation
            if (targetOffset === this.executionOffset) {
                // Already at target
                return { success: true, executionOffset: this.executionOffset };
            }
            
            // Compute statement counts for undo-to-state
            const currentStatements = this.statementIndex.getStatementsUpTo(this.executionOffset);
            const targetStatements = this.statementIndex.getStatementsUpTo(targetOffset);
            const currentCount = currentStatements.length;
            const targetCount = targetStatements.length;
            
            // Try fast undo-to-state first
            if (this.undoStateTracker.isValid() && this.processManager.isRunning()) {
                this.log(`Backward goToCursor: trying fast undo-to-state (${currentCount} -> ${targetCount} statements)`);
                this.stepping = true;
                this._onDidStartStep.fire();
                
                try {
                    const undoResult = await this.tryUndoToState(targetCount, currentCount, editor);
                    if (undoResult.success) {
                        this.log(`Fast undo-to-state succeeded for goToCursor`);
                        this._onDidCompleteStep.fire(undoResult);
                        return undoResult;
                    }
                    this.log(`Fast undo-to-state failed: ${undoResult.error}. Falling back to restart+replay.`);
                } finally {
                    this.stepping = false;
                }
            } else {
                this.log(`Undo-to-state not available for goToCursor. Using restart+replay.`);
            }
            
            // Fallback: use recovery
            this.log(`Backward goToCursor uses recovery to offset ${targetOffset}`);
            return await this.recoverState(targetOffset, editor);
        } else {
            // Forward navigation - batch step with UI suppression
            return await this.batchStepForward(targetOffset, editor);
        }
    }

    /**
     * Batch step forward to a target offset with UI suppression.
     * 
     * Shows a "verifying" range during processing and updates the
     * verified range only once at completion.
     * Uses transactional proof-state updates to prevent flicker.
     * 
     * @param targetOffset - The target offset to step to
     * @param editor - The active text editor
     * @returns Result of the operation
     */
    private async batchStepForward(targetOffset: number, editor: vscode.TextEditor): Promise<StepResult> {
        const text = editor.document.getText();
        
        // Get statements from current position to target
        this.statementIndex.update(text, editor.document.version);
        const allStatements = this.statementIndex.getStatementsInRange(this.executionOffset, targetOffset);
        
        // Filter to only statements we haven't executed yet
        const statements = allStatements.filter(stmt => stmt.endOffset > this.executionOffset && stmt.endOffset <= targetOffset);
        
        if (statements.length === 0) {
            return { success: true, executionOffset: this.executionOffset };
        }
        
        // Single statement - use regular stepForward
        if (statements.length === 1) {
            return await this.stepForward();
        }
        
        // Get the starting statement index for undo tracking
        const currentStatements = this.statementIndex.getStatementsUpTo(this.executionOffset);
        const startStatementIndex = currentStatements.length;
        
        // Multi-statement batch - use transaction for UI suppression
        this.stepping = true;
        this._onDidStartStep.fire();
        
        // Begin transaction for batch operation
        const tx = this.proofStateManager.beginTransaction('batch-forward');
        
        // Show verifying range for the pending region
        const verifyingRange = new vscode.Range(
            editor.document.positionAt(this.executionOffset),
            editor.document.positionAt(targetOffset)
        );
        this.decorator.setVerifyingRange(editor, verifyingRange);
        
        this.log(`Batch stepping forward: ${statements.length} statements to offset ${targetOffset} (startIndex=${startStatementIndex})`);
        
        try {
            // Ensure process is running
            if (!this.processManager.isRunning()) {
                try {
                    await this.processManager.start();
                    // Initialize undo tracker when process starts
                    this.undoStateTracker.initialize(0);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.proofStateManager.failTransaction(tx, `Failed to start process: ${msg}`);
                    return { success: false, error: `Failed to start process: ${msg}` };
                }
            }
            
            // Try batched execution first
            const batchedText = statements.map(stmt => stmt.text).join('\n');
            const batchedOutput = await this.sendAndWait(batchedText, editor.document.uri, statements.length);
            
            if (batchedOutput.parsed.errors.length === 0) {
                // Success - update execution offset and decorations once
                this.executionOffset = statements[statements.length - 1].endOffset;
                this.updateDecorations();
                this._onDidChangePosition.fire(this.getExecutionPosition());
                
                // Update undo state tracking from the batch output
                this.updateUndoStateFromBatch(batchedOutput.raw ?? '', startStatementIndex, statements.length);

                // End transaction with final output and progress
                const progress = this.computeProgressSnapshot();
                this.proofStateManager.endTransaction(tx, batchedOutput, progress);
                
                this.log(`Batch step complete. Final offset: ${this.executionOffset}`);
                const result: StepResult = {
                    success: true,
                    output: batchedOutput.raw,
                    executionOffset: this.executionOffset
                };
                this._onDidCompleteStep.fire(result);
                return result;
            }
            
            this.log('Batched step produced an error; attempting sequential fallback.');
            
            // Sequential fallback - still with UI suppression (no intermediate decoration updates)
            // Track undo state for each statement
            let lastOutput: ProcessOutput | undefined;
            let failedStatement: Statement | undefined;
            let currentIndex = startStatementIndex;
            
            for (const statement of statements) {
                // Track undo state: capture pre-state
                this.undoStateTracker.beforeStatementSend(currentIndex);
                
                lastOutput = await this.sendAndWait(statement.text, editor.document.uri);
                
                if (lastOutput.parsed.errors.length > 0) {
                    failedStatement = statement;
                    break;
                }
                
                // Track undo state: record post-state
                const prompts = extractAllPrompts(lastOutput.raw ?? '');
                if (prompts.length > 0) {
                    const lastPrompt = prompts[prompts.length - 1];
                    this.undoStateTracker.afterStatementProcessed(currentIndex, lastPrompt.promptInfo);
                }
                
                this.executionOffset = statement.endOffset;
                currentIndex++;
            }
            
            // Update decorations once at the end
            this.updateDecorations();
            this._onDidChangePosition.fire(this.getExecutionPosition());

            // End transaction with final output and progress
            const progress = this.computeProgressSnapshot();
            if (lastOutput) {
                this.proofStateManager.endTransaction(tx, lastOutput, progress);
            } else {
                // Shouldn't happen, but handle gracefully
                this.proofStateManager.endTransaction(tx, { raw: '', parsed: { errors: [], success: true, proofCompleted: false, remainingOutput: '' } }, progress);
            }
            
            if (failedStatement) {
                const message = lastOutput?.parsed.errors[0]?.message ?? 'Unknown EasyCrypt error';
                this.log(`Batch step stopped at offset ${this.executionOffset}: ${message}`);
                const result: StepResult = {
                    success: false,
                    error: message,
                    statement: failedStatement,
                    output: lastOutput?.raw,
                    executionOffset: this.executionOffset
                };
                this._onDidCompleteStep.fire(result);
                return result;
            }
            
            this.log(`Batch step complete (sequential fallback). Final offset: ${this.executionOffset}`);
            const result: StepResult = {
                success: true,
                output: lastOutput?.raw,
                executionOffset: this.executionOffset
            };
            this._onDidCompleteStep.fire(result);
            return result;
            
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Batch step error: ${msg}`);
            this.proofStateManager.failTransaction(tx, msg);
            const result: StepResult = {
                success: false,
                error: msg,
                executionOffset: this.executionOffset
            };
            this._onDidCompleteStep.fire(result);
            return result;
            
        } finally {
            this.stepping = false;
            this.decorator.setVerifyingRange(editor, undefined);
        }
    }

    /**
     * Resets the execution state
     */
    public reset(): void {
        this.log('Resetting step state');
        this.executionOffset = 0;
        this.stepping = false;
        this.recovering = false;
        if (this.pendingCommand) {
            clearTimeout(this.pendingCommand.timeoutHandle);
        }
        this.pendingCommand = undefined;
        this.retracting = false;
        this.pendingRetractOffset = undefined;
        this.statementIndex.clear();
        // Reset undo state tracker for fast backward navigation
        this.undoStateTracker.reset();
        // Reset proof state with count=0 so the webview knows we have an active context
        this.proofStateManager.reset({ provedStatementCount: 0 });
        
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.decorator.clearAll(editor);
        }
        
        this._onDidChangePosition.fire(new vscode.Position(0, 0));
    }

    /**
     * Sends a command and waits for output
     */
    private async sendAndWait(command: string, fileUri?: vscode.Uri, expectedPromptCount: number = 1): Promise<ProcessOutput> {
        if (this.pendingCommand) {
            throw new Error('Another EasyCrypt command is already pending');
        }

        return new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                if (this.pendingCommand) {
                    const pending = this.pendingCommand;
                    this.pendingCommand = undefined;
                    if (pending.completionDebounceHandle) {
                        clearTimeout(pending.completionDebounceHandle);
                        pending.completionDebounceHandle = undefined;
                    }
                    pending.reject(new Error('Command timeout'));
                }
            }, 30000);

            // Create a fresh prompt counter for this command/batch
            const promptCounter = new EmacsPromptCounter();

            this.pendingCommand = {
                fileUri,
                chunks: [],
                expectedPromptCount: Math.max(1, expectedPromptCount),
                promptCounter,
                resolve,
                reject: (err) => reject(err),
                timeoutHandle,
            };

            this.log(`sendAndWait: sending command (expectedPrompts=${expectedPromptCount})`);

            this.processManager.sendCommand(command, { fileUri }).catch(err => {
                if (this.pendingCommand) {
                    const pending = this.pendingCommand;
                    this.pendingCommand = undefined;
                    clearTimeout(pending.timeoutHandle);
                    if (pending.completionDebounceHandle) {
                        clearTimeout(pending.completionDebounceHandle);
                        pending.completionDebounceHandle = undefined;
                    }
                }
                reject(err);
            });
        });
    }

    /**
     * Updates decorations based on current execution position
     */
    private updateDecorations(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.document) {
            return;
        }
        
        if (editor.document.uri.toString() !== this.document.uri.toString()) {
            return;
        }
        
        if (this.executionOffset > 0) {
            const range = new vscode.Range(
                new vscode.Position(0, 0),
                editor.document.positionAt(this.executionOffset)
            );
            this.decorator.setVerifiedRange(editor, range);
        } else {
            this.decorator.setVerifiedRange(editor, undefined);
        }
    }

    /**
     * Handles document changes for auto-retraction
     */
    private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        // Verbose logging for document changes
        try {
            const logger = Logger.getInstance();
            logger.event('onDidChangeTextDocument', {
                uri: event.document.uri.fsPath,
                changeCount: event.contentChanges.length,
                isTrackedDocument: this.document?.uri.toString() === event.document.uri.toString(),
                executionOffset: this.executionOffset,
                stepping: this.stepping,
                retracting: this.retracting
            });
        } catch {
            // Logger not initialized, skip verbose logging
        }

        if (!this.document || event.document.uri.toString() !== this.document.uri.toString()) {
            return;
        }
        
        if (this.stepping || this.retracting || this.executionOffset === 0) {
            return;
        }
        
        // Check if any change is within the verified region
        for (const change of event.contentChanges) {
            const changeOffset = event.document.offsetAt(change.range.start);
            
            if (changeOffset < this.executionOffset) {
                // Edit in verified region - trigger auto-retraction
                this.log(`Edit in verified region at offset ${changeOffset}, retracting...`);
                this.queueRetraction(changeOffset);
                return;
            }
        }
    }

    private queueRetraction(targetOffset: number): void {
        this.pendingRetractOffset =
            this.pendingRetractOffset === undefined
                ? targetOffset
                : Math.min(this.pendingRetractOffset, targetOffset);

        if (this.retracting) {
            return;
        }

        void this.runPendingRetraction().catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Auto-retraction failed: ${msg}`);
        });
    }

    private async runPendingRetraction(): Promise<void> {
        if (this.retracting) {
            return;
        }

        this.retracting = true;
        try {
            while (this.pendingRetractOffset !== undefined && this.pendingRetractOffset < this.executionOffset) {
                const target = this.pendingRetractOffset;
                this.pendingRetractOffset = undefined;
                await this.retractTo(target);
            }
        } finally {
            this.retracting = false;
        }
    }

    /**
     * Retracts to a specific offset
     */
    private async retractTo(targetOffset: number): Promise<void> {
        if (this.stepping) {
            return;
        }
        
        // Find the statement boundary before the target
        const text = this.document?.getText() || '';
        const prevEnd = findPreviousStatementEnd(text, targetOffset);
        const newOffset = prevEnd !== null ? prevEnd : 0;

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.toString() !== this.document?.uri.toString()) {
            // Best-effort fallback: adjust local state without REPL interaction.
            this.executionOffset = newOffset;
            this.updateDecorations();
            this._onDidChangePosition.fire(this.getExecutionPosition());
            return;
        }

        this.log(`Retracting via recovery to offset ${newOffset}`);
        await this.recoverState(newOffset, editor);
    }

    /**
     * Disposes of the step manager
     */
    public dispose(): void {
        this._onDidChangePosition.dispose();
        this._onDidStartStep.dispose();
        this._onDidCompleteStep.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
