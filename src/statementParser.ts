/**
 * EasyCrypt Statement Parser (Pure)
 * 
 * Parses EasyCrypt source code to identify statement boundaries.
 * Statements in EasyCrypt end with a period (.) that is not inside
 * a comment or string literal.
 * 
 * @module statementParser
 */

/**
 * Represents a parsed statement
 */
export interface Statement {
    /** The text of the statement */
    text: string;
    /** Start offset in the document (0-indexed) */
    startOffset: number;
    /** End offset in the document (exclusive, 0-indexed) */
    endOffset: number;
}

/**
 * Parser state during scanning
 * 
 * Note: EasyCrypt uses (* ... *) for comments. The // token is NOT a comment
 * introducer; it is an ssreflect-style tactic token (e.g., `=> //.`, `//=`).
 * 
 * EasyCrypt block comments are **nestable**: `(* outer (* inner *) outer *)`.
 * We track comment nesting depth rather than a simple boolean to handle this correctly.
 */
interface ScanState {
    /** 
     * Nesting depth of block comments. 
     * 0 = not in a comment; >0 = inside nested comments.
     * Must never become negative.
     */
    blockCommentDepth: number;
    inString: boolean;
    stringChar: string;
}

/**
 * Finds the next complete statement starting from a given offset.
 * 
 * @param text - The full document text
 * @param startOffset - The offset to start searching from
 * @returns The next statement, or null if none found
 */
export function findNextStatement(text: string, startOffset: number): Statement | null {
    const len = text.length;
    
    // Skip leading whitespace
    let i = startOffset;
    while (i < len && /\s/.test(text[i])) {
        i++;
    }
    
    if (i >= len) {
        return null;
    }
    
    const statementStart = i;
    const state: ScanState = {
        blockCommentDepth: 0,
        inString: false,
        stringChar: ''
    };
    
    while (i < len) {
        const char = text[i];
        const nextChar = i + 1 < len ? text[i + 1] : '';
        const nextNextChar = i + 2 < len ? text[i + 2] : '';
        
        // Handle string literals (only when not inside a block comment)
        if (state.blockCommentDepth === 0) {
            if (state.inString) {
                if (char === state.stringChar && text[i - 1] !== '\\') {
                    state.inString = false;
                }
                i++;
                continue;
            }
            
            // EasyCrypt commonly uses apostrophes in identifiers (e.g., b'),
            // so we only treat double quotes as string delimiters here.
            if (char === '"') {
                state.inString = true;
                state.stringChar = char;
                i++;
                continue;
            }
        }
        
        // Handle comments
        // Note: EasyCrypt uses only (* ... *) for comments, and they are NESTABLE.
        // The // token is NOT a comment; it is an ssreflect-style tactic token
        // (e.g., `=> //.`, `//=`). Do not treat // as a line comment.
        if (!state.inString) {
            // Block comment start: (*
            // This works both when entering a new comment (depth 0 -> 1) and
            // when entering a nested comment (depth N -> N+1).
            if (char === '(' && nextChar === '*') {
                state.blockCommentDepth++;
                i += 2;
                continue;
            }
            
            // Block comment end: *)
            // Only decrement if we are inside a comment (depth > 0).
            // If depth is already 0, treat *) as ordinary text (do not go negative).
            if (char === '*' && nextChar === ')' && state.blockCommentDepth > 0) {
                state.blockCommentDepth--;
                i += 2;
                continue;
            }
        }
        
        // Check for statement terminator (period not in comment/string)
        if (char === '.' && state.blockCommentDepth === 0 && !state.inString) {
            // Check it's not part of a number (e.g., 1.5)
            const prevChar = i > 0 ? text[i - 1] : '';
            if (!/\d/.test(prevChar) || !/\d/.test(nextChar)) {
                // In EasyCrypt, many '.' are not statement terminators:
                // - record/projection: state.`field
                // - qualified names: A.B
                // We treat '.' as a terminator only if it is followed by:
                // - whitespace/newline
                // - EOF
                // - a block comment start (* )
                // Note: // is NOT a comment in EasyCrypt; it's an ssreflect tactic token.
                const followedByEof = nextChar === '';
                const followedByWhitespace = nextChar !== '' && /\s/.test(nextChar);
                const followedByBlockComment = nextChar === '(' && nextNextChar === '*';

                if (followedByEof || followedByWhitespace || followedByBlockComment) {
                    // Found end of statement
                    return {
                        text: text.slice(statementStart, i + 1).trim(),
                        startOffset: statementStart,
                        endOffset: i + 1
                    };
                }
            }
        }
        
        i++;
    }
    
    // No complete statement found
    return null;
}

