import * as vscode from 'vscode';
import { ConfigurationManager } from './configurationManager';
import { DecorationProjectionService } from './decorationProjectionService';
import { DiagnosticManager } from './diagnosticManager';
import { Logger } from './logger';
import { ManagedProofSession } from './managedProofSession';
import { ProofProgressSnapshot, ProofStateManager } from './proofStateManager';
import { ProofTransport, ProofTransportResponse } from './proofTransport';
import { FileSessionKey } from './sessionKey';
import { SessionStopReason } from './sessionRegistry';
import { StatementIndex } from './statementIndex';
import { findPreviousStatementEnd } from './statementParser';
import { StepResult } from './stepManager';
import { parseOutput } from './outputParser';

export interface LspFileSessionOptions {
    readonly key: FileSessionKey;
    readonly documentUri: vscode.Uri;
    readonly configurationManager: ConfigurationManager;
    readonly diagnosticManager: DiagnosticManager;
    readonly decorationProjection: DecorationProjectionService;
    readonly proofTransport: ProofTransport;
    readonly outputChannel: vscode.OutputChannel;
    readonly logger?: Logger;
}

export class LspFileSession implements ManagedProofSession {
    public readonly key: FileSessionKey;
    public readonly documentUri: vscode.Uri;
    public readonly channel = 'lsp' as const;
    public readonly proofStateManager: ProofStateManager;

