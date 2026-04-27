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

    /** @type {HTMLElement|null} */
    const app = document.getElementById('app');
    if (!app) {
        return;
    }

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
     * @typedef {Object} ProofLayoutHints
     * @property {number} [minScale]
     * @property {number} [maxScale]
     * @property {number} [defaultUserScale]
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
    * @property {ProofLayoutHints} [layoutHints]
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
        debugEmacsPromptMarker: undefined,
        layoutHints: undefined
    };

    const DEFAULT_MIN_SCALE = 0.65;
    const DEFAULT_MAX_SCALE = 2.5;
    const DEFAULT_USER_SCALE = 1;
    const PERSISTED_USER_SCALE_KEY = 'proofStateUserScale';
    const BUTTON_ZOOM_FACTOR = 1.1;
    const WHEEL_ZOOM_SENSITIVITY = 0.0012;
    const SCALE_EPSILON = 0.0001;

    /**
     * @typedef {Object} ProofViewLayoutState
     * @property {number} autoFitScale
     * @property {number} userScale
     * @property {number} effectiveScale
     * @property {number} minScale
     * @property {number} maxScale
     */

    /** @type {ProofViewLayoutState} */
    const layoutState = {
        autoFitScale: 1,
        userScale: DEFAULT_USER_SCALE,
        effectiveScale: 1,
        minScale: DEFAULT_MIN_SCALE,
        maxScale: DEFAULT_MAX_SCALE
    };

    let hasUserAdjustedScale = false;

    /** @type {number|undefined} */
    let pendingFitFrame;
    /** @type {HTMLElement|null} */
    let lastFitTarget = null;
    /** @type {ResizeObserver|undefined} */
    let resizeObserver;
    /** @type {HTMLElement|null} */
    let observedLayout = null;
    /** @type {HTMLElement|null} */
    let observedViewport = null;
    /** @type {HTMLElement|null} */
    let zoomLabelElement = null;

    initializeUserScale();

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
     * @param {number} value
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    /**
     * @param {unknown} value
     * @param {number} fallback
     * @returns {number}
     */
    function toFiniteNumber(value, fallback) {
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    /**
     * @param {number} minScale
     * @param {number} maxScale
     * @returns {{ minScale: number, maxScale: number }}
     */
    function normalizeScaleBounds(minScale, maxScale) {
        const safeMin = clamp(toFiniteNumber(minScale, DEFAULT_MIN_SCALE), 0.1, 10);
        const safeMax = clamp(toFiniteNumber(maxScale, DEFAULT_MAX_SCALE), safeMin, 10);
        return { minScale: safeMin, maxScale: safeMax };
    }

    /**
     * @returns {number}
     */
    function readPersistedUserScale() {
        const persisted = vscode.getState();
        if (!persisted || typeof persisted !== 'object') {
            return DEFAULT_USER_SCALE;
        }

        const rawUserScale = persisted[PERSISTED_USER_SCALE_KEY];
        return toFiniteNumber(rawUserScale, DEFAULT_USER_SCALE);
    }

    function initializeUserScale() {
        const restoredScale = readPersistedUserScale();
        const bounds = normalizeScaleBounds(layoutState.minScale, layoutState.maxScale);
        layoutState.minScale = bounds.minScale;
        layoutState.maxScale = bounds.maxScale;
        layoutState.userScale = clamp(restoredScale, layoutState.minScale, layoutState.maxScale);
        hasUserAdjustedScale = Math.abs(layoutState.userScale - DEFAULT_USER_SCALE) > SCALE_EPSILON;
        layoutState.effectiveScale = computeEffectiveScale(
            layoutState.autoFitScale,
            layoutState.userScale,
            layoutState.minScale,
            layoutState.maxScale
        );
    }

    function persistUserScale() {
        const persisted = vscode.getState();
        const persistedObject = persisted && typeof persisted === 'object' ? persisted : {};
        vscode.setState({
            ...persistedObject,
            [PERSISTED_USER_SCALE_KEY]: layoutState.userScale
        });
    }

    /**
     * @param {ProofLayoutHints|undefined} layoutHints
     */
    function applyLayoutHints(layoutHints) {
        const bounds = normalizeScaleBounds(
            toFiniteNumber(layoutHints?.minScale, DEFAULT_MIN_SCALE),
            toFiniteNumber(layoutHints?.maxScale, DEFAULT_MAX_SCALE)
        );

        layoutState.minScale = bounds.minScale;
        layoutState.maxScale = bounds.maxScale;

        if (!hasUserAdjustedScale) {
            const hintedDefault = toFiniteNumber(layoutHints?.defaultUserScale, DEFAULT_USER_SCALE);
            layoutState.userScale = clamp(hintedDefault, layoutState.minScale, layoutState.maxScale);
        } else {
            layoutState.userScale = clamp(layoutState.userScale, layoutState.minScale, layoutState.maxScale);
        }
    }

    /**
     * @typedef {Object} LayoutComputationInput
     * @property {number} viewportHeight
     * @property {number} contentNaturalHeight
     * @property {number} minScale
     * @property {number} maxScale
     */

    /**
     * @param {LayoutComputationInput} input
     * @returns {number}
     */
    function computeAutoFitScale(input) {
        const minScale = toFiniteNumber(input?.minScale, DEFAULT_MIN_SCALE);
        const maxScale = toFiniteNumber(input?.maxScale, DEFAULT_MAX_SCALE);
        const bounds = normalizeScaleBounds(minScale, maxScale);

        const viewportHeight = toFiniteNumber(input?.viewportHeight, 0);
        const contentNaturalHeight = toFiniteNumber(input?.contentNaturalHeight, 0);

        if (viewportHeight <= 0 || contentNaturalHeight <= 0) {
            return clamp(1, bounds.minScale, bounds.maxScale);
        }

        const rawFitScale = Math.min(1, viewportHeight / contentNaturalHeight);
        return clamp(rawFitScale, bounds.minScale, bounds.maxScale);
    }

    /**
     * @param {number} autoFitScale
     * @param {number} userScale
     * @param {number} minScale
     * @param {number} maxScale
     * @returns {number}
     */
    function computeEffectiveScale(autoFitScale, userScale, minScale, maxScale) {
        const safeAutoFitScale = toFiniteNumber(autoFitScale, 1);
        const safeUserScale = toFiniteNumber(userScale, DEFAULT_USER_SCALE);
        const bounds = normalizeScaleBounds(minScale, maxScale);
        return clamp(safeAutoFitScale * safeUserScale, bounds.minScale, bounds.maxScale);
    }

    function updateZoomLabel() {
        if (!zoomLabelElement) {
            return;
        }

        const zoomPercent = Math.round(layoutState.effectiveScale * 100);
        zoomLabelElement.textContent = `${zoomPercent}%`;
        zoomLabelElement.title = `Zoom ${zoomPercent}%`;
    }

    /**
     * @returns {{absolute: number, relative: number}|undefined}
     */
    function captureViewportScrollSnapshot() {
        const existingViewport = app.querySelector('.state-viewport');
        if (!(existingViewport instanceof HTMLElement)) {
            return undefined;
        }

        const maxScrollTop = Math.max(0, existingViewport.scrollHeight - existingViewport.clientHeight);
        const relative = maxScrollTop > 0 ? existingViewport.scrollTop / maxScrollTop : 0;

        return {
            absolute: existingViewport.scrollTop,
            relative
        };
    }

    /**
     * @param {HTMLElement} viewport
     * @param {{absolute: number, relative: number}|undefined} snapshot
     */
    function restoreViewportScroll(viewport, snapshot) {
        if (!snapshot) {
            return;
        }

        requestAnimationFrame(() => {
            const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
            if (maxScrollTop <= 0) {
                viewport.scrollTop = 0;
                return;
            }

            const relativeTarget = snapshot.relative * maxScrollTop;
            const absoluteTarget = Math.min(snapshot.absolute, maxScrollTop);
            viewport.scrollTop = Math.max(0, Math.min(maxScrollTop, Math.max(relativeTarget, absoluteTarget)));
        });
    }

    function applyLayoutFit(target) {
        if (!target) {
            return;
        }

        const viewport = target.parentElement;
        if (!(viewport instanceof HTMLElement)) {
            return;
        }

        target.style.setProperty('--proof-effective-scale', '1');

        const naturalHeight = target.scrollHeight;
        const viewportHeight = viewport.clientHeight;

        layoutState.autoFitScale = computeAutoFitScale({
            viewportHeight,
            contentNaturalHeight: naturalHeight,
            minScale: layoutState.minScale,
            maxScale: layoutState.maxScale
        });

        layoutState.effectiveScale = computeEffectiveScale(
            layoutState.autoFitScale,
            layoutState.userScale,
            layoutState.minScale,
            layoutState.maxScale
        );

        target.style.setProperty('--proof-effective-scale', String(layoutState.effectiveScale));
        target.classList.toggle('is-scaled-down', layoutState.effectiveScale < 1 - SCALE_EPSILON);
        updateZoomLabel();
    }

    /**
     * @param {number} nextUserScale
     */
    function setUserScale(nextUserScale) {
        const clampedScale = clamp(
            toFiniteNumber(nextUserScale, DEFAULT_USER_SCALE),
            layoutState.minScale,
            layoutState.maxScale
        );

        if (Math.abs(clampedScale - layoutState.userScale) < SCALE_EPSILON) {
            return;
        }

        layoutState.userScale = clampedScale;
        hasUserAdjustedScale = true;
        persistUserScale();
        scheduleLayoutFit(lastFitTarget);
    }

    /**
     * @param {number} factor
     */
    function adjustUserScaleByFactor(factor) {
        const safeFactor = toFiniteNumber(factor, 1);
        if (safeFactor <= 0) {
            return;
        }

        setUserScale(layoutState.userScale * safeFactor);
    }

    function resetUserScale() {
        setUserScale(DEFAULT_USER_SCALE);
    }

    /**
     * @param {HTMLElement|null} target
     */
    function updateLayoutObservers(target) {
        const viewport = target?.parentElement;
        const isSameTarget = target === observedLayout;
        const isSameViewport = viewport === observedViewport;

        if (isSameTarget && isSameViewport) {
            return;
        }

        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = undefined;
        }

        observedLayout = target;
        observedViewport = viewport instanceof HTMLElement ? viewport : null;

        if (typeof ResizeObserver === 'undefined' || !target || !observedViewport) {
            return;
        }

        resizeObserver = new ResizeObserver(() => {
            scheduleLayoutFit(lastFitTarget);
        });
        resizeObserver.observe(target);
        resizeObserver.observe(observedViewport);
    }

    function disposeLayoutScheduling() {
        if (pendingFitFrame !== undefined) {
            cancelAnimationFrame(pendingFitFrame);
            pendingFitFrame = undefined;
        }

        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = undefined;
        }

        observedLayout = null;
        observedViewport = null;
    }

    /**
     * Defers fit calculation until after layout settles.
     * @param {HTMLElement|null} target
     */
    function scheduleLayoutFit(target) {
        if (!target) {
            updateZoomLabel();
            return;
        }

        lastFitTarget = target;

        if (pendingFitFrame !== undefined) {
            cancelAnimationFrame(pendingFitFrame);
        }

        pendingFitFrame = requestAnimationFrame(() => {
            pendingFitFrame = undefined;
            applyLayoutFit(lastFitTarget);
        });
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
        const navGroup = createElement('div', 'nav-toolbar-group nav-toolbar-nav');

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

            navGroup.appendChild(button);
        }

        const zoomGroup = createElement('div', 'nav-toolbar-group nav-toolbar-zoom');

        const zoomOutButton = createElement('button', 'nav-button zoom-button', '−');
        zoomOutButton.title = 'Zoom Out';
        zoomOutButton.setAttribute('aria-label', 'Zoom Out');
        zoomOutButton.addEventListener('click', () => {
            adjustUserScaleByFactor(1 / BUTTON_ZOOM_FACTOR);
        });

        const zoomInButton = createElement('button', 'nav-button zoom-button', '+');
        zoomInButton.title = 'Zoom In';
        zoomInButton.setAttribute('aria-label', 'Zoom In');
        zoomInButton.addEventListener('click', () => {
            adjustUserScaleByFactor(BUTTON_ZOOM_FACTOR);
        });

        const resetZoomButton = createElement('button', 'nav-button zoom-button zoom-reset-button', 'Reset');
        resetZoomButton.title = 'Reset Zoom';
        resetZoomButton.setAttribute('aria-label', 'Reset Zoom');
        resetZoomButton.addEventListener('click', () => {
            resetUserScale();
        });

        zoomLabelElement = createElement('span', 'zoom-label');

        zoomGroup.appendChild(zoomOutButton);
        zoomGroup.appendChild(zoomInButton);
        zoomGroup.appendChild(resetZoomButton);
        zoomGroup.appendChild(zoomLabelElement);

        toolbar.appendChild(navGroup);
        toolbar.appendChild(zoomGroup);
        updateZoomLabel();

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
        const previousScrollSnapshot = captureViewportScrollSnapshot();

        // Clear existing content
        while (app.firstChild) {
            app.removeChild(app.firstChild);
        }

        // Always render toolbar at the top
        app.appendChild(renderToolbar());

        const viewport = createElement('div', 'state-viewport');
        app.appendChild(viewport);

        // Processing state
        if (state.isProcessing) {
            lastFitTarget = null;
            updateLayoutObservers(null);
            viewport.appendChild(renderProcessing());
            restoreViewportScroll(viewport, previousScrollSnapshot);
            updateZoomLabel();
            return;
        }

        const layout = createElement('div', 'state-layout');

        // Progress header (proved count, last statement, optional prompt marker)
        const progressHeader = renderProgressHeader();
        if (progressHeader) {
            layout.appendChild(progressHeader);
        }

        // Output section (lossless last statement output)
        const outputSection = renderOutputSection();
        if (outputSection) {
            layout.appendChild(outputSection);
        }

        // Messages section
        const messagesSection = renderMessagesSection();
        if (messagesSection) {
            layout.appendChild(messagesSection);
        }

        viewport.appendChild(layout);
        updateLayoutObservers(layout);
        scheduleLayoutFit(layout);
        restoreViewportScroll(viewport, previousScrollSnapshot);
    }

    /**
     * Handle messages from the extension
     * @param {MessageEvent} event
     */
    function handleMessage(event) {
        const message = event.data;
        if (message && message.type === 'updateState') {
            state = message.state;
            applyLayoutHints(state.layoutHints);
            render();
        }
    }

    /**
     * @param {UIEvent} event
     */
    function handleZoomWheel(event) {
        const wheelEvent = /** @type {WheelEvent} */ (event);
        if (!(wheelEvent.ctrlKey || wheelEvent.metaKey)) {
            return;
        }

        const targetNode = wheelEvent.target;
        if (!(targetNode instanceof Node) || !app.contains(targetNode)) {
            return;
        }

        wheelEvent.preventDefault();
        const factor = Math.exp(-wheelEvent.deltaY * WHEEL_ZOOM_SENSITIVITY);
        adjustUserScaleByFactor(factor);
    }

    function handleResize() {
        scheduleLayoutFit(lastFitTarget);
    }

    function dispose() {
        window.removeEventListener('message', handleMessage);
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('wheel', handleZoomWheel);
        disposeLayoutScheduling();
    }

    // Listen for messages from the extension
    window.addEventListener('message', handleMessage);

    // Re-fit when the view is resized by the workbench layout
    window.addEventListener('resize', handleResize);

    // Pinch/spread-like wheel gestures for zoom support.
    window.addEventListener('wheel', handleZoomWheel, { passive: false });
    window.addEventListener('unload', dispose, { once: true });

    // Initial render
    render();

    // Signal ready to the extension
    vscode.postMessage({ type: 'ready' });
})();
