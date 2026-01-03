/**
 * EasyCrypt Undo State Tracker - Pure Logic
 * 
 * This module contains pure TypeScript logic for tracking EasyCrypt
 * state numbers, with no VS Code dependencies. It can be used in unit tests.
 * 
 * @module undoStateTrackerCore
 */

/**
 * Prompt information extracted from EasyCrypt `-emacs` mode output.
 * 
 * EasyCrypt's `-emacs` mode prints prompts like: `[<uuid>|<mode>]>`
 * - uuid: EcCommands.uuid() — the current context stack level
 * - mode: EcCommands.mode() — e.g., "check", "weakcheck", "report"
 */
export interface PromptInfo {
    /** EasyCrypt's internal state id (context stack level) */
    readonly uuid: number;
    /** Mode tag from the prompt (e.g., "check", "weakcheck") */
    readonly mode: string;
}

/**
 * Snapshot of the undo state mapping.
 */
export interface UndoStateSnapshot {
    /** Current EasyCrypt uuid (from the most recent prompt) */
    readonly currentUuid: number;
    /**
     * For each processed statement i, the uuid to undo to in order to retract it.
     * preStateUuidByStatementIndex[i] = uuid_before_statement_i_was_executed
     */
    readonly preStateUuidByStatementIndex: ReadonlyArray<number>;
    /** Whether the tracker is in a valid state for this session */
    readonly isValid: boolean;
    /** Reason if the tracker became invalid */
    readonly invalidReason?: string;
}

/**
 * Result of parsing an EasyCrypt emacs prompt.
 */
export interface PromptParseResult {
    /** Whether the parse succeeded */
    success: boolean;
    /** Parsed prompt info (if successful) */
    promptInfo?: PromptInfo;
    /** Error message if parsing failed */
    error?: string;
}

/**
 * Regex pattern for EasyCrypt `-emacs` prompts.
 * Matches: [<uuid>|<mode>]>
 * Groups: 1 = uuid (number), 2 = mode (string)
 * 
 * Source citation (EasyCrypt, commit 4fc8b636e76ee1689c97089282809532cc4d3c5c):
 * - src/ecTerminal.ml: prints `[%d|%s]>` using `EcCommands.uuid()` / `EcCommands.mode()`
 */
export const EMACS_PROMPT_REGEX = /\[(\d+)\|([^\]]+)\]>/g;

/**
 * Parses a single EasyCrypt emacs prompt marker.
 * 
 * @param text - Text that may contain a prompt marker
 * @returns Parse result with prompt info or error
 */
export function parseEmacsPrompt(text: string): PromptParseResult {
    const regex = new RegExp(EMACS_PROMPT_REGEX.source);
    const match = text.match(regex);
    
    if (!match) {
        return { success: false, error: 'No prompt marker found' };
    }
    
    const uuid = parseInt(match[1], 10);
    const mode = match[2];
    
    if (isNaN(uuid)) {
        return { success: false, error: `Invalid uuid: ${match[1]}` };
    }
    
    return {
        success: true,
        promptInfo: { uuid, mode }
    };
}

/**
 * Extracts all prompt markers from a text with their positions.
 * 
 * @param text - Raw output text from EasyCrypt
 * @returns Array of prompt info with their positions
 */
export function extractAllPrompts(text: string): Array<{ promptInfo: PromptInfo; index: number; length: number }> {
    const results: Array<{ promptInfo: PromptInfo; index: number; length: number }> = [];
    const regex = new RegExp(EMACS_PROMPT_REGEX.source, 'g');
    let match: RegExpExecArray | null;
    
    while ((match = regex.exec(text)) !== null) {
        const uuid = parseInt(match[1], 10);
        const mode = match[2];
        
        if (!isNaN(uuid)) {
            results.push({
                promptInfo: { uuid, mode },
                index: match.index,
                length: match[0].length
            });
        }
    }
    
    return results;
}

/**
 * Logger interface for the tracker (can be no-op for tests)
 */
export interface TrackerLogger {
    log(message: string): void;
    logImportant(message: string): void;
}

/**
 * Undo state tracking result types
 */
export interface InvalidationEvent {
    reason: string;
}

export interface MappingUpdateEvent {
    snapshot: UndoStateSnapshot;
}

