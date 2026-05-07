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
import { ConfigurationManager } from './configurationManager';
import { findNextStatement, findPreviousStatementEnd, Statement } from './statementParser';
import { StatementIndex } from './statementIndex';
import { parseOutput } from './outputParser';
import { EmacsPromptCounter } from './emacsPromptCounter';
import { Logger } from './logger';
import { UndoStateTracker, extractAllPrompts } from './undoStateTracker';
import {
    SessionContextFingerprint,
    fingerprintVerificationContext,
    resolveVerificationContext
} from './verificationContextResolver';

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

export interface ReplayPlan {
    startOffset: number;
    targetOffset: number;
    origin: 'goToCursor-forward' | 'recovery';
    suppressIntermediateUi: boolean;
}

export interface ReplayOutcome {
    success: boolean;
    executionOffset: number;
    processedStatementCount: number;
    failedStatement?: Statement;
    output?: ProcessOutput;
    error?: string;
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
 * Decoration sink used by StepManager.
 *
 * This keeps step/navigation logic independent of how decoration state is
 * projected across editors (single-file vs per-file session projection).
 */
export interface StepDecorationSink {
    setVerifiedRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void;
    setProcessingRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void;
    setVerifyingRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void;
    clearAll(editor: vscode.TextEditor): void;
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
        private readonly decorator: StepDecorationSink,
        private readonly configManager: ConfigurationManager,
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
    public async forceRecovery(token?: vscode.CancellationToken): Promise<StepResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'easycrypt') {
            return { success: false, error: 'No active EasyCrypt file' };
        }

        this.throwIfCancelled(token, 'forceRecovery');

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

