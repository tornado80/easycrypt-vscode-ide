/**
 * EasyCrypt Proof State Parser (Pure)
 *
 * This module contains parsing logic that has no VS Code dependencies.
 * It is safe to import from unit tests running in plain Node.
 */

export interface ProofGoal {
    id: string;
    hypotheses: string[];
    conclusion: string;
}

export interface ProofMessage {
    severity: 'info' | 'warning' | 'error';
    content: string;
    timestamp: Date;
}

export interface ParsedProofState {
    goals: ProofGoal[];
    messages: ProofMessage[];
    isComplete: boolean;
    rawOutput: string;
}

// ============================================================================
// View Model Types (for Proof State View)
// ============================================================================

/**
 * View model for rendering proof state in the webview.
 * This is the lossless representation that preserves all output.
 */
export interface ProofStateViewModel {
    /** Parsed goal blocks with hypotheses and conclusions (deprecated; view now renders output only) */
    goals: { hypotheses: string[]; conclusion: string }[];
    /** All output lines for the last statement (preserved verbatim) */
    outputLines: string[];
    /** Extracted messages with severity */
    messages: { severity: 'info' | 'warning' | 'error'; content: string; timestamp: Date }[];
    /** Whether all goals have been completed */
    isComplete: boolean;
}

/**
 * Options for parsing proof state for view
 */
export interface ProofStateParseOptions {
    /** If true, preserve trailing whitespace on lines; default false */
    preserveTrailingWhitespace?: boolean;
}

/**
 * Extracts the last proof-state segment from batched EasyCrypt output.
 * 
 * When multiple statements are executed in a single batch, the output may contain
 * multiple proof state blocks. This function extracts only the final state segment
 * so that parseProofState() returns the correct end-state.
 * 
 * Strategy:
 * 1. If "No more goals" exists, extract from the last occurrence to EOF.
 * 2. Otherwise, find the last "Current goal" header and extract from there.
 * 3. If neither is found, return the entire output (single-statement case).
 * 
 * @param rawOutput - The complete raw output from EasyCrypt (possibly batched)
 * @returns The segment containing only the final proof state
 */
export function extractLastProofStateSegment(rawOutput: string): string {
    // Pattern for "No more goals" - proof completed
    const noMoreGoalsRegex = /no more goals/gi;
    // Pattern for "Current goal" - start of a goal block
    const currentGoalRegex = /Current goal/gi;

    // Find all matches for both patterns
    const noMoreGoalsMatches: number[] = [];
    const currentGoalMatches: number[] = [];

    let match: RegExpExecArray | null;

    // Find all "No more goals" positions
    while ((match = noMoreGoalsRegex.exec(rawOutput)) !== null) {
        noMoreGoalsMatches.push(match.index);
    }

    // Find all "Current goal" positions
    while ((match = currentGoalRegex.exec(rawOutput)) !== null) {
        currentGoalMatches.push(match.index);
    }

    // If we have "No more goals", prefer the last one
    if (noMoreGoalsMatches.length > 0) {
        const lastNoMoreGoals = noMoreGoalsMatches[noMoreGoalsMatches.length - 1];
        // Find the start of the line containing "No more goals"
        const lineStart = rawOutput.lastIndexOf('\n', lastNoMoreGoals - 1) + 1;
        return rawOutput.slice(lineStart);
    }

    // Otherwise, use the last "Current goal" block
    if (currentGoalMatches.length > 0) {
        const lastCurrentGoal = currentGoalMatches[currentGoalMatches.length - 1];
        // Find the start of the line containing "Current goal"
        const lineStart = rawOutput.lastIndexOf('\n', lastCurrentGoal - 1) + 1;
        return rawOutput.slice(lineStart);
    }

    // No recognizable proof state markers - return the whole output
    return rawOutput;
}

/**
 * Parses raw EasyCrypt output to extract proof state.
 */
