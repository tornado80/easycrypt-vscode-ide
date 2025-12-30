/**
 * EasyCrypt VS Code Extension - VS Code Type Utilities
 * 
 * This module contains utilities that bridge the pure parser types
 * with VS Code APIs. Import this module only in VS Code extension code.
 */

import * as vscode from 'vscode';

// Re-export core types for convenience
export * from './parserTypes';

import { ErrorSeverity, SourceRange, ParsedError } from './parserTypes';

/**
 * Converts ErrorSeverity to VS Code DiagnosticSeverity
 */
export function toVscodeSeverity(severity: ErrorSeverity): vscode.DiagnosticSeverity {
    switch (severity) {
        case ErrorSeverity.Error:
            return vscode.DiagnosticSeverity.Error;
        case ErrorSeverity.Warning:
            return vscode.DiagnosticSeverity.Warning;
        case ErrorSeverity.Info:
            return vscode.DiagnosticSeverity.Information;
        case ErrorSeverity.Hint:
            return vscode.DiagnosticSeverity.Hint;
        default:
            return vscode.DiagnosticSeverity.Error;
    }
}

/**
 * Converts SourceRange to VS Code Range (0-indexed)
 */
export function toVscodeRange(range: SourceRange): vscode.Range {
    // Convert from 1-indexed to 0-indexed
    return new vscode.Range(
        range.start.line - 1,
        range.start.column - 1,
        range.end.line - 1,
        range.end.column - 1
    );
}

/**
 * Creates a VS Code Diagnostic from a ParsedError
 */
export function createDiagnostic(error: ParsedError): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(
        toVscodeRange(error.range),
        error.message,
        toVscodeSeverity(error.severity)
    );
    
    diagnostic.source = 'EasyCrypt';
    
    if (error.code) {
        diagnostic.code = error.code;
    }
    
    return diagnostic;
}
