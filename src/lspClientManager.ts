import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    Trace,
    TransportKind
} from 'vscode-languageclient/node';
import { Logger } from './logger';

export interface LspManagerConfig {
    readonly executablePath: string;
    readonly serverArgs: readonly string[];
    readonly traceServer: 'off' | 'messages' | 'verbose';
    readonly requestTimeoutMs: number;
    readonly enableLogFile: boolean;
}

export interface LanguageClientLike extends vscode.Disposable {
    start(): Promise<void>;
    stop(): Promise<void>;
    sendRequest<TResult>(method: string, params?: unknown): Promise<TResult>;
    sendNotification(method: string, params?: unknown): Promise<void> | void;
    setTrace(value: Trace): void;
}

export type LanguageClientFactory = (
    id: string,
    name: string,
    serverOptions: ServerOptions,
    clientOptions: LanguageClientOptions
) => LanguageClientLike;

function defaultClientFactory(
    id: string,
    name: string,
    serverOptions: ServerOptions,
    clientOptions: LanguageClientOptions
): LanguageClientLike {
    return new LanguageClient(id, name, serverOptions, clientOptions);
}

function mapTrace(trace: LspManagerConfig['traceServer']): Trace {
    switch (trace) {
        case 'messages':
            return Trace.Messages;
        case 'verbose':
            return Trace.Verbose;
        case 'off':
        default:
            return Trace.Off;
    }
}

function createServerOptions(config: LspManagerConfig): ServerOptions {
    const args = ['lsp', ...config.serverArgs];
    const env: NodeJS.ProcessEnv = {
        ...process.env
    };

    if (config.enableLogFile) {
        env.EASYCRYPT_LSP_LOG = '1';
    }

    return {
        command: config.executablePath,
        args,
        transport: TransportKind.stdio,
        options: {
            env
        }
    };
}

function createClientOptions(outputChannel: vscode.OutputChannel): LanguageClientOptions {
    return {
        documentSelector: [],
        outputChannel
    };
}

export class LspClientManager implements vscode.Disposable {
    private client: LanguageClientLike | undefined;
    private disposed = false;
    private startPromise: Promise<void> | undefined;
    private stopPromise: Promise<void> | undefined;
    private requestTimeoutMs = 30000;
    private startCount = 0;
    private requestCount = 0;
    private generation = 0;

    constructor(
        private readonly outputChannel: vscode.OutputChannel,
        private readonly logger?: Logger,
        private readonly clientFactory: LanguageClientFactory = defaultClientFactory
    ) {}

    public isRunning(): boolean {
        return this.client !== undefined && !this.disposed;
    }

    public getStartCount(): number {
        return this.startCount;
    }

    public getRequestCount(): number {
        return this.requestCount;
    }

    public getGeneration(): number {
        return this.generation;
    }

    public async start(config: LspManagerConfig, token?: vscode.CancellationToken): Promise<void> {
        this.throwIfDisposed();

        if (this.client) {
            this.requestTimeoutMs = config.requestTimeoutMs;
            return;
        }

        if (this.startPromise) {
            await this.startPromise;
            return;
        }

        this.requestTimeoutMs = config.requestTimeoutMs;

        this.startPromise = this.startInternal(config, token);
        try {
            await this.startPromise;
        } finally {
            this.startPromise = undefined;
        }
    }

    private async startInternal(config: LspManagerConfig, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) {
            throw new Error('LSP start cancelled');
        }

        this.logger?.event('lsp-client-start-requested', {
            executablePath: config.executablePath,
            args: ['lsp', ...config.serverArgs],
            trace: config.traceServer,
            timeoutMs: config.requestTimeoutMs,
            enableLogFile: config.enableLogFile
        });

        const serverOptions = createServerOptions(config);
        const clientOptions = createClientOptions(this.outputChannel);
        const client = this.clientFactory(
            'easycrypt-lsp-client',
            'EasyCrypt LSP Client',
            serverOptions,
            clientOptions
        );

