/**
 * EasyCrypt Output Parser
 * 
 * This module provides functions to parse EasyCrypt REPL output and extract
 * structured error information. It handles various error formats produced by
 * the EasyCrypt proof assistant.
 * 
 * Error Format Reference (from Proof General):
 * - Basic error: [error-LINE-COL] message
 * - Range error: [error-LINE-COL-LINE-COL] message
 * - Anomaly: anomaly: message
 * - Location format: "at line X, column Y to line X, column Z"
 * 
 * @module OutputParser
 */

import { 
    ParsedError, 
    ParseResult, 
    ParserOptions, 
    SourceRange, 
    ErrorSeverity 
} from './parserTypes';

/**
 * Regular expression patterns for parsing EasyCrypt output
 */
const PATTERNS = {
    /**
     * Matches the [error-LINE-COL] format used by EasyCrypt
     * Format: [error-STARTLINE-STARTCOL] or [error-STARTLINE-STARTCOL-ENDLINE-ENDCOL]
     * Groups: 1=startLine, 2=startCol, 3=endLine (optional), 4=endCol (optional)
     */
    errorTag: /^\[error-(\d+)-(\d+)(?:-(\d+)-(\d+))?\]\s*(.*)/,

    /**
     * Matches the "easycrypt compile" severity format.
     * Example:
     *   [critical] [/path/to/file.ec: line 4 (2-22)] parse error ...
     * Groups: 1=severity, 2=filePath, 3=line, 4=startCol, 5=endCol, 6=message
     */
    compileSeverity: /^\[(critical|error|warning|info)\]\s*\[(.+?):\s*line\s*(\d+)\s*\((\d+)-(\d+)\)\]\s*(.*)$/i,

    /**
     * Matches the "easycrypt compile -script" error format.
     * Example:
     *   E critical /path/to/file.ec: line 4 (2-22) parse error ...
     * Groups: 1=severity, 2=filePath, 3=line, 4=startCol, 5=endCol, 6=message
     */
    scriptError: /^E\s+(critical|error|warning|info)\s+(.+?):\s*line\s*(\d+)\s*\((-?\d+)-(-?\d+)\)\s*(.*)$/i,

    /**
     * Matches OCaml-style location lines commonly produced by tooling.
     * Examples:
     *   File "/path/to/file.ec", line 306, characters 0-6: parse error
     *   File "/path/to/file.ec", line 306, characters 0-6:
     *     parse error
     * Groups: 1=filePath, 2=line, 3=startCol, 4=endCol, 5=message (optional)
     */
    ocamlFileLocation: /^File\s+"(.+?)",\s*line\s*(\d+),\s*characters?\s*(-?\d+)-(-?\d+):?\s*(.*)$/i,

    /**
     * Matches the "easycrypt compile -script" progress format.
     * Example:
     *   P 4 53 0.64634 -1.00 -1.00
     */
    scriptProgress: /^P\s+\d+\s+\d+\s+[0-9.]+\s+-?[0-9.]+\s+-?[0-9.]+\s*$/,

    /**
     * Matches the full location specification in error messages
     * Format: "at line X, column Y to line X, column Z:"
     * Groups: 1=startLine, 2=startCol, 3=endLine, 4=endCol
     */
    locationRange: /at line (\d+), columns? (\d+) to line (\d+), columns? (\d+)/i,

    /**
     * Matches single location specification
     * Format: "at line X, column Y:"
     * Groups: 1=line, 2=column
     */
    locationSingle: /at line (\d+), columns? (\d+)/i,

    /**
     * Matches anomaly errors (internal errors)
     * Format: "anomaly: message"
     */
    anomaly: /^anomaly:\s*(.*)/i,

    /**
     * Matches warning messages
     * Format: "warning: message" or "[warning-LINE-COL] message"
     */
    warning: /^\[?warning(?:-(\d+)-(\d+)(?:-(\d+)-(\d+))?)?\]?\s*:?\s*(.*)/i,

    /**
     * Matches type error messages (common in EasyCrypt)
     * Format: "type error: ..."
     */
    typeError: /^type error\s*:?\s*(.*)/i,

    /**
     * Matches syntax error messages
     * Format: "syntax error" or "parse error"
     */
    syntaxError: /^(?:syntax|parse) error\s*:?\s*(.*)/i,

    /**
     * Matches "No more goals" success message
     */
    proofCompleted: /No more goals/i,

    /**
     * Matches unknown symbol/identifier errors
     * Format: "unknown symbol: X" or "unbound identifier: X"
     */
    unknownSymbol: /^(?:unknown (?:symbol|identifier)|unbound (?:symbol|identifier))\s*:?\s*(.*)/i,

    /**
     * Matches tactic failure messages
     * Format: "tactic X failed" or "cannot apply tactic X"
     */
    tacticFailure: /^(?:tactic .* failed|cannot apply tactic)\s*:?\s*(.*)/i,

    /**
     * Generic error prefix
     */
    errorPrefix: /^error\s*:?\s*(.*)/i
};

