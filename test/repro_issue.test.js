
const assert = require('assert');
const { parseOutput } = require('../out/outputParser');

describe('Reproduction Issue Tests', function() {
    it('should parse syntax error with location in message', function() {
        // Simulating a potential output for "module." syntax error
        // If easycrypt outputs "parse error at line 306, column 1"
        const output = 'parse error at line 306, column 1';
        const result = parseOutput(output);
        
        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.errors[0].range.start.line, 306);
        assert.strictEqual(result.errors[0].range.start.column, 1);
    });

    it('should parse syntax error with location range in message', function() {
        const output = 'parse error at line 306, column 1 to line 306, column 7';
        const result = parseOutput(output);
        
        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.errors[0].range.start.line, 306);
        assert.strictEqual(result.errors[0].range.end.column, 7);
    });

    it('should parse syntax error with unexpected token', function() {
        const output = 'parse error: unexpected token "." at line 306, column 7';
        const result = parseOutput(output);
        
        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.errors[0].range.start.line, 306);
        assert.strictEqual(result.errors[0].range.start.column, 7);
    });

    it('should parse generic error with location', function() {
        const output = 'error: some generic error at line 306, column 1';
        const result = parseOutput(output);
        
        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.errors[0].range.start.line, 306);
    });
});
