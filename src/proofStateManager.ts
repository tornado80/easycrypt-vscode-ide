/**
 * EasyCrypt Proof State Manager
 * 
 * Maintains the current state of the proof and emits events when the state changes.
 * This is the central data store for proof goals, hypotheses, and messages.
 * 
 * Supports transactional proof-state publication for multi-statement operations
 * to prevent UI flicker and ensure only the final state is displayed.
 * 
 * @module proofStateManager
 */

import * as vscode from 'vscode';
import { ProcessOutput } from './processManager';
import { 
    ProofGoal, 
    ProofMessage,
    parseProofStateForView,
    extractLastStatementOutputWithPrompts
} from './proofStateParser';

export type { ProofGoal, ProofMessage };

// ============================================================================
// Progress and Debug Types
// ============================================================================

/**
 * Progress snapshot for the proof state view.
 * Contains the number of proved statements and the last proved statement text.
 */
export interface ProofProgressSnapshot {
    /** Number of statements in the proved/verified region */
    provedStatementCount: number;
    /** Full text of the last proved statement (as sent to EasyCrypt, including trailing '.') */
    lastProvedStatementText?: string;
}

// ============================================================================
// Transaction Types
// ============================================================================

/**
 * Reason for a proof-state update transaction
 */
export type ProofStateUpdateReason =
    | 'single-step'
    | 'go-to-cursor'
    | 'recovery'
    | 'batch-forward'
    | 'other';

/**
 * Represents an active proof-state update transaction.
 * Only the latest transaction may publish final proof state.
 */
export interface ProofStateTransaction {
    /** Unique transaction ID (monotonically increasing) */
    readonly id: number;
    /** Reason for this transaction */
    readonly reason: ProofStateUpdateReason;
}

/**
 * The complete state of the proof
 */
export interface ProofState {
    /** List of current goals */
    goals: ProofGoal[];
    /** List of messages from the last interaction */
    messages: ProofMessage[];
    /** Whether EasyCrypt is currently processing */
    isProcessing: boolean;
    /** Whether all goals have been completed */
    isComplete: boolean;
    /** The file URI this state relates to */
    fileUri?: vscode.Uri;
    /** Raw output from EasyCrypt (for fallback display) - deprecated, use outputLines */
    rawOutput?: string;
    /** All output lines not consumed by goal blocks (lossless, for view rendering) */
    outputLines?: string[];
    /** Progress snapshot (proved count, last statement text) */
    progress?: ProofProgressSnapshot;
    /** Debug-only emacs prompt marker associated with the last rendered output segment */
    debugEmacsPromptMarker?: string;
}

/**
 * Event fired when the proof state changes
 */
export interface ProofStateChangeEvent {
    /** The new proof state */
    state: ProofState;
    /** The previous state (if any) */
    previousState?: ProofState;
}

/**
 * Manages the proof state and emits change events.
 * 
 * Responsibilities:
 * - Maintain the current proof state
 * - Parse process output to extract goals/hypotheses
 * - Emit events when state changes
 * - Support transactional updates for multi-statement operations
 * 
 * @example
 * ```typescript
 * const stateManager = new ProofStateManager();
 * stateManager.onDidChangeState(event => {
 *     console.log('Goals:', event.state.goals.length);
 * });
 * processManager.onOutput(output => {
 *     stateManager.handleProcessOutput(output);
 * });
 * ```
 */
export class ProofStateManager implements vscode.Disposable {
    /** Current proof state */
    private _state: ProofState;

    /** Event emitter for state changes */
    private readonly _onDidChangeState = new vscode.EventEmitter<ProofStateChangeEvent>();

    /** Public event for state changes */
    public readonly onDidChangeState: vscode.Event<ProofStateChangeEvent> = this._onDidChangeState.event;

    /** Disposables */
    private readonly disposables: vscode.Disposable[] = [];

    /** Transaction counter for unique IDs */
    private transactionCounter = 0;

    /** Currently active transaction (if any) */
    private activeTransaction: ProofStateTransaction | undefined;

    /** ID of the last finalized (ended or failed) transaction, used for late-chunk safety */
    private lastFinalizedTransactionId = 0;

    /** 
     * Grace period (ms) after transaction completion during which late chunks 
     * should not trigger proof-state updates via handleProcessOutput.
     * This prevents bursty output from causing extra "final" updates.
     */
    private static readonly LATE_CHUNK_GRACE_PERIOD_MS = 200;

    /** Timestamp when the last transaction was finalized */
    private lastTransactionFinalizedAt = 0;

    /**
     * Creates a new ProofStateManager
     */
    constructor() {
        this._state = this.createInitialState();
    }

    /**
     * Creates the initial (empty) proof state
     */
    private createInitialState(): ProofState {
        return {
            goals: [],
            messages: [],
            isProcessing: false,
            isComplete: false,
            outputLines: []
        };
    }

