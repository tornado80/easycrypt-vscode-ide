/**
 * Unit Tests for EasyCrypt Statement Parser
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { 
    findNextStatement,
    findPreviousStatementEnd,
    findTargetStatementEndForCursor,
    getAllStatements,
    countStatements
} = require('../out/statementParser');

describe('StatementParser', function() {

    describe('findNextStatement', function() {
        
        it('finds a simple statement ending with period', function() {
            const text = 'require import A.';
            const stmt = findNextStatement(text, 0);
            
            assert.ok(stmt);
            assert.strictEqual(stmt.text, 'require import A.');
            assert.strictEqual(stmt.startOffset, 0);
            assert.strictEqual(stmt.endOffset, 17);
        });

        it('skips leading whitespace', function() {
            const text = '   lemma test : true.';
            const stmt = findNextStatement(text, 0);
            
            assert.ok(stmt);
            assert.strictEqual(stmt.text, 'lemma test : true.');
            assert.strictEqual(stmt.startOffset, 3);
        });

        it('handles multiline statements', function() {
            const text = 'lemma test :\n  true.';
            const stmt = findNextStatement(text, 0);
            
            assert.ok(stmt);
            assert.ok(stmt.text.includes('lemma'));
            assert.ok(stmt.text.includes('true'));
        });

        // Note: // is NOT a comment in EasyCrypt; it's an ssreflect tactic token.
        // The following test verifies that statements with => //. terminate correctly.
        it('treats ssreflect-style => //. as statement terminator, not comment', function() {
            const text = 'byequiv (_: ={glob A} ==> ={res})=> //.\nby do !sim.\nqed.';
            const stmts = getAllStatements(text);
            
            // Should produce 3 separate statements, not merge them
            assert.strictEqual(stmts.length, 3, `Expected 3 statements, got ${stmts.length}`);
            assert.ok(stmts[0].text.includes('byequiv'), 'First statement should be byequiv');
            assert.ok(stmts[0].text.endsWith('//.'), 'First statement should end with //.');
            assert.ok(stmts[1].text.includes('by do'), 'Second statement should be by do !sim.');
            assert.ok(stmts[2].text.includes('qed'), 'Third statement should be qed.');
        });

        it('treats //= as tactic token, not comment introducer', function() {
            const text = 'move=> //=.\nlemma t.';
            const stmts = getAllStatements(text);
            
            assert.strictEqual(stmts.length, 2, `Expected 2 statements, got ${stmts.length}`);
            assert.ok(stmts[0].text.endsWith('//=.'), 'First statement should end with //=.');
            assert.ok(stmts[1].text.includes('lemma'), 'Second statement should be lemma t.');
        });

        it('PRG.ec line 220-222: byequiv => //. followed by by do !sim. and qed.', function() {
            // Exact reproduction of the PRG.ec desync scenario
            const text = [
                '  proof.',
                '  byequiv (_: ={glob A} ==> ={res})=> //.',
                '  by do !sim.',
                '  qed.'
            ].join('\n');
            
            const stmts = getAllStatements(text);
            
            assert.strictEqual(stmts.length, 4, `Expected 4 statements, got ${stmts.length}`);
            assert.strictEqual(stmts[0].text, 'proof.');
            assert.ok(stmts[1].text.startsWith('byequiv'));
            assert.ok(stmts[1].text.endsWith('//.'), `Expected byequiv statement to end with //., got: ${stmts[1].text}`);
            assert.strictEqual(stmts[2].text, 'by do !sim.');
            assert.strictEqual(stmts[3].text, 'qed.');
        });

        it('ignores periods in block comments', function() {
            const text = '(* block comment with period. *) lemma test.';
            const stmt = findNextStatement(text, 0);
            
            assert.ok(stmt);
            assert.strictEqual(stmt.endOffset, 44);
        });

        it('ignores periods in string literals', function() {
            const text = 'op x = "hello.world". lemma test.';
            const stmt = findNextStatement(text, 0);
            
            assert.ok(stmt);
            // First statement should end at the first period not in the string
            assert.ok(stmt.text.includes('hello.world'));
        });

        it('does not treat record projection dot (state.`field) as a statement terminator', function() {
            const text = 'op x = state.`is_resp.';
            const stmt = findNextStatement(text, 0);

            assert.ok(stmt);
            assert.strictEqual(stmt.text, 'op x = state.`is_resp.');
            assert.strictEqual(stmt.endOffset, text.length);
        });

        it('does not treat qualified name dot (A.B) as a statement terminator', function() {
            const text = 'require import A.B.';
            const stmt = findNextStatement(text, 0);

            assert.ok(stmt);
            assert.strictEqual(stmt.text, 'require import A.B.');
            assert.strictEqual(stmt.endOffset, text.length);
        });

        it("does not treat apostrophes in identifiers (b') as string delimiters", function() {
            const text = [
                'module M = {',
                '  proc run() : bool = {',
                "    var b' : bool;",
                "    b' <- true;",
                "    return b';",
                '  }',
                '}.'
            ].join('\n');

            const stmt = findNextStatement(text, 0);
            assert.ok(stmt, 'Expected a statement, got null');
            assert.strictEqual(stmt.text, text);
        });

        it('returns null when no statement found', function() {
            const text = '   ';
            const stmt = findNextStatement(text, 0);
            assert.strictEqual(stmt, null);
        });

        it('returns null for incomplete statement', function() {
            const text = 'lemma test : true';
            const stmt = findNextStatement(text, 0);
            assert.strictEqual(stmt, null);
        });

        it('finds statement starting from offset', function() {
            const text = 'require A. require B.';
            const stmt = findNextStatement(text, 10);
            
            assert.ok(stmt);
            assert.strictEqual(stmt.text, 'require B.');
        });
    });

    describe('findPreviousStatementEnd', function() {
        
        it('finds previous statement end', function() {
            const text = 'require A. require B.';
            const prevEnd = findPreviousStatementEnd(text, 20);
            
            assert.strictEqual(prevEnd, 10);
        });

        it('treats endOffset as exclusive (boundary returns previous)', function() {
            const text = 'require A. require B.';
            // At the end of the first statement, the previous statement is none.
            const atFirstEnd = findPreviousStatementEnd(text, 10);
            assert.strictEqual(atFirstEnd, null);

            // At the end of the second statement, the previous is the first.
            const secondEnd = text.indexOf('require B.') + 'require B.'.length;
            const atSecondEnd = findPreviousStatementEnd(text, secondEnd);
            assert.strictEqual(atSecondEnd, 10);
        });

        it('returns null when at start', function() {
            const text = 'require A.';
            const prevEnd = findPreviousStatementEnd(text, 5);
            
            assert.strictEqual(prevEnd, null);
        });

        it('handles multiple statements', function() {
            const text = 'a. b. c.';
            // Searching backwards from end (offset 8), skipping 'c.', finds end of 'b.' at offset 5
            const prevEnd = findPreviousStatementEnd(text, 4);
            
            assert.strictEqual(prevEnd, 2); // end of 'a.'
        });
    });

    describe('findTargetStatementEndForCursor', function() {

        it('targets the containing statement end when cursor is in the middle of a statement', function() {
            const text = 'require A. require B.';

            // Cursor placed inside the second statement.
            const cursorOffset = text.indexOf('require B') + 3;
            const target = findTargetStatementEndForCursor(text, cursorOffset);

            assert.strictEqual(target, text.length);
        });

        it('targets the current statement end when cursor is exactly at the statement end', function() {
            const text = 'require A. require B.';

            // Cursor placed immediately after the '.' of the first statement.
            const firstEnd = 'require A.'.length;
            const target = findTargetStatementEndForCursor(text, firstEnd);

            assert.strictEqual(target, firstEnd);
        });

        it('targets the previous statement end when cursor is between statements', function() {
            const text = 'require A.   require B.';

            // Cursor placed in the whitespace between the two statements.
            const cursorOffset = text.indexOf('   ') + 1;
            const target = findTargetStatementEndForCursor(text, cursorOffset);

            assert.strictEqual(target, 'require A.'.length);
        });
    });

    describe('getAllStatements', function() {
        
        it('gets all statements in text', function() {
            const text = 'require A. require B. lemma test.';
            const stmts = getAllStatements(text);
            
            assert.strictEqual(stmts.length, 3);
            assert.ok(stmts[0].text.includes('require A'));
            assert.ok(stmts[1].text.includes('require B'));
            assert.ok(stmts[2].text.includes('lemma'));
        });

        it('handles empty text', function() {
            const stmts = getAllStatements('');
            assert.strictEqual(stmts.length, 0);
        });

        it('respects range bounds', function() {
            const text = 'a. b. c. d.';
            const stmts = getAllStatements(text, 3, 8);
            
            assert.strictEqual(stmts.length, 2); // b. and c.
        });
    });

    describe('countStatements', function() {
        
        it('counts statements correctly', function() {
            const text = 'a. b. c.';
            const count = countStatements(text, 0, text.length);
            assert.strictEqual(count, 3);
        });

        it('counts within range', function() {
            const text = 'a. b. c. d.';
            const count = countStatements(text, 3, 8);
            assert.strictEqual(count, 2);
        });
    });
});
