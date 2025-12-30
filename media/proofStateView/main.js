/**
 * EasyCrypt Proof State View - Main Script
 * 
 * Handles rendering of proof state and communication with the extension.
 * Uses DOM construction for security (avoids innerHTML with untrusted content).
 */

(function () {
    'use strict';

    // Acquire VS Code API
    // @ts-ignore - acquireVsCodeApi is provided by VS Code webview
    const vscode = acquireVsCodeApi();

    /** @type {HTMLElement} */
    const app = document.getElementById('app');

    /**
     * @typedef {Object} ProofGoal
     * @property {string[]} hypotheses
     * @property {string} conclusion
     */

    /**
     * @typedef {Object} ProofMessage
     * @property {'info'|'warning'|'error'} severity
     * @property {string} content
     * @property {string} timestamp
     */

    /**
     * @typedef {Object} ProofProgress
     * @property {number} provedStatementCount
     * @property {string} [lastProvedStatementText]
     */

    /**
     * @typedef {Object} SerializedProofState
     * @property {ProofGoal[]} goals
     * @property {ProofMessage[]} messages
     * @property {boolean} isProcessing
     * @property {boolean} isComplete
     * @property {string[]} outputLines
     * @property {ProofProgress} [progress]
     * @property {string} [debugEmacsPromptMarker]
     */

    /**
     * @typedef {'stepBackward'|'stepForward'|'goToCursor'|'resetProof'} NavAction
     */

    /**
     * Navigation button configuration
     * @type {Array<{action: NavAction, label: string, tooltip: string}>}
     */
    const NAV_BUTTONS = [
        { action: 'stepBackward', label: '↑ Back', tooltip: 'Step Backward (Alt+Up)' },
        { action: 'stepForward', label: '↓ Forward', tooltip: 'Step Forward (Alt+Down)' },
        { action: 'goToCursor', label: '⎯▸ Cursor', tooltip: 'Go to Cursor (Alt+Right)' },
        { action: 'resetProof', label: '⟲ Reset', tooltip: 'Reset Proof (Alt+Left)' }
    ];

    /** @type {SerializedProofState} */
    let state = {
        goals: [],
        messages: [],
        isProcessing: false,
        isComplete: false,
        outputLines: [],
        progress: undefined,
        debugEmacsPromptMarker: undefined
    };

    /**
     * Creates a text node safely (no HTML interpretation)
     * @param {string} text
     * @returns {Text}
     */
    function createText(text) {
        return document.createTextNode(text);
    }

    /**
     * Creates an element with optional class and text content
     * @param {string} tag
     * @param {string} [className]
     * @param {string} [textContent]
     * @returns {HTMLElement}
     */
    function createElement(tag, className, textContent) {
        const el = document.createElement(tag);
        if (className) {
            el.className = className;
        }
        if (textContent !== undefined) {
            el.textContent = textContent;
        }
        return el;
    }

    /**
     * Sends a navigation action to the extension
     * @param {NavAction} action
     */
    function sendNavAction(action) {
        vscode.postMessage({ type: 'nav', action: action });
    }

    /**
     * Computes the disabled state for each navigation button
     * @returns {{disableAll: boolean, canStepBackward: boolean}}
     */
    function computeNavButtonState() {
        const hasContext = !!state.progress;
        const disableAll = state.isProcessing || !hasContext;
        const canStepBackward = hasContext && 
            (state.progress?.provedStatementCount ?? 0) > 0 && 
            !state.isProcessing;
        
        return { disableAll, canStepBackward };
    }

    /**
     * Renders the navigation toolbar
     * @returns {HTMLElement}
     */
    function renderToolbar() {
        const toolbar = createElement('div', 'nav-toolbar');
        const buttonState = computeNavButtonState();

        for (const btnConfig of NAV_BUTTONS) {
            const button = createElement('button', 'nav-button', btnConfig.label);
            button.title = btnConfig.tooltip;
            button.dataset.action = btnConfig.action;

            // Determine if this specific button should be disabled
            let isDisabled = buttonState.disableAll;
            if (btnConfig.action === 'stepBackward' && !buttonState.canStepBackward) {
                isDisabled = true;
            }

            button.disabled = isDisabled;
            if (isDisabled) {
                button.classList.add('disabled');
            }

            // Click handler - only send if not disabled
            button.addEventListener('click', () => {
                if (!button.disabled) {
                    sendNavAction(btnConfig.action);
                }
            });

            toolbar.appendChild(button);
        }

        return toolbar;
    }

    /**
     * Renders the progress header section.
     * Displays proved statement count, last statement text, and optional debug prompt marker.
     * @returns {HTMLElement|null}
     */
    function renderProgressHeader() {
        const progress = state.progress;
        const debugPromptMarker = state.debugEmacsPromptMarker;
        
        // Don't render if no progress data
        if (!progress && !debugPromptMarker) {
            return null;
        }

        const container = createElement('div', 'progress-header');

        // Proved statement count (always shown when progress exists)
        if (progress) {
            const countLine = createElement('div', 'progress-line proved-count');
            const label = createElement('span', 'progress-label', 'Proved: ');
            const value = createElement('span', 'progress-value');
            value.textContent = progress.provedStatementCount > 0 
                ? `${progress.provedStatementCount} statement${progress.provedStatementCount !== 1 ? 's' : ''}`
                : '—';
            countLine.appendChild(label);
            countLine.appendChild(value);
            container.appendChild(countLine);
        }

        // Last proved statement (shown when proved region is non-empty)
        if (progress && progress.lastProvedStatementText) {
            const stmtLine = createElement('div', 'progress-line last-statement');
            const label = createElement('span', 'progress-label', 'Last: ');
            const value = createElement('span', 'progress-value last-statement-text');
            // Collapse multiple lines into a single line
            const collapsedText = progress.lastProvedStatementText.replace(/\s+/g, ' ').trim();
            value.textContent = collapsedText;
            // Set title for full text on hover (useful if truncated)
            value.title = progress.lastProvedStatementText;
            stmtLine.appendChild(label);
            stmtLine.appendChild(value);
            container.appendChild(stmtLine);
        }

        // Debug prompt marker (only shown when enabled via settings)
        if (debugPromptMarker) {
            const promptLine = createElement('div', 'progress-line prompt-marker');
            const label = createElement('span', 'progress-label', 'Prompt: ');
            const value = createElement('span', 'progress-value prompt-value');
            value.textContent = debugPromptMarker;
            promptLine.appendChild(label);
            promptLine.appendChild(value);
            container.appendChild(promptLine);
        }

        return container;
    }

    /**
     * Renders the processing indicator
     * @returns {HTMLElement}
     */
    function renderProcessing() {
        const container = createElement('div', 'processing');
        container.appendChild(createElement('div', 'spinner'));
        container.appendChild(createElement('span', undefined, 'Processing...'));
        return container;
    }

    /**
     * Renders output lines section (verbatim output from last statement)
     * @param {string[]} outputLines
     * @returns {HTMLElement|null}
     */
    function renderOutputLines(outputLines) {
        // Filter out empty lines and check if there's meaningful content
        const nonEmptyLines = outputLines.filter(line => line.trim() !== '');
        if (nonEmptyLines.length === 0) {
            return null;
        }

        const container = createElement('div', 'output-lines');
        // Preserve whitespace and line breaks
        container.textContent = outputLines.join('\n');
        return container;
    }

    /**
     * Renders a single message
     * @param {ProofMessage} msg
     * @returns {HTMLElement}
     */
    function renderMessage(msg) {
        const container = createElement('div', `message ${msg.severity}`);
        const content = createElement('span', 'message-content');
        content.textContent = `[${msg.severity}] ${msg.content}`;
        container.appendChild(content);
        return container;
    }

    /**
     * Renders the output section (last statement output, lossless)
     * @returns {HTMLElement|null}
     */
    function renderOutputSection() {
        const outputElement = renderOutputLines(state.outputLines);
        if (!outputElement) {
            return null;
        }

        const section = createElement('div', 'section');

        // Header
        const header = createElement('div', 'section-header');
        header.appendChild(createElement('span', 'section-title', 'Output'));
        section.appendChild(header);

        section.appendChild(outputElement);
        return section;
    }

    /**
     * Renders the messages section
     * @returns {HTMLElement|null}
     */
    function renderMessagesSection() {
        if (state.messages.length === 0) {
            return null;
        }

        const section = createElement('div', 'section');

        // Header
        const header = createElement('div', 'section-header');
        header.appendChild(createElement('span', 'section-title', 'Messages'));
        header.appendChild(createElement('span', 'badge', String(state.messages.length)));
        section.appendChild(header);

        // Messages container
        const messagesContainer = createElement('div', 'messages-container');
        for (const msg of state.messages) {
            messagesContainer.appendChild(renderMessage(msg));
        }
        section.appendChild(messagesContainer);

        return section;
    }

    /**
     * Main render function - rebuilds the entire view
     */
    function render() {
        // Clear existing content
        while (app.firstChild) {
            app.removeChild(app.firstChild);
        }

        // Always render toolbar at the top
        app.appendChild(renderToolbar());

        // Processing state
        if (state.isProcessing) {
            app.appendChild(renderProcessing());
            return;
        }

        // Progress header (proved count, last statement, optional prompt marker)
        const progressHeader = renderProgressHeader();
        if (progressHeader) {
            app.appendChild(progressHeader);
        }

        // Output section (lossless last statement output)
        const outputSection = renderOutputSection();
        if (outputSection) {
            app.appendChild(outputSection);
        }

        // Messages section
        const messagesSection = renderMessagesSection();
        if (messagesSection) {
            app.appendChild(messagesSection);
        }
    }

    /**
     * Handle messages from the extension
     * @param {MessageEvent} event
     */
    function handleMessage(event) {
        const message = event.data;
        if (message && message.type === 'updateState') {
            state = message.state;
            render();
        }
    }

    // Listen for messages from the extension
    window.addEventListener('message', handleMessage);

    // Initial render
    render();

    // Signal ready to the extension
    vscode.postMessage({ type: 'ready' });
})();
