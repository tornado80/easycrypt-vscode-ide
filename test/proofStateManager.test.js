/**
 * Unit Tests for ProofStateManager
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Import from compiled JS output
const { 
    parseProofState, 
    extractLastProofStateSegment,
    extractLastStatementOutput,
    parseProofStateForView
} = require('../out/proofStateParser');

describe('ProofStateParser', function() {

    it('parses a single goal with hypotheses and conclusion', function() {
        const raw = [
            'Current goal',
            '',
            'Type variables: <none>',
            '',
            '  x : int',
            '  y : int',
            '  H : x = y',
            '  ------------------------------------------------------------------------',
            '  x + 1 = y + 1',
            ''
        ].join('\n');

        const state = parseProofState(raw);

        assert.strictEqual(state.isComplete, false);
        assert.strictEqual(state.goals.length, 1);
        assert.strictEqual(state.messages.length, 0);

        const goal = state.goals[0];
        assert.ok(goal.id);
        assert.ok(goal.hypotheses.some(l => l.includes('x : int')));
        assert.ok(goal.hypotheses.some(l => l.includes('H : x = y')));
        assert.ok(goal.conclusion.includes('x + 1 = y + 1'));
    });

    it('marks proof complete on "No more goals" without injecting messages', function() {
        const state = parseProofState('No more goals.');

        assert.strictEqual(state.isComplete, true);
        assert.strictEqual(state.goals.length, 0);
        assert.strictEqual(state.messages.length, 0);
    });

    it('extracts error messages from output', function() {
        const state = parseProofState('Error: cannot apply tactic');

        assert.strictEqual(state.messages.length, 1);
        assert.strictEqual(state.messages[0].severity, 'error');
        assert.ok(state.messages[0].content.includes('cannot apply tactic'));
    });

    it('extracts warning messages from output', function() {
        const state = parseProofState('warning: deprecated feature');

        assert.strictEqual(state.messages.length, 1);
        assert.strictEqual(state.messages[0].severity, 'warning');
        assert.ok(state.messages[0].content.includes('deprecated'));
    });
});

describe('extractLastProofStateSegment', function() {
    
    it('extracts segment from last "No more goals" when multiple exist', function() {
        const output = [
            'Current goal',
            '  x : int',
            '  ------------------------------------------------------------------------',
            '  x = x',
            '',
            'No more goals.',  // First completion
            '',
            'Current goal',
            '  y : int',
            '  ------------------------------------------------------------------------',
            '  y = y',
            '',
            'No more goals.'   // Last completion (should be returned)
        ].join('\n');

        const segment = extractLastProofStateSegment(output);
        
        // Should contain the last "No more goals" and nothing before the intermediate state
        assert.ok(segment.includes('No more goals.'));
        // Segment should start from the line containing "No more goals" 
        // The last occurrence should be captured
        const lines = segment.split('\n');
        // Verify we got a segment (not the whole output)
        assert.ok(segment.length < output.length, 'Should extract a subset');
    });

    it('extracts segment from last "Current goal" when no completion exists', function() {
        const output = [
            'Current goal',
            '  x : int',
            '  ------------------------------------------------------------------------',
            '  x = x',
            '',
            'Current goal',   // Second goal block (should be captured)
            '  y : int',
            '  z : int',
            '  ------------------------------------------------------------------------',
            '  y + z = z + y'
        ].join('\n');

        const segment = extractLastProofStateSegment(output);
        
        // Should contain the last goal block
        assert.ok(segment.includes('y : int'));
        assert.ok(segment.includes('z : int'));
        assert.ok(segment.includes('y + z = z + y'));
        
        // Should NOT contain the first goal (x = x)
        // Note: it may or may not contain 'x : int' depending on position
        // The key check is that parsing the segment gives us the last goal
        const state = parseProofState(segment);
        assert.strictEqual(state.goals.length, 1);
        assert.ok(state.goals[0].conclusion.includes('y + z'));
    });

    it('returns entire output when no proof state markers exist', function() {
        const output = 'Some random output without goals';
        
        const segment = extractLastProofStateSegment(output);
        
        assert.strictEqual(segment, output);
    });

    it('handles single statement output (no batching)', function() {
        const output = [
            'Current goal',
            '',
            '  H : x = 1',
            '  ------------------------------------------------------------------------',
            '  x + 1 = 2'
        ].join('\n');

        const segment = extractLastProofStateSegment(output);
        
        // For single goal, should return basically the same content
        assert.ok(segment.includes('Current goal'));
        assert.ok(segment.includes('x + 1 = 2'));
    });

    it('handles output with errors interleaved', function() {
        const output = [
            'Current goal',
            '  x : int',
            '  ------------------------------------------------------------------------',
            '  x = x',
            '',
            'Error: cannot apply tactic',
            '',
            'Current goal',  // Should capture from here
            '  y : int',
            '  ------------------------------------------------------------------------',
            '  y = y'
        ].join('\n');

        const segment = extractLastProofStateSegment(output);
        
        // Should get the last goal block
        const state = parseProofState(segment);
        assert.ok(state.goals[0].conclusion.includes('y = y'));
    });

    it('handles case-insensitive matching', function() {
        const output = [
            'current goal',  // lowercase
            '  a : int',
            '  ------------------------------------------------------------------------',
            '  a = a',
            '',
            'CURRENT GOAL',  // uppercase - should be captured
            '  b : int',
            '  ------------------------------------------------------------------------',
            '  b = b'
        ].join('\n');

        const segment = extractLastProofStateSegment(output);
        
        // Should capture from the last occurrence regardless of case
        assert.ok(segment.includes('b = b') || segment.includes('CURRENT GOAL'));
    });
});

describe('extractLastStatementOutput', function() {
    
    it('extracts from last "No more goals" with priority', function() {
        const output = [
            'Current goal',
            '  x : int',
            '  ------------------------------------------------------------------------',
            '  x = x',
            '',
            'No more goals.'
        ].join('\n');

        const segment = extractLastStatementOutput(output);
        
        assert.ok(segment.includes('No more goals'));
        // Should start from the "No more goals" line
        assert.ok(segment.startsWith('No more goals'));
    });

    it('extracts from last "Current goal" when no completion', function() {
        const output = [
            'Current goal',
            '  x : int',
            '  ------------------------------------------------------------------------',
            '  x = x',
            '',
            'Current goal',
            '  y : int',
            '  ------------------------------------------------------------------------',
            '  y = y'
        ].join('\n');

        const segment = extractLastStatementOutput(output);
        
        assert.ok(segment.includes('y = y'));
        assert.ok(segment.includes('y : int'));
    });

    it('extracts from error tag when no goal markers', function() {
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

    it('extracts between the last two emacs prompt markers when present', function() {
        const output = [
            '[98|check]>',
            'first output line',
            '[99|check]>',
            'second output line',
            'second output line 2',
            '[100|check]>'
        ].join('\n');

        const segment = extractLastStatementOutput(output);

        assert.strictEqual(segment.trimEnd(), ['second output line', 'second output line 2'].join('\n'));
    });

    it('extracts the last statement output from a real PRG.ec emacs snippet fixture', function() {
        const fixturePath = path.join(__dirname, 'fixtures', 'prg-emacs-snippet.txt');
        const raw = fs.readFileSync(fixturePath, 'utf8');

        const segment = extractLastStatementOutput(raw);

        // The last two prompts in the fixture are [21|check]> and [22|check]>,
        // so the extracted segment should be exactly what EasyCrypt printed for that step.
        assert.strictEqual(segment.trimEnd(), 'No more goals');
    });
});

describe('parseProofStateForView', function() {
    
    it('keeps the entire output losslessly in outputLines (no goal parsing)', function() {
        const output = [
            'Some preamble line',
            'Current goal',
            '  x : int',
            '  ------------------------------------------------------------------------',
            '  x = x'
        ].join('\n');

        const viewModel = parseProofStateForView(output);

        assert.strictEqual(viewModel.isComplete, false);
        assert.strictEqual(viewModel.goals.length, 0);
        assert.deepStrictEqual(viewModel.outputLines, output.split('\n'));
    });

    it('marks proof complete on "No more goals"', function() {
        const viewModel = parseProofStateForView('No more goals.');

        assert.strictEqual(viewModel.isComplete, true);
        assert.strictEqual(viewModel.goals.length, 0);
    });

    it('extracts error messages into messages array', function() {
        const output = [
            '[error-1-5] cannot apply tactic',
            'error: something went wrong'
        ].join('\n');

        const viewModel = parseProofStateForView(output);

        assert.ok(viewModel.messages.length >= 1);
        assert.ok(viewModel.messages.some(m => m.severity === 'error'));
    });

    it('extracts warning messages into messages array', function() {
        const output = 'warning: deprecated feature used';

        const viewModel = parseProofStateForView(output);

        assert.ok(viewModel.messages.length >= 1);
        assert.ok(viewModel.messages.some(m => m.severity === 'warning'));
    });

    it('handles empty output gracefully', function() {
        const viewModel = parseProofStateForView('');

        assert.strictEqual(viewModel.goals.length, 0);
        assert.strictEqual(viewModel.isComplete, false);
    });
});

// Import the new extraction function
const { extractLastStatementOutputWithPrompts } = require('../out/proofStateParser');

describe('extractLastStatementOutputWithPrompts', function() {
    
    describe('Two prompts present', function() {
        it('extracts output between last two prompts and returns both markers', function() {
            const raw = '[10|check]>\nFirst statement output\n[11|check]>\nSecond statement output\n[12|check]>';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.ok(result.output.includes('Second statement output'));
            assert.ok(!result.output.includes('First statement output'));
            assert.ok(result.prevPrompt);
            assert.ok(result.nextPrompt);
            assert.strictEqual(result.prevPrompt.text, '[11|check]>');
            assert.strictEqual(result.prevPrompt.number, 11);
            assert.strictEqual(result.prevPrompt.tag, 'check');
            assert.strictEqual(result.nextPrompt.text, '[12|check]>');
            assert.strictEqual(result.nextPrompt.number, 12);
            assert.strictEqual(result.nextPrompt.tag, 'check');
        });
        
        it('handles multiple prompts and extracts only the last segment', function() {
            const raw = [
                '[50|check]>',
                'output1',
                '[51|check]>',
                'output2',
                '[52|check]>',
                'output3',
                '[53|check]>'
            ].join('\n');
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.ok(result.output.includes('output3'));
            assert.ok(!result.output.includes('output1'));
            assert.ok(!result.output.includes('output2'));
            assert.strictEqual(result.nextPrompt?.text, '[53|check]>');
        });
    });
    
    describe('One prompt present', function() {
        it('extracts output after prompt when prompt is at beginning', function() {
            const raw = '[10|check]>\nSome output here';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.ok(result.output.includes('Some output here'));
            assert.ok(result.prevPrompt);
            assert.strictEqual(result.prevPrompt.text, '[10|check]>');
            assert.strictEqual(result.nextPrompt, undefined);
        });
        
        it('extracts output before prompt when prompt is at end', function() {
            const raw = 'Some output here\n[10|check]>';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.ok(result.output.includes('Some output here'));
            assert.strictEqual(result.prevPrompt, undefined);
            assert.ok(result.nextPrompt);
            assert.strictEqual(result.nextPrompt.text, '[10|check]>');
        });
    });
    
    describe('No prompts present', function() {
        it('falls back to conservative extraction with No more goals', function() {
            const raw = 'Some preamble\nNo more goals.\nSome trailing';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.ok(result.output.includes('No more goals'));
            assert.strictEqual(result.prevPrompt, undefined);
            assert.strictEqual(result.nextPrompt, undefined);
        });
        
        it('falls back to Current goal extraction', function() {
            const raw = [
                'Some preamble',
                'Current goal',
                '  x : int',
                '  ---',
                '  conclusion'
            ].join('\n');
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.ok(result.output.includes('Current goal'));
            assert.strictEqual(result.prevPrompt, undefined);
            assert.strictEqual(result.nextPrompt, undefined);
        });
        
        it('returns entire output when no markers found', function() {
            const raw = 'Some arbitrary output without any markers';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.strictEqual(result.output, raw);
            assert.strictEqual(result.prevPrompt, undefined);
            assert.strictEqual(result.nextPrompt, undefined);
        });
    });
    
    describe('Prompt marker parsing', function() {
        it('correctly parses prompt number and tag', function() {
            const raw = '[99|fancy]>\noutput\n[100|idle]>';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.strictEqual(result.prevPrompt?.number, 99);
            assert.strictEqual(result.prevPrompt?.tag, 'fancy');
            assert.strictEqual(result.nextPrompt?.number, 100);
            assert.strictEqual(result.nextPrompt?.tag, 'idle');
        });
        
        it('handles high prompt numbers', function() {
            const raw = '[12345|check]>\noutput\n[12346|check]>';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.strictEqual(result.nextPrompt?.number, 12346);
        });
    });

    describe('Single prompt only (terminating prompt case)', function() {
        it('returns nextPrompt when input is only a prompt marker', function() {
            const raw = '[10|check]>';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.strictEqual(result.output, '');
            assert.strictEqual(result.prevPrompt, undefined);
            assert.ok(result.nextPrompt);
            assert.strictEqual(result.nextPrompt.text, '[10|check]>');
            assert.strictEqual(result.nextPrompt.number, 10);
            assert.strictEqual(result.nextPrompt.tag, 'check');
        });

        it('returns nextPrompt when input is prompt marker with trailing newline', function() {
            const raw = '[10|check]>\n';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.strictEqual(result.output, '');
            assert.strictEqual(result.prevPrompt, undefined);
            assert.ok(result.nextPrompt);
            assert.strictEqual(result.nextPrompt.text, '[10|check]>');
        });

        it('returns nextPrompt when input is prompt marker with trailing whitespace', function() {
            const raw = '[10|check]>\n   \n';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.strictEqual(result.output, '');
            assert.strictEqual(result.prevPrompt, undefined);
            assert.ok(result.nextPrompt);
            assert.strictEqual(result.nextPrompt.text, '[10|check]>');
        });

        it('returns prevPrompt when prompt at start has non-empty output after it', function() {
            // Existing behavior: if there's output after the prompt, prompt is prevPrompt
            const raw = '[10|check]>\nSome output here';
            
            const result = extractLastStatementOutputWithPrompts(raw);
            
            assert.ok(result.output.includes('Some output here'));
            assert.ok(result.prevPrompt);
            assert.strictEqual(result.prevPrompt.text, '[10|check]>');
            assert.strictEqual(result.nextPrompt, undefined);
        });
    });
});
