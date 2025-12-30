/**
 * EasyCrypt Process Manager
 * 
 * Manages the lifecycle of the EasyCrypt child process. Handles spawning,
 * communication via stdin/stdout, and graceful shutdown.
 * 
 * @module processManager
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { ConfigurationManager } from './configurationManager';
import { parseOutput } from './outputParser';
import { ParseResult } from './parserTypes';

/**
 * Events emitted by the ProcessManager
 */
export interface ProcessManagerEvents {
    /** Fired when output is received from EasyCrypt */
    onOutput: vscode.Event<ProcessOutput>;
    /** Fired when the process starts */
    onDidStart: vscode.Event<void>;
    /** Fired when the process stops */
    onDidStop: vscode.Event<{ code: number | null; signal: string | null }>;
    /** Fired when an error occurs */
    onError: vscode.Event<Error>;
}

/**
 * Output received from the EasyCrypt process
 */
export interface ProcessOutput {
    /** Raw output string */
    raw: string;
    /** Parsed result with errors/warnings */
    parsed: ParseResult;
    /** The file URI this output relates to (if known) */
    fileUri?: vscode.Uri;
}

/**
 * Options for sending commands
 */
export interface SendCommandOptions {
    /** The file URI this command relates to */
    fileUri?: vscode.Uri;
    /** Timeout in milliseconds (0 = no timeout) */
    timeout?: number;
}

/**
 * Manages the EasyCrypt child process.
 * 
 * Responsibilities:
 * - Lifecycle: Start, Stop, Restart the process
 * - Communication: Write to stdin, listen to stdout/stderr
 * - Buffering: Handle split chunks of data from streams
 * - Error Handling: Handle process crashes gracefully
 * 
 * @example
 * ```typescript
 * const processManager = new ProcessManager(configManager, outputChannel);
 * await processManager.start();
 * 
 * processManager.onOutput(output => {
 *     console.log('Received:', output.raw);
 *     if (output.parsed.errors.length > 0) {
 *         diagnosticManager.setDiagnostics(uri, output.parsed.errors);
 *     }
 * });
 * 
 * await processManager.sendCommand('lemma test : true.');
 * ```
 */
export class ProcessManager implements vscode.Disposable {
    /** The EasyCrypt child process */
    private process: ChildProcess | undefined;

    /** Buffer for incomplete stdout data */
    private stdoutBuffer: string = '';

    /** Buffer for incomplete stderr data */
    private stderrBuffer: string = '';

    /** Whether we initiated the stop (vs crash) */
    private stoppingIntentionally: boolean = false;

    /** Current file URI for context */
    private currentFileUri: vscode.Uri | undefined;

    /** Total number of successful process starts (spawn cycles) */
    private processStartCount: number = 0;

    /** Total number of sendCommand() invocations (useful for deterministic tests) */
    private sendCommandCount: number = 0;

    /** Event emitters */
    private readonly _onOutput = new vscode.EventEmitter<ProcessOutput>();
    private readonly _onDidStart = new vscode.EventEmitter<void>();
    private readonly _onDidStop = new vscode.EventEmitter<{ code: number | null; signal: string | null }>();
    private readonly _onError = new vscode.EventEmitter<Error>();

    /** Public events */
    public readonly onOutput: vscode.Event<ProcessOutput> = this._onOutput.event;
    public readonly onDidStart: vscode.Event<void> = this._onDidStart.event;
    public readonly onDidStop: vscode.Event<{ code: number | null; signal: string | null }> = this._onDidStop.event;
    public readonly onError: vscode.Event<Error> = this._onError.event;

    /** Disposables */
    private readonly disposables: vscode.Disposable[] = [];

    /**
     * Creates a new ProcessManager
     * 
     * @param configManager - The configuration manager
     * @param outputChannel - Output channel for logging
     */
    constructor(
        private readonly configManager: ConfigurationManager,
        private readonly outputChannel: vscode.OutputChannel
    ) {
        // Listen for configuration changes
        const configDisposable = this.configManager.onDidChangeConfiguration(async () => {
            if (this.isRunning()) {
                this.log('Configuration changed, restarting process...');
                await this.restart();
            }
        });
        this.disposables.push(configDisposable);
    }

    /**
     * Logs a message to the output channel
     */
    private log(message: string): void {
        this.outputChannel.appendLine(`[ProcessManager] ${message}`);
    }

    /**
     * Checks if the process is currently running
     */
    public isRunning(): boolean {
        return this.process !== undefined && this.process.exitCode === null && !this.process.killed;
    }

