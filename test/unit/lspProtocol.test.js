const assert = require('assert');

const { parseLspProofResponse, parseLspQueryResponse } = require('../../out/lspProtocol');

describe('LSP Protocol Parsing', function () {
    it('parses valid proof responses', function () {
        const parsed = parseLspProofResponse({
            output: 'Current goal\\n',
            processedEnd: 42,
            sentenceStart: 10,
            sentenceEnd: 20,
            uuid: 7,
            mode: 'check'
        });

        assert.strictEqual(parsed.output, 'Current goal\\n');
        assert.strictEqual(parsed.processedEnd, 42);
        assert.strictEqual(parsed.sentenceStart, 10);
        assert.strictEqual(parsed.sentenceEnd, 20);
        assert.strictEqual(parsed.uuid, 7);
        assert.strictEqual(parsed.mode, 'check');
    });

    it('accepts nullable sentence boundaries', function () {
        const parsed = parseLspProofResponse({
            output: 'No more goals.',
            processedEnd: 12,
            sentenceStart: null,
            sentenceEnd: null,
            uuid: 9,
            mode: 'check'
        });

        assert.strictEqual(parsed.sentenceStart, null);
        assert.strictEqual(parsed.sentenceEnd, null);
    });

    it('rejects malformed proof responses', function () {
        assert.throws(() => {
            parseLspProofResponse({ output: 'x', processedEnd: 'oops', uuid: 1, mode: 'check' });
        }, /processedEnd/);

        assert.throws(() => {
            parseLspProofResponse({ output: 'x', processedEnd: 1, uuid: 1 });
        }, /mode/);
    });

    it('parses valid query responses', function () {
        const parsed = parseLspQueryResponse({ output: 'locate foo' });
        assert.strictEqual(parsed.output, 'locate foo');
    });

    it('rejects malformed query responses', function () {
        assert.throws(() => {
            parseLspQueryResponse({ output: 123 });
        }, /output/);
    });
});
