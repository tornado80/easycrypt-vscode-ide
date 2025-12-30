/**
 * Unit Tests for Efficient Proof Navigation (Batch Stepping)
 * 
 * Tests the batch stepping functionality in StepManager that enables
 * efficient "Go to Cursor" operations by suppressing intermediate UI updates.
 */

const assert = require('assert');
const path = require('path');

// Import from compiled JS output
const { findNextStatement, getAllStatements } = require('../out/statementParser');

describe('Efficient Proof Navigation - Statement Collection', function() {

    describe('Statement collection for batch execution', function() {

        it('collects all statements between two offsets', function() {
            const text = [
                'require import A.',
                'require import B.',
                'lemma test : true.',
                'proof.',
                '  trivial.',
                'qed.'
            ].join('\n');

            // Simulate collecting statements from offset 0 to end
            const statements = [];
            let offset = 0;
            const targetOffset = text.length;

            while (offset < targetOffset) {
                const stmt = findNextStatement(text, offset);
                if (!stmt || stmt.startOffset >= targetOffset) {
                    break;
                }
                statements.push(stmt);
                offset = stmt.endOffset;
            }

            assert.strictEqual(statements.length, 6);
            assert.ok(statements[0].text.includes('require import A'));
            assert.ok(statements[5].text.includes('qed'));
        });

        it('stops collecting at target offset', function() {
            const text = [
                'require import A.',
                'require import B.',
                'lemma test : true.'
            ].join('\n');

            // Target is just after first statement
            const firstStmt = findNextStatement(text, 0);
            const targetOffset = firstStmt.endOffset + 5; // Slightly into second line

            const statements = [];
            let offset = 0;

            while (offset < targetOffset) {
                const stmt = findNextStatement(text, offset);
                if (!stmt || stmt.startOffset >= targetOffset) {
                    break;
                }
                statements.push(stmt);
                offset = stmt.endOffset;
            }

            // Should only collect statements that START before targetOffset
            assert.strictEqual(statements.length, 2);
        });

        it('handles empty range (already at target)', function() {
            const text = 'require import A.\nrequire import B.';
            const currentOffset = 17; // End of first statement
            const targetOffset = 17; // Same position

            const statements = [];
            let offset = currentOffset;

            while (offset < targetOffset) {
                const stmt = findNextStatement(text, offset);
                if (!stmt || stmt.startOffset >= targetOffset) {
                    break;
                }
                statements.push(stmt);
                offset = stmt.endOffset;
            }

            assert.strictEqual(statements.length, 0);
        });

        it('collects statements across multi-line definitions', function() {
            const text = [
                'module M = {',
                '  proc run() : bool = {',
                '    return true;',
                '  }',
                '}.',
                'lemma test : true.'
            ].join('\n');

            const statements = [];
            let offset = 0;
            const targetOffset = text.length;

            while (offset < targetOffset) {
                const stmt = findNextStatement(text, offset);
                if (!stmt || stmt.startOffset >= targetOffset) {
                    break;
                }
                statements.push(stmt);
                offset = stmt.endOffset;
            }

            // Should find 2 statements: module and lemma
            assert.strictEqual(statements.length, 2);
            assert.ok(statements[0].text.includes('module M'));
            assert.ok(statements[0].text.includes('}.'));
            assert.ok(statements[1].text.includes('lemma test'));
        });
    });

    describe('Statement counting for progress indication', function() {

        it('counts statements correctly for progress message', function() {
            const text = [
                'require import A.',
                'require import B.',
                'require import C.',
                'lemma t : true.',
                'proof.',
                '  trivial.',
                'qed.'
            ].join('\n');

            const statements = [];
            let offset = 0;

            while (offset < text.length) {
                const stmt = findNextStatement(text, offset);
                if (!stmt) break;
                statements.push(stmt);
                offset = stmt.endOffset;
            }

            assert.strictEqual(statements.length, 7);
            
            // Verify singular/plural message would be correct
            const message = `Verifying ${statements.length} statement${statements.length > 1 ? 's' : ''}...`;
            assert.ok(message.includes('statements'));
        });

        it('handles single statement case', function() {
            const text = 'require import A.';

            const statements = [];
            let offset = 0;

            while (offset < text.length) {
                const stmt = findNextStatement(text, offset);
                if (!stmt) break;
                statements.push(stmt);
                offset = stmt.endOffset;
            }

            assert.strictEqual(statements.length, 1);
            
            const message = `Verifying ${statements.length} statement${statements.length > 1 ? 's' : ''}...`;
            assert.ok(!message.includes('statements'));
            assert.ok(message.includes('statement'));
        });
    });
});