    /**
     * Gets the current proof state
     */
    public get state(): ProofState {
        return this._state;
    }

    // ========================================================================
    // Transaction API
    // ========================================================================

    /**
     * Begins a new transaction for multi-statement operations.
     * 
     * During a transaction:
     * - isProcessing is set to true
     * - Intermediate updates are suppressed
     * - Only endTransaction() or failTransaction() will publish the final state
     * 
     * A newer transaction automatically invalidates any older active transaction.
     * 
     * @param reason - The reason for this transaction
     * @returns The transaction object (used to end/fail the transaction)
     */
    public beginTransaction(reason: ProofStateUpdateReason): ProofStateTransaction {
        this.transactionCounter++;
        const tx: ProofStateTransaction = {
            id: this.transactionCounter,
            reason
        };
        this.activeTransaction = tx;

        // Set processing state and emit one update
        const previousState = { ...this._state };
        this._state = { 
            ...this._state, 
            isProcessing: true,
            // Clear stale goals/messages during transaction
            goals: [],
            messages: [],
            outputLines: []
        };
        this._onDidChangeState.fire({ state: this._state, previousState });

        return tx;
    }

    /**
     * Ends a transaction successfully with the final output.
     * 
     * Only the latest transaction may publish; if tx is stale, this is a no-op.
     * 
     * @param tx - The transaction to end
     * @param finalOutput - The final process output (will be parsed for view)
     * @param progress - Optional progress snapshot (proved statement count, last statement)
     */
    public endTransaction(
        tx: ProofStateTransaction, 
        finalOutput: ProcessOutput,
        progress?: ProofProgressSnapshot
    ): void {
        if (!this.isTransactionValid(tx)) {
            return; // Stale transaction, ignore
        }

        this.activeTransaction = undefined;
        this.lastFinalizedTransactionId = tx.id;
        this.lastTransactionFinalizedAt = Date.now();

        // Extract last statement output with prompt metadata for debug display
        const extraction = extractLastStatementOutputWithPrompts(finalOutput.raw);
        const viewModel = parseProofStateForView(extraction.output);

        // Use nextPrompt (terminating prompt) as the debug marker.
        // Fall back to prevPrompt for robustness (e.g., edge cases where parser behavior differs).
        const debugEmacsPromptMarker = extraction.nextPrompt?.text ?? extraction.prevPrompt?.text;

        const previousState = { ...this._state };
        this._state = {
            // We intentionally don't expose structured goals here.
            // EasyCrypt -emacs output typically shows only the current goal.
            goals: [],
            messages: viewModel.messages,
            isProcessing: false,
            isComplete: viewModel.isComplete,
            fileUri: finalOutput.fileUri,
            rawOutput: finalOutput.raw,
            outputLines: viewModel.outputLines,
            progress,
            debugEmacsPromptMarker
        };
        this._onDidChangeState.fire({ state: this._state, previousState });
    }

    /**
     * Fails a transaction with an error message.
     * 
     * Only the latest transaction may publish; if tx is stale, this is a no-op.
     * 
     * @param tx - The transaction to fail
     * @param errorMessage - The error message to display
     */
    public failTransaction(tx: ProofStateTransaction, errorMessage: string): void {
        if (!this.isTransactionValid(tx)) {
            return; // Stale transaction, ignore
        }

        this.activeTransaction = undefined;
        this.lastFinalizedTransactionId = tx.id;
        this.lastTransactionFinalizedAt = Date.now();

        const previousState = { ...this._state };
        this._state = {
            ...this._state,
            isProcessing: false,
            messages: [
                { severity: 'error', content: errorMessage, timestamp: new Date() }
            ]
        };
        this._onDidChangeState.fire({ state: this._state, previousState });
    }

    /**
     * Checks if a transaction is still valid (i.e., is the active transaction).
     */
    public isTransactionValid(tx: ProofStateTransaction): boolean {
        return this.activeTransaction !== undefined && this.activeTransaction.id === tx.id;
    }

    /**
     * Gets the currently active transaction, if any.
     */
    public getActiveTransaction(): ProofStateTransaction | undefined {
        return this.activeTransaction;
    }

    /**
     * Checks if we are within the grace period after a transaction finalized.
     * During this period, streaming output should not trigger proof-state updates
     * to prevent late chunks from causing extra "final" updates.
     */
    public isWithinGracePeriod(): boolean {
        if (this.lastTransactionFinalizedAt === 0) {
            return false;
        }
        const elapsed = Date.now() - this.lastTransactionFinalizedAt;
        return elapsed < ProofStateManager.LATE_CHUNK_GRACE_PERIOD_MS;
    }

    /**
     * Gets the ID of the last finalized transaction.
     * Useful for debugging and testing.
     */
    public getLastFinalizedTransactionId(): number {
        return this.lastFinalizedTransactionId;
    }