export function parseProofState(rawOutput: string): ParsedProofState {
    const goals: ProofGoal[] = [];
    const messages: ProofMessage[] = [];
    let isComplete = false;

    const lines = rawOutput.split('\n');

    // Check for "No more goals" - proof is complete
    if (/no more goals/i.test(rawOutput)) {
        isComplete = true;
        return { goals, messages, isComplete, rawOutput };
    }

    // Try to parse goal blocks
    const separatorRegex = /^[-=]{10,}\s*$/;

    let currentGoalId = 0;
    let currentHypotheses: string[] = [];
    let inGoalBlock = false;
    let conclusionLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();

        if (!inGoalBlock && trimmedLine === '') {
            continue;
        }

        if (/^Current goal/i.test(trimmedLine)) {
            inGoalBlock = true;
            currentGoalId++;
            currentHypotheses = [];
            conclusionLines = [];
            continue;
        }

        if (/^Type variables:/i.test(trimmedLine)) {
            continue;
        }

        if (separatorRegex.test(trimmedLine)) {
            for (let j = i + 1; j < lines.length; j++) {
                const conclusionLine = lines[j];
                if (conclusionLine.trim() === '' && conclusionLines.length > 0) {
                    break;
                }
                if (conclusionLine.trim() !== '') {
                    conclusionLines.push(conclusionLine);
                }
            }

            if (conclusionLines.length > 0 || currentHypotheses.length > 0) {
                goals.push({
                    id: `goal-${currentGoalId}`,
                    hypotheses: currentHypotheses,
                    conclusion: conclusionLines.join('\n').trim()
                });
            }

            inGoalBlock = false;
            currentHypotheses = [];
            conclusionLines = [];
            continue;
        }

        if (inGoalBlock && trimmedLine !== '') {
            currentHypotheses.push(line);
        }
    }

    // Extract basic error and warning messages
    if (/error/i.test(rawOutput) && !/^no error/i.test(rawOutput)) {
        const errorMatch = rawOutput.match(/(?:error|Error)[:\s]+(.+?)(?:\n|$)/);
        if (errorMatch) {
            messages.push({
                severity: 'error',
                content: errorMatch[1].trim(),
                timestamp: new Date()
            });
        }
    }

    const warningMatches = rawOutput.matchAll(/warning[:\s]+(.+?)(?:\n|$)/gi);
    for (const match of warningMatches) {
        messages.push({
            severity: 'warning',
            content: match[1].trim(),
            timestamp: new Date()
        });
    }

    return { goals, messages, isComplete, rawOutput };
}

// ============================================================================
// Lossless View Parser Functions
// ============================================================================

/**
 * Extracts the output segment for the last statement from batched EasyCrypt output.
 * 
 * This is similar to extractLastProofStateSegment but with additional handling
 * for error tags and is intended for the proof state view.
 * 
 * Strategy (conservative, deterministic):
 * 1. Last occurrence of a "No more goals" line → return from that line to EOF.
 * 2. Else last occurrence of a "Current goal" line → return from that line to EOF.
 * 3. Else last occurrence of an error tag line (e.g. `[error-…]`, `[critical] …`) → return from that line to EOF.
 * 4. Else return entire output.
 * 
 * @param rawOutput - The complete raw output from EasyCrypt (possibly batched)
 * @returns The segment containing only the final statement's output
 */
export function extractLastStatementOutput(rawOutput: string): string {
    // EasyCrypt `cli -emacs` typically prints a prompt marker like:
    //   [99|check]>
    // Output for a command is between two successive prompts.
    // Prefer extracting between prompts when they are present.
    const emacsPromptRegex = /\[(\d+)\|([^\]]+)\]>\s*/g;
    const promptMatches = Array.from(rawOutput.matchAll(emacsPromptRegex));

    if (promptMatches.length >= 2) {
        const prev = promptMatches[promptMatches.length - 2];
        const last = promptMatches[promptMatches.length - 1];
        const prevIdx = prev.index ?? 0;
        const lastIdx = last.index ?? rawOutput.length;
        const start = prevIdx + prev[0].length;
        const end = lastIdx;
        return rawOutput.slice(start, end);
    }

    if (promptMatches.length === 1) {
        const only = promptMatches[0];
        const idx = only.index ?? 0;

        // If the prompt is at the beginning, treat everything after it as output.
        if (idx === 0) {
            return rawOutput.slice(only[0].length);
        }

        // Otherwise, treat everything before it as output.
        return rawOutput.slice(0, idx);
    }

    // Pattern for "No more goals" - proof completed
    const noMoreGoalsRegex = /no more goals/gi;
    // Pattern for "Current goal" - start of a goal block
    const currentGoalRegex = /Current goal/gi;
    // Pattern for error tags - [error-...] or [critical] or similar
    const errorTagRegex = /\[(?:error|critical|warning)/gi;

    // Find all matches for each pattern
    let match: RegExpExecArray | null;
    let lastNoMoreGoals = -1;
    let lastCurrentGoal = -1;
    let lastErrorTag = -1;

    // Find last "No more goals" position
    while ((match = noMoreGoalsRegex.exec(rawOutput)) !== null) {
        lastNoMoreGoals = match.index;
    }

    // Find last "Current goal" position
    while ((match = currentGoalRegex.exec(rawOutput)) !== null) {
        lastCurrentGoal = match.index;
    }

    // Find last error tag position
    while ((match = errorTagRegex.exec(rawOutput)) !== null) {
        lastErrorTag = match.index;
    }

    // Helper to find line start from position
    const findLineStart = (pos: number): number => {
        if (pos <= 0) return 0;
        const idx = rawOutput.lastIndexOf('\n', pos - 1);
        return idx < 0 ? 0 : idx + 1;
    };

    // Priority: "No more goals" > "Current goal" > error tag
    if (lastNoMoreGoals >= 0) {
        return rawOutput.slice(findLineStart(lastNoMoreGoals));
    }

    if (lastCurrentGoal >= 0) {
        return rawOutput.slice(findLineStart(lastCurrentGoal));
    }

    if (lastErrorTag >= 0) {
        return rawOutput.slice(findLineStart(lastErrorTag));
    }

    // No recognizable markers - return the whole output
    return rawOutput;
}

