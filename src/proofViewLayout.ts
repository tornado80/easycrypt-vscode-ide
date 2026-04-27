/**
 * Pure layout scaling helpers for the Proof State webview.
 *
 * These helpers are intentionally VS Code/webview agnostic so they can be
 * tested deterministically in Node-based unit tests.
 */

export interface ProofViewLayoutState {
    autoFitScale: number;
    userScale: number;
    effectiveScale: number;
    minScale: number;
    maxScale: number;
}

export interface LayoutComputationInput {
    viewportHeight: number;
    contentNaturalHeight: number;
    minScale: number;
    maxScale: number;
}

const DEFAULT_SCALE = 1;
const MIN_SCALE_FLOOR = 0.1;
const MAX_SCALE_CEILING = 10;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

function normalizeScaleBounds(minScale: number, maxScale: number): { minScale: number; maxScale: number } {
    const safeMin = clamp(toFiniteNumber(minScale, DEFAULT_SCALE), MIN_SCALE_FLOOR, MAX_SCALE_CEILING);
    const safeMax = clamp(toFiniteNumber(maxScale, DEFAULT_SCALE), safeMin, MAX_SCALE_CEILING);
    return { minScale: safeMin, maxScale: safeMax };
}

export function computeAutoFitScale(input: LayoutComputationInput): number {
    const bounds = normalizeScaleBounds(input.minScale, input.maxScale);
    const viewportHeight = toFiniteNumber(input.viewportHeight, 0);
    const contentNaturalHeight = toFiniteNumber(input.contentNaturalHeight, 0);

    if (viewportHeight <= 0 || contentNaturalHeight <= 0) {
        return clamp(DEFAULT_SCALE, bounds.minScale, bounds.maxScale);
    }

    const rawFitScale = Math.min(DEFAULT_SCALE, viewportHeight / contentNaturalHeight);
    return clamp(rawFitScale, bounds.minScale, bounds.maxScale);
}

export function computeEffectiveScale(
    autoFitScale: number,
    userScale: number,
    minScale: number,
    maxScale: number
): number {
    const bounds = normalizeScaleBounds(minScale, maxScale);
    const safeAutoFit = toFiniteNumber(autoFitScale, DEFAULT_SCALE);
    const safeUserScale = toFiniteNumber(userScale, DEFAULT_SCALE);
    return clamp(safeAutoFit * safeUserScale, bounds.minScale, bounds.maxScale);
}
