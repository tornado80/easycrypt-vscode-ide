#!/usr/bin/env node
/**
 * Mock EasyCrypt Binary
 * 
 * A simple mock that simulates EasyCrypt's CLI behavior for testing
 * without requiring the actual EasyCrypt installation.
 * 
 * Usage:
 *   node mock_easycrypt.js cli -emacs     # Interactive REPL mode
 *   node mock_easycrypt.js compile FILE   # One-shot compile mode
 */

const readline = require('readline');
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0];

function emitError(line, startCol, endCol, message) {
    console.log(`[critical] [mock.ec: line ${line} (${startCol}-${endCol})] ${message}`);
}

function emitScriptError(line, startCol, endCol, message) {
    console.log(`E critical mock.ec: line ${line} (${startCol}-${endCol}) ${message}`);
}

// Some real EasyCrypt installations reject top-level `-emacs` (unknown option).
// Keep this behavior in the mock so tests catch regressions.
const looksLikeFlag = (s) => typeof s === 'string' && s.startsWith('-');

if (looksLikeFlag(command)) {
    console.error(`easycrypt: unknown option '${command}'`);
    process.exit(1);

} else if (command === 'cli') {
    // Interactive REPL mode
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    let lineNumber = 1;
    let lastCommandTimeMs = 0;
    let rapidCommandStreak = 0;
    let promptCounter = 1;

    // When enabled, the mock will treat the first processed statement as "silent" and
    // will coalesce its prompt with the *next* statement's output. This deterministically
    // simulates a real-world pattern seen in EasyCrypt where the first statement in a
    // batched send produces no output, so a chunk can begin with a prompt like:
    //   [1|check]>
    //   + added ...
    //   [2|check]>
    // This pattern previously triggered an off-by-one prompt undercount in the extension.
    const coalesceFirstPromptWithNextOutput = process.env.MOCK_EC_COALESCE_FIRST_PROMPT_WITH_NEXT_OUTPUT === '1';
    let firstProcessedStatement = true;
    let pendingCoalescedPromptLine = undefined;

    // Tracks whether multiple input lines arrived in the same burst.
    // Used to simulate "batch-only" failures deterministically.
    let inputBurstCount = 0;
    let inputBurstResetScheduled = false;

    // When enabled, delay between prompts so ProcessManager emits output in
    // multiple prompt-delimited chunks (simulates bursty/slow output).
    const burstyPrompts = process.env.MOCK_EC_BURSTY_PROMPTS === '1';
    const burstDelayMs = Math.max(0, Number(process.env.MOCK_EC_BURST_DELAY_MS ?? '80'));

    // When enabled, emit a leading prompt before the first command's response
    // to simulate OS-level coalescing where stdout contains a prompt from the
    // previous command at the start of a read. This tests the extension's
    // prompt counting robustness.
    const emitLeadingPrompt = process.env.MOCK_EC_LEADING_PROMPT === '1';
    let firstCommandAfterStart = true;

    /**
     * Serialize all stdout writes so delayed prompt emission doesn't reorder output.
     */
    let writeQueue = Promise.resolve();
    const enqueue = (fn) => {
        writeQueue = writeQueue.then(fn).catch(() => undefined);
    };

    const writeLine = (s) => {
        process.stdout.write(String(s ?? '') + '\n');
    };

    const emitPrompt = async () => {
        writeLine(`[${promptCounter++}|check]>`);
        if (burstyPrompts && burstDelayMs > 0) {
            await new Promise((r) => setTimeout(r, burstDelayMs));
        }
    };

    const maybeFlushCoalescedPrompt = () => {
        if (pendingCoalescedPromptLine) {
            writeLine(pendingCoalescedPromptLine);
            pendingCoalescedPromptLine = undefined;
        }
    };

    const emitPromptPossiblyCoalesced = async () => {
        if (coalesceFirstPromptWithNextOutput && firstProcessedStatement) {
            // Hold the prompt and write it before the next statement's output.
            pendingCoalescedPromptLine = `[${promptCounter++}|check]>`;
        } else {
            await emitPrompt();
        }
    };

    rl.on('line', (line) => {
        enqueue(async () => {
            const trimmed = line.trim();

            if (!trimmed || trimmed.startsWith('(*')) {
                // Skip empty lines and comments
                lineNumber++;
                return;
            }

            // Emit a leading prompt to simulate coalesced stdout (tests prompt counting).
            // This prompt appears at the START of the first command's response to simulate
            // a prompt from "before" the command that got coalesced into the same read.
            if (emitLeadingPrompt && firstCommandAfterStart) {
                // Emit a "fake" leading prompt (with a different counter to be visible in logs)
                // In real EasyCrypt this would be the previous command's trailing prompt.
                writeLine(`[0|check]>`);
                firstCommandAfterStart = false;
            }

            // Control flags for simulating process desync/undo failures.
            // Used by E2E tests to verify StepManager smart recovery.
            const shouldFailUndo = process.env.MOCK_EC_UNDO_FAIL === '1';

            // Control flag for simulating batch-only failures.
            // When enabled, the mock emits a parse error if it observes multiple
            // commands arriving in rapid succession (typical of one-shot batching).
            // Sequential replay sends one command at a time and should not trigger this.
            const shouldFailRapidBatches = process.env.MOCK_EC_FAIL_RAPID_BATCH === '1';

            if (shouldFailRapidBatches && trimmed) {
                // Treat "batch" as multiple commands arriving in a single input burst.
                // One-shot replay sends many lines at once; sequential replay should
                // send one line, await the prompt, then send the next.
                inputBurstCount++;
                if (!inputBurstResetScheduled) {
                    inputBurstResetScheduled = true;
                    setImmediate(() => {
                        inputBurstCount = 0;
                        inputBurstResetScheduled = false;
                    });
                }

                // Fail on the second command in the same burst onward.
                if (inputBurstCount >= 2) {
                    writeLine('[error-4-6]parse error');
                    await emitPrompt();
                    lineNumber++;
                    return;
                }
            }

            // Built-in commands used by the extension.
            if (trimmed === 'reset.') {
                writeLine('Session reset');
                promptCounter = 1;
                await emitPrompt();
                lineNumber = 1;
                return;
            }

            if (trimmed === 'undo.') {
                if (shouldFailUndo) {
                    writeLine('[error-4-6]parse error');
                } else {
                    writeLine('Undo successful');
                    // Decrement prompt counter to simulate undo
                    if (promptCounter > 1) {
                        promptCounter--;
                    }
                }
                await emitPrompt();
                lineNumber++;
                return;
            }

            // Support undo <uuid>. command for fast backward navigation
            // Source citation (EasyCrypt, commit 4fc8b636e76ee1689c97089282809532cc4d3c5c):
            // - src/ec.ml: routes parsed `P_Undo i` to `EcCommands.undo i`
            // - src/ecCommands.ml: implements `undo (olduuid : int)` by repeated `pop_context`
            const undoToStateMatch = trimmed.match(/^undo\s+(\d+)\.$/);
            if (undoToStateMatch) {
                const targetUuid = parseInt(undoToStateMatch[1], 10);
                if (shouldFailUndo) {
                    writeLine('[error-4-6]cannot undo (undo stack disabled)');
                } else if (targetUuid < 0) {
                    writeLine('[error-4-6]invalid undo target');
                } else {
                    // Set prompt counter to target uuid + 1 (emitPrompt increments after writing)
                    promptCounter = targetUuid;
                    writeLine(`Undo to state ${targetUuid}`);
                }
                await emitPrompt();
                return;
            }

            // Simulate errors for specific patterns
            if (trimmed.includes('undefined_symbol')) {
                maybeFlushCoalescedPrompt();
                emitError(lineNumber, 1, trimmed.length, 'unknown symbol: undefined_symbol');
            } else if (trimmed.includes('syntax_error')) {
                maybeFlushCoalescedPrompt();
                emitError(lineNumber, 1, trimmed.length, 'parse error');
            } else if (trimmed.includes('type_error')) {
                maybeFlushCoalescedPrompt();
                emitError(lineNumber, 1, trimmed.length, 'type error: expected int, got bool');
            } else if (trimmed === 'admit.') {
                maybeFlushCoalescedPrompt();
                writeLine('Warning: proof completed with admit');
            } else if (trimmed === 'qed.') {
                maybeFlushCoalescedPrompt();
                writeLine('No more goals');
            } else {
                // Normal output
                maybeFlushCoalescedPrompt();
                writeLine(`Processed line ${lineNumber}: ${trimmed.substring(0, 30)}...`);
            }

            await emitPromptPossiblyCoalesced();
            firstProcessedStatement = false;
            lineNumber++;
        });
    });

    rl.on('close', () => {
        process.exit(0);
    });

} else if (command === 'compile') {
    // One-shot compile mode
    const useScript = args.includes('-script');
    const filePath = args.find(a => a.endsWith('.ec') || a.endsWith('.eca')) || args[args.length - 1];

    if (!filePath || !fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let hasErrors = false;

    lines.forEach((line, index) => {
        const lineNum = index + 1;
        const trimmed = line.trim();

        if (trimmed.includes('undefined_symbol') || trimmed.includes('this_is_not_a_tactic')) {
            hasErrors = true;
            if (useScript) {
                console.log(`E critical ${filePath}: line ${lineNum} (1-${trimmed.length}) parse error`);
            } else {
                console.log(`[critical] [${filePath}: line ${lineNum} (1-${trimmed.length})] parse error`);
            }
        } else if (trimmed.includes('syntax_error')) {
            hasErrors = true;
            if (useScript) {
                console.log(`E critical ${filePath}: line ${lineNum} (1-${trimmed.length}) syntax error`);
            } else {
                console.log(`[critical] [${filePath}: line ${lineNum} (1-${trimmed.length})] syntax error`);
            }
        }
    });

    if (hasErrors) {
        process.exit(1);
    } else {
        if (useScript) {
            // Progress output
            console.log(`P ${lines.length} 100 1.0 -1.00 -1.00`);
        }
        console.log('Compilation successful');
        process.exit(0);
    }

} else {
    console.log('Usage: mock_easycrypt.js [cli|compile] [options] [file]');
    console.log('');
    console.log('Commands:');
    console.log('  cli      Run interactive REPL mode');
    console.log('  compile  Compile a file');
    console.log('');
    console.log('Options:');
    console.log('  -emacs   Use emacs-friendly output format');
    console.log('  -script  Use script output format');
    process.exit(0);
}