    /**
     * Starts the EasyCrypt process
     * 
     * @throws Error if the executable path is invalid
     */
    public async start(): Promise<void> {
        if (this.isRunning()) {
            this.log('Process already running');
            return;
        }

        // Validate executable path
        const validation = await this.configManager.validateExecutablePath();
        if (!validation.valid) {
            const error = new Error(validation.error || 'Invalid executable path');
            this._onError.fire(error);
            await this.configManager.showConfigurationError(validation.error || 'EasyCrypt executable not found');
            throw error;
        }

        const execPath = validation.resolvedPath || this.configManager.getExecutablePath();
        const args = this.buildArgs();

        this.log(`Starting EasyCrypt: ${execPath} ${args.join(' ')}`);

        try {
            this.process = spawn(execPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env }
            });

            this.setupProcessHandlers();
            this.stoppingIntentionally = false;

            this.processStartCount++;

            this._onDidStart.fire();
            this.log(`EasyCrypt process started (PID: ${this.process.pid})`);

        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this._onError.fire(err);
            this.log(`Failed to start process: ${err.message}`);
            throw err;
        }
    }

    /**
     * Returns how many times the process has been successfully started.
     * Intended for internal diagnostics/testing.
     */
    public getProcessStartCount(): number {
        return this.processStartCount;
    }

    /**
     * Returns how many times sendCommand() has been invoked.
     * Intended for internal diagnostics/testing.
     */
    public getSendCommandCount(): number {
        return this.sendCommandCount;
    }

    /**
     * Builds command-line arguments for the EasyCrypt process
     */
    private buildArgs(): string[] {
        const config = this.configManager.getConfig();
        const args: string[] = ['cli', '-emacs']; // Use CLI mode with emacs-friendly output

        // Add user-specified arguments
        args.push(...config.arguments);

        // Add prover arguments if specified
        if (config.proverArgs.length > 0) {
            for (const proverArg of config.proverArgs) {
                args.push(proverArg);
            }
        }

        return args;
    }

    /**
     * Sets up event handlers for the child process
     */
    private setupProcessHandlers(): void {
        if (!this.process) return;

        // Handle stdout
        this.process.stdout?.on('data', (data: Buffer) => {
            this.handleStdout(data.toString('utf8'));
        });

        // Handle stderr
        this.process.stderr?.on('data', (data: Buffer) => {
            this.handleStderr(data.toString('utf8'));
        });

        // Handle process exit
        this.process.on('exit', (code, signal) => {
            this.log(`Process exited (code: ${code}, signal: ${signal})`);
            this.process = undefined;
            this._onDidStop.fire({ code, signal });

            if (!this.stoppingIntentionally && code !== 0) {
                this.handleUnexpectedExit(code, signal);
            }
        });

        // Handle process errors
        this.process.on('error', (error) => {
            this.log(`Process error: ${error.message}`);
            this._onError.fire(error);
        });
    }

    /**
     * Handles data received on stdout
     */
    private handleStdout(data: string): void {
        this.stdoutBuffer += data;
        this.processBuffer();
    }

    /**
     * Handles data received on stderr
     */
    private handleStderr(data: string): void {
        this.stderrBuffer += data;
        // Log stderr but also try to parse it for errors
        this.log(`[stderr] ${data}`);
        
        // Process stderr for error messages
        const parsed = parseOutput(data, {
            defaultFilePath: this.currentFileUri?.fsPath,
            includeRawOutput: true
        });

        if (parsed.errors.length > 0) {
            this._onOutput.fire({
                raw: data,
                parsed,
                fileUri: this.currentFileUri
            });
        }
    }

    /**
     * Processes the stdout buffer, emitting complete responses
     * 
     * EasyCrypt in -emacs mode uses specific delimiters.
     * We look for complete response blocks.
     */
    private processBuffer(): void {
        // In `cli -emacs` mode, EasyCrypt prints prompt markers like:
        //   [99|check]>
        // A command's response is considered complete once a prompt has been printed.
        // Buffer until we have at least one complete prompt marker line ending in `\n`,
        // then emit the whole accumulated block. This avoids emitting partial output
        // mid-response (which can cause the Proof State view to show truncated output).

        const promptLineRegex = /\[\d+\|[^\]]+\]>\s*\n/g;
        let lastPromptEnd = -1;
        let match: RegExpExecArray | null;

        while ((match = promptLineRegex.exec(this.stdoutBuffer)) !== null) {
            lastPromptEnd = match.index + match[0].length;
        }

        if (lastPromptEnd < 0) {
            return;
        }

        const output = this.stdoutBuffer.slice(0, lastPromptEnd);
        this.stdoutBuffer = this.stdoutBuffer.slice(lastPromptEnd);

        if (!output.trim()) {
            return;
        }

        this.log(`[stdout] ${output}`);

        const parsed = parseOutput(output, {
            defaultFilePath: this.currentFileUri?.fsPath,
            includeRawOutput: true
        });

        this._onOutput.fire({
            raw: output,
            parsed,
            fileUri: this.currentFileUri
        });
    }

    /**
     * Handles unexpected process exit
     */
    private handleUnexpectedExit(code: number | null, signal: string | null): void {
        const message = signal
            ? `EasyCrypt process was terminated by signal ${signal}`
            : `EasyCrypt process exited unexpectedly with code ${code}`;

        this.log(message);

        vscode.window.showErrorMessage(message, 'Restart').then(action => {
            if (action === 'Restart') {
                this.start().catch(err => {
                    this.log(`Failed to restart: ${err.message}`);
                });
            }
        });
    }

    /**
     * Stops the EasyCrypt process
     */
    public stop(): void {
        if (!this.process) {
            return;
        }

        this.log('Stopping EasyCrypt process...');
        this.stoppingIntentionally = true;

        // Capture the current process instance so the delayed force-kill
        // can't accidentally kill a newly started process.
        const proc = this.process;

        // Try graceful shutdown first
        proc.stdin?.end();

        // Give it a moment, then force kill if needed
        setTimeout(() => {
            if (this.process === proc && !proc.killed) {
                this.log('Force killing process...');
                proc.kill('SIGKILL');
            }
        }, 1000);
    }

    /**
     * Stops the EasyCrypt process and waits for it to exit.
     * This is safer than calling stop() and immediately starting a new process,
     * because stdin may be closed while the OS process is still alive.
     */
    public async stopAndWait(timeoutMs: number = 4000): Promise<void> {
        const proc = this.process;
        if (!proc) {
            return;
        }

        this.log('Stopping EasyCrypt process (awaiting exit)...');
        this.stoppingIntentionally = true;

        await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };

            proc.once('exit', finish);

            try {
                proc.stdin?.end();
            } catch {
                // ignore
            }

            // Timeout fallback: force kill, then wait a short grace period.
            setTimeout(() => {
                if (done) return;
                try {
                    this.log('Force killing process (stop timeout)...');
                    proc.kill('SIGKILL');
                } catch {
                    // ignore
                }
                setTimeout(finish, 1000);
            }, timeoutMs);
        });
    }

    /**
     * Restarts the EasyCrypt process
     */
    public async restart(): Promise<void> {
        this.log('Restarting EasyCrypt process...');

        await this.stopAndWait(4000);

        await this.start();
        vscode.window.showInformationMessage('EasyCrypt process restarted');
    }

    /**
     * Sends a command to the EasyCrypt process
     * 
     * @param command - The command to send
     * @param options - Optional settings
     */
    public async sendCommand(command: string, options: SendCommandOptions = {}): Promise<void> {
        if (!this.isRunning() || !this.process?.stdin) {
            throw new Error('EasyCrypt process is not running');
        }

        this.sendCommandCount++;

        this.currentFileUri = options.fileUri;

        // Ensure command ends with newline
        const normalizedCommand = command.endsWith('\n') ? command : command + '\n';

        this.log(`Sending command: ${command.trim()}`);

        return new Promise((resolve, reject) => {
            this.process!.stdin!.write(normalizedCommand, 'utf8', (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Sends file content to EasyCrypt for verification
     * 
     * @param document - The text document to verify
     * @param endLine - Optional line to verify up to (1-indexed, inclusive)
     */
    public async verifyDocument(document: vscode.TextDocument, endLine?: number): Promise<void> {
        if (!this.isRunning()) {
            await this.start();
        }

        this.currentFileUri = document.uri;

        const text = endLine !== undefined
            ? document.getText(new vscode.Range(0, 0, endLine, 0))
            : document.getText();

        // For EasyCrypt CLI mode, we send the content directly
        // The process will parse and verify it
        await this.sendCommand(text, { fileUri: document.uri });
    }

    /**
     * Flushes any remaining buffered output
     */
    public flush(): void {
        if (this.stdoutBuffer.trim()) {
            const parsed = parseOutput(this.stdoutBuffer, {
                defaultFilePath: this.currentFileUri?.fsPath,
                includeRawOutput: true
            });
            this._onOutput.fire({
                raw: this.stdoutBuffer,
                parsed,
                fileUri: this.currentFileUri
            });
            this.stdoutBuffer = '';
        }
    }

    /**
     * Disposes of the process manager
     */
    public dispose(): void {
        this.stop();
        this._onOutput.dispose();
        this._onDidStart.dispose();
        this._onDidStop.dispose();
        this._onError.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
