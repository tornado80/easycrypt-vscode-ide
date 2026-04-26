import * as vscode from 'vscode';
import { Logger } from './logger';
import { ManagedProofSession } from './managedProofSession';
import { ProofState } from './proofStateManager';
import { ProofStateViewProvider } from './proofStateViewProvider';
import { SessionRegistry } from './sessionRegistry';

function createEmptyProofState(): ProofState {
    return {
        goals: [],
        messages: [],
        isProcessing: false,
        isComplete: false,
        outputLines: []
    };
}

export class ActiveProofStateBridge implements vscode.Disposable {
    private activeStateDisposable: vscode.Disposable | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly registry: SessionRegistry<vscode.TextDocument, ManagedProofSession>,
        private readonly provider: ProofStateViewProvider,
        private readonly logger?: Logger
    ) {
        this.disposables.push(
            this.registry.onDidChangeActiveSession((session) => {
                this.bindActiveSession(session);
            })
        );

        this.bindActiveSession(this.registry.getActiveSession());
    }

    private bindActiveSession(session: ManagedProofSession | undefined): void {
        if (this.activeStateDisposable) {
            this.activeStateDisposable.dispose();
            this.activeStateDisposable = undefined;
        }

        if (!session) {
            this.provider.setDisplayedState(createEmptyProofState());
            this.logger?.event('proof-state-bridge-cleared', {});
            return;
        }

        this.provider.setDisplayedState(session.proofStateManager.state);
        this.logger?.event('proof-state-bridge-bound', {
            sessionKey: session.key,
            uri: session.documentUri.fsPath
        });

        this.activeStateDisposable = session.proofStateManager.onDidChangeState((event) => {
            if (this.registry.getActiveSession()?.key !== session.key) {
                return;
            }
            this.provider.setDisplayedState(event.state);
        });
    }

    public dispose(): void {
        this.activeStateDisposable?.dispose();
        this.activeStateDisposable = undefined;
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
