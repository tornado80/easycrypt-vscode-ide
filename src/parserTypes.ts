/**
 * EasyCrypt VS Code Extension - Core Type Definitions
 * 
 * This module contains pure TypeScript interfaces and types used for parsing.
 * These types have no VS Code dependencies and can be used in unit tests.
 */

/**
 * Represents a position in the source file (1-indexed, matching EasyCrypt output)
 */
export interface SourcePosition {
    /** Line number (1-indexed) */
    line: number;
    /** Column number (1-indexed) */
    column: number;
}

/**
 * Represents a range in the source file
 */
export interface SourceRange {
    /** Start position of the range */
    start: SourcePosition;
    /** End position of the range */
    end: SourcePosition;
}

/**
 * Severity levels for parsed errors/warnings
 */
export enum ErrorSeverity {
    Error = 'error',
    Warning = 'warning',
    Info = 'info',
    Hint = 'hint'
}

/**
 * Represents a parsed error from EasyCrypt output.
 * This is the structured representation of an error extracted from the REPL output.
 */
export interface ParsedError {
    /** The severity level of the error */
    severity: ErrorSeverity;
    
    /** The source range where the error occurred */
    range: SourceRange;
    
    /** The human-readable error message */
    message: string;
    
    /** Optional error code (e.g., from [error-LINE-COL] format) */
    code?: string;
    
    /** Optional file path if the error refers to an imported file */
    filePath?: string;
    
    /** Raw output that was parsed to create this error */
    rawOutput?: string;
}

/**
 * Represents the result of parsing EasyCrypt output
 */
export interface ParseResult {
    /** List of parsed errors/warnings */
    errors: ParsedError[];
    
    /** Whether the output indicates success (no errors) */
    success: boolean;
    
    /** Whether the proof is completed (no more goals) */
    proofCompleted: boolean;
    
    /** Any unparsed/unrecognized output */
    remainingOutput: string;
}

/**
 * Options for the output parser
 */
export interface ParserOptions {
    /** Whether to include raw output in parsed errors */
    includeRawOutput?: boolean;
    
    /** Default file path to use for errors without explicit file paths */
    defaultFilePath?: string;
}