/**
 * Finds the previous statement ending before a given offset.
 * 
 * @param text - The full document text
 * @param endOffset - The offset to search backwards from
 * @returns The previous statement, or null if none found
 */
export function findPreviousStatementEnd(text: string, endOffset: number): number | null {
    // We need to scan from the beginning to find statement boundaries
    // because we need to track comment/string state correctly
    
    let lastStatementEnd = -1;
    let offset = 0;
    
    while (offset < endOffset) {
        const stmt = findNextStatement(text, offset);
        // We want the previous statement end strictly *before* endOffset.
        // If a statement ends exactly at endOffset, it is the current statement,
        // not the previous one.
        if (!stmt || stmt.endOffset >= endOffset) {
            break;
        }
        lastStatementEnd = stmt.endOffset;
        offset = stmt.endOffset;
    }
    
    return lastStatementEnd > 0 ? lastStatementEnd : null;
}

/**
 * Finds the start of the statement containing a given offset.
 * 
 * @param text - The full document text
 * @param offset - The offset within the statement
 * @returns The start offset of the containing statement, or 0 if at start
 */
export function findStatementStart(text: string, offset: number): number {
    const prevEnd = findPreviousStatementEnd(text, offset);
    if (prevEnd === null) {
        return 0;
    }
    
    // Skip whitespace after the previous statement end
    let start = prevEnd;
    while (start < text.length && /\s/.test(text[start])) {
        start++;
    }
    
    return start;
}

/**
 * Computes the target statement end offset for a "prove/go to cursor" operation.
 *
 * UX rule:
 * - If the cursor is inside (or exactly at the end of) a statement, target that statement's end.
 * - If the cursor is between statements (whitespace/comments area), target the previous statement end.
 * - If no previous statement exists, target 0.
 */
export function findTargetStatementEndForCursor(text: string, cursorOffset: number): number {
    const statementStart = findStatementStart(text, cursorOffset);
    const stmt = findNextStatement(text, statementStart);

    if (stmt && cursorOffset >= stmt.startOffset && cursorOffset <= stmt.endOffset) {
        return stmt.endOffset;
    }

    const prevEnd = findPreviousStatementEnd(text, cursorOffset);
    return prevEnd ?? 0;
}

/**
 * Counts the number of complete statements in a text range.
 * 
 * @param text - The full document text
 * @param startOffset - Start of range
 * @param endOffset - End of range
 * @returns The number of complete statements
 */
export function countStatements(text: string, startOffset: number, endOffset: number): number {
    let count = 0;
    let offset = startOffset;
    
    while (offset < endOffset) {
        const stmt = findNextStatement(text, offset);
        if (!stmt || stmt.endOffset > endOffset) {
            break;
        }
        count++;
        offset = stmt.endOffset;
    }
    
    return count;
}

/**
 * Gets all statements in a text range.
 * 
 * @param text - The full document text
 * @param startOffset - Start of range (default: 0)
 * @param endOffset - End of range (default: text.length)
 * @returns Array of statements
 */
export function getAllStatements(
    text: string, 
    startOffset: number = 0, 
    endOffset: number = text.length
): Statement[] {
    const statements: Statement[] = [];
    let offset = startOffset;
    
    while (offset < endOffset) {
        const stmt = findNextStatement(text, offset);
        if (!stmt || stmt.startOffset >= endOffset) {
            break;
        }
        statements.push(stmt);
        offset = stmt.endOffset;
    }
    
    return statements;
}
