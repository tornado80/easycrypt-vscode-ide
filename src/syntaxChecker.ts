/**
 * EasyCrypt Syntax Checker
 * 
 * Provides live syntax checking by spawning a separate EasyCrypt process
 * in batch mode to check the current document content. This enables
 * "as-you-type" error feedback without affecting the interactive proof session.
 * 
 * @module syntaxChecker
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import { parseOutput } from './outputParser';
import { ParsedError } from './parserTypes';
import { ConfigurationManager } from './configurationManager';

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);

/**
 * Options for the SyntaxChecker
 */
export interface SyntaxCheckerOptions {
    /** Whether to use a hidden file in the same directory (default: true) */
    useSameDirectory?: boolean;
    /** Custom temp directory (if useSameDirectory is false) */
    tempDirectory?: string;
}

/**
 * Result of a syntax check operation
 */
export interface SyntaxCheckResult {
    /** Errors found during the check */
    errors: ParsedError[];
    /** Whether the check completed successfully (vs. was cancelled/failed) */
    completed: boolean;
    /** Duration of the check in milliseconds */
    duration: number;
}

/**
 * Manages live syntax checking for EasyCrypt files.
 * 
 * This class handles:
 * - Creating temporary files for checking
 * - Spawning EasyCrypt processes in batch mode
 * - Cancellation of in-flight checks
 * - Path remapping from temp files to original documents
 * 
 * @example
 * ```typescript
 * const checker = new SyntaxChecker(configManager);
 * 
 * const result = await checker.check(document, token);
 * if (result.completed) {
 *     diagnosticManager.setDiagnostics(document.uri, result.errors);
 * }
 * 
 * checker.dispose();
 * ```
 */
export class SyntaxChecker implements vscode.Disposable {
    /** Configuration manager for executable path and arguments */
    private readonly configManager: ConfigurationManager;
    
    /** Options for the checker */
    private readonly options: Required<SyntaxCheckerOptions>;
    
    /** Currently running process (for cancellation) */
    private runningProcess: ChildProcess | undefined;
    
    /** Current cancellation token source */
    private currentCancellation: vscode.CancellationTokenSource | undefined;
    
    /** Set of temp files to clean up on dispose */
    private readonly tempFiles: Set<string> = new Set();
    
    /** Output channel for logging (optional) */
    private readonly outputChannel: vscode.OutputChannel | undefined;

    /**
     * Creates a new SyntaxChecker instance
     * 
     * @param configManager - The configuration manager for settings
     * @param outputChannel - Optional output channel for logging
     * @param options - Configuration options
     */
    constructor(
        configManager: ConfigurationManager,
        outputChannel?: vscode.OutputChannel,
        options: SyntaxCheckerOptions = {}
    ) {
        this.configManager = configManager;
        this.outputChannel = outputChannel;
        this.options = {
            useSameDirectory: options.useSameDirectory ?? true,
            tempDirectory: options.tempDirectory ?? ''
        };
    }