    private executionOffset = 0;
    private disposed = false;
    private inCommand = false;
    private retracting = false;
    private pendingRetractOffset: number | undefined;
    private readonly statementIndex = new StatementIndex();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly options: LspFileSessionOptions) {
        this.key = options.key;
        this.documentUri = options.documentUri;
        this.proofStateManager = new ProofStateManager();
        this.proofStateManager.reset({ provedStatementCount: 0 });

        this.disposables.push(this.proofStateManager);
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                void this.handleDocumentChange(event);
            })
        );
    }

    public async ensureStarted(token?: vscode.CancellationToken): Promise<void> {
        this.throwIfDisposed();

        const document = await this.requireDocument();
        await this.options.proofTransport.start(document, token);
        await this.options.proofTransport.syncDocumentOpen(document);
    }

    public async stop(reason: SessionStopReason): Promise<void> {
        if (this.disposed) {
            return;
        }

        try {
            const document = this.getOpenedDocument();
            if (document) {
                await this.options.proofTransport.syncDocumentClose(document);
            }
        } catch {
            // best effort close
        }

        await this.options.proofTransport.stop(reason);
    }

    public async restart(token?: vscode.CancellationToken): Promise<void> {
        this.throwIfDisposed();

        const document = await this.requireDocument();
        await this.options.proofTransport.restart(document, token);
        this.executionOffset = 0;
        this.proofStateManager.reset({ provedStatementCount: 0 });
        this.updateDecorations();
    }

    public async syncDocumentOpen(document: vscode.TextDocument): Promise<void> {
        if (!this.isTrackedDocument(document)) {
            return;
        }

        this.statementIndex.update(document.getText(), document.version);
        await this.options.proofTransport.syncDocumentOpen(document);
    }

    public async syncDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        if (!this.isTrackedDocument(event.document)) {
            return;
        }

        this.statementIndex.update(event.document.getText(), event.document.version);
        await this.options.proofTransport.syncDocumentChange(event);
    }

    public async syncDocumentClose(document: vscode.TextDocument): Promise<void> {
        if (!this.isTrackedDocument(document)) {
            return;
        }

        await this.options.proofTransport.syncDocumentClose(document);
    }

    public async stepForward(token?: vscode.CancellationToken): Promise<StepResult> {
        return this.runCommand(token, async (document) => {
            const preview = await this.options.proofTransport.proofNext(document, token);
            this.showProcessingRange(document, preview);

            const response = await this.options.proofTransport.proofStep(document, token);
            if (token?.isCancellationRequested) {
                throw new Error('Command cancelled: stepForward');
            }

            return this.applyProofResponse(document, response);
        });
    }

    public async stepBackward(token?: vscode.CancellationToken): Promise<StepResult> {
        return this.runCommand(token, async (document) => {
            const response = await this.options.proofTransport.proofBack(document, token);
            if (token?.isCancellationRequested) {
                throw new Error('Command cancelled: stepBackward');
            }

            return this.applyProofResponse(document, response);
        });
    }

    public async goToCursor(token?: vscode.CancellationToken): Promise<StepResult> {
        return this.runCommand(token, async (document) => {
            this.statementIndex.update(document.getText(), document.version);
            const cursorOffset = this.resolveCursorOffset(document);
            const targetOffset = this.statementIndex.getTargetEndOffset(cursorOffset);
            const response = await this.options.proofTransport.proofJumpTo(document, targetOffset, token);

            if (token?.isCancellationRequested) {
                throw new Error('Command cancelled: goToCursor');
            }

            return this.applyProofResponse(document, response);
        });
    }

    public async resetProof(token?: vscode.CancellationToken): Promise<StepResult> {
        return this.runCommand(token, async (document) => {
            const response = await this.options.proofTransport.proofRestart(document, token);
            if (token?.isCancellationRequested) {
                throw new Error('Command cancelled: resetProof');
            }

            const result = this.applyProofResponse(document, response);
            if (result.success) {
                this.proofStateManager.reset({ provedStatementCount: 0 });
                this.updateDecorations();
            }

            return {
                ...result,
                executionOffset: this.executionOffset
            };
        });
    }

    public async forceRecovery(token?: vscode.CancellationToken): Promise<StepResult> {
        return this.runCommand(token, async (document) => {
            const currentOffset = this.executionOffset;

            await this.options.proofTransport.restart(document, token);
            if (currentOffset === 0) {
                this.executionOffset = 0;
                this.updateDecorations();
                this.proofStateManager.reset({ provedStatementCount: 0 });
                return {
                    success: true,
                    executionOffset: this.executionOffset
                };
            }

            const response = await this.options.proofTransport.proofJumpTo(document, currentOffset, token);
            if (token?.isCancellationRequested) {
                throw new Error('Command cancelled: forceRecovery');
            }

            return this.applyProofResponse(document, response);
        });
    }

    public isRuntimeRunning(): boolean {
        return this.options.proofTransport.isRunning();
    }

    public getExecutionOffset(): number {
        return this.executionOffset;
    }

    public getProcessStartCount(): number {
        return this.options.proofTransport.getProcessStartCount();
    }

    public getSendCommandCount(): number {
        return this.options.proofTransport.getSendCommandCount();
    }

    private async runCommand(
        token: vscode.CancellationToken | undefined,
        run: (document: vscode.TextDocument) => Promise<StepResult>
    ): Promise<StepResult> {
        this.throwIfDisposed();

        if (token?.isCancellationRequested) {
            throw new Error('Command cancelled');
        }

        if (this.inCommand) {
            return {
                success: false,
                error: 'Step already in progress',
                executionOffset: this.executionOffset
            };
        }

        this.inCommand = true;
        this.proofStateManager.setProcessing(true);

        try {
            await this.ensureStarted(token);
            const document = await this.requireDocument();
            await this.options.proofTransport.syncDocumentOpen(document);
            const result = await run(document);
            return {
                ...result,
                executionOffset: this.executionOffset
            };
        } finally {
            this.inCommand = false;
            this.proofStateManager.setProcessing(false);
            this.clearProcessingAndVerifyingRanges();
        }
    }

    private applyProofResponse(document: vscode.TextDocument, response: ProofTransportResponse): StepResult {
        const rawOutput = this.withDebugPromptMarker(response);
        const parsed = parseOutput(response.output, {
            defaultFilePath: document.uri.fsPath,
            includeRawOutput: true
        });

        this.executionOffset = response.processedEnd;
        this.statementIndex.update(document.getText(), document.version);

        const progress = this.computeProgressSnapshot(document);
        this.proofStateManager.handleProcessOutput(
            {
                raw: rawOutput,
                parsed,
                fileUri: this.documentUri
            },
            progress
        );

        this.updateDiagnostics(parsed.errors);
        this.updateDecorations();

        const error = parsed.errors[0]?.message;
        return {
            success: error === undefined,
            error,
            output: response.output,
            executionOffset: this.executionOffset
        };
    }

    private withDebugPromptMarker(response: ProofTransportResponse): string {
        if (response.uuid === undefined || !response.mode) {
            return response.output;
        }

        const promptMarker = `[${response.uuid}|${response.mode}]>`;
        if (response.output.trim().length === 0) {
            return promptMarker;
        }

        return `${response.output}\n${promptMarker}`;
    }

    private computeProgressSnapshot(document: vscode.TextDocument): ProofProgressSnapshot {
        const statements = this.statementIndex.getStatementsUpTo(this.executionOffset);
        const provedStatementCount = statements.length;

        let lastProvedStatementText: string | undefined;
        if (provedStatementCount > 0) {
            let lastStatement = statements[statements.length - 1];
            if (lastStatement.endOffset !== this.executionOffset) {
                for (let index = statements.length - 1; index >= 0; index--) {
                    if (statements[index].endOffset <= this.executionOffset) {
                        lastStatement = statements[index];
                        break;
                    }
                }
            }
            lastProvedStatementText = lastStatement.text;
        }

        this.options.logger?.proof('lsp-progress-snapshot', {
            sessionKey: this.key,
            uri: document.uri.fsPath,
            provedStatementCount,
            executionOffset: this.executionOffset
        });

        return { provedStatementCount, lastProvedStatementText };
    }

    private updateDiagnostics(errors: ReturnType<typeof parseOutput>['errors']): void {
        if (!this.options.configurationManager.isDiagnosticsEnabled()) {
            this.options.diagnosticManager.clearDiagnostics(this.documentUri);
            return;
        }

        this.options.diagnosticManager.setDiagnostics(this.documentUri, errors);
    }

    private updateDecorations(): void {
        const verifiedRange = this.computeVerifiedRange();
        const current = this.options.decorationProjection.get(this.documentUri) ?? {};
        this.options.decorationProjection.update(this.documentUri, {
            ...current,
            verifiedRange,
            processingRange: undefined,
            verifyingRange: undefined
        });
    }

    private showProcessingRange(document: vscode.TextDocument, response: ProofTransportResponse): void {
        const start = response.sentenceStart;
        const end = response.sentenceEnd;

        if (start === null || end === null || start === undefined || end === undefined) {
            return;
        }

        const current = this.options.decorationProjection.get(this.documentUri) ?? {};
        this.options.decorationProjection.update(this.documentUri, {
            ...current,
            processingRange: new vscode.Range(document.positionAt(start), document.positionAt(end))
        });
    }

    private clearProcessingAndVerifyingRanges(): void {
        const current = this.options.decorationProjection.get(this.documentUri) ?? {};
        this.options.decorationProjection.update(this.documentUri, {
            ...current,
            processingRange: undefined,
            verifyingRange: undefined
        });
    }

    private computeVerifiedRange(): vscode.Range | undefined {
        const document = this.getOpenedDocument();
        if (!document || this.executionOffset <= 0) {
            return undefined;
        }

        return new vscode.Range(new vscode.Position(0, 0), document.positionAt(this.executionOffset));
    }

    private async handleDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        if (!this.isTrackedDocument(event.document)) {
            return;
        }

        await this.syncDocumentChange(event);

        if (this.executionOffset === 0 || this.inCommand || this.retracting) {
            return;
        }

        let minOffset: number | undefined;
        for (const change of event.contentChanges) {
            const changeOffset = event.document.offsetAt(change.range.start);
            if (changeOffset < this.executionOffset) {
                minOffset = minOffset === undefined ? changeOffset : Math.min(minOffset, changeOffset);
            }
        }

        if (minOffset !== undefined) {
            this.queueRetraction(minOffset);
        }
    }

    private queueRetraction(targetOffset: number): void {
        this.pendingRetractOffset =
            this.pendingRetractOffset === undefined
                ? targetOffset
                : Math.min(this.pendingRetractOffset, targetOffset);

        if (this.retracting) {
            return;
        }

        void this.runPendingRetraction();
    }

    private async runPendingRetraction(): Promise<void> {
        if (this.retracting) {
            return;
        }

        this.retracting = true;
        try {
            while (this.pendingRetractOffset !== undefined && this.pendingRetractOffset < this.executionOffset) {
                const target = this.pendingRetractOffset;
                this.pendingRetractOffset = undefined;
                await this.retractTo(target);
            }
        } finally {
            this.retracting = false;
        }
    }

    private async retractTo(targetOffset: number): Promise<void> {
        if (this.inCommand) {
            return;
        }

        const document = await this.requireDocument();
        const previousEnd = findPreviousStatementEnd(document.getText(), targetOffset);
        const normalizedTarget = previousEnd ?? 0;

        const response = await this.options.proofTransport.proofJumpTo(document, normalizedTarget);
        this.applyProofResponse(document, response);
    }

    private resolveCursorOffset(document: vscode.TextDocument): number {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.toString() !== document.uri.toString()) {
            return this.executionOffset;
        }

        return document.offsetAt(activeEditor.selection.active);
    }

    private getOpenedDocument(): vscode.TextDocument | undefined {
        return vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === this.documentUri.toString()
        );
    }

    private async requireDocument(): Promise<vscode.TextDocument> {
        const opened = this.getOpenedDocument();
        if (opened) {
            return opened;
        }

        return vscode.workspace.openTextDocument(this.documentUri);
    }

    private isTrackedDocument(document: vscode.TextDocument): boolean {
        return document.uri.toString() === this.documentUri.toString();
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw new Error('LSP session has already been disposed');
        }
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.options.decorationProjection.clear(this.documentUri);
        this.options.diagnosticManager.clearDiagnostics(this.documentUri);
        this.options.proofTransport.dispose();
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
