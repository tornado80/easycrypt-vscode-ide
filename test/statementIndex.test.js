/**
 * Unit tests for StatementIndex
 */

const { StatementIndex } = require('../out/statementIndex');
const assert = require('assert');

describe('StatementIndex', function () {
    /** @type {InstanceType<typeof StatementIndex>} */
    let index;

    beforeEach(function () {
        index = new StatementIndex();
    });

    describe('update', function () {
        it('should build index from document text', function () {
            const text = 'require import A. lemma foo : true. qed.';
            index.update(text, 1);

            assert.strictEqual(index.length, 3);
            assert.strictEqual(index.getVersion(), 1);
        });

        it('should skip update if version matches', function () {
            const text = 'require import A.';
            index.update(text, 1);
            assert.strictEqual(index.length, 1);

            // Same version and length should skip
            index.update(text, 1);
            assert.strictEqual(index.length, 1);
        });

        it('should rebuild if version changes', function () {
            const text1 = 'require import A.';
            index.update(text1, 1);
            assert.strictEqual(index.length, 1);

            const text2 = 'require import A. require import B.';
            index.update(text2, 2);
            assert.strictEqual(index.length, 2);
        });
    });

    describe('getTargetEndOffset', function () {
        it('should return 0 for empty document', function () {
            index.update('', 1);
            assert.strictEqual(index.getTargetEndOffset(0), 0);
            assert.strictEqual(index.getTargetEndOffset(10), 0);
        });

        it('should return statement end when cursor is inside statement', function () {
            const text = 'require import A.';
            index.update(text, 1);

            // Cursor at position 5 (inside "require import A.")
            const endOffset = index.getTargetEndOffset(5);
            assert.strictEqual(endOffset, 17); // End of "require import A."
        });

        it('should return statement end when cursor is at statement end', function () {
            const text = 'require import A.';
            index.update(text, 1);

            // Cursor exactly at end
            const endOffset = index.getTargetEndOffset(17);
            assert.strictEqual(endOffset, 17);
        });

        it('should return previous statement end when cursor is in whitespace', function () {
            const text = 'require import A.   lemma foo : true.';
            index.update(text, 1);

            // Cursor in whitespace between statements (position 18-20)
            const endOffset = index.getTargetEndOffset(19);
            assert.strictEqual(endOffset, 17); // End of first statement
        });

        it('should return 0 when cursor is before first statement', function () {
            const text = '   require import A.';
            index.update(text, 1);

            // Cursor in leading whitespace
            const endOffset = index.getTargetEndOffset(1);
            assert.strictEqual(endOffset, 0);
        });

        it('should handle cursor at document start', function () {
            const text = 'require import A.';
            index.update(text, 1);

            const endOffset = index.getTargetEndOffset(0);
            // Cursor at position 0 is inside the first statement
            assert.strictEqual(endOffset, 17);
        });

        it('should handle multiple statements correctly', function () {
            const text = 'require import A. require import B. lemma foo : true.';
            index.update(text, 1);

            // Cursor inside second statement
            const endOffset1 = index.getTargetEndOffset(20);
            assert.strictEqual(endOffset1, 35);

            // Cursor inside third statement
            const endOffset2 = index.getTargetEndOffset(40);
            assert.strictEqual(endOffset2, 53);
        });
    });

    describe('getStatementsUpTo', function () {
        it('should return empty array for offset 0', function () {
            const text = 'require import A.';
            index.update(text, 1);

            const stmts = index.getStatementsUpTo(0);
            assert.strictEqual(stmts.length, 0);
        });

        it('should return statements ending before or at offset', function () {
            const text = 'require import A. require import B. lemma foo : true.';
            index.update(text, 1);

            // Get statements up to end of second statement
            const stmts = index.getStatementsUpTo(35);
            assert.strictEqual(stmts.length, 2);
            assert.strictEqual(stmts[0].text, 'require import A.');
            assert.strictEqual(stmts[1].text, 'require import B.');
        });

        it('should return all statements when offset is beyond document', function () {
            const text = 'require import A. require import B.';
            index.update(text, 1);

            const stmts = index.getStatementsUpTo(1000);
            assert.strictEqual(stmts.length, 2);
        });
    });

    describe('getStatementsInRange', function () {
        it('should return statements within range', function () {
            const text = 'require import A. require import B. lemma foo : true.';
            index.update(text, 1);

            // Get statements from offset 17 to 53
            const stmts = index.getStatementsInRange(17, 53);
            assert.strictEqual(stmts.length, 2);
            assert.strictEqual(stmts[0].text, 'require import B.');
            assert.strictEqual(stmts[1].text, 'lemma foo : true.');
        });

        it('should return empty array for empty range', function () {
            const text = 'require import A. require import B.';
            index.update(text, 1);

            const stmts = index.getStatementsInRange(17, 17);
            assert.strictEqual(stmts.length, 0);
        });
    });

    describe('findStatementIndexAtOffset', function () {
        it('should return index of statement containing offset', function () {
            const text = 'require import A. require import B.';
            index.update(text, 1);

            assert.strictEqual(index.findStatementIndexAtOffset(5), 0);
            assert.strictEqual(index.findStatementIndexAtOffset(20), 1);
        });

        it('should return -1 when offset is in whitespace between statements', function () {
            const text = 'require import A.   require import B.';
            index.update(text, 1);

            // Offset 18 is in whitespace
            assert.strictEqual(index.findStatementIndexAtOffset(18), -1);
        });
    });

    describe('clear', function () {
        it('should reset all state', function () {
            const text = 'require import A.';
            index.update(text, 1);
            assert.strictEqual(index.length, 1);
            assert.strictEqual(index.getVersion(), 1);

            index.clear();
            assert.strictEqual(index.length, 0);
            assert.strictEqual(index.getVersion(), -1);
        });
    });

    describe('isValid', function () {
        it('should return true when version and length match', function () {
            const text = 'require import A.';
            index.update(text, 1);

            assert.strictEqual(index.isValid(1, text.length), true);
            assert.strictEqual(index.isValid(2, text.length), false);
            assert.strictEqual(index.isValid(1, 100), false);
        });
    });

    describe('Progress computation (proved statement count)', function () {
        it('returns correct count at offset 0', function () {
            const text = 'require import A. require import B. lemma foo : true.';
            index.update(text, 1);
            
            const stmts = index.getStatementsUpTo(0);
            assert.strictEqual(stmts.length, 0);
        });

        it('returns correct count at end of statement 1', function () {
            const text = 'require import A. require import B. lemma foo : true.';
            index.update(text, 1);
            
            // First statement ends at offset 17
            const stmts = index.getStatementsUpTo(17);
            assert.strictEqual(stmts.length, 1);
            assert.strictEqual(stmts[0].text, 'require import A.');
        });

        it('returns correct count at end of statement k', function () {
            const text = 'require import A. require import B. lemma foo : true.';
            index.update(text, 1);
            
            // Second statement ends at offset 35
            const stmts = index.getStatementsUpTo(35);
            assert.strictEqual(stmts.length, 2);
        });

        it('handles last proved statement selection correctly', function () {
            const text = 'require import A. require import B. lemma foo : true.';
            index.update(text, 1);
            
            // At executionOffset = 35 (end of statement 2)
            const stmts = index.getStatementsUpTo(35);
            assert.strictEqual(stmts.length, 2);
            
            // The last statement should be the one that ends exactly at 35
            const lastStmt = stmts[stmts.length - 1];
            assert.strictEqual(lastStmt.endOffset, 35);
            assert.strictEqual(lastStmt.text, 'require import B.');
        });

        it('correctly identifies last proved statement when offset is at boundary', function () {
            const text = 'require import A.';
            index.update(text, 1);
            
            const stmts = index.getStatementsUpTo(17);
            assert.strictEqual(stmts.length, 1);
            assert.strictEqual(stmts[0].endOffset, 17);
        });
    });
});
