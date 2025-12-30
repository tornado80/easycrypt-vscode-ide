/**
 * Configuration Manager for EasyCrypt VS Code Extension
 * 
 * Provides a centralized service for managing user configuration settings.
 * Handles setting retrieval, validation, and change notifications.
 * 
 * @module configurationManager
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const access = promisify(fs.access);

/** Configuration section name */
const CONFIG_SECTION = 'easycrypt';

/**
 * Interface representing the EasyCrypt configuration
 */
export interface EasyCryptConfig {
    /** Path to the EasyCrypt executable */
    executablePath: string;
    /** Additional arguments to pass to EasyCrypt on startup */
    arguments: string[];
    /** Arguments for backend provers */
    proverArgs: string[];
    /** Whether diagnostics are enabled */
    diagnosticsEnabled: boolean;
    /** Whether live syntax checks are enabled */
    liveChecksEnabled: boolean;
    /** Delay in milliseconds before running live checks */
    liveCheckDelay: number;
    /** Whether to check on document change */
    checkOnChange: boolean;
    /** Whether to check on document save */
    checkOnSave: boolean;
}

/**
 * Validation result for executable path
 */
export interface ValidationResult {
    /** Whether the validation passed */
    valid: boolean;
    /** Error message if validation failed */
    error?: string;
    /** The resolved path (if different from input) */
    resolvedPath?: string;
}

/**
 * Centralized configuration manager for the EasyCrypt extension.
 * 
 * Responsibilities:
 * - Read settings from VS Code configuration
 * - Validate executable path
 * - Emit events when configuration changes
 * 
 * @example
 * ```typescript
 * const configManager = new ConfigurationManager();
 * const config = configManager.getConfig();
 * console.log(config.executablePath);
 * 
 * // Listen for changes
 * configManager.onDidChangeConfiguration(() => {
 *     console.log('Configuration changed');
 * });
 * ```
 */
export class ConfigurationManager implements vscode.Disposable {
    /** Event emitter for configuration changes */
    private readonly _onDidChangeConfiguration = new vscode.EventEmitter<void>();
    
    /** Public event for configuration changes */
    public readonly onDidChangeConfiguration: vscode.Event<void> = this._onDidChangeConfiguration.event;
    
    /** Disposables to clean up */
    private readonly disposables: vscode.Disposable[] = [];

    /** Cached configuration */
    private cachedConfig: EasyCryptConfig | undefined;