/**
 * Pure undo state tracker logic.
 * 
 * Usage:
 * 1. Call beforeStatementSend() before sending a statement
 * 2. Call afterStatementProcessed() with the new prompt uuid after success
 * 3. Use getUndoTarget() to get the uuid for retracting a statement
 * 
 * The tracker validates invariants and automatically invalidates itself
 * if inconsistencies are detected (e.g., non-monotonic uuid).
 */
export class UndoStateTrackerCore {
    /** Current EasyCrypt uuid (from the most recent prompt) */
    private currentUuid: number = 0;
    
    /** 
     * For each processed statement i, the uuid to undo to in order to retract it.
     * preStateUuidByStatementIndex[i] = uuid_before_statement_i_was_executed
     */
    private preStateUuidByStatementIndex: number[] = [];
    
    /** Whether the tracker is valid for this session */
    private valid: boolean = true;
    
    /** Reason if the tracker became invalid */
    private invalidReason: string | undefined;
    
    /** Pending pre-state uuid for the next statement being processed */
    private pendingPreStateUuid: number | undefined;
    
    /** Logger (can be no-op) */
    private logger: TrackerLogger;
    
    /** Callbacks for events */
    private onInvalidated: ((event: InvalidationEvent) => void) | undefined;
    private onMappingUpdated: ((event: MappingUpdateEvent) => void) | undefined;
    private onReset: (() => void) | undefined;
    
    /**
     * Creates a new UndoStateTrackerCore.
     * 
     * @param logger - Logger for debug output (can be no-op)
     */
    constructor(logger?: TrackerLogger) {
        this.logger = logger ?? { log: () => {}, logImportant: () => {} };
    }
    
    /**
     * Sets event callbacks.
     */
    public setCallbacks(callbacks: {
        onInvalidated?: (event: InvalidationEvent) => void;
        onMappingUpdated?: (event: MappingUpdateEvent) => void;
        onReset?: () => void;
    }): void {
        this.onInvalidated = callbacks.onInvalidated;
        this.onMappingUpdated = callbacks.onMappingUpdated;
        this.onReset = callbacks.onReset;
    }
    
    /**
     * Gets the current snapshot of the undo state.
     */
    public getSnapshot(): UndoStateSnapshot {
        return {
            currentUuid: this.currentUuid,
            preStateUuidByStatementIndex: [...this.preStateUuidByStatementIndex],
            isValid: this.valid,
            invalidReason: this.invalidReason
        };
    }
    
    /**
     * Checks if the tracker is valid for this session.
     */
    public isValid(): boolean {
        return this.valid;
    }
    
    /**
     * Gets the number of tracked statements.
     */
    public getTrackedStatementCount(): number {
        return this.preStateUuidByStatementIndex.length;
    }
    
    /**
     * Gets the current uuid.
     */
    public getCurrentUuid(): number {
        return this.currentUuid;
    }
    
    /**
     * Initializes the tracker with a startup uuid (typically 0).
     * Call this when the EasyCrypt process starts and emits its first prompt.
     * 
     * @param startupUuid - The uuid from the startup prompt (usually 0)
     */
    public initialize(startupUuid: number): void {
        this.logger.log(`Initializing with startup uuid=${startupUuid}`);
        this.currentUuid = startupUuid;
        this.preStateUuidByStatementIndex = [];
        this.pendingPreStateUuid = undefined;
        this.valid = true;
        this.invalidReason = undefined;
        this.onReset?.();
    }
    
    /**
     * Resets the tracker. Call this on process restart/recovery.
     */
    public reset(): void {
        this.logger.log('Resetting tracker');
        this.currentUuid = 0;
        this.preStateUuidByStatementIndex = [];
        this.pendingPreStateUuid = undefined;
        this.valid = true;
        this.invalidReason = undefined;
        this.onReset?.();
    }
    
    /**
     * Invalidates the tracker with a reason.
     * After invalidation, the tracker will always return fallback behavior.
     * 
     * @param reason - Why the tracker became invalid
     */
    private invalidate(reason: string): void {
        if (!this.valid) {
            return; // Already invalid
        }
        
        this.logger.logImportant(`INVALIDATED: ${reason}`);
        this.valid = false;
        this.invalidReason = reason;
        this.onInvalidated?.({ reason });
    }
    