    /**
     * Logs a message to the output channel
     */
    private log(message: string): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[SyntaxChecker] ${message}`);
        }
    }

    /**
     * Generates a unique temp file path for a document
     * 
     * @param document - The document to create a temp file for
     * @returns The temp file path
     */
    private getTempFilePath(document: vscode.TextDocument): string {
        const originalPath = document.uri.fsPath;
        const dir = path.dirname(originalPath);
        const ext = path.extname(originalPath);
        const baseName = path.basename(originalPath, ext);
        
        // Create a short hash of the content for uniqueness
        const contentHash = crypto
            .createHash('md5')
            .update(document.getText())
            .digest('hex')
            .substring(0, 8);
        
        if (this.options.useSameDirectory) {
            // Hidden file in the same directory (for import resolution)
            return path.join(dir, `.${baseName}.${contentHash}${ext}.tmp`);
        } else {
            // Use system temp directory or configured directory
            const tempDir = this.options.tempDirectory || os.tmpdir();
            return path.join(tempDir, `easycrypt-check-${baseName}-${contentHash}${ext}`);
        }
    }

    /**
     * Creates a temporary file with the document content
     * 
     * @param document - The document to write
     * @returns The path to the temp file
     */
    private async createTempFile(document: vscode.TextDocument): Promise<string> {
        const tempPath = this.getTempFilePath(document);
        const content = document.getText();
        
        // Ensure directory exists
        const dir = path.dirname(tempPath);
        try {
            await mkdir(dir, { recursive: true });
        } catch {
            // Directory may already exist
        }
        
        await writeFile(tempPath, content, 'utf8');
        this.tempFiles.add(tempPath);
        this.log(`Created temp file: ${tempPath}`);
        
        return tempPath;
    }

    /**
     * Deletes a temporary file
     * 
     * @param tempPath - The path to delete
     */
    private async deleteTempFile(tempPath: string): Promise<void> {
        try {
            await unlink(tempPath);
            this.tempFiles.delete(tempPath);
            this.log(`Deleted temp file: ${tempPath}`);
        } catch {
            // File may already be deleted
            this.log(`Failed to delete temp file: ${tempPath}`);
        }
    }

    /**
     * Cancels any running syntax check
     */
    public cancel(): void {
        if (this.runningProcess) {
            this.log('Cancelling running check');
            this.runningProcess.kill('SIGTERM');
            this.runningProcess = undefined;
        }
        if (this.currentCancellation) {
            this.currentCancellation.cancel();
            this.currentCancellation.dispose();
            this.currentCancellation = undefined;
        }
    }

    /**
     * Checks a document for syntax/type errors
     * 
     * Spawns EasyCrypt in batch mode to check the document.
     * Any previous check will be cancelled.
     * 
     * @param document - The document to check
     * @param token - Optional cancellation token
     * @returns The check result with errors
     */
    public async check(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<SyntaxCheckResult> {
        const startTime = Date.now();
        
        // Cancel any previous check
        this.cancel();
        
        // Create new cancellation token if not provided
        if (!token) {
            this.currentCancellation = new vscode.CancellationTokenSource();
            token = this.currentCancellation.token;
        }
        
        // Get configuration
        const config = this.configManager.getConfig();
        const executablePath = config.executablePath;
        
        // Validate executable
        const validation = await this.configManager.validateExecutablePath();
        if (!validation.valid) {
            this.log(`Executable validation failed: ${validation.error}`);
            return {
                errors: [],
                completed: false,
                duration: Date.now() - startTime
            };
        }
        
        const resolvedExec = validation.resolvedPath || executablePath;
        
        // Create temp file
        let tempPath: string;
        try {
            tempPath = await this.createTempFile(document);
        } catch (error) {
            this.log(`Failed to create temp file: ${error}`);
            return {
                errors: [],
                completed: false,
                duration: Date.now() - startTime
            };
        }
        
        // Check for cancellation
        if (token.isCancellationRequested) {
            await this.deleteTempFile(tempPath);
            return {
                errors: [],
                completed: false,
                duration: Date.now() - startTime
            };
        }
        
        // Build command arguments.
        // Use `compile -script` for stable, machine-readable diagnostics.
        // Some EasyCrypt builds do not accept `-emacs` as a top-level option.
        const args = ['compile', '-script', ...config.arguments, tempPath];
        
        this.log(`Running: ${resolvedExec} ${args.join(' ')}`);
        
        // Run EasyCrypt
        try {
            const result = await this.runEasyCrypt(resolvedExec, args, token, tempPath);
            
            // Remap file paths from temp file to original document
            const remappedErrors = this.remapFilePaths(
                result.errors,
                tempPath,
                document.uri.fsPath
            );
            
            return {
                errors: remappedErrors,
                completed: result.completed,
                duration: Date.now() - startTime
            };
        } finally {
            // Clean up temp file
            await this.deleteTempFile(tempPath);
        }
    }

    /**
     * Runs EasyCrypt and parses the output
     * 
     * @param execPath - Path to the EasyCrypt executable
     * @param args - Arguments to pass
     * @param token - Cancellation token
     * @param tempPath - Path to the temp file (for context)
     * @returns Promise with errors and completion status
     */
    private runEasyCrypt(
        execPath: string,
        args: string[],
        token: vscode.CancellationToken,
        tempPath: string
    ): Promise<{ errors: ParsedError[]; completed: boolean }> {
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let completed = false;
            
            const childProcess = spawn(execPath, args, {
                cwd: path.dirname(tempPath),
                env: { ...globalThis.process.env },
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            this.runningProcess = childProcess;
            
            // Handle cancellation
            const cancellationListener = token.onCancellationRequested(() => {
                this.log('Check cancelled');
                childProcess.kill('SIGTERM');
            });
            
            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });
            
            childProcess.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });
            
            childProcess.on('close', (code: number | null) => {
                cancellationListener.dispose();
                this.runningProcess = undefined;
                completed = !token.isCancellationRequested;
                
                this.log(`Process exited with code ${code}`);
                
                // Parse both stdout and stderr
                const combinedOutput = stdout + '\n' + stderr;
                const parseResult = parseOutput(combinedOutput, {
                    defaultFilePath: tempPath,
                    includeRawOutput: false
                });
                
                resolve({
                    errors: parseResult.errors,
                    completed
                });
            });
            
            childProcess.on('error', (error: Error) => {
                cancellationListener.dispose();
                this.runningProcess = undefined;
                this.log(`Process error: ${error.message}`);
                
                resolve({
                    errors: [],
                    completed: false
                });
            });
            
            // Close stdin immediately since we're doing batch mode
            childProcess.stdin?.end();
        });
    }

    /**
     * Remaps file paths in errors from temp file to original document
     * 
     * @param errors - The errors with temp file paths
     * @param tempPath - The temp file path
     * @param originalPath - The original document path
     * @returns Errors with corrected paths
     */
    private remapFilePaths(
        errors: ParsedError[],
        tempPath: string,
        originalPath: string
    ): ParsedError[] {
        const normalizedTemp = path.normalize(tempPath).toLowerCase();
        const normalizedOriginal = path.normalize(originalPath);
        
        return errors.map(error => {
            if (!error.filePath) {
                // No file path, assume it's the original file
                return { ...error, filePath: normalizedOriginal };
            }
            
            const normalizedError = path.normalize(error.filePath).toLowerCase();
            
            // Check if the error refers to the temp file
            if (normalizedError === normalizedTemp || 
                normalizedError.includes(path.basename(tempPath).toLowerCase())) {
                return { ...error, filePath: normalizedOriginal };
            }
            
            // Keep original path (may be an imported file)
            return error;
        });
    }

    /**
     * Cleans up all temp files created by this checker
     */
    public async cleanupAllTempFiles(): Promise<void> {
        const files = Array.from(this.tempFiles);
        await Promise.all(files.map(f => this.deleteTempFile(f)));
    }

    /**
     * Disposes of the syntax checker and all resources
     */
    public dispose(): void {
        this.cancel();
        
        // Synchronously try to clean up temp files
        for (const tempFile of this.tempFiles) {
            try {
                fs.unlinkSync(tempFile);
            } catch {
                // Ignore errors during disposal
            }
        }
        this.tempFiles.clear();
        
        this.log('Disposed');
    }
}
