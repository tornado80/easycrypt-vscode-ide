/**
 * EasyCrypt Logger
 * 
 * Centralized logging service for the EasyCrypt VS Code extension.
 * Provides configurable verbose logging that can be enabled/disabled
 * via the `easycrypt.verboseLogging` setting.
 * 
 * @module logger
 */

import * as vscode from 'vscode';

/**
 * Log level for categorizing messages
 */
export enum LogLevel {
    /** Debug-level messages (verbose, only when enabled) */
    DEBUG = 'DEBUG',
    /** Informational messages */
    INFO = 'INFO',
    /** Warning messages */
    WARN = 'WARN',
    /** Error messages */
    ERROR = 'ERROR',
    /** Command invocation traces */
    COMMAND = 'CMD',
    /** Event traces */
    EVENT = 'EVENT',
    /** Process I/O traces */
    PROCESS = 'PROC',
    /** Proof state transitions */
    PROOF = 'PROOF'
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
    /** Whether verbose logging is enabled */
    verboseLogging: boolean;
}

/**
 * Centralized logger for the EasyCrypt extension.
 * 
 * Usage:
 * ```typescript
 * const logger = Logger.getInstance();
 * logger.info('ProcessManager', 'Process started');
 * logger.debug('StepManager', 'Stepping forward');
 * logger.command('stepForward', { offset: 100 });
 * logger.event('onDidChangeTextDocument', { uri: 'file.ec' });
 * ```
 */
export class Logger implements vscode.Disposable {
    private static instance: Logger | undefined;
    
    private outputChannel: vscode.OutputChannel;
    private verboseLogging: boolean = false;
    private disposables: vscode.Disposable[] = [];
    
    private constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.loadConfiguration();
        
        // Listen for configuration changes
        const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('easycrypt.verboseLogging')) {
                this.loadConfiguration();
            }
        });
        this.disposables.push(configWatcher);
    }
    
    /**
     * Gets the singleton Logger instance.
     * Must call initialize() first.
     */
    public static getInstance(): Logger {
        if (!Logger.instance) {
            throw new Error('Logger not initialized. Call Logger.initialize() first.');
        }
        return Logger.instance;
    }
    
    /**
     * Initializes the Logger singleton.
     * @param outputChannel - The VS Code output channel to write to
     */
    public static initialize(outputChannel: vscode.OutputChannel): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger(outputChannel);
        }
        return Logger.instance;
    }
    
    /**
     * Disposes the Logger singleton.
     */
    public static disposeInstance(): void {
        if (Logger.instance) {
            Logger.instance.dispose();
            Logger.instance = undefined;
        }
    }
    
    /**
     * Loads configuration from VS Code settings.
     */
    private loadConfiguration(): void {
        const config = vscode.workspace.getConfiguration('easycrypt');
        const wasVerbose = this.verboseLogging;
        this.verboseLogging = config.get<boolean>('verboseLogging', false);
        
        if (wasVerbose !== this.verboseLogging) {
            this.log(LogLevel.INFO, 'Logger', `Verbose logging ${this.verboseLogging ? 'enabled' : 'disabled'}`);
        }
    }
    
    /**
     * Returns whether verbose logging is currently enabled.
     */
    public isVerbose(): boolean {
        return this.verboseLogging;
    }
    
    /**
     * Formats a timestamp for log messages.
     */
    private formatTimestamp(): string {
        const now = new Date();
        return now.toISOString();
    }
    
    /**
     * Formats additional data for log messages.
     */
    private formatData(data?: Record<string, unknown>): string {
        if (!data || Object.keys(data).length === 0) {
            return '';
        }
        try {
            return ' ' + JSON.stringify(data);
        } catch {
            return ' [unserializable data]';
        }
    }
    
    /**
     * Core logging method.
     */
    private log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
        const timestamp = this.formatTimestamp();
        const dataStr = this.formatData(data);
        const line = `[${timestamp}] [${level}] [${component}] ${message}${dataStr}`;
        this.outputChannel.appendLine(line);
    }
    
    /**
     * Logs a debug message (only when verbose logging is enabled).
     */
    public debug(component: string, message: string, data?: Record<string, unknown>): void {
        if (this.verboseLogging) {
            this.log(LogLevel.DEBUG, component, message, data);
        }
    }
    
    /**
     * Logs an info message.
     */
    public info(component: string, message: string, data?: Record<string, unknown>): void {
        this.log(LogLevel.INFO, component, message, data);
    }
    
    /**
     * Logs a warning message.
     */
    public warn(component: string, message: string, data?: Record<string, unknown>): void {
        this.log(LogLevel.WARN, component, message, data);
    }
    
    /**
     * Logs an error message.
     */
    public error(component: string, message: string, data?: Record<string, unknown>): void {
        this.log(LogLevel.ERROR, component, message, data);
    }
    
    /**
     * Logs a command invocation (verbose only).
     */
    public command(commandName: string, data?: Record<string, unknown>): void {
        if (this.verboseLogging) {
            this.log(LogLevel.COMMAND, 'Extension', `Command invoked: ${commandName}`, data);
        }
    }
    
    /**
     * Logs a command completion (verbose only).
     */
    public commandComplete(commandName: string, success: boolean, data?: Record<string, unknown>): void {
        if (this.verboseLogging) {
            this.log(LogLevel.COMMAND, 'Extension', `Command completed: ${commandName} (success=${success})`, data);
        }
    }
    
    /**
     * Logs an event (verbose only).
     */
    public event(eventName: string, data?: Record<string, unknown>): void {
        if (this.verboseLogging) {
            this.log(LogLevel.EVENT, 'Extension', `Event: ${eventName}`, data);
        }
    }
    
    /**
     * Logs process-related activity (verbose only).
     */
    public process(action: string, data?: Record<string, unknown>): void {
        if (this.verboseLogging) {
            this.log(LogLevel.PROCESS, 'ProcessManager', action, data);
        }
    }
    
    /**
     * Logs proof state changes (verbose only).
     */
    public proof(action: string, data?: Record<string, unknown>): void {
        if (this.verboseLogging) {
            this.log(LogLevel.PROOF, 'ProofState', action, data);
        }
    }
    
    /**
     * Creates a scoped logger for a specific component.
     */
    public scoped(component: string): ScopedLogger {
        return new ScopedLogger(this, component);
    }
    
    /**
     * Disposes the logger.
     */
    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

/**
 * A logger scoped to a specific component.
 */
export class ScopedLogger {
    constructor(
        private readonly logger: Logger,
        private readonly component: string
    ) {}
    
    public debug(message: string, data?: Record<string, unknown>): void {
        this.logger.debug(this.component, message, data);
    }
    
    public info(message: string, data?: Record<string, unknown>): void {
        this.logger.info(this.component, message, data);
    }
    
    public warn(message: string, data?: Record<string, unknown>): void {
        this.logger.warn(this.component, message, data);
    }
    
    public error(message: string, data?: Record<string, unknown>): void {
        this.logger.error(this.component, message, data);
    }
}
