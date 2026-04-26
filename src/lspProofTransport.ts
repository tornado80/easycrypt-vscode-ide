import * as vscode from 'vscode';
import { Logger } from './logger';
import { LspClientManager, LspManagerConfig } from './lspClientManager';
import { parseLspProofResponse, parseLspQueryResponse } from './lspProtocol';
import {
    ProofTransport,
    ProofTransportResponse,
    QueryTransportResponse,
    TransportStopReason
} from './proofTransport';

function toLspUri(document: vscode.TextDocument): string {
    return document.uri.toString();
}

function toDidOpenParams(document: vscode.TextDocument): Record<string, unknown> {
    return {
        textDocument: {
            uri: toLspUri(document),
            languageId: document.languageId,
            version: document.version,
            text: document.getText()
        }
    };
}

function toDidChangeParams(event: vscode.TextDocumentChangeEvent): Record<string, unknown> {
    return {
        textDocument: {
            uri: toLspUri(event.document),
            version: event.document.version
        },
        contentChanges: event.contentChanges.map((change) => ({
            range: {
                start: {
                    line: change.range.start.line,
                    character: change.range.start.character
                },
                end: {
                    line: change.range.end.line,
                    character: change.range.end.character
                }
            },
            rangeLength: change.rangeLength,
            text: change.text
        }))
    };
}

function toDidCloseParams(document: vscode.TextDocument): Record<string, unknown> {
    return {
        textDocument: {
            uri: toLspUri(document)
        }
    };
}

export class LspProofTransport implements ProofTransport {
    public readonly channel = 'lsp' as const;

    private disposed = false;
    private executionOffset = 0;
    private readonly syncedDocumentVersions = new Map<string, number>();

    constructor(
        private readonly clientManager: LspClientManager,
        private readonly configProvider: () => LspManagerConfig,
        private readonly logger?: Logger
    ) {}

