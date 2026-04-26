import * as vscode from 'vscode';
import { ProofStateManager } from './proofStateManager';
import { FileSessionKey } from './sessionKey';
import { SessionStopReason } from './sessionRegistry';
import { StepResult } from './stepManager';

export type SessionChannel = 'emacs' | 'lsp';

export interface ManagedProofSession extends vscode.Disposable {
    readonly key: FileSessionKey;
    readonly documentUri: vscode.Uri;
    readonly channel: SessionChannel;
    readonly proofStateManager: ProofStateManager;

    ensureStarted(token?: vscode.CancellationToken): Promise<void>;
    stop(reason: SessionStopReason): Promise<void>;
    restart(token?: vscode.CancellationToken): Promise<void>;

    syncDocumentOpen(document: vscode.TextDocument): Promise<void>;
    syncDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void>;
    syncDocumentClose(document: vscode.TextDocument): Promise<void>;

    stepForward(token?: vscode.CancellationToken): Promise<StepResult>;
    stepBackward(token?: vscode.CancellationToken): Promise<StepResult>;
    goToCursor(token?: vscode.CancellationToken): Promise<StepResult>;
    resetProof(token?: vscode.CancellationToken): Promise<StepResult>;
    forceRecovery(token?: vscode.CancellationToken): Promise<StepResult>;

    isRuntimeRunning(): boolean;
    getExecutionOffset(): number;
    getProcessStartCount(): number;
    getSendCommandCount(): number;
}
