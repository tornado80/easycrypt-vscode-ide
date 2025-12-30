/**
 * Comprehensive Unit Tests for EasyCrypt Diagnostics Parser
 * 
 * These tests verify that all supported error formats are correctly parsed
 * as specified in the diagnostics-reporting-plan.md document.
 * 
 * Supported formats:
 * - [error-LINE-COL] and [error-LINE-COL-LINE-COL] tags
 * - E <sev> <path>: line <n> (<c1>-<c2>) <msg> (script format)
 * - [<sev>] [<path>: line <n> (<c1>-<c2>)] <msg> (compile format)
 * - at line <n>, column(s) <c> ... (message-embedded)
 */

const assert = require('assert');

const { 
    parseOutput, 
    parseError, 
    hasError, 
    isProofCompleted,
    parserPatterns 
} = require('../out/outputParser');

describe('Diagnostics Parser - Comprehensive Tests', function() {

    describe('Format 1: EasyCrypt Error Tags', function() {
        
        describe('[error-LINE-COL] format', function() {
            
            it('should parse basic error with line and column', function() {
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

            it('should ensure non-empty range for squiggle visibility', function() {
                const output = '[error-5-10] test error';
                const result = parseOutput(output);
                
                const error = result.errors[0];
                // End column should be > start column for visible squiggle
                assert.ok(
                    error.range.end.column > error.range.start.column,
                    'Range must be non-empty for VS Code to render squiggle'
                );
            });

            it('should handle edge case of line 1 column 1', function() {
                const output = '[error-1-1] error at start of file';
                const result = parseOutput(output);
                
                const error = result.errors[0];
                assert.strictEqual(error.range.start.line, 1);
                assert.strictEqual(error.range.start.column, 1);
                assert.ok(error.range.end.column > 1, 'Should have non-empty range');
            });
        });

        describe('[error-L1-C1-L2-C2] format (ranges)', function() {
            
            it('should parse full range on same line', function() {
                const output = '[error-5-10-5-25] type mismatch';
                const result = parseOutput(output);
                
                const error = result.errors[0];
                assert.strictEqual(error.range.start.line, 5);
                assert.strictEqual(error.range.start.column, 10);
                assert.strictEqual(error.range.end.line, 5);
                assert.strictEqual(error.range.end.column, 25);
            });

            it('should parse multiline error range', function() {
                const output = '[error-10-1-15-20] expression spans multiple lines';
                const result = parseOutput(output);
                
                const error = result.errors[0];
                assert.strictEqual(error.range.start.line, 10);
                assert.strictEqual(error.range.start.column, 1);
                assert.strictEqual(error.range.end.line, 15);
                assert.strictEqual(error.range.end.column, 20);
            });

            it('should handle reversed range (normalize if end < start)', function() {
                // Some edge cases might produce reversed ranges
                const output = '[error-10-20-10-5] reversed range';
                const result = parseOutput(output);
                
                const error = result.errors[0];
                // Parser should normalize to ensure end >= start
                assert.ok(
                    error.range.end.column >= error.range.start.column ||
                    error.range.end.line > error.range.start.line,
                    'Range should be normalized'
                );
            });
        });
    });

    describe('Format 2: Compile/Script Output', function() {

        describe('[severity] [path: line N (C1-C2)] format', function() {

            it('should parse critical severity', function() {
                const output = '[critical] [/path/to/file.ec: line 4 (2-22)] parse error';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.severity, 'error');
                assert.strictEqual(err.filePath, '/path/to/file.ec');
                assert.strictEqual(err.range.start.line, 4);
                assert.strictEqual(err.range.start.column, 2);
                assert.strictEqual(err.range.end.column, 22);
            });

            it('should parse error severity', function() {
                const output = '[error] [/test.ec: line 10 (5-15)] unknown identifier';
                const result = parseOutput(output);

                const err = result.errors[0];
                assert.strictEqual(err.severity, 'error');
            });

            it('should parse warning severity', function() {
                const output = '[warning] [/test.ec: line 20 (1-10)] unused variable';
                const result = parseOutput(output);

                const err = result.errors[0];
                assert.strictEqual(err.severity, 'warning');
            });

            it('should parse info severity', function() {
                const output = '[info] [/test.ec: line 5 (1-5)] informational message';
                const result = parseOutput(output);

                const err = result.errors[0];
                assert.strictEqual(err.severity, 'info');
            });

            it('should handle paths with spaces', function() {
                const output = '[critical] [/path/to/my file.ec: line 3 (1-10)] error';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].filePath, '/path/to/my file.ec');
            });
        });

        describe('E <severity> <path>: line N (C1-C2) format (script mode)', function() {

            it('should parse script error format', function() {
                const output = 'E critical /tmp/test.ec: line 4 (2-22) parse error';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.severity, 'error');
                assert.strictEqual(err.filePath, '/tmp/test.ec');
                assert.strictEqual(err.range.start.line, 4);
                assert.strictEqual(err.range.start.column, 2);
                assert.strictEqual(err.range.end.column, 22);
            });

            it('should strip trailing progress info', function() {
                const output = 'E critical /tmp/test.ec: line 4 (2-22) parse error P 4 53 0.64634 -1.00 -1.00';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                // Message should not include the P ... progress segment
                assert.ok(!err.message.includes('P 4 53'), 'Progress info should be stripped');
                assert.ok(err.message.toLowerCase().includes('parse error'));
            });

            it('should ignore standalone progress lines', function() {
                const output = `P 1 100 0.5 -1.00 -1.00
P 2 100 0.8 -1.00 -1.00
P 3 100 1.0 -1.00 -1.00`;
                const result = parseOutput(output);
                
                assert.strictEqual(result.errors.length, 0);
                assert.strictEqual(result.success, true);
            });
        });
    });

    describe('Format 3: Message-Embedded Locations', function() {

        describe('at line N, column C format (single position)', function() {

            it('should extract location from error prefix message', function() {
                const output = 'error: at line 25, column 10: undefined variable';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.range.start.line, 25);
                assert.strictEqual(err.range.start.column, 10);
            });

            it('should handle "columns" plural form', function() {
                const output = 'error: at line 5, columns 3: test';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.range.start.line, 5);
                assert.strictEqual(err.range.start.column, 3);
            });
        });

        describe('at line N, column C1 to line M, column C2 format (range)', function() {

            it('should extract full range from message', function() {
                const output = 'error: at line 5, column 1 to line 5, column 20: invalid expression';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                const err = result.errors[0];
                assert.strictEqual(err.range.start.line, 5);
                assert.strictEqual(err.range.start.column, 1);
                assert.strictEqual(err.range.end.line, 5);
                assert.strictEqual(err.range.end.column, 20);
            });

            it('should handle multiline range in message', function() {
                const output = 'error: at line 10, column 5 to line 12, column 15: spans multiple lines';
                const result = parseOutput(output);

                const err = result.errors[0];
                assert.strictEqual(err.range.start.line, 10);
                assert.strictEqual(err.range.end.line, 12);
            });
        });
    });

    describe('Fallback Behavior', function() {

        it('should use default range when no location found', function() {
            const output = 'type error: expected int, got bool';
            const result = parseOutput(output);

            assert.strictEqual(result.errors.length, 1);
            const err = result.errors[0];
            // Should fall back to line 1 with non-empty range
            assert.strictEqual(err.range.start.line, 1);
            assert.ok(
                err.range.end.column > err.range.start.column,
                'Fallback range must be non-empty for squiggle visibility'
            );
        });

        it('should handle anomaly without location', function() {
            const output = 'anomaly: internal error in proof engine';
            const result = parseOutput(output);

            assert.strictEqual(result.errors.length, 1);
            const err = result.errors[0];
            assert.strictEqual(err.severity, 'error');
            assert.ok(err.message.includes('Anomaly'));
            // Should have fallback range
            assert.ok(err.range.start.line >= 1);
        });

        it('should preserve original message content', function() {
            const output = '[error-5-10] variable "x" is not declared in the current scope';
            const result = parseOutput(output);

            const err = result.errors[0];
            assert.ok(err.message.includes('variable'));
            assert.ok(err.message.includes('not declared'));
        });
    });

    describe('Special Error Types', function() {

        describe('Anomaly errors', function() {
            
            it('should parse basic anomaly', function() {
                const output = 'anomaly: internal error occurred';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].code, 'anomaly');
                assert.strictEqual(result.errors[0].severity, 'error');
            });

            it('should extract location from anomaly message if present', function() {
                const output = 'anomaly: at line 10, column 5: unexpected state';
                const result = parseOutput(output);

                const err = result.errors[0];
                assert.strictEqual(err.range.start.line, 10);
                assert.strictEqual(err.range.start.column, 5);
            });
        });

        describe('Warning messages', function() {

            it('should parse [warning-LINE-COL] format', function() {
                const output = '[warning-8-3] unused variable';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].severity, 'warning');
                assert.strictEqual(result.errors[0].range.start.line, 8);
            });

            it('should parse plain warning: prefix', function() {
                const output = 'warning: deprecated feature used';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].severity, 'warning');
            });
        });

        describe('Type errors', function() {

            it('should parse type error prefix', function() {
                const output = 'type error: expected int, got bool';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].code, 'type-error');
                assert.ok(result.errors[0].message.includes('Type error'));
            });
        });

        describe('Syntax/parse errors', function() {

            it('should parse syntax error prefix', function() {
                const output = 'syntax error: unexpected token';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].code, 'syntax-error');
            });

            it('should parse parse error prefix', function() {
                const output = 'parse error: missing semicolon';
                const result = parseOutput(output);

                assert.strictEqual(result.errors.length, 1);
                assert.strictEqual(result.errors[0].code, 'syntax-error');
            });
        });
    });

    describe('Multiple Errors and Edge Cases', function() {

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

        it('should handle empty input', function() {
            const result = parseOutput('');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.success, true);
        });

        it('should handle whitespace-only input', function() {
            const result = parseOutput('   \n   \n   ');

            assert.strictEqual(result.errors.length, 0);
            assert.strictEqual(result.success, true);
        });

        it('should handle non-error output', function() {
            const result = parseOutput('Proof completed successfully');

            assert.strictEqual(result.success, true);
        });

        it('should detect proof completion', function() {
            const result = parseOutput('No more goals');

            assert.strictEqual(result.proofCompleted, true);
            assert.strictEqual(result.success, true);
        });

        it('should handle mixed success and error output', function() {
            const output = `Processing file...
[error-5-1] error found
Some other output`;
            const result = parseOutput(output);

            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.success, false);
        });
    });

    describe('Parser Options', function() {

        it('should include raw output when requested', function() {
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

        it('should not override explicit file path with default', function() {
            const output = '[critical] [/explicit/path.ec: line 1 (1-10)] error';
            const result = parseOutput(output, { defaultFilePath: '/default/path.ec' });

            assert.strictEqual(result.errors[0].filePath, '/explicit/path.ec');
        });
    });

    describe('Utility Functions', function() {

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
                assert.strictEqual(isProofCompleted('no more goals'), true);
            });

            it('should return false for other output', function() {
                assert.strictEqual(isProofCompleted('1 goal remaining'), false);
            });
        });
    });
});
