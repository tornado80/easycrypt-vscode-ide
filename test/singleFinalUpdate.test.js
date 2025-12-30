/**
 * Unit Tests for Proof State View — Single Final Update
 * 
 * Tests the behavior ensuring the Proof State view shows only a single
 * final update for long-running navigation operations (no repeated "last output").
 * 
 * Related plan: proof-state-view-single-final-update-plan.md
 * 
 * Note: Tests for ProofStateManager transaction API require VS Code and
 * are in the integration tests (test/e2e/). This file tests only the
 * pure functions that don't depend on VS Code.
 */

const assert = require('assert');

// Import only pure functions from compiled JS output (no VS Code dependency)
const { extractLastStatementOutput, parseProofStateForView } = require('../out/proofStateParser');

describe('Proof State View — Single Final Update', function() {

    describe('extractLastStatementOutput with EasyCrypt emacs prompts', function() {

        it('extracts output between last two prompt markers', function() {
            const output = [
                '[98|check]>',
                'first command output',
                '[99|check]>',
                'second command output',
                'more output',
                '[100|check]>'
            ].join('\n');

            const segment = extractLastStatementOutput(output);

            assert.strictEqual(segment.trimEnd(), ['second command output', 'more output'].join('\n'));
        });

        it('handles single prompt at the beginning', function() {
            const output = [
                '[1|check]>',
                'command output',
                'more output'
            ].join('\n');

            const segment = extractLastStatementOutput(output);

            assert.ok(segment.includes('command output'));
            assert.ok(segment.includes('more output'));
        });

        it('falls back to marker extraction when no prompts', function() {
            const output = [
                'Some output',
                'Current goal',
                '  x : int',
                '  ---',
                '  x = x'
            ].join('\n');

            const segment = extractLastStatementOutput(output);

            assert.ok(segment.includes('Current goal'));
            assert.ok(segment.includes('x = x'));
        });

        it('handles output with multiple goal blocks (no prompts)', function() {
            const output = [
                'Current goal',
                '  x : int',
                '  ---',
                '  x = x',
                '',
                'Current goal',
                '  y : int',
                '  ---',
                '  y = y'
            ].join('\n');

            const segment = extractLastStatementOutput(output);

            // Should extract from the last "Current goal"
            assert.ok(segment.includes('y = y'));
            assert.ok(segment.includes('y : int'));
        });

        it('prioritizes "No more goals" over "Current goal"', function() {
            const output = [
                'Current goal',
                '  x : int',
                '  ---',
                '  x = x',
                '',
                'No more goals.'
            ].join('\n');

            const segment = extractLastStatementOutput(output);

            assert.ok(segment.startsWith('No more goals'));
        });

        it('handles error tags when no goal markers', function() {
            const output = [
                'Some preamble',
                '[error-1-5] cannot apply tactic',
                'Additional error info'
            ].join('\n');

            const segment = extractLastStatementOutput(output);

            assert.ok(segment.includes('[error-1-5]'));
        });

        it('returns entire output when no markers found', function() {
            const output = 'Some output without any markers';

            const segment = extractLastStatementOutput(output);

            assert.strictEqual(segment, output);
        });

        it('handles empty output', function() {
            const segment = extractLastStatementOutput('');

            assert.strictEqual(segment, '');
        });

        it('handles output with only whitespace', function() {
            const output = '   \n\n   ';

            const segment = extractLastStatementOutput(output);

            assert.strictEqual(segment, output);
        });
    });

    describe('parseProofStateForView - lossless parsing', function() {

        it('preserves all output lines verbatim', function() {
            const output = [
                'Line 1',
                '  indented line',
                '',
                'Line after blank'
            ].join('\n');

            const viewModel = parseProofStateForView(output);

            assert.deepStrictEqual(viewModel.outputLines, [
                'Line 1',
                '  indented line',
                '',
                'Line after blank'
            ]);
        });

        it('marks proof complete on "No more goals"', function() {
            const viewModel = parseProofStateForView('No more goals.');

            assert.strictEqual(viewModel.isComplete, true);
        });

        it('extracts error messages with severity', function() {
            const output = '[error-1-5] cannot apply tactic';

            const viewModel = parseProofStateForView(output);

            assert.ok(viewModel.messages.length >= 1);
            assert.ok(viewModel.messages.some(m => m.severity === 'error'));
        });

        it('extracts warning messages with severity', function() {
            const output = 'warning: deprecated feature';

            const viewModel = parseProofStateForView(output);

            assert.ok(viewModel.messages.length >= 1);
            assert.ok(viewModel.messages.some(m => m.severity === 'warning'));
        });

        it('handles output with mixed content', function() {
            const output = [
                'Some info',
                'Current goal',
                '  x : int',
                '  ---',
                '  x = x',
                'warning: something'
            ].join('\n');

            const viewModel = parseProofStateForView(output);

            // All lines preserved
            assert.strictEqual(viewModel.outputLines.length, 6);
            
            // Warning extracted
            assert.ok(viewModel.messages.some(m => m.severity === 'warning'));
        });

        it('handles empty output gracefully', function() {
            const viewModel = parseProofStateForView('');

            assert.strictEqual(viewModel.goals.length, 0);
            assert.strictEqual(viewModel.isComplete, false);
            assert.deepStrictEqual(viewModel.outputLines, ['']);
        });
    });

    describe('Combined extraction and parsing', function() {

        it('correctly processes batched output with multiple statements', function() {
            const batchedOutput = [
                '[1|check]>',
                'first statement output',
                '[2|check]>',
                'Current goal',
                '  x : int',
                '  ---',
                '  x = x',
                '[3|check]>'
            ].join('\n');

            // Extract last statement output
            const lastOutput = extractLastStatementOutput(batchedOutput);

            // Parse for view
            const viewModel = parseProofStateForView(lastOutput);

            // Should have the goal block in output lines
            assert.ok(viewModel.outputLines.some(l => l.includes('Current goal')));
            assert.ok(viewModel.outputLines.some(l => l.includes('x = x')));
        });

        it('correctly processes batched output ending with No more goals', function() {
            const batchedOutput = [
                '[1|check]>',
                'Current goal',
                '  x : int',
                '  ---',
                '  x = x',
                '[2|check]>',
                'No more goals',
                '[3|check]>'
            ].join('\n');

            // Extract last statement output
            const lastOutput = extractLastStatementOutput(batchedOutput);

            // Parse for view
            const viewModel = parseProofStateForView(lastOutput);

            // Should be marked complete
            assert.strictEqual(viewModel.isComplete, true);
            assert.ok(viewModel.outputLines.some(l => l.includes('No more goals')));
        });
    });
});