function severityFromEasyCrypt(sev: string): ErrorSeverity {
    const normalized = sev.toLowerCase();
    switch (normalized) {
        case 'warning':
            return ErrorSeverity.Warning;
        case 'info':
            return ErrorSeverity.Info;
        case 'critical':
        case 'error':
        default:
            return ErrorSeverity.Error;
    }
}

function stripScriptProgressSuffix(message: string): string {
    // Some EasyCrypt script lines include a trailing "P ..." progress segment.
    return message.replace(/\s+P\s+\d+\s+\d+\s+[0-9.]+\s+-?[0-9.]+\s+-?[0-9.]+\s*$/i, '');
}

/**
 * Creates a default source range (first line, first column)
 */
function createDefaultRange(): SourceRange {
    return {
        start: { line: 1, column: 1 },
        // Ensure a non-empty range so VS Code can render a squiggle.
        end: { line: 1, column: 2 }
    };
}

/**
 * Creates a source range from parsed numeric values
 */
function createRange(
    startLine: number,
    startCol: number,
    endLine: number = startLine,
    endCol: number = startCol + 1
): SourceRange {
    const normalizedStartLine = Math.max(1, startLine);
    const normalizedStartCol = Math.max(1, startCol);
    let normalizedEndLine = Math.max(1, endLine);
    let normalizedEndCol = Math.max(1, endCol);

    // Normalize to a non-empty range (important for VS Code squiggles).
    if (normalizedEndLine < normalizedStartLine) {
        normalizedEndLine = normalizedStartLine;
    }
    if (normalizedEndLine === normalizedStartLine && normalizedEndCol <= normalizedStartCol) {
        normalizedEndCol = normalizedStartCol + 1;
    }

    return {
        start: { line: normalizedStartLine, column: normalizedStartCol },
        end: {
            line: normalizedEndLine,
            column: normalizedEndCol
        }
    };
}

/**
 * Parses an integer from a string, with fallback
 */
function parseIntSafe(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? fallback : parsed;
}

/**
 * Attempts to extract location information from an error message
 */
function extractLocationFromMessage(message: string): SourceRange | null {
    // Try range format first
    const rangeMatch = message.match(PATTERNS.locationRange);
    if (rangeMatch) {
        const startLine = parseIntSafe(rangeMatch[1], 1);
        const startCol = parseIntSafe(rangeMatch[2], 1);
        const endLine = parseIntSafe(rangeMatch[3], startLine);
        const endCol = parseIntSafe(rangeMatch[4], startCol + 1);
        return createRange(startLine, startCol, endLine, endCol);
    }

    // Try single location format
    const singleMatch = message.match(PATTERNS.locationSingle);
    if (singleMatch) {
        const line = parseIntSafe(singleMatch[1], 1);
        const col = parseIntSafe(singleMatch[2], 1);
        return createRange(line, col, line, col + 1);
    }

    return null;
}

/**
 * Cleans up an error message by removing location prefixes and extra whitespace
 */
