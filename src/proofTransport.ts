import * as vscode from 'vscode';
import { CommunicationChannel } from './channelSelectionPolicy';

export interface ProofTransportResponse {
    readonly output: string;
    readonly processedEnd: number;
    readonly sentenceStart?: number | null;
    readonly sentenceEnd?: number | null;
    readonly uuid?: number;
    readonly mode?: string;
}

export interface QueryTransportResponse {
    readonly output: string;
}

export type TransportStopReason =
    | 'manual-stop'
    | 'switch'
    | 'shutdown'
    | 'config-change'
    | 'file-close';

export interface ProofTransport extends vscode.Disposable {
    readonly channel: Exclude<CommunicationChannel, 'auto'>;

    start(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<void>;
    stop(reason: TransportStopReason): Promise<void>;
    restart(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<void>;

    syncDocumentOpen(document: vscode.TextDocument): Promise<void>;
    syncDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void>;
    syncDocumentClose(document: vscode.TextDocument): Promise<void>;

    proofNext(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<ProofTransportResponse>;
    proofStep(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<ProofTransportResponse>;
    proofJumpTo(
        document: vscode.TextDocument,
        target: number,
        token?: vscode.CancellationToken
    ): Promise<ProofTransportResponse>;
    proofBack(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<ProofTransportResponse>;
    proofRestart(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<ProofTransportResponse>;
    proofGoals(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<ProofTransportResponse>;

    queryPrint(
        document: vscode.TextDocument,
        query: string,
        token?: vscode.CancellationToken
    ): Promise<QueryTransportResponse>;
    queryLocate(
        document: vscode.TextDocument,
        query: string,
        token?: vscode.CancellationToken
    ): Promise<QueryTransportResponse>;
    querySearch(
        document: vscode.TextDocument,
        query: string,
        token?: vscode.CancellationToken
    ): Promise<QueryTransportResponse>;

    isRunning(): boolean;
    getExecutionOffset(): number;
    getProcessStartCount(): number;
    getSendCommandCount(): number;
}