        try {
            await this.ensureSessionContextForDocument(editor.document);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, error: `Failed to bind session context: ${msg}` };
        }

        return await this.recoverState(currentOffset, editor, token);
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

    private getWorkspaceFolderPath(document: vscode.TextDocument): string | undefined {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (workspaceFolder) {
            return workspaceFolder.uri.fsPath;
        }

        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private buildSessionContextForDocument(document: vscode.TextDocument): SessionContextFingerprint {
        const context = resolveVerificationContext({
            documentPath: document.uri.fsPath,
            workspaceFolderPath: this.getWorkspaceFolderPath(document),
            configArgs: this.configManager.getArguments(),
            proverArgs: this.configManager.getProverArgs()
        });

        return fingerprintVerificationContext(context);
    }

    private async ensureSessionContextForDocument(document: vscode.TextDocument): Promise<void> {
        const sessionContext = this.buildSessionContextForDocument(document);
        this.log(
            `Ensuring session context: cwd=${sessionContext.workingDirectory}, ` +
            `includeRoots=${sessionContext.includeRoots.join(', ') || '<none>'}`
        );
        const startsBefore = this.processManager.getProcessStartCount();
        await this.processManager.ensureSessionContext(sessionContext);
        const startsAfter = this.processManager.getProcessStartCount();
        if (startsAfter > startsBefore) {
            this.undoStateTracker.initialize(0);
        }
    }

    private throwIfCancelled(token: vscode.CancellationToken | undefined, operation: string): void {
        if (token?.isCancellationRequested) {
            throw new Error(`Command cancelled: ${operation}`);
        }
    }

    private isCancellationError(err: unknown): boolean {
        if (!(err instanceof Error)) {
            return false;
        }

        return err.message.startsWith('Command cancelled');
    }

    private createEmptyOutput(fileUri?: vscode.Uri): ProcessOutput {
        return {
            raw: '',
            parsed: {
                errors: [],
                success: true,
                proofCompleted: false,
                remainingOutput: ''
            },
            fileUri
        };
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

        try {
            await this.ensureSessionContextForDocument(editor.document);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, error: `Failed to bind session context: ${msg}` };
        }

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
    public async stepBackward(internal: boolean = false, token?: vscode.CancellationToken): Promise<StepResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'easycrypt') {
            return { success: false, error: 'No active EasyCrypt file' };
        }

        this.throwIfCancelled(token, 'stepBackward');
        
        if (this.stepping || (!internal && this.retracting)) {
            return { success: false, error: 'Step already in progress' };
        }

        this.setDocument(editor.document);

        try {
            await this.ensureSessionContextForDocument(editor.document);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, error: `Failed to bind session context: ${msg}` };
        }
        
        if (this.executionOffset === 0) {
            return { success: false, error: 'Already at start' };
        }

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
                    this.throwIfCancelled(token, 'stepBackward');
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
            const recoveryResult = await this.recoverState(newOffset, editor, token);
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
     * Recovers the proof state by resetting and replaying statements with
     * statement-level backpressure.
     */
    private async recoverState(
        targetOffset: number,
        editor: vscode.TextEditor,
        token?: vscode.CancellationToken
    ): Promise<StepResult> {
        if (this.recovering) {
            return { success: false, error: 'Recovery already in progress' };
        }

        this.throwIfCancelled(token, 'recovery');

        this.recovering = true;
        this.log(`Starting recovery to offset ${targetOffset}...`);

        const tx = this.proofStateManager.beginTransaction('recovery');
        const statusMessage = vscode.window.setStatusBarMessage('$(sync~spin) Recovering proof state...');

        const verifyingRange = new vscode.Range(
            new vscode.Position(0, 0),
            editor.document.positionAt(targetOffset)
        );
        this.decorator.setVerifyingRange(editor, verifyingRange);

        try {
            await this.restartProcessForRecovery(editor.document);
            this.executionOffset = 0;

            const outcome = await this.replayToOffsetSerial(
                {
                    startOffset: 0,
                    targetOffset,
                    origin: 'recovery',
                    suppressIntermediateUi: true
                },
                editor,
                token
            );

            this.throwIfCancelled(token, 'recovery-finalize');

            this.updateDecorations();
            this._onDidChangePosition.fire(this.getExecutionPosition());

            const progress = this.computeProgressSnapshot();
            this.proofStateManager.endTransaction(
                tx,
                outcome.output ?? this.createEmptyOutput(editor.document.uri),
                progress
            );

            if (!outcome.success) {
                const message = outcome.error ?? 'Unknown EasyCrypt error';
                this.log(`Recovery stopped at offset ${this.executionOffset}: ${message}`);
                return {
                    success: false,
                    error: `Recovery stopped: ${message}`,
                    statement: outcome.failedStatement,
                    output: outcome.output?.raw,
                    executionOffset: this.executionOffset
                };
            }

            this.log(
                `Recovery complete (serial). Replayed ${outcome.processedStatementCount} statements. ` +
                `Final offset: ${this.executionOffset}`
            );
            return {
                success: true,
                executionOffset: this.executionOffset,
                output: outcome.output?.raw
            };
        } catch (err) {
            if (this.isCancellationError(err)) {
                this.log('Recovery cancelled');
                this.proofStateManager.failTransaction(tx, 'Command cancelled');
                throw err;
            }

            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Recovery failed: ${msg}`);
            this.proofStateManager.failTransaction(tx, `Recovery failed: ${msg}`);
            return {
                success: false,
                error: `Recovery failed: ${msg}`,
                executionOffset: this.executionOffset
            };
        } finally {
            this.recovering = false;
            this.decorator.setVerifyingRange(editor, undefined);
            statusMessage.dispose();
        }
    }

    private async restartProcessForRecovery(document: vscode.TextDocument): Promise<void> {
        const sessionContext = this.buildSessionContextForDocument(document);
        await this.processManager.stopAndWait(4000);
        await this.processManager.start(sessionContext);
        // Reset undo state tracker after process restart
        this.undoStateTracker.initialize(0);
    }

    /**
     * Steps to the cursor position.
     */
    public async goToCursor(token?: vscode.CancellationToken): Promise<StepResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'easycrypt') {
            return { success: false, error: 'No active EasyCrypt file' };
        }

        this.throwIfCancelled(token, 'goToCursor');
        
        if (this.stepping || this.retracting || this.recovering) {
            return { success: false, error: 'Step already in progress' };
        }
        
        this.setDocument(editor.document);

        try {
            await this.ensureSessionContextForDocument(editor.document);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, error: `Failed to bind session context: ${msg}` };
        }

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
                        this.throwIfCancelled(token, 'goToCursor');
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
            return await this.recoverState(targetOffset, editor, token);
        } else {
            return await this.batchStepForward(targetOffset, editor, token);
        }
    }

    /**
     * Forward replay to a target offset with statement-level backpressure.
     */
    private async batchStepForward(
        targetOffset: number,
        editor: vscode.TextEditor,
        token?: vscode.CancellationToken
    ): Promise<StepResult> {
        this.throwIfCancelled(token, 'goToCursor-forward');

        const text = editor.document.getText();
        
        this.statementIndex.update(text, editor.document.version);
        const allStatements = this.statementIndex.getStatementsInRange(this.executionOffset, targetOffset);
        const statements = allStatements.filter(stmt => stmt.endOffset > this.executionOffset && stmt.endOffset <= targetOffset);
        
        if (statements.length === 0) {
            return { success: true, executionOffset: this.executionOffset };
        }
        
        // Single statement - use regular stepForward
        if (statements.length === 1) {
            return await this.stepForward();
        }
        
        this.stepping = true;
        this._onDidStartStep.fire();

        const tx = this.proofStateManager.beginTransaction('go-to-cursor');
        const verifyingRange = new vscode.Range(
            editor.document.positionAt(this.executionOffset),
            editor.document.positionAt(targetOffset)
        );
        this.decorator.setVerifyingRange(editor, verifyingRange);

        this.log(`Forward replay (serial): ${statements.length} statements to offset ${targetOffset}`);
        
        try {
            const outcome = await this.replayToOffsetSerial(
                {
                    startOffset: this.executionOffset,
                    targetOffset,
                    origin: 'goToCursor-forward',
                    suppressIntermediateUi: true
                },
                editor,
                token
            );

            this.throwIfCancelled(token, 'goToCursor-forward-finalize');

            this.updateDecorations();
            this._onDidChangePosition.fire(this.getExecutionPosition());

            const progress = this.computeProgressSnapshot();
            this.proofStateManager.endTransaction(
                tx,
                outcome.output ?? this.createEmptyOutput(editor.document.uri),
                progress
            );

            if (!outcome.success) {
                const message = outcome.error ?? 'Unknown EasyCrypt error';
                this.log(`Forward replay stopped at offset ${this.executionOffset}: ${message}`);
                const result: StepResult = {
                    success: false,
                    error: message,
                    statement: outcome.failedStatement,
                    output: outcome.output?.raw,
                    executionOffset: this.executionOffset
                };
                this._onDidCompleteStep.fire(result);
                return result;
            }

            this.log(
                `Forward replay complete. Replayed ${outcome.processedStatementCount} statements. ` +
                `Final offset: ${this.executionOffset}`
            );
            const result: StepResult = {
                success: true,
                output: outcome.output?.raw,
                executionOffset: this.executionOffset
            };
            this._onDidCompleteStep.fire(result);
            return result;
            
        } catch (err) {
            if (this.isCancellationError(err)) {
                this.log('Forward goToCursor replay cancelled');
                this.proofStateManager.failTransaction(tx, 'Command cancelled');
                throw err;
            }

            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Forward replay error: ${msg}`);
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

    private async replayToOffsetSerial(
        plan: ReplayPlan,
        editor: vscode.TextEditor,
        token?: vscode.CancellationToken
    ): Promise<ReplayOutcome> {
        const text = editor.document.getText();
        this.statementIndex.update(text, editor.document.version);

        const allStatements = this.statementIndex.getStatementsInRange(plan.startOffset, plan.targetOffset);
        const statements = allStatements.filter(
            (stmt) => stmt.endOffset > plan.startOffset && stmt.endOffset <= plan.targetOffset
        );

        if (statements.length === 0) {
            return {
                success: true,
                executionOffset: this.executionOffset,
                processedStatementCount: 0,
                output: this.createEmptyOutput(editor.document.uri)
            };
        }

        const startStatementIndex = this.statementIndex.getStatementsUpTo(plan.startOffset).length;
        let currentStatementIndex = startStatementIndex;
        let lastOutput: ProcessOutput | undefined;

        this.log(
            `Serial replay start: origin=${plan.origin}, statements=${statements.length}, ` +
            `startOffset=${plan.startOffset}, targetOffset=${plan.targetOffset}`
        );

        for (const statement of statements) {
            this.throwIfCancelled(token, `${plan.origin}:before-send`);

            this.undoStateTracker.beforeStatementSend(currentStatementIndex);
            lastOutput = await this.sendAndWait(statement.text, editor.document.uri, 1, token);

            if (lastOutput.parsed.errors.length > 0) {
                const message = lastOutput.parsed.errors[0]?.message ?? 'Unknown EasyCrypt error';
                this.log(`Serial replay stopped at statementIndex=${currentStatementIndex}: ${message}`);
                return {
                    success: false,
                    executionOffset: this.executionOffset,
                    processedStatementCount: (currentStatementIndex - startStatementIndex) + 1,
                    failedStatement: statement,
                    output: lastOutput,
                    error: message
                };
            }

            const prompts = extractAllPrompts(lastOutput.raw ?? '');
            if (prompts.length > 0) {
                const lastPrompt = prompts[prompts.length - 1];
                this.undoStateTracker.afterStatementProcessed(currentStatementIndex, lastPrompt.promptInfo);
            } else {
                this.log('Warning: No prompt found in replay output, undo tracking may be incomplete');
            }

            this.executionOffset = statement.endOffset;
            currentStatementIndex++;

            this.throwIfCancelled(token, `${plan.origin}:after-send`);
        }

        return {
            success: true,
            executionOffset: this.executionOffset,
            processedStatementCount: statements.length,
            output: lastOutput ?? this.createEmptyOutput(editor.document.uri)
        };
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
    private async sendAndWait(
        command: string,
        fileUri?: vscode.Uri,
        expectedPromptCount: number = 1,
        token?: vscode.CancellationToken
    ): Promise<ProcessOutput> {
        this.throwIfCancelled(token, 'sendAndWait');

        if (this.pendingCommand) {
            throw new Error('Another EasyCrypt command is already pending');
        }

        return new Promise((resolve, reject) => {
            if (token?.isCancellationRequested) {
                reject(new Error('Command cancelled: sendAndWait'));
                return;
            }

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
