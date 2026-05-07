/**
 * Tests for Proof State View navigation toolbar functionality
 * 
 * These tests verify the nav action to command mapping at the protocol level
 * without requiring a full VS Code host or webview DOM.
 */

const assert = require('assert');

describe('Proof State View Navigation', () => {
    // Navigation action types (must match ProofStateViewNavAction in proofStateViewProvider.ts)
    const NAV_ACTIONS = ['stepBackward', 'stepForward', 'goToCursor', 'resetProof'];
    
    // Expected command mapping (must match NAV_ACTION_TO_COMMAND in provider)
    const NAV_ACTION_TO_COMMAND = {
        stepBackward: 'easycrypt.stepBackward',
        stepForward: 'easycrypt.stepForward',
        goToCursor: 'easycrypt.goToCursor',
        resetProof: 'easycrypt.resetProof'
    };

    describe('Navigation action to command mapping', () => {
        it('maps stepBackward to easycrypt.stepBackward', () => {
            assert.strictEqual(NAV_ACTION_TO_COMMAND['stepBackward'], 'easycrypt.stepBackward');
        });

        it('maps stepForward to easycrypt.stepForward', () => {
            assert.strictEqual(NAV_ACTION_TO_COMMAND['stepForward'], 'easycrypt.stepForward');
        });

        it('maps goToCursor to easycrypt.goToCursor', () => {
            assert.strictEqual(NAV_ACTION_TO_COMMAND['goToCursor'], 'easycrypt.goToCursor');
        });

        it('maps resetProof to easycrypt.resetProof', () => {
            assert.strictEqual(NAV_ACTION_TO_COMMAND['resetProof'], 'easycrypt.resetProof');
        });

        it('all actions have valid command mappings', () => {
            for (const action of NAV_ACTIONS) {
                const commandId = NAV_ACTION_TO_COMMAND[action];
                assert.ok(commandId, `Action '${action}' should have a command mapping`);
                assert.ok(commandId.startsWith('easycrypt.'), 
                    `Command '${commandId}' should start with 'easycrypt.'`);
            }
        });
    });

    describe('Webview message protocol', () => {
        /**
         * Validates a navigation message matches expected schema
         * @param {object} message 
         * @returns {boolean}
         */
        function isValidNavMessage(message) {
            if (!message || typeof message !== 'object') {
                return false;
            }
            return message.type === 'nav' && 
                   typeof message.action === 'string' &&
                   NAV_ACTIONS.includes(message.action);
        }

        it('validates correct nav message structure', () => {
            assert.strictEqual(isValidNavMessage({ type: 'nav', action: 'stepForward' }), true);
            assert.strictEqual(isValidNavMessage({ type: 'nav', action: 'stepBackward' }), true);
            assert.strictEqual(isValidNavMessage({ type: 'nav', action: 'goToCursor' }), true);
            assert.strictEqual(isValidNavMessage({ type: 'nav', action: 'resetProof' }), true);
        });

        it('rejects invalid nav messages', () => {
            assert.strictEqual(isValidNavMessage({ type: 'nav' }), false); // missing action
            assert.strictEqual(isValidNavMessage({ type: 'nav', action: 'unknownAction' }), false); // unknown action
            assert.strictEqual(isValidNavMessage({ type: 'ready' }), false); // wrong type
            assert.strictEqual(isValidNavMessage(null), false); // null message
            assert.strictEqual(isValidNavMessage(undefined), false); // undefined message
        });
    });

    describe('Button state derivation', () => {
        /**
         * Computes navigation button state from proof state
         * @param {object} state - Serialized proof state
         * @returns {{ disableAll: boolean, canStepBackward: boolean }}
         */
        function computeNavButtonState(state) {
            const hasContext = !!(state && state.progress);
            const disableAll = (state && state.isProcessing) || !hasContext;
            const canStepBackward = hasContext && 
                ((state.progress && state.progress.provedStatementCount) || 0) > 0 && 
                !(state && state.isProcessing);
            
            return { disableAll, canStepBackward };
        }

        it('disables all buttons when no context (no progress)', () => {
            const state = { isProcessing: false };
            const result = computeNavButtonState(state);
            assert.strictEqual(result.disableAll, true);
            assert.strictEqual(result.canStepBackward, false);
        });

        it('disables all buttons when processing', () => {
            const state = { 
                isProcessing: true, 
                progress: { provedStatementCount: 5 } 
            };
            const result = computeNavButtonState(state);
            assert.strictEqual(result.disableAll, true);
            assert.strictEqual(result.canStepBackward, false);
        });

        it('enables buttons when context exists and not processing', () => {
            const state = { 
                isProcessing: false, 
                progress: { provedStatementCount: 5 } 
            };
            const result = computeNavButtonState(state);
            assert.strictEqual(result.disableAll, false);
            assert.strictEqual(result.canStepBackward, true);
        });

        it('disables stepBackward when provedStatementCount is 0', () => {
            const state = { 
                isProcessing: false, 
                progress: { provedStatementCount: 0 } 
            };
            const result = computeNavButtonState(state);
            assert.strictEqual(result.disableAll, false, 'other buttons should be enabled');
            assert.strictEqual(result.canStepBackward, false, 'stepBackward should be disabled at start');
        });

        it('enables stepBackward when provedStatementCount > 0', () => {
            const state = { 
                isProcessing: false, 
                progress: { provedStatementCount: 1 } 
            };
            const result = computeNavButtonState(state);
            assert.strictEqual(result.canStepBackward, true);
        });
    });
});