        try {
            client.setTrace(mapTrace(config.traceServer));
            await client.start();
            this.client = client;
            this.startCount += 1;
            this.generation += 1;
            this.logger?.event('lsp-client-started', {
                startCount: this.startCount,
                generation: this.generation
            });
        } catch (error) {
            try {
                client.dispose();
            } catch {
                // best effort cleanup
            }
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.error('LspClientManager', `Failed to start LSP client: ${message}`);
            throw new Error(`Failed to start LSP client: ${message}`);
        }
    }

    public async stop(reason: 'manual-stop' | 'switch' | 'shutdown' | 'config-change'): Promise<void> {
        if (!this.client) {
            return;
        }

        if (this.stopPromise) {
            await this.stopPromise;
            return;
        }

        this.stopPromise = this.stopInternal(reason);
        try {
            await this.stopPromise;
        } finally {
            this.stopPromise = undefined;
        }
    }

    private async stopInternal(reason: 'manual-stop' | 'switch' | 'shutdown' | 'config-change'): Promise<void> {
        const client = this.client;
        if (!client) {
            return;
        }

        this.logger?.event('lsp-client-stop-requested', {
            reason,
            generation: this.generation
        });

        this.client = undefined;

        try {
            await client.stop();
        } finally {
            try {
                client.dispose();
            } catch {
                // best effort cleanup
            }
            this.generation += 1;
            this.logger?.event('lsp-client-stopped', {
                reason,
                generation: this.generation
            });
        }
    }

    public async restart(
        config: LspManagerConfig,
        reason: 'manual-stop' | 'switch' | 'shutdown' | 'config-change',
        token?: vscode.CancellationToken
    ): Promise<void> {
        await this.stop(reason);
        await this.start(config, token);
    }

    public async sendRequest<TResult>(
        method: string,
        params: unknown,
        token?: vscode.CancellationToken,
        timeoutMs?: number
    ): Promise<TResult> {
        this.throwIfDisposed();

        const client = this.client;
        if (!client) {
            throw new Error('LSP client is not running');
        }

        if (token?.isCancellationRequested) {
            throw new Error(`LSP request cancelled: ${method}`);
        }

        this.requestCount += 1;
        const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;

        let timeoutHandle: NodeJS.Timeout | undefined;
        let cancellationDisposable: vscode.Disposable | undefined;

        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            if (effectiveTimeout <= 0) {
                return;
            }

            timeoutHandle = setTimeout(() => {
                reject(new Error(`LSP request timeout (${method}) after ${effectiveTimeout}ms`));
            }, effectiveTimeout);
        });

        const cancellationPromise = new Promise<never>((_resolve, reject) => {
            if (!token) {
                return;
            }

            cancellationDisposable = token.onCancellationRequested(() => {
                reject(new Error(`LSP request cancelled: ${method}`));
            });
        });

        try {
            const result = await Promise.race([
                client.sendRequest<TResult>(method, params),
                timeoutPromise,
                cancellationPromise
            ]);

            this.logger?.process('lsp-request-success', {
                method,
                requestCount: this.requestCount,
                generation: this.generation
            });

            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.warn('LspClientManager', `LSP request failed for ${method}: ${message}`);
            throw error;
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            cancellationDisposable?.dispose();
        }
    }

    public async sendNotification(method: string, params: unknown): Promise<void> {
        this.throwIfDisposed();

        const client = this.client;
        if (!client) {
            throw new Error('LSP client is not running');
        }

        await Promise.resolve(client.sendNotification(method, params));
        this.logger?.process('lsp-notification-sent', {
            method,
            generation: this.generation
        });
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw new Error('LspClientManager has been disposed');
        }
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        const client = this.client;
        this.client = undefined;

        if (client) {
            void client.stop().finally(() => {
                try {
                    client.dispose();
                } catch {
                    // best effort cleanup
                }
            });
        }
    }
}