/**
 * Parses EasyCrypt output for the proof state view, preserving all content losslessly.
 * 
 * Unlike parseProofState(), this function:
 * - Preserves internal blank lines in conclusions
 * - Captures all non-goal lines in outputLines (verbatim)
 * - Does not rely on rawOutput fallback in the view
 * 
 * @param lastStatementOutput - The output segment for the last statement
 * @param options - Parsing options
 * @returns A view model suitable for rendering in the webview
 */
export function parseProofStateForView(
    lastStatementOutput: string,
    options?: ProofStateParseOptions
): ProofStateViewModel {
    const preserveTrailing = options?.preserveTrailingWhitespace ?? false;
    const goals: { hypotheses: string[]; conclusion: string }[] = [];
    const messages: { severity: 'info' | 'warning' | 'error'; content: string; timestamp: Date }[] = [];
    const outputLines: string[] = [];
    let isComplete = false;

    const lines = lastStatementOutput.split('\n');

    // Check for "No more goals" - proof is complete
    if (/no more goals/i.test(lastStatementOutput)) {
        isComplete = true;
    }

    // Collect all lines (lossless) into outputLines.
    // We intentionally do not attempt to separate goals/hypotheses:
    // EasyCrypt often shows only the current goal and a remaining-goals counter.
    for (const line of lines) {
        outputLines.push(preserveTrailing ? line : line.trimEnd());
    }

    // Extract error messages for severity highlighting
    if (/error/i.test(lastStatementOutput) && !/^no error/i.test(lastStatementOutput)) {
        const errorMatches = lastStatementOutput.matchAll(/(?:\[error[^\]]*\]|error)[:\s]+(.+?)(?:\n|$)/gi);
        for (const match of errorMatches) {
            messages.push({
                severity: 'error',
                content: match[1].trim(),
                timestamp: new Date()
            });
        }
    }

    // Extract warning messages
    const warningMatches = lastStatementOutput.matchAll(/(?:\[warning[^\]]*\]|warning)[:\s]+(.+?)(?:\n|$)/gi);
    for (const match of warningMatches) {
        messages.push({
            severity: 'warning',
            content: match[1].trim(),
            timestamp: new Date()
        });
    }

    return { goals, outputLines, messages, isComplete };
}

// ============================================================================
// Emacs Prompt Marker Extraction (for Debug Display)
// ============================================================================

/**
 * Represents an EasyCrypt cli -emacs prompt marker.
 * Example: "[54|check]>"
 */
export interface EmacsPromptMarker {
    /** Full marker text, e.g. "[54|check]>" (without trailing whitespace/newline). */
    text: string;
    /** Parsed prompt number, if present. */
    number?: number;
    /** Parsed prompt mode tag, e.g. "check". */
    tag?: string;
}

/**
 * Result of extracting the last statement output along with prompt metadata.
 */
export interface LastStatementExtraction {
    /** The extracted output segment for the last statement. */
    output: string;
    /** The prompt that precedes the extracted output segment (if prompt-delimited). */
    prevPrompt?: EmacsPromptMarker;
    /** The prompt that follows the extracted output segment (if prompt-delimited). */
    nextPrompt?: EmacsPromptMarker;
}

/**
 * Parses an emacs prompt marker string into its components.
 * 
 * @param markerText - The full marker text, e.g. "[54|check]>"
 * @returns The parsed EmacsPromptMarker
 */
function parseEmacsPromptMarker(markerText: string): EmacsPromptMarker {
    const match = markerText.match(/^\[(\d+)\|([^\]]+)\]>$/);
    if (match) {
        return {
            text: markerText,
            number: parseInt(match[1], 10),
            tag: match[2]
        };
    }
    // Fallback if parsing fails
    return { text: markerText };
}

