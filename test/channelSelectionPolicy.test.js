const assert = require('assert');

const { DefaultChannelSelectionPolicy } = require('../out/channelSelectionPolicy');

describe('DefaultChannelSelectionPolicy', function () {
    it('keeps explicit emacs selection', function () {
        const policy = new DefaultChannelSelectionPolicy();
        const decision = policy.resolvePreferredChannel({
            preferredChannel: 'emacs',
            configArgs: ['-I', 'theories'],
            proverArgs: ['--dummy-prover-arg']
        });

        assert.strictEqual(decision.channel, 'emacs');
        assert.strictEqual(decision.reason, 'explicit-emacs');
        assert.strictEqual(decision.hasCompatibilityRisk, true);
    });

    it('keeps explicit lsp selection', function () {
        const policy = new DefaultChannelSelectionPolicy();
        const decision = policy.resolvePreferredChannel({
            preferredChannel: 'lsp',
            configArgs: [],
            proverArgs: []
        });

        assert.strictEqual(decision.channel, 'lsp');
        assert.strictEqual(decision.reason, 'explicit-lsp');
        assert.strictEqual(decision.hasCompatibilityRisk, false);
    });

    it('selects lsp in auto mode for empty args', function () {
        const policy = new DefaultChannelSelectionPolicy();
        const decision = policy.resolvePreferredChannel({
            preferredChannel: 'auto',
            configArgs: [],
            proverArgs: []
        });

        assert.strictEqual(decision.channel, 'lsp');
        assert.strictEqual(decision.reason, 'auto-compatible');
        assert.strictEqual(decision.hasCompatibilityRisk, false);
    });

    it('selects emacs in auto mode when args are context-sensitive', function () {
        const policy = new DefaultChannelSelectionPolicy();
        const decision = policy.resolvePreferredChannel({
            preferredChannel: 'auto',
            configArgs: ['-I', 'theories'],
            proverArgs: []
        });

        assert.strictEqual(decision.channel, 'emacs');
        assert.strictEqual(decision.reason, 'auto-context-risk');
        assert.strictEqual(decision.hasCompatibilityRisk, true);
    });
});