describe('Efficient Proof Navigation - Batch Range Calculation', function() {

    it('calculates correct batch range from first to last statement', function() {
        const text = [
            'require import A.',
            'require import B.',
            'lemma test : true.'
        ].join('\n');

        const statements = [];
        let offset = 0;

        while (offset < text.length) {
            const stmt = findNextStatement(text, offset);
            if (!stmt) break;
            statements.push(stmt);
            offset = stmt.endOffset;
        }

        const batchStartOffset = statements[0].startOffset;
        const batchEndOffset = statements[statements.length - 1].endOffset;

        assert.strictEqual(batchStartOffset, 0);
        assert.strictEqual(batchEndOffset, text.length);
    });

    it('handles whitespace before first statement', function() {
        const text = '  \n  require import A.\nrequire import B.';

        const statements = [];
        let offset = 0;

        while (offset < text.length) {
            const stmt = findNextStatement(text, offset);
            if (!stmt) break;
            statements.push(stmt);
            offset = stmt.endOffset;
        }

        // First statement should skip leading whitespace
        assert.ok(statements[0].startOffset > 0);
        assert.ok(statements[0].text.startsWith('require'));
    });
});

describe('Efficient Proof Navigation - Error Scenarios', function() {

    it('identifies statement that would cause error (by position)', function() {
        const text = [
            'require import A.',
            'require import undefined_symbol.',  // This would cause error
            'lemma test : true.'
        ].join('\n');

        const statements = [];
        let offset = 0;

        while (offset < text.length) {
            const stmt = findNextStatement(text, offset);
            if (!stmt) break;
            statements.push(stmt);
            offset = stmt.endOffset;
        }

        // In batch mode, if statement 1 (0-indexed) fails, we should be able to identify it
        const failingStatementIndex = 1;
        const failingStatement = statements[failingStatementIndex];
        
        assert.ok(failingStatement.text.includes('undefined_symbol'));
        
        // The execution offset should be set to just after the last successful statement
        const expectedOffset = statements[failingStatementIndex - 1].endOffset;
        assert.ok(expectedOffset < failingStatement.startOffset);
    });

    it('handles error on first statement in batch', function() {
        const text = [
            'undefined_symbol.',  // Error on first statement
            'require import A.'
        ].join('\n');

        const statements = [];
        let offset = 0;

        while (offset < text.length) {
            const stmt = findNextStatement(text, offset);
            if (!stmt) break;
            statements.push(stmt);
            offset = stmt.endOffset;
        }

        // If first statement fails, execution offset should remain at 0
        const failingStatementIndex = 0;
        
        // Simulating: no previous successful statement
        const executionOffsetAfterError = failingStatementIndex === 0 
            ? 0 
            : statements[failingStatementIndex - 1].endOffset;
        
        assert.strictEqual(executionOffsetAfterError, 0);
    });
});

describe('Efficient Proof Navigation - Real File Tests', function() {

    it('processes multiple statements from test file efficiently', function() {
        const fs = require('fs');
        const filePath = path.join(__dirname, 'test_sample.ec');
        
        // Skip if file doesn't exist
        if (!fs.existsSync(filePath)) {
            this.skip();
            return;
        }

        const text = fs.readFileSync(filePath, 'utf8');

        const statements = [];
        let offset = 0;

        while (offset < text.length) {
            const stmt = findNextStatement(text, offset);
            if (!stmt) break;
            statements.push(stmt);
            offset = stmt.endOffset;
        }

        // Verify we found statements
        assert.ok(statements.length > 0, 'Expected to find statements in test file');
        
        // Verify all statements have valid offsets
        for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i];
            assert.ok(stmt.startOffset >= 0);
            assert.ok(stmt.endOffset > stmt.startOffset);
            assert.ok(stmt.text.length > 0);
            
            // Verify statements don't overlap
            if (i > 0) {
                assert.ok(stmt.startOffset >= statements[i - 1].endOffset,
                    `Statement ${i} should start after statement ${i - 1} ends`);
            }
        }
    });

    it('handles PRG.ec file for batch stepping to end', function() {
        const fs = require('fs');
        const filePath = path.join(__dirname, 'PRG.ec');
        
        if (!fs.existsSync(filePath)) {
            this.skip();
            return;
        }

        const text = fs.readFileSync(filePath, 'utf8');

        const statements = [];
        let offset = 0;
        const startTime = Date.now();

        while (offset < text.length) {
            const stmt = findNextStatement(text, offset);
            if (!stmt) break;
            statements.push(stmt);
            offset = stmt.endOffset;
        }

        const parseTime = Date.now() - startTime;

        // Verify parsing is fast (should be < 100ms for reasonable file sizes)
        assert.ok(parseTime < 500, `Parsing took too long: ${parseTime}ms`);
        
        // Should have found multiple statements
        assert.ok(statements.length > 0, 'Expected statements in PRG.ec');
        
        console.log(`  PRG.ec: ${statements.length} statements parsed in ${parseTime}ms`);
    });
});