    /**
     * Called before sending a statement to EasyCrypt.
     * Captures the current uuid as the pre-state for this statement.
     * 
     * @param statementIndex - The 0-based index of the statement being sent
     */
    public beforeStatementSend(statementIndex: number): void {
        if (!this.valid) {
            return;
        }
        
        // Validate that we're processing statements in order
        const expectedIndex = this.preStateUuidByStatementIndex.length;
        if (statementIndex !== expectedIndex) {
            this.invalidate(
                `Statement index mismatch: expected ${expectedIndex}, got ${statementIndex}. ` +
                `This may indicate out-of-order processing.`
            );
            return;
        }
        
        // Capture the pre-state uuid
        this.pendingPreStateUuid = this.currentUuid;
        this.logger.log(`beforeStatementSend: index=${statementIndex}, preStateUuid=${this.pendingPreStateUuid}`);
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
        if (!this.valid) {
            return false;
        }
        
        const expectedIndex = this.preStateUuidByStatementIndex.length;
        if (statementIndex !== expectedIndex) {
            this.invalidate(
                `Statement index mismatch in afterStatementProcessed: ` +
                `expected ${expectedIndex}, got ${statementIndex}`
            );
            return false;
        }
        
        if (this.pendingPreStateUuid === undefined) {
            this.invalidate(
                `No pending pre-state uuid for statement ${statementIndex}. ` +
                `beforeStatementSend() may not have been called.`
            );
            return false;
        }
        
        const preStateUuid = this.pendingPreStateUuid;
        const newUuid = newPromptInfo.uuid;
        
        // Validate monotonic increment (uuid should increase by exactly 1 per statement)
        // Note: Some EasyCrypt operations may increment by more than 1 (e.g., require blocks),
        // but for now we enforce strict +1 invariant. We can relax this if needed.
        const expectedNewUuid = preStateUuid + 1;
        if (newUuid !== expectedNewUuid) {
            // Allow non-strict mode: uuid should at least increase
            if (newUuid <= preStateUuid) {
                this.invalidate(
                    `Non-monotonic uuid: expected >${preStateUuid}, got ${newUuid}. ` +
                    `This may indicate undo stack issues or process desync.`
                );
                return false;
            }
            // Warn but continue if uuid skipped (e.g., multi-push commands)
            this.logger.log(
                `Warning: uuid skipped from ${preStateUuid} to ${newUuid} ` +
                `(expected ${expectedNewUuid}). Continuing with relaxed invariant.`
            );
        }
        
        // Record the mapping
        this.preStateUuidByStatementIndex.push(preStateUuid);
        this.currentUuid = newUuid;
        this.pendingPreStateUuid = undefined;
        
        this.logger.log(
            `afterStatementProcessed: index=${statementIndex}, ` +
            `preStateUuid=${preStateUuid}, newUuid=${newUuid}, ` +
            `mappingSize=${this.preStateUuidByStatementIndex.length}`
        );
        
        this.onMappingUpdated?.({ snapshot: this.getSnapshot() });
        return true;
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
        if (!this.valid) {
            return false;
        }
        
        if (promptInfos.length !== statementCount) {
            this.invalidate(
                `Prompt count mismatch in batch: expected ${statementCount}, got ${promptInfos.length}`
            );
            return false;
        }
        
        const expectedIndex = this.preStateUuidByStatementIndex.length;
        if (startStatementIndex !== expectedIndex) {
            this.invalidate(
                `Batch start index mismatch: expected ${expectedIndex}, got ${startStatementIndex}`
            );
            return false;
        }
        
        // Process each statement in the batch
        let prevUuid = this.currentUuid;
        for (let i = 0; i < statementCount; i++) {
            const promptInfo = promptInfos[i];
            const newUuid = promptInfo.uuid;
            
            // Validate monotonic increase
            if (newUuid <= prevUuid) {
                this.invalidate(
                    `Non-monotonic uuid in batch at position ${i}: ` +
                    `expected >${prevUuid}, got ${newUuid}`
                );
                return false;
            }
            
            this.preStateUuidByStatementIndex.push(prevUuid);
            prevUuid = newUuid;
        }
        
        this.currentUuid = prevUuid;
        
        this.logger.log(
            `afterBatchProcessed: startIndex=${startStatementIndex}, count=${statementCount}, ` +
            `finalUuid=${this.currentUuid}, mappingSize=${this.preStateUuidByStatementIndex.length}`
        );
        
        this.onMappingUpdated?.({ snapshot: this.getSnapshot() });
        return true;
    }
    