/**
 * Extracts the output segment for the last statement from batched EasyCrypt output,
 * along with prompt metadata for debugging.
 * 
 * This is similar to extractLastStatementOutput but also returns the prompt markers
 * that delimit the extracted output, which can be displayed for debugging.
 * 
 * Strategy:
 * 1. If two or more emacs prompts exist, extract between the last two and return both prompts.
 * 2. If only one prompt exists, extract accordingly and return that prompt.
 * 3. If no prompts exist, fall back to conservative extraction (no prompt metadata).
 * 
 * Invariants:
 * - If both prevPrompt and nextPrompt exist, output is exactly the slice between them.
 * - If prompts don't exist, output falls back to the existing conservative extraction behavior.
 * 
 * @param rawOutput - The complete raw output from EasyCrypt (possibly batched)
 * @returns The extracted output segment and optional prompt metadata
 */
export function extractLastStatementOutputWithPrompts(rawOutput: string): LastStatementExtraction {
    // EasyCrypt `cli -emacs` typically prints a prompt marker like:
    //   [99|check]>
    // Output for a command is between two successive prompts.
    const emacsPromptRegex = /\[(\d+)\|([^\]]+)\]>/g;
    const promptMatches = Array.from(rawOutput.matchAll(emacsPromptRegex));

    if (promptMatches.length >= 2) {
        const prev = promptMatches[promptMatches.length - 2];
        const last = promptMatches[promptMatches.length - 1];
        const prevIdx = prev.index ?? 0;
        const lastIdx = last.index ?? rawOutput.length;
        const start = prevIdx + prev[0].length;
        const end = lastIdx;
        
        // Trim leading whitespace from the output slice
        let output = rawOutput.slice(start, end);
        // Remove leading newline if present
        if (output.startsWith('\n')) {
            output = output.slice(1);
        }
        
        return {
            output,
            prevPrompt: parseEmacsPromptMarker(prev[0]),
            nextPrompt: parseEmacsPromptMarker(last[0])
        };
    }

    if (promptMatches.length === 1) {
        const only = promptMatches[0];
        const idx = only.index ?? 0;
        const promptMarker = parseEmacsPromptMarker(only[0]);

        // If the prompt is at the beginning, extract output after it.
        if (idx === 0) {
            let output = rawOutput.slice(only[0].length);
            if (output.startsWith('\n')) {
                output = output.slice(1);
            }
            // If output after the prompt is empty (only whitespace), treat the single prompt
            // as the terminating prompt (nextPrompt). This handles responses that consist
            // only of a prompt marker.
            if (output.trim() === '') {
                return {
                    output: '',
                    nextPrompt: promptMarker
                };
            }
            // Otherwise, the prompt precedes non-empty output.
            return {
                output,
                prevPrompt: promptMarker
            };
        }

        // Otherwise, treat everything before it as output.
        return {
            output: rawOutput.slice(0, idx),
            nextPrompt: promptMarker
        };
    }

    // No prompts found - fall back to conservative extraction
    // Use the same logic as extractLastStatementOutput for fallback
    const noMoreGoalsRegex = /no more goals/gi;
    const currentGoalRegex = /Current goal/gi;
    const errorTagRegex = /\[(?:error|critical|warning)/gi;

    let match: RegExpExecArray | null;
    let lastNoMoreGoals = -1;
    let lastCurrentGoal = -1;
    let lastErrorTag = -1;

    while ((match = noMoreGoalsRegex.exec(rawOutput)) !== null) {
        lastNoMoreGoals = match.index;
    }

    while ((match = currentGoalRegex.exec(rawOutput)) !== null) {
        lastCurrentGoal = match.index;
    }

    while ((match = errorTagRegex.exec(rawOutput)) !== null) {
        lastErrorTag = match.index;
    }

    const findLineStart = (pos: number): number => {
        if (pos <= 0) return 0;
        const idx = rawOutput.lastIndexOf('\n', pos - 1);
        return idx < 0 ? 0 : idx + 1;
    };

    if (lastNoMoreGoals >= 0) {
        return { output: rawOutput.slice(findLineStart(lastNoMoreGoals)) };
    }

    if (lastCurrentGoal >= 0) {
        return { output: rawOutput.slice(findLineStart(lastCurrentGoal)) };
    }

    if (lastErrorTag >= 0) {
        return { output: rawOutput.slice(findLineStart(lastErrorTag)) };
    }

    return { output: rawOutput };
}
