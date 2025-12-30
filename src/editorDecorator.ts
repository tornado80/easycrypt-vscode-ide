/**
 * EasyCrypt Editor Decorator
 * 
 * Manages text decorations in the editor to visualize the verified region
 * of the proof script.
 * 
 * @module editorDecorator
 */

import * as vscode from 'vscode';

/**
 * Decoration configuration
 */
export interface DecorationConfig {
    /** Background color for verified region (CSS color) */
    verifiedBackground?: string;
    /** Background color for the current statement being processed */
    processingBackground?: string;
    /** Background color for the region being verified (during batch operations) */
    verifyingBackground?: string;
    /** Whether to show a gutter icon */
    showGutterIcon?: boolean;
}

/**
 * Default decoration colors that work with VS Code themes
 */
const DEFAULT_CONFIG: Required<DecorationConfig> = {
    verifiedBackground: 'rgba(144, 238, 144, 0.15)', // Light green
    processingBackground: 'rgba(255, 255, 0, 0.2)',  // Yellow
    verifyingBackground: 'rgba(100, 149, 237, 0.15)', // Light blue (cornflower)
    showGutterIcon: false
};

/**
 * Manages decorations for the verified region in EasyCrypt files.
 * 
 * Responsibilities:
 * - Apply background color to verified code region
 * - Show processing indicator for current statement
 * - Show verifying indicator for batch operations
 * - Clean up decorations when needed
 */
export class EditorDecorator implements vscode.Disposable {
    /** Decoration type for verified region */
    private verifiedDecorationType: vscode.TextEditorDecorationType;
    
    /** Decoration type for processing region */
    private processingDecorationType: vscode.TextEditorDecorationType;
    
    /** Decoration type for verifying region (batch operations) */
    private verifyingDecorationType: vscode.TextEditorDecorationType;
    
    /** Current verified range */
    private verifiedRange: vscode.Range | undefined;
    
    /** Current processing range */
    private processingRange: vscode.Range | undefined;
    
    /** Current verifying range (for batch operations) */
    private verifyingRange: vscode.Range | undefined;
    
    /** Configuration */
    private config: Required<DecorationConfig>;
    
    /** Disposables */
    private disposables: vscode.Disposable[] = [];

    /**
     * Creates a new EditorDecorator
     * 
     * @param config - Optional decoration configuration
     */
    constructor(config?: DecorationConfig) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        // Create decoration types
        this.verifiedDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: this.config.verifiedBackground,
            isWholeLine: true,
            overviewRulerColor: 'rgba(144, 238, 144, 0.5)',
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
        
        this.processingDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: this.config.processingBackground,
            isWholeLine: true
        });
        
        this.verifyingDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: this.config.verifyingBackground,
            isWholeLine: true,
            overviewRulerColor: 'rgba(100, 149, 237, 0.5)',
            overviewRulerLane: vscode.OverviewRulerLane.Center
        });
        
        // Listen for editor changes to reapply decorations
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    this.reapplyDecorations(editor);
                }
            })
        );
    }

    /**
     * Sets the verified region in the editor
     * 
     * @param editor - The text editor
     * @param range - The range to mark as verified, or undefined to clear
     */
    public setVerifiedRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void {
        this.verifiedRange = range;
        
        if (range) {
            editor.setDecorations(this.verifiedDecorationType, [range]);
        } else {
            editor.setDecorations(this.verifiedDecorationType, []);
        }
    }

    /**
     * Sets the processing region (current statement being verified)
     * 
     * @param editor - The text editor
     * @param range - The range being processed, or undefined to clear
     */
    public setProcessingRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void {
        this.processingRange = range;
        
        if (range) {
            editor.setDecorations(this.processingDecorationType, [range]);
        } else {
            editor.setDecorations(this.processingDecorationType, []);
        }
    }

    /**
     * Sets the verifying region (for batch operations like prove-to-cursor)
     * 
     * This shows a distinct highlight for the region being verified during
     * long-running batch operations, preventing "green creep" flicker.
     * 
     * @param editor - The text editor
     * @param range - The range being verified, or undefined to clear
     */
    public setVerifyingRange(editor: vscode.TextEditor, range: vscode.Range | undefined): void {
        this.verifyingRange = range;
        
        if (range) {
            editor.setDecorations(this.verifyingDecorationType, [range]);
        } else {
            editor.setDecorations(this.verifyingDecorationType, []);
        }
    }

    /**
     * Clears all decorations from the editor
     * 
     * @param editor - The text editor
     */
    public clearAll(editor: vscode.TextEditor): void {
        this.verifiedRange = undefined;
        this.processingRange = undefined;
        this.verifyingRange = undefined;
        editor.setDecorations(this.verifiedDecorationType, []);
        editor.setDecorations(this.processingDecorationType, []);
        editor.setDecorations(this.verifyingDecorationType, []);
    }

    /**
     * Reapplies decorations to an editor (e.g., when switching tabs)
     * 
     * @param editor - The text editor
     */
    private reapplyDecorations(editor: vscode.TextEditor): void {
        if (editor.document.languageId !== 'easycrypt') {
            return;
        }
        
        if (this.verifiedRange) {
            editor.setDecorations(this.verifiedDecorationType, [this.verifiedRange]);
        }
        
        if (this.processingRange) {
            editor.setDecorations(this.processingDecorationType, [this.processingRange]);
        }
        
        if (this.verifyingRange) {
            editor.setDecorations(this.verifyingDecorationType, [this.verifyingRange]);
        }
    }

    /**
     * Gets the current verified range
     */
    public getVerifiedRange(): vscode.Range | undefined {
        return this.verifiedRange;
    }

    /**
     * Gets the current verifying range
     */
    public getVerifyingRange(): vscode.Range | undefined {
        return this.verifyingRange;
    }

    /**
     * Disposes of the decorator
     */
    public dispose(): void {
        this.verifiedDecorationType.dispose();
        this.processingDecorationType.dispose();
        this.verifyingDecorationType.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
