/**
 * Unit tests for UndoStateTracker
 * 
 * Tests the undo state tracking logic for fast backward navigation.
 * 
 * Note: We import from undoStateTrackerCore to avoid vscode module dependency.
 */

const assert = require('assert');

// Import from the core module (compiled JS) - no vscode dependency
const {
    parseEmacsPrompt,
    extractAllPrompts,
    UndoStateTrackerCore
} = require('../out/undoStateTrackerCore');

// Alias for tests - the core has the same API we need to test
const UndoStateTracker = UndoStateTrackerCore;

describe('UndoStateTracker', function () {
    describe('parseEmacsPrompt', function () {
        it('parses a valid prompt', function () {
            const result = parseEmacsPrompt('[5|check]>');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.promptInfo.uuid, 5);
            assert.strictEqual(result.promptInfo.mode, 'check');
        });

        it('parses prompt with different modes', function () {
            const result = parseEmacsPrompt('[10|weakcheck]>');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.promptInfo.uuid, 10);
            assert.strictEqual(result.promptInfo.mode, 'weakcheck');
        });

        it('returns failure for invalid prompt', function () {
            const result = parseEmacsPrompt('not a prompt');
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.promptInfo, undefined);
        });

        it('returns failure for malformed prompt', function () {
            const result = parseEmacsPrompt('[abc|check]>');
            assert.strictEqual(result.success, false);
        });
    });

    describe('extractAllPrompts', function () {
        it('extracts single prompt', function () {
            const prompts = extractAllPrompts('output\n[1|check]>');
            assert.strictEqual(prompts.length, 1);
            assert.strictEqual(prompts[0].promptInfo.uuid, 1);
        });

        it('extracts multiple prompts', function () {
            const prompts = extractAllPrompts('[1|check]>\noutput\n[2|check]>\nmore\n[3|check]>');
            assert.strictEqual(prompts.length, 3);
            assert.strictEqual(prompts[0].promptInfo.uuid, 1);
            assert.strictEqual(prompts[1].promptInfo.uuid, 2);
            assert.strictEqual(prompts[2].promptInfo.uuid, 3);
        });

        it('returns empty array for no prompts', function () {
            const prompts = extractAllPrompts('no prompts here');
            assert.strictEqual(prompts.length, 0);
        });

        it('extracts prompts with positions', function () {
            const text = 'abc[1|check]>def';
            const prompts = extractAllPrompts(text);
            assert.strictEqual(prompts.length, 1);
            assert.strictEqual(prompts[0].index, 3);
            assert.strictEqual(prompts[0].length, 10);
        });
    });

    describe('UndoStateTracker', function () {
        let tracker;

        beforeEach(function () {
            tracker = new UndoStateTracker(undefined, false);
            tracker.initialize(0);
        });

        afterEach(function () {
            // Core module doesn't have dispose - it's only on the VS Code wrapper
            if (tracker.dispose) {
                tracker.dispose();
            }
        });

        describe('initialization', function () {
            it('starts valid', function () {
                assert.strictEqual(tracker.isValid(), true);
            });

            it('starts with zero statements', function () {
                assert.strictEqual(tracker.getTrackedStatementCount(), 0);
            });

            it('starts with uuid 0', function () {
                assert.strictEqual(tracker.getCurrentUuid(), 0);
            });
        });

        describe('single statement tracking', function () {
            it('tracks a single statement', function () {
                tracker.beforeStatementSend(0);
                tracker.afterStatementProcessed(0, { uuid: 1, mode: 'check' });

                assert.strictEqual(tracker.getTrackedStatementCount(), 1);
                assert.strictEqual(tracker.getCurrentUuid(), 1);
            });

            it('records correct pre-state uuid', function () {
                tracker.beforeStatementSend(0);
                tracker.afterStatementProcessed(0, { uuid: 1, mode: 'check' });

                const target = tracker.getUndoTarget(0);
                assert.strictEqual(target, 0);
            });
        });

        describe('multiple statement tracking', function () {
            it('tracks multiple statements sequentially', function () {
                // Statement 0
                tracker.beforeStatementSend(0);
                tracker.afterStatementProcessed(0, { uuid: 1, mode: 'check' });

                // Statement 1
                tracker.beforeStatementSend(1);
                tracker.afterStatementProcessed(1, { uuid: 2, mode: 'check' });

                // Statement 2
                tracker.beforeStatementSend(2);
                tracker.afterStatementProcessed(2, { uuid: 3, mode: 'check' });

                assert.strictEqual(tracker.getTrackedStatementCount(), 3);
                assert.strictEqual(tracker.getCurrentUuid(), 3);
            });

            it('records correct pre-state uuids for each statement', function () {
                tracker.beforeStatementSend(0);
                tracker.afterStatementProcessed(0, { uuid: 1, mode: 'check' });

                tracker.beforeStatementSend(1);
                tracker.afterStatementProcessed(1, { uuid: 2, mode: 'check' });

                tracker.beforeStatementSend(2);
                tracker.afterStatementProcessed(2, { uuid: 3, mode: 'check' });

                assert.strictEqual(tracker.getUndoTarget(0), 0);
                assert.strictEqual(tracker.getUndoTarget(1), 1);
                assert.strictEqual(tracker.getUndoTarget(2), 2);
            });
        });

        describe('getUndoTargetForBackwardJump', function () {
            beforeEach(function () {
                // Set up 5 statements
                for (let i = 0; i < 5; i++) {
                    tracker.beforeStatementSend(i);
                    tracker.afterStatementProcessed(i, { uuid: i + 1, mode: 'check' });
                }
            });

            it('returns correct target for jump from 5 to 3 statements', function () {
                const target = tracker.getUndoTargetForBackwardJump(5, 3);
                // To have 3 statements, undo to preStateUuid[3] = 3
                assert.strictEqual(target, 3);
            });

            it('returns correct target for jump from 5 to 0 statements', function () {
                const target = tracker.getUndoTargetForBackwardJump(5, 0);
                // To have 0 statements, undo to preStateUuid[0] = 0
                assert.strictEqual(target, 0);
            });

            it('returns undefined for forward jump', function () {
                const target = tracker.getUndoTargetForBackwardJump(3, 5);
                assert.strictEqual(target, undefined);
            });

            it('returns undefined for no-op', function () {
                const target = tracker.getUndoTargetForBackwardJump(5, 5);
                assert.strictEqual(target, undefined);
            });
        });

        describe('batch processing', function () {
            it('tracks a batch of statements', function () {
                const promptInfos = [
                    { uuid: 1, mode: 'check' },
                    { uuid: 2, mode: 'check' },
                    { uuid: 3, mode: 'check' }
                ];
                const success = tracker.afterBatchProcessed(0, 3, promptInfos);

                assert.strictEqual(success, true);
                assert.strictEqual(tracker.getTrackedStatementCount(), 3);
                assert.strictEqual(tracker.getCurrentUuid(), 3);
            });

            it('records correct pre-state uuids for batch', function () {
                const promptInfos = [
                    { uuid: 1, mode: 'check' },
                    { uuid: 2, mode: 'check' },
                    { uuid: 3, mode: 'check' }
                ];
                tracker.afterBatchProcessed(0, 3, promptInfos);

                assert.strictEqual(tracker.getUndoTarget(0), 0);
                assert.strictEqual(tracker.getUndoTarget(1), 1);
                assert.strictEqual(tracker.getUndoTarget(2), 2);
            });

            it('fails on prompt count mismatch', function () {
                const promptInfos = [
                    { uuid: 1, mode: 'check' },
                    { uuid: 2, mode: 'check' }
                ];
                const success = tracker.afterBatchProcessed(0, 3, promptInfos);

                assert.strictEqual(success, false);
                assert.strictEqual(tracker.isValid(), false);
            });
        });

        describe('afterUndoSucceeded', function () {
            beforeEach(function () {
                // Set up 5 statements
                for (let i = 0; i < 5; i++) {
                    tracker.beforeStatementSend(i);
                    tracker.afterStatementProcessed(i, { uuid: i + 1, mode: 'check' });
                }
            });

            it('truncates mapping after undo', function () {
                tracker.afterUndoSucceeded(3, 3);

                assert.strictEqual(tracker.getTrackedStatementCount(), 3);
                assert.strictEqual(tracker.getCurrentUuid(), 3);
            });

            it('preserves remaining mappings after undo', function () {
                tracker.afterUndoSucceeded(3, 3);

                assert.strictEqual(tracker.getUndoTarget(0), 0);
                assert.strictEqual(tracker.getUndoTarget(1), 1);
                assert.strictEqual(tracker.getUndoTarget(2), 2);
                assert.strictEqual(tracker.getUndoTarget(3), undefined);
            });

            it('handles undo to 0 statements', function () {
                tracker.afterUndoSucceeded(0, 0);

                assert.strictEqual(tracker.getTrackedStatementCount(), 0);
                assert.strictEqual(tracker.getCurrentUuid(), 0);
            });
        });

        describe('invalidation', function () {
            it('invalidates on non-monotonic uuid', function () {
                tracker.beforeStatementSend(0);
                tracker.afterStatementProcessed(0, { uuid: 1, mode: 'check' });

                tracker.beforeStatementSend(1);
                // uuid goes backward
                tracker.afterStatementProcessed(1, { uuid: 0, mode: 'check' });

                assert.strictEqual(tracker.isValid(), false);
            });

            it('invalidates on out-of-order statement index', function () {
                tracker.beforeStatementSend(0);
                tracker.afterStatementProcessed(0, { uuid: 1, mode: 'check' });

                // Skip statement 1
                tracker.beforeStatementSend(2);

                assert.strictEqual(tracker.isValid(), false);
            });

            it('returns undefined for undo target when invalid', function () {
                tracker.beforeStatementSend(0);
                tracker.afterStatementProcessed(0, { uuid: 1, mode: 'check' });

                // Invalidate
                tracker.beforeStatementSend(5); // wrong index

                assert.strictEqual(tracker.getUndoTarget(0), undefined);
            });
        });

        describe('reset', function () {
            it('clears all state', function () {
                tracker.beforeStatementSend(0);
                tracker.afterStatementProcessed(0, { uuid: 1, mode: 'check' });

                tracker.reset();

                assert.strictEqual(tracker.isValid(), true);
                assert.strictEqual(tracker.getTrackedStatementCount(), 0);
                assert.strictEqual(tracker.getCurrentUuid(), 0);
            });
        });
    });
});