    /**
     * Gets the target uuid to undo to in order to retract a statement.
     * 
     * @param statementIndex - The 0-based index of the statement to retract
     * @returns The target uuid, or undefined if not available
     */
    public getUndoTarget(statementIndex: number): number | undefined {
        if (!this.valid) {
            this.logger.log(`getUndoTarget: tracker is invalid, returning undefined`);
            return undefined;
        }
        
        if (statementIndex < 0 || statementIndex >= this.preStateUuidByStatementIndex.length) {
            this.logger.log(
                `getUndoTarget: index ${statementIndex} out of range ` +
                `[0, ${this.preStateUuidByStatementIndex.length}), returning undefined`
            );
            return undefined;
        }
        
        const targetUuid = this.preStateUuidByStatementIndex[statementIndex];
        this.logger.log(`getUndoTarget: index=${statementIndex}, targetUuid=${targetUuid}`);
        return targetUuid;
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
        if (!this.valid) {
            this.logger.log(`getUndoTargetForBackwardJump: tracker is invalid`);
            return undefined;
        }
        
        if (targetStatementCount >= currentStatementCount) {
            this.logger.log(
                `getUndoTargetForBackwardJump: not a backward jump ` +
                `(current=${currentStatementCount}, target=${targetStatementCount})`
            );
            return undefined;
        }
        
        if (targetStatementCount < 0) {
            // Undo everything: target uuid is 0
            this.logger.log(`getUndoTargetForBackwardJump: target=0 (undo all)`);
            return 0;
        }
        
        if (targetStatementCount >= this.preStateUuidByStatementIndex.length) {
            this.logger.log(
                `getUndoTargetForBackwardJump: target ${targetStatementCount} >= mapping size ` +
                `${this.preStateUuidByStatementIndex.length}`
            );
            return undefined;
        }
        
        const targetUuid = this.preStateUuidByStatementIndex[targetStatementCount];
        this.logger.log(
            `getUndoTargetForBackwardJump: current=${currentStatementCount}, ` +
            `target=${targetStatementCount}, targetUuid=${targetUuid}`
        );
        return targetUuid;
    }
    
    /**
     * Truncates the mapping after a successful undo.
     * Call this after `undo <uuid>.` succeeds to update the tracker state.
     * 
     * @param newStatementCount - The new number of statements after undo
     * @param newUuid - The uuid from the undo response prompt
     */
    public afterUndoSucceeded(newStatementCount: number, newUuid: number): void {
        if (!this.valid) {
            return;
        }
        
        if (newStatementCount < 0 || newStatementCount > this.preStateUuidByStatementIndex.length) {
            this.invalidate(
                `Invalid new statement count after undo: ${newStatementCount} ` +
                `(mapping size: ${this.preStateUuidByStatementIndex.length})`
            );
            return;
        }
        
        // Validate that the new uuid matches our expectation
        let expectedUuid: number;
        if (newStatementCount === 0) {
            expectedUuid = 0;
        } else {
            expectedUuid = this.preStateUuidByStatementIndex[newStatementCount];
        }
        
        // Allow for some flexibility in uuid validation
        if (newUuid !== expectedUuid) {
            this.logger.log(
                `Warning: uuid mismatch after undo. Expected ${expectedUuid}, got ${newUuid}. ` +
                `Updating tracker anyway.`
            );
        }
        
        // Truncate the mapping
        this.preStateUuidByStatementIndex = this.preStateUuidByStatementIndex.slice(0, newStatementCount);
        this.currentUuid = newUuid;
        this.pendingPreStateUuid = undefined;
        
        this.logger.log(
            `afterUndoSucceeded: newStatementCount=${newStatementCount}, ` +
            `newUuid=${newUuid}, mappingSize=${this.preStateUuidByStatementIndex.length}`
        );
        
        this.onMappingUpdated?.({ snapshot: this.getSnapshot() });
    }
}
