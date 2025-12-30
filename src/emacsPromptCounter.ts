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
    /** Whether we've already ignored a leading prompt for this command */
    ignoredLeadingPrompt: boolean;
    /** Whether we've seen any non-prompt content */
    seenNonPromptContent: boolean;
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
        ignoredLeadingPrompt: false,
        seenNonPromptContent: false,
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
        // No prompts in this chunk, but we've now seen non-prompt content
        if (chunk.trim().length > 0) {
            state.seenNonPromptContent = true;
        }
        return result;
    }

    // Determine if there's non-prompt content before the first prompt
    const firstPrompt = matches[0];
    const contentBeforeFirstPrompt = chunk.slice(0, firstPrompt.index).trim();

    // Check for content between prompts and after the last prompt
    let hasNonPromptContent = contentBeforeFirstPrompt.length > 0;
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const endOfPrompt = m.index + m.length;
        const nextPromptStart = i + 1 < matches.length ? matches[i + 1].index : chunk.length;
        const contentBetween = chunk.slice(endOfPrompt, nextPromptStart).trim();
        if (contentBetween.length > 0) {
            hasNonPromptContent = true;
        }
    }

    // Decide whether to ignore the first prompt as a "leading prompt".
    //
    // There are two cases we need to handle:
    // 1) Process startup prompt: EasyCrypt prints an initial prompt like [0|check]> BEFORE
    //    any command is processed. If a sendAndWait starts immediately after process start,
    //    the banner + initial [0|check]> can arrive while we're pending. That prompt must
    //    never count toward response completion.
    //
    // 2) Coalesced leading prompt: stdout chunks can begin with the trailing prompt from
    //    the previous command (prompt appears before any response content).
    let promptsToIgnore = 0;

    const isFirstPromptOverall = state.allPromptNumbers.length === 0;
    const isStartupPromptZero = isFirstPromptOverall && matches[0]?.promptNum === 0;
    if (!state.ignoredStartupPrompt && isStartupPromptZero) {
        // Always ignore the startup prompt [0|check]> regardless of surrounding banner text.
        promptsToIgnore = 1;
        state.ignoredStartupPrompt = true;
    } else if (!state.ignoredLeadingPrompt && !state.seenNonPromptContent) {
        // This is potentially the first chunk and we haven't seen response content yet.
        // If there's no content before the first prompt AND there's content after it,
        // this first prompt is likely a coalesced prompt from the previous command.
        //
        // However, we should NOT ignore if:
        // - There's content before the first prompt (it's a response prompt)
        // - There's no content after any prompts (prompt-only chunk - rare edge case)
        if (contentBeforeFirstPrompt.length === 0 && hasNonPromptContent) {
            promptsToIgnore = 1;
            state.ignoredLeadingPrompt = true;
        }
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

    // If there's any non-prompt content in this chunk, mark it
    if (hasNonPromptContent) {
        state.seenNonPromptContent = true;
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
        return this.state.ignoredLeadingPrompt || this.state.ignoredStartupPrompt;
    }

    /**
     * Gets a debug summary of the counter state.
     */
    public getDebugSummary(): string {
        return [
            `responsePrompts=${this.state.totalResponsePrompts}`,
            `promptNumbers=[${this.state.allPromptNumbers.join(',')}]`,
            `ignoredStartup=${this.state.ignoredStartupPrompt}`,
            `ignoredLeading=${this.state.ignoredLeadingPrompt}`,
            `seenContent=${this.state.seenNonPromptContent}`
        ].join(', ');
    }
}
