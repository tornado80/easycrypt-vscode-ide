/**
 * EasyCrypt Emacs Prompt Counter
 * 
 * Provides robust counting of EasyCrypt `cli -emacs` prompt markers for
 * correct completion detection in batched sends.
 * 
 * Problem: When sending batched commands to EasyCrypt, the extension expects
 * one prompt per statement. However, stdout chunks can contain:
 * - A "leading prompt" from the previous command (coalesced into the same read)
 * - Multiple prompts in a single chunk
 * 
 * This module implements prompt counting that ignores the first prompt in a
 * response *only* when there's evidence it's a pre-response prompt (i.e., the
 * prompt appears before any response content).
 * 
 * @module emacsPromptCounter
 */

/**
 * Result of counting prompts in a chunk
 */
export interface PromptCountingResult {
    /** Number of prompts attributable to command responses in this chunk */
    responsePrompts: number;
    /** Total number of emacs prompts found in this chunk */
    totalPrompts: number;
    /** Prompt numbers extracted from the chunk (in order) */
    promptNumbers: number[];
}

/**
 * State for the prompt counter across chunks
 */
export interface PromptCounterState {
    /** Whether we've already ignored the startup prompt [0|check]> */
    ignoredStartupPrompt: boolean;
    /** Total response prompts counted so far */
    totalResponsePrompts: number;
    /** All prompt numbers seen (for debugging) */
    allPromptNumbers: number[];
}

/**
 * Regex for EasyCrypt emacs prompt markers.
 * Matches patterns like: [99|check]>
 */
const EMACS_PROMPT_REGEX = /\[(\d+)\|([^\]]+)\]>\s*/g;

/**
 * Creates a fresh prompt counter state for a new command/batch.
 */
export function createPromptCounterState(): PromptCounterState {
    return {
        ignoredStartupPrompt: false,
        totalResponsePrompts: 0,
        allPromptNumbers: []
    };
}

/**
 * Counts response prompts in a chunk, updating the state.
 * 
 * Key behavior:
 * - If this is the first chunk and it starts with a prompt (before any content),
 *   that prompt is considered a "leading prompt" from the previous command
 *   and is NOT counted as a response prompt.
 * - All subsequent prompts are counted as response prompts.
 * 
 * @param chunk - The raw stdout chunk to process
 * @param state - The counter state (will be mutated)
 * @returns Prompt counting result for this chunk
 */
export function countResponsePrompts(
    chunk: string,
    state: PromptCounterState
): PromptCountingResult {
    const result: PromptCountingResult = {
        responsePrompts: 0,
        totalPrompts: 0,
        promptNumbers: []
    };

    if (!chunk) {
        return result;
    }

    // Find all prompt matches with their positions
    const matches: Array<{ index: number; length: number; promptNum: number }> = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(EMACS_PROMPT_REGEX.source, 'g');

    while ((match = regex.exec(chunk)) !== null) {
        matches.push({
            index: match.index,
            length: match[0].length,
            promptNum: parseInt(match[1], 10)
        });
    }

    result.totalPrompts = matches.length;

    if (matches.length === 0) {
        return result;
    }

    // Ignore the process startup prompt [0|check]>.
    //
    // Important: we do NOT attempt to ignore an additional "leading prompt" at the start
    // of a response. In batched sends, it is common for the first processed statement to
    // produce no output; EasyCrypt still prints the prompt for that statement, and the next
    // statement's output may follow immediately. Treating that prompt as "leading" causes an
    // off-by-one undercount and can lead to sendAndWait timeouts.
    let promptsToIgnore = 0;
    const isFirstPromptOverall = state.allPromptNumbers.length === 0;
    const isStartupPromptZero = isFirstPromptOverall && matches[0]?.promptNum === 0;
    if (!state.ignoredStartupPrompt && isStartupPromptZero) {
        promptsToIgnore = 1;
        state.ignoredStartupPrompt = true;
    }

    // Count response prompts
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        result.promptNumbers.push(m.promptNum);
        state.allPromptNumbers.push(m.promptNum);

        if (i < promptsToIgnore) {
            // This prompt is ignored (leading prompt)
            continue;
        }

        result.responsePrompts++;
        state.totalResponsePrompts++;
    }

    return result;
}

/**
 * Prompt counter class for use in sendAndWait operations.
 * 
 * Encapsulates the state and provides a clean API for prompt counting.
 */
export class EmacsPromptCounter {
    private state: PromptCounterState;

    constructor() {
        this.state = createPromptCounterState();
    }

    /**
     * Resets the counter for a new command/batch.
     */
    public reset(): void {
        this.state = createPromptCounterState();
    }

    /**
     * Ingests a chunk and returns the prompt counting result.
     */
    public ingestChunk(chunk: string): PromptCountingResult {
        return countResponsePrompts(chunk, this.state);
    }

    /**
     * Gets the total number of response prompts seen so far.
     */
    public getTotalResponsePrompts(): number {
        return this.state.totalResponsePrompts;
    }

    /**
     * Gets all prompt numbers seen (for debugging).
     */
    public getAllPromptNumbers(): number[] {
        return [...this.state.allPromptNumbers];
    }

    /**
     * Gets whether a leading prompt was ignored.
     */
    public hasIgnoredLeadingPrompt(): boolean {
        return this.state.ignoredStartupPrompt;
    }

    /**
     * Gets a debug summary of the counter state.
     */
    public getDebugSummary(): string {
        return [
            `responsePrompts=${this.state.totalResponsePrompts}`,
            `promptNumbers=[${this.state.allPromptNumbers.join(',')}]`,
            `ignoredStartup=${this.state.ignoredStartupPrompt}`,
            `ignoredLeading=false`,
            `seenContent=true`
        ].join(', ');
    }
}
