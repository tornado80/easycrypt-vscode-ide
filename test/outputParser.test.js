/**
 * Unit Tests for EasyCrypt Output Parser
 * 
 * These tests verify that the output parser correctly handles various
 * EasyCrypt error message formats.
 */

const assert = require('assert');

// Since we're testing compiled output, import from the compiled JS
// In a real scenario, you'd set up proper TypeScript test infrastructure
const { 
    parseOutput, 
    parseError, 
    hasError, 
    isProofCompleted,
    parserPatterns 
} = require('../out/outputParser');

describe('OutputParser', function() {
    
    describe('parseOutput', function() {
        
        describe('Basic error tag format [error-LINE-COL]', function() {
            
            it('should parse simple error with line and column', function() {
                const output = '[error-10-5] unknown symbol: x';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.success, false);
                
                const error = result.errors[0];
                assert.strictEqual(error.severity, 'error');
                assert.strictEqual(error.range.start.line, 10);
                assert.strictEqual(error.range.start.column, 5);
                assert.ok(error.message.includes('unknown symbol'));
            });

            it('should parse error with full range [error-L1-C1-L2-C2]', function() {
                const output = '[error-5-10-5-25] type mismatch';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                
                const error = result.errors[0];
                assert.strictEqual(error.range.start.line, 5);
                assert.strictEqual(error.range.start.column, 10);
                assert.strictEqual(error.range.end.line, 5);
                assert.strictEqual(error.range.end.column, 25);
            });

            it('should handle multiline error range', function() {
                const output = '[error-10-1-15-20] expression spans multiple lines';
                const result = parseOutput(output);
                
                const error = result.errors[0];
                assert.strictEqual(error.range.start.line, 10);
                assert.strictEqual(error.range.end.line, 15);
            });

        });

        describe('Anomaly errors', function() {
            
            it('should parse anomaly errors', function() {
                const output = 'anomaly: internal error occurred';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.success, false);
                
                const error = result.errors[0];
                assert.strictEqual(error.code, 'anomaly');
                assert.ok(error.message.includes('Anomaly'));
            });

        });

        describe('Warning messages', function() {
            
            it('should parse warning with line/column', function() {
                const output = '[warning-8-3] unused variable';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                
                const error = result.errors[0];
                assert.strictEqual(error.severity, 'warning');
                assert.strictEqual(error.range.start.line, 8);
            });

            it('should parse warning without location', function() {
                const output = 'warning: deprecated feature used';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].severity, 'warning');
            });

        });

        describe('Type errors', function() {
            
            it('should parse type error messages', function() {
                const output = 'type error: expected int, got bool';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                
                const error = result.errors[0];
                assert.strictEqual(error.code, 'type-error');
                assert.ok(error.message.includes('Type error'));
                assert.ok(
                    error.range.end.column > error.range.start.column,
                    'Expected non-empty range for diagnostics'
                );
            });

        });

        describe('Syntax errors', function() {
            
            it('should parse syntax error messages', function() {
                const output = 'syntax error: unexpected token';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                
                const error = result.errors[0];
                assert.strictEqual(error.code, 'syntax-error');
            });

            it('should parse parse error messages', function() {
                const output = 'parse error: missing semicolon';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].code, 'syntax-error');
            });

        });

        describe('Location extraction from message', function() {
            
            it('should extract location from "at line X, column Y" format', function() {
                const output = 'error: at line 25, column 10: undefined variable';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                
                const error = result.errors[0];
                assert.strictEqual(error.range.start.line, 25);
                assert.strictEqual(error.range.start.column, 10);
                assert.ok(
                    error.range.end.column > error.range.start.column,
                    'Expected non-empty range for diagnostics'
                );
            });

            it('should extract range from "at line X, column Y to line X, column Z"', function() {
                const output = 'error: at line 5, column 1 to line 5, column 20: invalid expression';
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 1);
                
                const error = result.errors[0];
                assert.strictEqual(error.range.start.line, 5);
                assert.strictEqual(error.range.start.column, 1);
                assert.strictEqual(error.range.end.line, 5);
                assert.strictEqual(error.range.end.column, 20);
            });

        });

        describe('Proof completion detection', function() {
            
            it('should detect "No more goals" message', function() {
                const output = 'No more goals';
                const result = parseOutput(output);
                
                assert.strictEqual(result.proofCompleted, true);
                assert.strictEqual(result.success, true);
            });

            it('should handle case insensitive matching', function() {
                const output = 'no more goals';
                const result = parseOutput(output);
                
                assert.strictEqual(result.proofCompleted, true);
            });

        });

        describe('EasyCrypt compile output formats', function() {

            it('should parse easycrypt compile default [critical] location format', function() {
                const output = '[critical] [/tmp/easycrypt-bad.ec: line 4 (2-22)] parse error';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.severity, 'error');
                assert.strictEqual(err.filePath, '/tmp/easycrypt-bad.ec');
                assert.strictEqual(err.range.start.line, 4);
                assert.strictEqual(err.range.start.column, 2);
                assert.strictEqual(err.range.end.column, 22);
                assert.ok(err.message.toLowerCase().includes('parse error'));
            });

            it('should parse easycrypt compile -script E critical format (ignoring trailing progress)', function() {
                const output = 'E critical /tmp/easycrypt-bad.ec: line 4 (2-22) parse error P 4 53 0.64634 -1.00 -1.00';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.severity, 'error');
                assert.strictEqual(err.filePath, '/tmp/easycrypt-bad.ec');
                assert.strictEqual(err.range.start.line, 4);
                assert.strictEqual(err.range.start.column, 2);
                assert.strictEqual(err.range.end.column, 22);
                assert.ok(err.message.toLowerCase().includes('parse error'));
            });

            it('should parse OCaml-style File "...", line N, characters C1-C2: message', function() {
                const output = 'File "/tmp/easycrypt-bad.ec", line 306, characters 0-6: parse error';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.severity, 'error');
                assert.strictEqual(err.filePath, '/tmp/easycrypt-bad.ec');
                assert.strictEqual(err.range.start.line, 306);
                assert.ok(err.range.start.column >= 1, 'Column should be normalized to >= 1');
                assert.ok(err.message.toLowerCase().includes('parse error'));
            });

            it('should parse OCaml-style location line with message on next line', function() {
                const output = 'File "/tmp/easycrypt-bad.ec", line 306, characters 0-6:\nparse error: unexpected token';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.filePath, '/tmp/easycrypt-bad.ec');
                assert.strictEqual(err.range.start.line, 306);
                assert.ok(err.message.toLowerCase().includes('parse error'));
            });

            it('should ignore easycrypt -script progress lines', function() {
                const output = 'P 4 53 0.64634 -1.00 -1.00\nP 5 60 0.81230 -1.00 -1.00';
                const result = parseOutput(output);
                assert.strictEqual(result.errors.length, 0);
                assert.strictEqual(result.success, true);
            });

        });

        describe('Multiple errors', function() {
            
            it('should parse multiple errors in output', function() {
                const output = `[error-1-5] first error
[error-10-3] second error
[warning-15-1] a warning`;
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 3);
                assert.strictEqual(result.errors[0].range.start.line, 1);
                assert.strictEqual(result.errors[1].range.start.line, 10);
                assert.strictEqual(result.errors[2].range.start.line, 15);
            });

        });

        describe('Empty and invalid input', function() {
            
            it('should handle empty input', function() {
                const result = parseOutput('');
                
                assert.strictEqual(result.errors.length, 0);
                assert.strictEqual(result.success, true);
            });

            it('should handle input with only whitespace', function() {
                const result = parseOutput('   \n   \n   ');
                
                assert.strictEqual(result.errors.length, 0);
                assert.strictEqual(result.success, true);
            });

            it('should handle non-error output', function() {
                const result = parseOutput('Proof completed successfully');
                
                assert.strictEqual(result.success, true);
            });

        });

        describe('Parser options', function() {
            
            it('should include raw output when option is set', function() {
                const output = '[error-5-10] some error';
                const result = parseOutput(output, { includeRawOutput: true });
                
                assert.ok(result.errors[0].rawOutput);
                assert.ok(result.errors[0].rawOutput.includes('[error-5-10]'));
            });

            it('should set default file path', function() {
                const output = '[error-1-1] error message';
                const result = parseOutput(output, { defaultFilePath: '/path/to/file.ec' });
                
                assert.strictEqual(result.errors[0].filePath, '/path/to/file.ec');
            });

        });

    });

    describe('parseError', function() {
        
        it('should parse single error message', function() {
            const error = parseError('[error-5-10] test error');
            
            assert.ok(error);
            assert.strictEqual(error.range.start.line, 5);
            assert.strictEqual(error.range.start.column, 10);
        });

        it('should return null for non-error message', function() {
            const error = parseError('just some text');
            
            assert.strictEqual(error, null);
        });

    });

    describe('hasError', function() {
        
        it('should detect error tag', function() {
            assert.strictEqual(hasError('[error-1-1] test'), true);
        });

        it('should detect anomaly', function() {
            assert.strictEqual(hasError('anomaly: test'), true);
        });

        it('should detect type error', function() {
            assert.strictEqual(hasError('type error: test'), true);
        });

        it('should return false for clean output', function() {
            assert.strictEqual(hasError('Proof completed'), false);
        });

    });

    describe('isProofCompleted', function() {
        
        it('should detect "No more goals"', function() {
            assert.strictEqual(isProofCompleted('No more goals'), true);
        });

        it('should be case insensitive', function() {
            assert.strictEqual(isProofCompleted('NO MORE GOALS'), true);
        });

        it('should return false for other output', function() {
            assert.strictEqual(isProofCompleted('1 goal remaining'), false);
        });

    });

    describe('Pattern matching', function() {
        
        it('errorTag pattern should match basic format', function() {
            const match = '[error-10-5] message'.match(parserPatterns.errorTag);
            assert.ok(match);
            assert.strictEqual(match[1], '10');
            assert.strictEqual(match[2], '5');
        });

        it('errorTag pattern should match full range format', function() {
            const match = '[error-10-5-12-20] message'.match(parserPatterns.errorTag);
            assert.ok(match);
            assert.strictEqual(match[1], '10');
            assert.strictEqual(match[2], '5');
            assert.strictEqual(match[3], '12');
            assert.strictEqual(match[4], '20');
        });

    });

});
