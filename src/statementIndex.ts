/**
 * EasyCrypt Statement Index (Pure)
 * 
 * Maintains a cached index of statement boundaries for efficient cursor-to-statement
 * mapping. This is a pure module with no VS Code dependencies, enabling easy unit testing.
 * 
 * @module statementIndex
 */

import { getAllStatements, Statement } from './statementParser';

/**
 * Cached index of statement boundaries for a document.
 * 
 * Provides O(log n) lookup for cursor-to-statement-boundary mapping
 * instead of O(n) iterative scanning.
 */
export class StatementIndex {
    /** Cached statements sorted by startOffset */
    private statements: Statement[] = [];
    
    /** Document version this index was built for */
    private documentVersion: number = -1;
    
    /** Document text hash for additional validation */
    private documentTextLength: number = 0;

    /**
     * Updates the index for a new document version.
     * 
     * @param documentText - The full document text
     * @param version - The document version number
     */
    public update(documentText: string, version: number): void {
        // Skip if already up to date
        if (version === this.documentVersion && documentText.length === this.documentTextLength) {
            return;
        }
        
        this.statements = getAllStatements(documentText, 0, documentText.length);
        this.documentVersion = version;
        this.documentTextLength = documentText.length;
    }

    /**
     * Clears the cached index.
     */
    public clear(): void {
        this.statements = [];
        this.documentVersion = -1;
        this.documentTextLength = 0;
    }

    /**
     * Gets the cached statements.
     * 
     * @returns Array of cached statements (read-only view)
     */
    public getStatements(): readonly Statement[] {
        return this.statements;
    }

    /**
     * Gets the document version this index was built for.
     */
    public getVersion(): number {
        return this.documentVersion;
    }

    /**
     * Checks if the index is valid for the given document.
     * 
     * @param version - The document version to check
     * @param textLength - The document text length
     */
    public isValid(version: number, textLength: number): boolean {
        return this.documentVersion === version && this.documentTextLength === textLength;
    }

    /**
     * Gets the target statement end offset for a "prove/go to cursor" operation.
     * 
     * UX rules:
     * - If cursor is inside (or exactly at the end of) a statement, target that statement's end.
     * - If cursor is between statements (whitespace/comments), target the previous statement's end.
     * - If no previous statement exists, returns 0.
     * 
     * Uses binary search for O(log n) performance.
     * 
     * @param cursorOffset - The cursor position in the document
     * @returns The end offset of the target statement (or 0)
     */
    public getTargetEndOffset(cursorOffset: number): number {
        if (this.statements.length === 0) {
            return 0;
        }

        // Binary search to find the statement containing or just before the cursor
        let left = 0;
        let right = this.statements.length - 1;
        let result = -1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const stmt = this.statements[mid];

            if (cursorOffset >= stmt.startOffset && cursorOffset <= stmt.endOffset) {
                // Cursor is inside this statement - return its end
                return stmt.endOffset;
            } else if (cursorOffset > stmt.endOffset) {
                // Cursor is after this statement - it's a candidate
                result = mid;
                left = mid + 1;
            } else {
                // Cursor is before this statement
                right = mid - 1;
            }
        }

        // Return the end offset of the last statement before cursor, or 0
        return result >= 0 ? this.statements[result].endOffset : 0;
    }

    /**
     * Gets the statement at a specific index.
     * 
     * @param index - The statement index
     * @returns The statement at that index, or undefined
     */
    public getStatementAt(index: number): Statement | undefined {
        return this.statements[index];
    }

    /**
     * Gets the number of statements in the index.
     */
    public get length(): number {
        return this.statements.length;
    }

    /**
     * Finds the index of the statement containing or ending at the given offset.
     * 
     * @param offset - The offset to search for
     * @returns The statement index, or -1 if not found
     */
    public findStatementIndexAtOffset(offset: number): number {
        let left = 0;
        let right = this.statements.length - 1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const stmt = this.statements[mid];

            if (offset >= stmt.startOffset && offset <= stmt.endOffset) {
                return mid;
            } else if (offset > stmt.endOffset) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        return -1;
    }

    /**
     * Gets all statements up to (and including) the given end offset.
     * 
     * @param endOffset - The end offset (exclusive boundary)
     * @returns Array of statements that end before or at endOffset
     */
    public getStatementsUpTo(endOffset: number): Statement[] {
        const result: Statement[] = [];
        for (const stmt of this.statements) {
            if (stmt.endOffset > endOffset) {
                break;
            }
            result.push(stmt);
        }
        return result;
    }

    /**
     * Gets statements in a specific range.
     * 
     * @param startOffset - Start offset (inclusive)
     * @param endOffset - End offset (exclusive)
     * @returns Array of statements within the range
     */
    public getStatementsInRange(startOffset: number, endOffset: number): Statement[] {
        const result: Statement[] = [];
        for (const stmt of this.statements) {
            if (stmt.endOffset <= startOffset) {
                continue;
            }
            if (stmt.startOffset >= endOffset) {
                break;
            }
            result.push(stmt);
        }
        return result;
    }
}