function cleanMessage(message: string): string {
    return message
        .replace(PATTERNS.locationRange, '')
        .replace(PATTERNS.locationSingle, '')
        .replace(/^:\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Parses a single line of EasyCrypt output
 * 
 * @param line - A single line of EasyCrypt output
 * @param options - Parser options
 * @returns A ParsedError if the line contains an error, null otherwise
 */
function parseLine(line: string, options: ParserOptions = {}): ParsedError | null {
    const trimmedLine = line.trim();
    if (!trimmedLine) return null;

    // Ignore easycrypt -script progress lines
    if (PATTERNS.scriptProgress.test(trimmedLine)) {
        return null;
    }

    // Parse "easycrypt compile -script" machine output
    const scriptErrorMatch = trimmedLine.match(PATTERNS.scriptError);
    if (scriptErrorMatch) {
        const severity = scriptErrorMatch[1] ?? 'error';
        const filePath = scriptErrorMatch[2];
        const startLine = parseIntSafe(scriptErrorMatch[3], 1);
        const startCol = parseIntSafe(scriptErrorMatch[4], 1);
        const endCol = parseIntSafe(scriptErrorMatch[5], startCol + 1);
        const message = stripScriptProgressSuffix(scriptErrorMatch[6] ?? '');

        return {
            severity: severityFromEasyCrypt(severity),
            range: createRange(startLine, startCol, startLine, endCol),
            message: cleanMessage(message) || 'Unknown error',
            code: severity.toLowerCase(),
            filePath,
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Parse OCaml-style file/line/characters output
    const ocamlLocMatch = trimmedLine.match(PATTERNS.ocamlFileLocation);
    if (ocamlLocMatch) {
        const filePath = ocamlLocMatch[1];
        const startLine = parseIntSafe(ocamlLocMatch[2], 1);
        const startCol = parseIntSafe(ocamlLocMatch[3], 1);
        const endCol = parseIntSafe(ocamlLocMatch[4], startCol + 1);
        const message = ocamlLocMatch[5] ?? '';

        return {
            severity: ErrorSeverity.Error,
            range: createRange(startLine, startCol, startLine, endCol),
            message: cleanMessage(message) || 'Unknown error',
            code: 'ocaml-location',
            filePath,
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Parse "easycrypt compile" default output
    const compileSeverityMatch = trimmedLine.match(PATTERNS.compileSeverity);
    if (compileSeverityMatch) {
        const severity = compileSeverityMatch[1] ?? 'error';
        const filePath = compileSeverityMatch[2];
        const startLine = parseIntSafe(compileSeverityMatch[3], 1);
        const startCol = parseIntSafe(compileSeverityMatch[4], 1);
        const endCol = parseIntSafe(compileSeverityMatch[5], startCol + 1);
        const message = compileSeverityMatch[6] ?? '';

        return {
            severity: severityFromEasyCrypt(severity),
            range: createRange(startLine, startCol, startLine, endCol),
            message: cleanMessage(message) || 'Unknown error',
            code: severity.toLowerCase(),
            filePath,
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Check for [error-LINE-COL] format
    const errorTagMatch = trimmedLine.match(PATTERNS.errorTag);
    if (errorTagMatch) {
        const startLine = parseIntSafe(errorTagMatch[1], 1);
        const startCol = parseIntSafe(errorTagMatch[2], 1);
        const endLine = parseIntSafe(errorTagMatch[3], startLine);
        const endCol = parseIntSafe(errorTagMatch[4], startCol + 1);
        const message = errorTagMatch[5] || 'Unknown error';

        return {
            severity: ErrorSeverity.Error,
            range: createRange(startLine, startCol, endLine, endCol),
            message: cleanMessage(message),
            code: `error-${startLine}-${startCol}`,
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Check for anomaly
    const anomalyMatch = trimmedLine.match(PATTERNS.anomaly);
    if (anomalyMatch) {
        const locationFromMsg = extractLocationFromMessage(anomalyMatch[1]);
        return {
            severity: ErrorSeverity.Error,
            range: locationFromMsg ?? createDefaultRange(),
            message: `Anomaly: ${cleanMessage(anomalyMatch[1])}`,
            code: 'anomaly',
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Check for warnings
    const warningMatch = trimmedLine.match(PATTERNS.warning);
    if (warningMatch) {
        const startLine = parseIntSafe(warningMatch[1], 1);
        const startCol = parseIntSafe(warningMatch[2], 1);
        const endLine = parseIntSafe(warningMatch[3], startLine);
        const endCol = parseIntSafe(warningMatch[4], startCol + 1);
        const message = warningMatch[5] || 'Warning';
        const locationFromMsg = extractLocationFromMessage(message);

        return {
            severity: ErrorSeverity.Warning,
            range: warningMatch[1] 
                ? createRange(startLine, startCol, endLine, endCol)
                : (locationFromMsg ?? createDefaultRange()),
            message: cleanMessage(message),
            code: 'warning',
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Check for type errors
    const typeErrorMatch = trimmedLine.match(PATTERNS.typeError);
    if (typeErrorMatch) {
        const locationFromMsg = extractLocationFromMessage(typeErrorMatch[1]);
        return {
            severity: ErrorSeverity.Error,
            range: locationFromMsg ?? createDefaultRange(),
            message: `Type error: ${cleanMessage(typeErrorMatch[1])}`,
            code: 'type-error',
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Check for syntax errors
    const syntaxErrorMatch = trimmedLine.match(PATTERNS.syntaxError);
    if (syntaxErrorMatch) {
        const locationFromMsg = extractLocationFromMessage(syntaxErrorMatch[1]);
        return {
            severity: ErrorSeverity.Error,
            range: locationFromMsg ?? createDefaultRange(),
            message: `Syntax error: ${cleanMessage(syntaxErrorMatch[1])}`,
            code: 'syntax-error',
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Check for unknown symbol errors
    const unknownSymbolMatch = trimmedLine.match(PATTERNS.unknownSymbol);
    if (unknownSymbolMatch) {
        const locationFromMsg = extractLocationFromMessage(unknownSymbolMatch[1]);
        return {
            severity: ErrorSeverity.Error,
            range: locationFromMsg ?? createDefaultRange(),
            message: `Unknown symbol: ${cleanMessage(unknownSymbolMatch[1])}`,
            code: 'unknown-symbol',
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Check for tactic failures
    const tacticFailureMatch = trimmedLine.match(PATTERNS.tacticFailure);
    if (tacticFailureMatch) {
        const locationFromMsg = extractLocationFromMessage(tacticFailureMatch[1]);
        return {
            severity: ErrorSeverity.Error,
            range: locationFromMsg ?? createDefaultRange(),
            message: cleanMessage(tacticFailureMatch[0]),
            code: 'tactic-failure',
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    // Check for generic error prefix
    const errorPrefixMatch = trimmedLine.match(PATTERNS.errorPrefix);
    if (errorPrefixMatch) {
        const locationFromMsg = extractLocationFromMessage(errorPrefixMatch[1]);
        return {
            severity: ErrorSeverity.Error,
            range: locationFromMsg ?? createDefaultRange(),
            message: cleanMessage(errorPrefixMatch[1]) || 'Unknown error',
            code: 'error',
            rawOutput: options.includeRawOutput ? trimmedLine : undefined
        };
    }

    return null;
}

/**
 * Parses multi-line error output from EasyCrypt
 * 
 * Some errors span multiple lines (error tag on one line, message continuation on next).
 * This function handles those cases by joining related lines.
 * 
 * @param lines - Array of output lines
 * @param startIndex - Index to start parsing from
 * @returns Tuple of [ParsedError or null, number of lines consumed]
 */
function parseMultiLineError(
    lines: string[], 
    startIndex: number, 
    options: ParserOptions
): [ParsedError | null, number] {
    const currentLine = lines[startIndex].trim();
    
    // Check if this line starts an error tag
    const errorTagMatch = currentLine.match(/^\[error-(\d+)-(\d+)(?:-(\d+)-(\d+))?\]/);
    if (errorTagMatch) {
        let message = currentLine.replace(/^\[error-\d+-\d+(?:-\d+-\d+)?\]\s*/, '');
        let linesConsumed = 1;

        // Look ahead for continuation lines (indented or not starting with [)
        for (let i = startIndex + 1; i < lines.length; i++) {
            const nextLine = lines[i].trim();
            if (!nextLine || nextLine.startsWith('[') || PATTERNS.anomaly.test(nextLine)) {
                break;
            }
            // Check if this looks like a continuation (doesn't start with a new error indicator)
            if (!PATTERNS.errorPrefix.test(nextLine) && 
                !PATTERNS.warning.test(nextLine) &&
                !PATTERNS.proofCompleted.test(nextLine)) {
                message += ' ' + nextLine;
                linesConsumed++;
            } else {
                break;
            }
        }

        const startLine = parseIntSafe(errorTagMatch[1], 1);
        const startCol = parseIntSafe(errorTagMatch[2], 1);
        const endLine = parseIntSafe(errorTagMatch[3], startLine);
        const endCol = parseIntSafe(errorTagMatch[4], startCol + 1);

        // Try to extract more precise location from message content
        const locationFromMsg = extractLocationFromMessage(message);

        return [{
            severity: ErrorSeverity.Error,
            range: locationFromMsg ?? createRange(startLine, startCol, endLine, endCol),
            message: cleanMessage(message),
            code: `error-${startLine}-${startCol}`,
            rawOutput: options.includeRawOutput ? lines.slice(startIndex, startIndex + linesConsumed).join('\n') : undefined
        }, linesConsumed];
    }

    // Fall back to single-line parsing
    // Special case: OCaml-style location line followed by message on next line.
    const ocamlLoc = currentLine.match(PATTERNS.ocamlFileLocation);
    if (ocamlLoc) {
        const messageInline = (ocamlLoc[5] ?? '').trim();
        if (!messageInline) {
            // If the location line ends with ':' and no message, pull continuation lines.
            let message = '';
            let linesConsumed = 1;
            for (let i = startIndex + 1; i < lines.length; i++) {
                const nextLine = lines[i].trim();
                if (!nextLine) {
                    linesConsumed++;
                    continue;
                }
                if (nextLine.startsWith('[') || nextLine.startsWith('File ') || nextLine.startsWith('E ') || PATTERNS.scriptProgress.test(nextLine)) {
                    break;
                }
                message += (message ? ' ' : '') + nextLine;
                linesConsumed++;
                // Usually a single continuation line is enough; stop after first non-empty line.
                break;
            }

            const filePath = ocamlLoc[1];
            const startLine = parseIntSafe(ocamlLoc[2], 1);
            const startCol = parseIntSafe(ocamlLoc[3], 1);
            const endCol = parseIntSafe(ocamlLoc[4], startCol + 1);

            return [
                {
                    severity: ErrorSeverity.Error,
                    range: createRange(startLine, startCol, startLine, endCol),
                    message: cleanMessage(message) || 'Unknown error',
                    code: 'ocaml-location',
                    filePath,
                    rawOutput: options.includeRawOutput
                        ? lines.slice(startIndex, startIndex + linesConsumed).join('\n')
                        : undefined
                },
                linesConsumed
            ];
        }
    }

    const singleResult = parseLine(currentLine, options);
    return [singleResult, 1];
}

/**
 * Parses EasyCrypt REPL output and extracts all errors and warnings.
 * 
 * This is the main entry point for parsing EasyCrypt output.
 * 
 * @param output - The raw output string from EasyCrypt
 * @param options - Optional parser configuration
 * @returns A ParseResult containing all parsed errors and status information
 * 
 * @example
 * ```typescript
 * const output = `[error-10-5] unknown symbol: x`;
 * const result = parseOutput(output);
 * console.log(result.errors[0].message); // "unknown symbol: x"
 * console.log(result.errors[0].range.start.line); // 10
 * ```
 */
export function parseOutput(output: string, options: ParserOptions = {}): ParseResult {
    const lines = output.split('\n');
    const errors: ParsedError[] = [];
    const unrecognizedLines: string[] = [];
    let proofCompleted = false;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();

        // Skip empty lines
        if (!line) {
            i++;
            continue;
        }

        // Check for proof completion
        if (PATTERNS.proofCompleted.test(line)) {
            proofCompleted = true;
            i++;
            continue;
        }

        // Try to parse multi-line error
        const [error, linesConsumed] = parseMultiLineError(lines, i, options);
        
        if (error) {
            // Apply default file path if needed
            if (options.defaultFilePath && !error.filePath) {
                error.filePath = options.defaultFilePath;
            }
            errors.push(error);
        } else if (line && !line.startsWith('#')) {
            // Track unrecognized non-comment lines for debugging
            unrecognizedLines.push(line);
        }

        i += linesConsumed;
    }

    return {
        errors,
        success: errors.filter(e => e.severity === ErrorSeverity.Error).length === 0,
        proofCompleted,
        remainingOutput: unrecognizedLines.join('\n')
    };
}

/**
 * Parses a single error message (convenience function)
 * 
 * @param errorMessage - A single error message string
 * @param options - Optional parser configuration
 * @returns A ParsedError if the message contains an error, null otherwise
 */
export function parseError(errorMessage: string, options: ParserOptions = {}): ParsedError | null {
    const result = parseOutput(errorMessage, options);
    return result.errors.length > 0 ? result.errors[0] : null;
}

/**
 * Checks if output indicates an error occurred
 * 
 * @param output - The raw output string from EasyCrypt
 * @returns true if the output contains error indicators
 */
export function hasError(output: string): boolean {
    return PATTERNS.errorTag.test(output) || 
           PATTERNS.anomaly.test(output) ||
           PATTERNS.errorPrefix.test(output) ||
           PATTERNS.typeError.test(output) ||
           PATTERNS.syntaxError.test(output);
}

/**
 * Checks if output indicates proof completion
 * 
 * @param output - The raw output string from EasyCrypt
 * @returns true if the output indicates no more goals
 */
export function isProofCompleted(output: string): boolean {
    return PATTERNS.proofCompleted.test(output);
}

// Export patterns for testing purposes
export const parserPatterns = PATTERNS;