    // ========================================================================
    // Legacy API (for single-step operations)
    // ========================================================================

    /**
     * Sets the processing state
     */
    public setProcessing(isProcessing: boolean): void {
        if (this._state.isProcessing !== isProcessing) {
            const previousState = { ...this._state };
            this._state = { ...this._state, isProcessing };
            this._onDidChangeState.fire({ state: this._state, previousState });
        }
    }

    /**
     * Handles output from the ProcessManager
     * Parses the output to extract goals and messages.
     * 
     * For single-step operations, use this method directly.
     * For multi-statement operations, prefer using beginTransaction/endTransaction.
     * 
     * @param output - The process output to handle
     * @param progress - Optional progress snapshot
     */
    public handleProcessOutput(output: ProcessOutput, progress?: ProofProgressSnapshot): void {
        const previousState = { ...this._state };

        const currentFileUriStr = this._state.fileUri?.toString();
        const outputFileUriStr = output.fileUri?.toString();
        const isSameFile =
            currentFileUriStr !== undefined &&
            outputFileUriStr !== undefined &&
            currentFileUriStr === outputFileUriStr;

        // Some outputs (e.g., initial prompt after restart) are not associated with a specific
        // statement/progress snapshot. In that case, preserve the existing progress context
        // (but avoid carrying progress across different files).
        const nextProgress =
            progress !== undefined
                ? progress
                : (output.fileUri === undefined || isSameFile)
                    ? this._state.progress
                    : undefined;

        const nextFileUri = output.fileUri ?? this._state.fileUri;
        
        // Extract last statement output with prompt metadata
        const extraction = extractLastStatementOutputWithPrompts(output.raw);
        const viewModel = parseProofStateForView(extraction.output);

        // Use nextPrompt (terminating prompt) as the debug marker.
        // Fall back to prevPrompt for robustness (e.g., edge cases where parser behavior differs).
        const debugEmacsPromptMarker = extraction.nextPrompt?.text ?? extraction.prevPrompt?.text;

        this._state = {
            goals: [],
            messages: viewModel.messages,
            isProcessing: false,
            isComplete: viewModel.isComplete,
            fileUri: nextFileUri,
            rawOutput: output.raw,
            outputLines: viewModel.outputLines,
            progress: nextProgress,
            debugEmacsPromptMarker
        };

        this._onDidChangeState.fire({ state: this._state, previousState });
    }

    /**
     * Resets the proof state to initial
     * 
     * @param initialProgress - Optional initial progress (e.g. count=0) to enable navigation context
     */
    public reset(initialProgress?: ProofProgressSnapshot): void {
        this.activeTransaction = undefined;
        const previousState = { ...this._state };
        this._state = {
            ...this.createInitialState(),
            // Preserve file association across reset so prompt-only output emitted with
            // ProcessManager.currentFileUri doesn't get treated as "different file".
            fileUri: previousState.fileUri,
            progress: initialProgress
        };
        this._onDidChangeState.fire({ state: this._state, previousState });
    }

    /**
     * Resets the proof state but keeps the processing throbber on.
     *
     * This is used for long-running operations (e.g., recovery / batch stepping)
     * to avoid UI flicker while still clearing stale goals/messages.
     * 
     * @deprecated Use beginTransaction() for multi-statement operations instead
     */
    public resetForProcessing(): void {
        const previousState = { ...this._state };
        this._state = {
            goals: [],
            messages: [],
            isProcessing: true,
            isComplete: false,
            fileUri: this._state.fileUri,
            rawOutput: this._state.rawOutput,
            outputLines: [],
            progress: this._state.progress
        };
        this._onDidChangeState.fire({ state: this._state, previousState });
    }

    /**
     * Adds a message to the current state
     */
    public addMessage(severity: 'info' | 'warning' | 'error', content: string): void {
        const previousState = { ...this._state };
        this._state = {
            ...this._state,
            messages: [
                ...this._state.messages,
                { severity, content, timestamp: new Date() }
            ]
        };
        this._onDidChangeState.fire({ state: this._state, previousState });
    }

    /**
     * Clears all messages
     */
    public clearMessages(): void {
        if (this._state.messages.length > 0) {
            const previousState = { ...this._state };
            this._state = { ...this._state, messages: [] };
            this._onDidChangeState.fire({ state: this._state, previousState });
        }
    }

    /**
     * Updates the state with new goals directly (for testing or manual updates)
     */
    public setGoals(goals: ProofGoal[]): void {
        const previousState = { ...this._state };
        this._state = {
            ...this._state,
            goals,
            isComplete: goals.length === 0
        };
        this._onDidChangeState.fire({ state: this._state, previousState });
    }

    /**
     * Disposes of the manager
     */
    public dispose(): void {
        this._onDidChangeState.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
