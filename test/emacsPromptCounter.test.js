/**
 * Unit Tests for EasyCrypt Emacs Prompt Counter
 * 
 * Tests the prompt counting logic that handles:
 * - Leading prompt coalescing (prompt from previous command at start of chunk)
 * - Multiple prompts in a single chunk
 * - Edge cases in prompt detection
 * 
 * Related plan: proof-state-view-prompt-statement-sync-plan.md
 */

const assert = require('assert');
const { 
    createPromptCounterState, 
    countResponsePrompts, 
    EmacsPromptCounter 
} = require('../out/emacsPromptCounter');

describe('EasyCrypt Emacs Prompt Counter', function() {

    describe('countResponsePrompts - basic counting', function() {

        it('counts a single prompt at the end of response', function() {
            const state = createPromptCounterState();
            const chunk = 'Some output\n[1|check]>';
            
            const result = countResponsePrompts(chunk, state);
            
            assert.strictEqual(result.totalPrompts, 1);
            assert.strictEqual(result.responsePrompts, 1);
            assert.deepStrictEqual(result.promptNumbers, [1]);
            assert.strictEqual(state.totalResponsePrompts, 1);
        });

        it('counts multiple prompts in one chunk', function() {
            const state = createPromptCounterState();
            const chunk = 'Output 1\n[1|check]>\nOutput 2\n[2|check]>';
            
            const result = countResponsePrompts(chunk, state);
            
            assert.strictEqual(result.totalPrompts, 2);
            assert.strictEqual(result.responsePrompts, 2);
            assert.deepStrictEqual(result.promptNumbers, [1, 2]);
        });

        it('returns zero for chunk without prompts', function() {
            const state = createPromptCounterState();
            const chunk = 'Some output without prompts';
            
            const result = countResponsePrompts(chunk, state);
            
            assert.strictEqual(result.totalPrompts, 0);
            assert.strictEqual(result.responsePrompts, 0);
            assert.deepStrictEqual(result.promptNumbers, []);
        });

        it('handles empty chunk', function() {
            const state = createPromptCounterState();
            
            const result = countResponsePrompts('', state);
            
            assert.strictEqual(result.totalPrompts, 0);
            assert.strictEqual(result.responsePrompts, 0);
        });

    });

    describe('countResponsePrompts - leading prompt handling', function() {

        it('ignores startup prompt [0|check]> even when preceded by banner text', function() {
            const state = createPromptCounterState();
            const chunk = [
                'Copyright (c) EasyCrypt contributors',
                'GIT hash: r2025.10-2-gc063e99',
                '[0|check]>',
                '+ added lemma: `X`',
                '[1|check]>'
            ].join('\n');

            const result = countResponsePrompts(chunk, state);

            // The initial [0|check]> is a pre-command prompt and must not count.
            assert.strictEqual(result.totalPrompts, 2);
            assert.strictEqual(result.responsePrompts, 1);
            assert.deepStrictEqual(result.promptNumbers, [0, 1]);
            assert.strictEqual(state.totalResponsePrompts, 1);
            assert.strictEqual(state.ignoredStartupPrompt, true);
            assert.strictEqual(state.ignoredLeadingPrompt, false);
        });

        it('ignores leading prompt when it appears at start before content', function() {
            const state = createPromptCounterState();
            // Simulates: prompt from previous command coalesced with current response
            const chunk = '[50|check]>\nSome response output\n[51|check]>';
            
            const result = countResponsePrompts(chunk, state);
            
            // First prompt (0) is leading, second (1) is the response prompt
            assert.strictEqual(result.totalPrompts, 2);
            assert.strictEqual(result.responsePrompts, 1);
            assert.strictEqual(state.ignoredLeadingPrompt, true);
        });

        it('does NOT ignore leading prompt when there is content before it', function() {
            const state = createPromptCounterState();
            // Content appears before the prompt, so it's a response prompt
            const chunk = 'Some output\n[1|check]>';
            
            const result = countResponsePrompts(chunk, state);
            
            assert.strictEqual(result.totalPrompts, 1);
            assert.strictEqual(result.responsePrompts, 1);
            assert.strictEqual(state.ignoredLeadingPrompt, false);
        });

        it('only ignores leading prompt once per command batch', function() {
            const state = createPromptCounterState();
            
            // First chunk: leading prompt followed by content and response prompt
            const chunk1 = '[10|check]>\nOutput\n[11|check]>';
            const result1 = countResponsePrompts(chunk1, state);
            
            assert.strictEqual(result1.responsePrompts, 1);
            assert.strictEqual(state.ignoredLeadingPrompt, true);
            
            // Second chunk: another leading prompt pattern, but we already ignored one
            const chunk2 = '[12|check]>\nMore output\n[13|check]>';
            const result2 = countResponsePrompts(chunk2, state);
            
            // Both prompts should be counted (no more ignoring)
            assert.strictEqual(result2.responsePrompts, 2);
            assert.strictEqual(state.totalResponsePrompts, 3);
        });

        it('does not ignore prompt when chunk is prompt-only (no content)', function() {
            const state = createPromptCounterState();
            // Just a prompt, no other content - this is a valid response prompt
            const chunk = '[1|check]>';
            
            const result = countResponsePrompts(chunk, state);
            
            // No content after the prompt, so don't ignore it
            assert.strictEqual(result.responsePrompts, 1);
            assert.strictEqual(state.ignoredLeadingPrompt, false);
        });

        it('handles real-world scenario: batch with leading prompt coalescing', function() {
            const state = createPromptCounterState();
            
            // Chunk 1: Previous command's trailing prompt + first command's output + prompt
            const chunk1 = '[50|check]>\nProcessed statement 1\n[51|check]>';
            const result1 = countResponsePrompts(chunk1, state);
            
            // [50] is leading (ignored), [51] is response
            assert.strictEqual(result1.responsePrompts, 1);
            
            // Chunk 2: Second command's output + prompt
            const chunk2 = 'Processed statement 2\n[52|check]>';
            const result2 = countResponsePrompts(chunk2, state);
            
            assert.strictEqual(result2.responsePrompts, 1);
            
            // Total: 2 response prompts
            assert.strictEqual(state.totalResponsePrompts, 2);
        });

    });

    describe('countResponsePrompts - edge cases', function() {

        it('handles prompts with different tag types', function() {
            const state = createPromptCounterState();
            const chunk = '[1|tactic]>\n[2|check]>\n[3|proof]>';
            
            const result = countResponsePrompts(chunk, state);
            
            assert.strictEqual(result.totalPrompts, 3);
            assert.deepStrictEqual(result.promptNumbers, [1, 2, 3]);
        });

        it('handles high prompt numbers', function() {
            const state = createPromptCounterState();
            const chunk = 'Output\n[12345|check]>';
            
            const result = countResponsePrompts(chunk, state);
            
            assert.strictEqual(result.responsePrompts, 1);
            assert.deepStrictEqual(result.promptNumbers, [12345]);
        });

        it('accumulates state across multiple chunks', function() {
            const state = createPromptCounterState();
            
            countResponsePrompts('Output 1\n[1|check]>', state);
            countResponsePrompts('Output 2\n[2|check]>', state);
            countResponsePrompts('Output 3\n[3|check]>', state);
            
            assert.strictEqual(state.totalResponsePrompts, 3);
            assert.deepStrictEqual(state.allPromptNumbers, [1, 2, 3]);
        });

        it('handles whitespace variations in prompts', function() {
            const state = createPromptCounterState();
            // Prompts can have trailing whitespace
            const chunk = 'Output\n[1|check]>   \nMore\n[2|check]>\n';
            
            const result = countResponsePrompts(chunk, state);
            
            assert.strictEqual(result.totalPrompts, 2);
            assert.strictEqual(result.responsePrompts, 2);
        });

    });

    describe('EmacsPromptCounter class', function() {

        it('provides clean API for prompt counting', function() {
            const counter = new EmacsPromptCounter();
            
            counter.ingestChunk('[50|check]>\nOutput\n[51|check]>');
            counter.ingestChunk('More output\n[2|check]>');
            
            assert.strictEqual(counter.getTotalResponsePrompts(), 2);
            assert.strictEqual(counter.hasIgnoredLeadingPrompt(), true);
        });

        it('reset clears all state', function() {
            const counter = new EmacsPromptCounter();
            
            counter.ingestChunk('[50|check]>\nOutput\n[51|check]>');
            assert.strictEqual(counter.getTotalResponsePrompts(), 1);
            
            counter.reset();
            
            assert.strictEqual(counter.getTotalResponsePrompts(), 0);
            assert.strictEqual(counter.hasIgnoredLeadingPrompt(), false);
            assert.deepStrictEqual(counter.getAllPromptNumbers(), []);
        });

        it('provides debug summary', function() {
            const counter = new EmacsPromptCounter();
            counter.ingestChunk('[50|check]>\nOutput\n[51|check]>');
            
            const summary = counter.getDebugSummary();
            
            assert.ok(summary.includes('responsePrompts=1'));
            assert.ok(summary.includes('ignoredLeading=true') || summary.includes('ignoredStartup=true'));
        });

    });

    describe('Integration scenarios', function() {

        it('simulates PRG.ec goToCursor+stepBackward scenario', function() {
            // This test simulates the scenario from the plan where:
            // 1. User runs goToCursor (batch of ~54 statements)
            // 2. First chunk contains a leading prompt from process startup
            // 3. The counter should not resolve early
            
            const counter = new EmacsPromptCounter();
            const expectedStatements = 54;
            
            // Simulated first chunk: leading prompt + responses
            // (In real scenario, the leading prompt appears from process greeting)
            const chunk1 = '[0|check]>\nProcessed line 1\n[1|check]>\nProcessed line 2\n[2|check]>';
            const result1 = counter.ingestChunk(chunk1);
            
            // [0] is leading (ignored), [1] and [2] are response prompts
            assert.strictEqual(result1.responsePrompts, 2);
            assert.strictEqual(counter.hasIgnoredLeadingPrompt(), true);
            
            // More chunks...
            for (let i = 3; i <= expectedStatements; i++) {
                counter.ingestChunk(`Output ${i}\n[${i}|check]>`);
            }
            
            // Should have exactly 54 response prompts (not 55)
            assert.strictEqual(counter.getTotalResponsePrompts(), expectedStatements);
        });

        it('handles batch where all prompts arrive in one chunk', function() {
            const counter = new EmacsPromptCounter();
            
            // All 5 statements' prompts arrive at once (plus a leading prompt)
            const chunk = [
                '[0|check]>',
                'Output 1', '[1|check]>',
                'Output 2', '[2|check]>',
                'Output 3', '[3|check]>',
                'Output 4', '[4|check]>',
                'Output 5', '[5|check]>'
            ].join('\n');
            
            const result = counter.ingestChunk(chunk);
            
            // 6 total prompts, but [0] is leading
            assert.strictEqual(result.totalPrompts, 6);
            assert.strictEqual(result.responsePrompts, 5);
            assert.strictEqual(counter.getTotalResponsePrompts(), 5);
        });

    });

});