    /**
     * Creates a new ConfigurationManager instance
     */
    constructor() {
        // Listen for configuration changes
        const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(CONFIG_SECTION)) {
                // Invalidate cache
                this.cachedConfig = undefined;
                // Fire change event
                this._onDidChangeConfiguration.fire();
            }
        });
        this.disposables.push(configWatcher);
    }

    /**
     * Gets the current configuration snapshot
     * 
     * @returns The current EasyCrypt configuration
     */
    public getConfig(): EasyCryptConfig {
        if (this.cachedConfig) {
            return this.cachedConfig;
        }

        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        
        this.cachedConfig = {
            executablePath: config.get<string>('executablePath', 'easycrypt'),
            arguments: config.get<string[]>('arguments', []),
            proverArgs: config.get<string[]>('proverArgs', []),
            diagnosticsEnabled: config.get<boolean>('diagnostics.enabled', true),
            liveChecksEnabled: config.get<boolean>('diagnostics.liveChecks', true),
            liveCheckDelay: config.get<number>('diagnostics.delay', 500),
            checkOnChange: config.get<boolean>('diagnostics.onChange', true),
            checkOnSave: config.get<boolean>('diagnostics.onSave', true)
        };

        return this.cachedConfig;
    }

    /**
     * Gets the configured executable path
     * 
     * @returns The executable path string
     */
    public getExecutablePath(): string {
        return this.getConfig().executablePath;
    }

    /**
     * Gets the arguments to pass to EasyCrypt
     * 
     * @returns Array of argument strings
     */
    public getArguments(): string[] {
        return this.getConfig().arguments;
    }

    /**
     * Gets the prover arguments
     * 
     * @returns Array of prover argument strings
     */
    public getProverArgs(): string[] {
        return this.getConfig().proverArgs;
    }

    /**
     * Checks if diagnostics are enabled
     * 
     * @returns True if diagnostics are enabled
     */
    public isDiagnosticsEnabled(): boolean {
        return this.getConfig().diagnosticsEnabled;
    }

    /**
     * Checks if live syntax checks are enabled
     * 
     * @returns True if live checks are enabled
     */
    public isLiveChecksEnabled(): boolean {
        const config = this.getConfig();
        return config.diagnosticsEnabled && config.liveChecksEnabled;
    }

    /**
     * Gets the delay before running live checks
     * 
     * @returns Delay in milliseconds
     */
    public getLiveCheckDelay(): number {
        return this.getConfig().liveCheckDelay;
    }

    /**
     * Checks if checks should run on document change
     * 
     * @returns True if checks should run on change
     */
    public isCheckOnChangeEnabled(): boolean {
        return this.getConfig().checkOnChange;
    }

    /**
     * Checks if checks should run on document save
     * 
     * @returns True if checks should run on save
     */
    public isCheckOnSaveEnabled(): boolean {
        return this.getConfig().checkOnSave;
    }

    /**
     * Validates the configured executable path
     * 
     * Checks if the path exists and is executable.
     * For relative paths or just 'easycrypt', attempts to resolve via PATH.
     * 
     * @returns Promise resolving to validation result
     */
    public async validateExecutablePath(): Promise<ValidationResult> {
        const execPath = this.getExecutablePath();
        
        // Handle empty path
        if (!execPath || execPath.trim() === '') {
            return {
                valid: false,
                error: 'Executable path is not configured'
            };
        }

        // If it's an absolute path, check directly
        if (path.isAbsolute(execPath)) {
            return this.checkFileExecutable(execPath);
        }

        // For relative paths or just 'easycrypt', try to resolve via which/where
        const resolvedPath = await this.resolveExecutableInPath(execPath);
        if (resolvedPath) {
            return {
                valid: true,
                resolvedPath
            };
        }

        // If not found in PATH, check if it's a relative path from workspace
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const workspacePath = path.join(workspaceFolder.uri.fsPath, execPath);
            const workspaceResult = await this.checkFileExecutable(workspacePath);
            if (workspaceResult.valid) {
                return {
                    valid: true,
                    resolvedPath: workspacePath
                };
            }
        }

        return {
            valid: false,
            error: `EasyCrypt executable not found: '${execPath}'. Please configure the correct path in settings.`
        };
    }

    /**
     * Checks if a file exists and is executable
     * 
     * @param filePath - Path to check
     * @returns Promise resolving to validation result
     */
    private async checkFileExecutable(filePath: string): Promise<ValidationResult> {
        try {
            // Check if file exists
            await access(filePath, fs.constants.F_OK);
            
            // Check if file is executable (on Unix-like systems)
            // On Windows, we just check existence since .exe handling is automatic
            if (process.platform !== 'win32') {
                await access(filePath, fs.constants.X_OK);
            }

            return {
                valid: true,
                resolvedPath: filePath
            };
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === 'ENOENT') {
                return {
                    valid: false,
                    error: `File not found: '${filePath}'`
                };
            } else if (err.code === 'EACCES') {
                return {
                    valid: false,
                    error: `File is not executable: '${filePath}'`
                };
            }
            return {
                valid: false,
                error: `Cannot access file: '${filePath}' (${err.message})`
            };
        }
    }

    /**
     * Attempts to resolve an executable name in the system PATH
     * 
     * @param execName - Name of the executable to find
     * @returns Promise resolving to the full path, or undefined if not found
     */
    private async resolveExecutableInPath(execName: string): Promise<string | undefined> {
        const pathEnv = process.env.PATH || '';
        const pathSeparator = process.platform === 'win32' ? ';' : ':';
        const pathDirs = pathEnv.split(pathSeparator);
        
        // Extensions to try on Windows
        const extensions = process.platform === 'win32' 
            ? ['', '.exe', '.cmd', '.bat']
            : [''];

        for (const dir of pathDirs) {
            for (const ext of extensions) {
                const fullPath = path.join(dir, execName + ext);
                const result = await this.checkFileExecutable(fullPath);
                if (result.valid) {
                    return fullPath;
                }
            }
        }

        return undefined;
    }

    /**
     * Shows an error notification with a button to open settings
     * 
     * @param message - The error message to display
     */
    public async showConfigurationError(message: string): Promise<void> {
        const openSettings = 'Open Settings';
        const result = await vscode.window.showErrorMessage(
            `EasyCrypt: ${message}`,
            openSettings
        );
        
        if (result === openSettings) {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'easycrypt.executablePath'
            );
        }
    }

    /**
     * Shows a warning notification
     * 
     * @param message - The warning message to display
     */
    public showConfigurationWarning(message: string): void {
        vscode.window.showWarningMessage(`EasyCrypt: ${message}`);
    }

    /**
     * Updates a configuration value
     * 
     * @param key - The configuration key (without 'easycrypt.' prefix)
     * @param value - The new value
     * @param target - The configuration target (default: Workspace)
     */
    public async updateConfig<T>(
        key: string,
        value: T,
        target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await config.update(key, value, target);
        // Cache will be invalidated by the change event listener
    }

    /**
     * Disposes of the configuration manager
     */
    public dispose(): void {
        this._onDidChangeConfiguration.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

/**
 * Singleton instance of the configuration manager
 * Use getConfigurationManager() to access
 */
let instance: ConfigurationManager | undefined;

/**
 * Gets or creates the singleton ConfigurationManager instance
 * 
 * @returns The ConfigurationManager instance
 */
export function getConfigurationManager(): ConfigurationManager {
    if (!instance) {
        instance = new ConfigurationManager();
    }
    return instance;
}

/**
 * Disposes of the singleton instance
 * Should be called during extension deactivation
 */
export function disposeConfigurationManager(): void {
    if (instance) {
        instance.dispose();
        instance = undefined;
    }
}
