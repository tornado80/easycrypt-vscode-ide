import * as vscode from 'vscode';
import { ConfigurationManager } from './configurationManager';
import { DecorationProjectionService } from './decorationProjectionService';
import { DiagnosticManager } from './diagnosticManager';
import { Logger } from './logger';
import { ProcessManager, ProcessOutput } from './processManager';
import { ProofStateManager } from './proofStateManager';
import { StepDecorationSink, StepManager } from './stepManager';
import { FileSessionKey } from './sessionKey';
import {
    SessionContextFingerprint,
    fingerprintVerificationContext,
    resolveVerificationContext
} from './verificationContextResolver';

export type SessionStopReason = 'file-close' | 'manual-stop' | 'config-change' | 'shutdown';

export interface EasyCryptFileSessionOptions {
    readonly key: FileSessionKey;
    readonly documentUri: vscode.Uri;
    readonly configurationManager: ConfigurationManager;
    readonly diagnosticManager: DiagnosticManager;
    readonly decorationProjection: DecorationProjectionService;
    readonly outputChannel: vscode.OutputChannel;
    readonly logger?: Logger;
}

class ProjectionDecorationSink implements StepDecorationSink {
    constructor(
        private readonly documentUri: vscode.Uri,
        private readonly projection: DecorationProjectionService
    ) {}

    public setVerifiedRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void {
        if (editor.document.uri.toString() !== this.documentUri.toString()) {
            return;
        }

        const current = this.projection.get(this.documentUri) ?? {};
        this.projection.update(this.documentUri, {
            ...current,
            verifiedRange: range
        });
    }

    public setProcessingRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void {
        if (editor.document.uri.toString() !== this.documentUri.toString()) {
            return;
        }

        const current = this.projection.get(this.documentUri) ?? {};
        this.projection.update(this.documentUri, {
            ...current,
            processingRange: range
        });
    }

    public setVerifyingRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void {
        if (editor.document.uri.toString() !== this.documentUri.toString()) {
            return;
        }

        const current = this.projection.get(this.documentUri) ?? {};
        this.projection.update(this.documentUri, {
            ...current,
            verifyingRange: range
        });
    }

    public clearAll(editor: vscode.TextEditor): void {
        if (editor.document.uri.toString() !== this.documentUri.toString()) {
            return;
        }

        this.projection.update(this.documentUri, {});
    }
}

export class EasyCryptFileSession implements vscode.Disposable {
    public readonly key: FileSessionKey;
    public readonly documentUri: vscode.Uri;
    public readonly processManager: ProcessManager;
    public readonly proofStateManager: ProofStateManager;
    public readonly stepManager: StepManager;

    private disposed = false;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly options: EasyCryptFileSessionOptions) {
        this.key = options.key;
        this.documentUri = options.documentUri;

        const decorationSink = new ProjectionDecorationSink(
            this.documentUri,
            options.decorationProjection
        );

        this.processManager = new ProcessManager(
            options.configurationManager,
            options.outputChannel
        );
        this.proofStateManager = new ProofStateManager();
        // Seed an explicit empty context so proof-view navigation can be enabled
        // immediately for an active EasyCrypt file before the first step.
        this.proofStateManager.reset({ provedStatementCount: 0 });
        this.stepManager = new StepManager(
            this.processManager,
            this.proofStateManager,
            decorationSink,
            options.configurationManager,
            options.outputChannel
        );

        this.disposables.push(this.stepManager);
        this.disposables.push(this.proofStateManager);
        this.disposables.push(this.processManager);

        this.disposables.push(
            this.processManager.onOutput((output) => {
                this.handleProcessOutput(output);
            })
        );

        this.disposables.push(
            this.processManager.onDidStart(() => {
                this.options.logger?.event('session-process-started', {
                    sessionKey: this.key,
                    uri: this.documentUri.fsPath
                });
            })
        );

        this.disposables.push(
            this.processManager.onDidStop(({ code, signal }) => {
                this.options.logger?.event('session-process-stopped', {
                    sessionKey: this.key,
                    uri: this.documentUri.fsPath,
                    code,
                    signal
                });
            })
        );

        this.disposables.push(
            this.processManager.onError((error) => {
                this.options.logger?.event('session-process-error', {
                    sessionKey: this.key,
                    uri: this.documentUri.fsPath,
                    error: error.message
                });
            })
        );
    }

    public async ensureStarted(token?: vscode.CancellationToken): Promise<void> {
        this.throwIfDisposed();

        if (token?.isCancellationRequested) {
            throw new Error('Session start cancelled');
        }

        await this.processManager.ensureSessionContext(this.buildSessionContext());

        if (token?.isCancellationRequested) {
            throw new Error('Session start cancelled');
        }
    }

    public async stop(reason: SessionStopReason): Promise<void> {
        if (this.disposed) {
            return;
        }

        this.options.logger?.event('session-stop-requested', {
            sessionKey: this.key,
            uri: this.documentUri.fsPath,
            reason
        });

        await this.processManager.stopAndWait(4000);
    }

    public async restart(): Promise<void> {
        this.throwIfDisposed();
        await this.processManager.restart(this.buildSessionContext());
    }

    private handleProcessOutput(output: ProcessOutput): void {
        this.options.logger?.process('session-output', {
            sessionKey: this.key,
            uri: this.documentUri.fsPath,
            rawLength: output.raw.length,
            errorCount: output.parsed.errors.length,
            hasFileUri: Boolean(output.fileUri)
        });

        const hasActiveTransaction = this.proofStateManager.getActiveTransaction() !== undefined;
        const isWithinGrace = this.proofStateManager.isWithinGracePeriod();

        if (
            !this.stepManager.isStepping() &&
            !this.stepManager.isRecovering() &&
            !hasActiveTransaction &&
            !isWithinGrace
        ) {
            this.proofStateManager.handleProcessOutput(output);
        }

        if (!this.options.configurationManager.isDiagnosticsEnabled()) {
            this.options.diagnosticManager.clearDiagnostics(this.documentUri);
            return;
        }

        this.options.diagnosticManager.setDiagnostics(
            this.documentUri,
            output.parsed.errors
        );
    }

    private buildSessionContext(): SessionContextFingerprint {
        const config = this.options.configurationManager.getConfig();
        const verificationContext = resolveVerificationContext({
            documentPath: this.documentUri.fsPath,
            workspaceFolderPath: this.getWorkspaceFolderPath(),
            configArgs: config.arguments,
            proverArgs: config.proverArgs
        });

        return fingerprintVerificationContext(verificationContext);
    }

    private getWorkspaceFolderPath(): string | undefined {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.documentUri);
        if (workspaceFolder) {
            return workspaceFolder.uri.fsPath;
        }

        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw new Error('Session has already been disposed');
        }
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;

        this.options.decorationProjection.clear(this.documentUri);
        this.options.diagnosticManager.clearDiagnostics(this.documentUri);

        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