    public async start(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<void> {
        this.throwIfDisposed();
        await this.clientManager.start(this.configProvider(), token);
        await this.syncDocumentOpen(document);
    }

    public async stop(reason: TransportStopReason): Promise<void> {
        if (this.disposed) {
            return;
        }

        if (reason === 'file-close') {
            return;
        }

        await this.clientManager.stop(reason);
    }

    public async restart(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<void> {
        this.throwIfDisposed();
        await this.clientManager.restart(this.configProvider(), 'manual-stop', token);
        this.syncedDocumentVersions.clear();
        this.executionOffset = 0;
        await this.syncDocumentOpen(document);
    }

    public async syncDocumentOpen(document: vscode.TextDocument): Promise<void> {
        if (!this.clientManager.isRunning()) {
            return;
        }

        const key = document.uri.toString();
        const lastVersion = this.syncedDocumentVersions.get(key);
        if (lastVersion !== undefined) {
            if (lastVersion !== document.version) {
                await this.clientManager.sendNotification('textDocument/didChange', {
                    textDocument: {
                        uri: toLspUri(document),
                        version: document.version
                    },
                    contentChanges: [
                        {
                            text: document.getText()
                        }
                    ]
                });
                this.syncedDocumentVersions.set(key, document.version);
            }
            return;
        }

        await this.clientManager.sendNotification('textDocument/didOpen', toDidOpenParams(document));
        this.syncedDocumentVersions.set(key, document.version);
    }

    public async syncDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        if (!this.clientManager.isRunning()) {
            return;
        }

        const key = event.document.uri.toString();
        if (!this.syncedDocumentVersions.has(key)) {
            await this.syncDocumentOpen(event.document);
            return;
        }

        await this.clientManager.sendNotification('textDocument/didChange', toDidChangeParams(event));
        this.syncedDocumentVersions.set(key, event.document.version);
    }

    public async syncDocumentClose(document: vscode.TextDocument): Promise<void> {
        if (!this.clientManager.isRunning()) {
            this.syncedDocumentVersions.delete(document.uri.toString());
            return;
        }

        const key = document.uri.toString();
        if (!this.syncedDocumentVersions.has(key)) {
            return;
        }

        await this.clientManager.sendNotification('textDocument/didClose', toDidCloseParams(document));
        this.syncedDocumentVersions.delete(key);
    }

    public async proofNext(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<ProofTransportResponse> {
        return this.sendProofRequest('easycrypt/proof/next', { uri: toLspUri(document) }, token, false);
    }

    public async proofStep(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<ProofTransportResponse> {
        return this.sendProofRequest('easycrypt/proof/step', { uri: toLspUri(document) }, token, true);
    }

    public async proofJumpTo(
        document: vscode.TextDocument,
        target: number,
        token?: vscode.CancellationToken
    ): Promise<ProofTransportResponse> {
        return this.sendProofRequest(
            'easycrypt/proof/jumpTo',
            { uri: toLspUri(document), target },
            token,
            true
        );
    }

    public async proofBack(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<ProofTransportResponse> {
        return this.sendProofRequest('easycrypt/proof/back', { uri: toLspUri(document) }, token, true);
    }

    public async proofRestart(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<ProofTransportResponse> {
        return this.sendProofRequest('easycrypt/proof/restart', { uri: toLspUri(document) }, token, true);
    }

    public async proofGoals(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<ProofTransportResponse> {
        return this.sendProofRequest('easycrypt/proof/goals', { uri: toLspUri(document) }, token, false);
    }

    public async queryPrint(
        document: vscode.TextDocument,
        query: string,
        token?: vscode.CancellationToken
    ): Promise<QueryTransportResponse> {
        return this.sendQueryRequest('easycrypt/query/print', { uri: toLspUri(document), query }, token);
    }

    public async queryLocate(
        document: vscode.TextDocument,
        query: string,
        token?: vscode.CancellationToken
    ): Promise<QueryTransportResponse> {
        return this.sendQueryRequest('easycrypt/query/locate', { uri: toLspUri(document), query }, token);
    }

    public async querySearch(
        document: vscode.TextDocument,
        query: string,
        token?: vscode.CancellationToken
    ): Promise<QueryTransportResponse> {
        return this.sendQueryRequest('easycrypt/query/search', { uri: toLspUri(document), query }, token);
    }

    public isRunning(): boolean {
        return this.clientManager.isRunning();
    }

    public getExecutionOffset(): number {
        return this.executionOffset;
    }

    public getProcessStartCount(): number {
        return this.clientManager.getStartCount();
    }

    public getSendCommandCount(): number {
        return this.clientManager.getRequestCount();
    }

    private async sendProofRequest(
        method: string,
        params: Record<string, unknown>,
        token: vscode.CancellationToken | undefined,
        mutateOffset: boolean
    ): Promise<ProofTransportResponse> {
        this.throwIfDisposed();

        const raw = await this.clientManager.sendRequest<unknown>(
            method,
            params,
            token,
            this.configProvider().requestTimeoutMs
        );

        const parsed = parseLspProofResponse(raw);
        const response: ProofTransportResponse = {
            output: parsed.output,
            processedEnd: parsed.processedEnd,
            sentenceStart: parsed.sentenceStart,
            sentenceEnd: parsed.sentenceEnd,
            uuid: parsed.uuid,
            mode: parsed.mode
        };

        if (mutateOffset) {
            this.executionOffset = response.processedEnd;
        }

        this.logger?.process('lsp-proof-response', {
            method,
            processedEnd: response.processedEnd,
            sentenceStart: response.sentenceStart,
            sentenceEnd: response.sentenceEnd,
            uuid: response.uuid,
            mode: response.mode
        });

        return response;
    }

    private async sendQueryRequest(
        method: string,
        params: Record<string, unknown>,
        token: vscode.CancellationToken | undefined
    ): Promise<QueryTransportResponse> {
        this.throwIfDisposed();

        const raw = await this.clientManager.sendRequest<unknown>(
            method,
            params,
            token,
            this.configProvider().requestTimeoutMs
        );

        const parsed = parseLspQueryResponse(raw);
        return {
            output: parsed.output
        };
    }

    private throwIfDisposed(): void {
        if (this.disposed) {
            throw new Error('LspProofTransport has been disposed');
        }
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.syncedDocumentVersions.clear();
    }
}
