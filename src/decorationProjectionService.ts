import * as vscode from 'vscode';
import { computeProjectedStates } from './decorationProjectionModel';
import { EditorDecorator } from './editorDecorator';

export interface DecorationProjectionState {
    readonly verifiedRange?: vscode.Range;
    readonly processingRange?: vscode.Range;
    readonly verifyingRange?: vscode.Range;
}

export class DecorationProjectionService implements vscode.Disposable {
    private readonly stateByUri = new Map<string, DecorationProjectionState>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly editorDecorator: EditorDecorator) {
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(() => {
                this.projectVisibleEditors(vscode.window.activeTextEditor?.document.uri);
            })
        );

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this.projectVisibleEditors(editor?.document.uri);
            })
        );
    }

    public get(uri: vscode.Uri): DecorationProjectionState | undefined {
        const current = this.stateByUri.get(uri.toString());
        return current ? { ...current } : undefined;
    }

    public update(uri: vscode.Uri, state: DecorationProjectionState): void {
        this.stateByUri.set(uri.toString(), { ...state });
        this.projectVisibleEditors(vscode.window.activeTextEditor?.document.uri);
    }

    public clear(uri: vscode.Uri): void {
        this.stateByUri.delete(uri.toString());

        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === uri.toString()) {
                this.editorDecorator.clearAll(editor);
            }
        }

        this.projectVisibleEditors(vscode.window.activeTextEditor?.document.uri);
    }

    public getVerifiedRange(uri: vscode.Uri): vscode.Range | undefined {
        return this.stateByUri.get(uri.toString())?.verifiedRange;
    }

    public projectVisibleEditors(activeUri: vscode.Uri | undefined): void {
        const activeKey = activeUri?.toString();
        const visibleEditors = vscode.window.visibleTextEditors.filter(
            (editor) => editor.document.languageId === 'easycrypt'
        );
        const projectedStates = computeProjectedStates(
            activeKey,
            visibleEditors.map((editor) => editor.document.uri.toString()),
            this.stateByUri
        );

        for (const editor of visibleEditors) {
            const editorKey = editor.document.uri.toString();
            const projectedState = projectedStates.get(editorKey);
            if (!projectedState) {
                this.editorDecorator.clearAll(editor);
                continue;
            }

            this.applyState(editor, projectedState);
        }
    }

    private applyState(editor: vscode.TextEditor, state: DecorationProjectionState | undefined): void {
        this.editorDecorator.setVerifiedRange(editor, state?.verifiedRange);
        this.editorDecorator.setProcessingRange(editor, state?.processingRange);
        this.editorDecorator.setVerifyingRange(editor, state?.verifyingRange);
    }

    public dispose(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId === 'easycrypt') {
                this.editorDecorator.clearAll(editor);
            }
        }

        this.stateByUri.clear();
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
