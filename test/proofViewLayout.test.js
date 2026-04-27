const assert = require('assert');

const {
    computeAutoFitScale,
    computeEffectiveScale
} = require('../out/proofViewLayout');

function assertApproximatelyEqual(actual, expected, epsilon = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) <= epsilon,
        `expected ${actual} to be approximately ${expected}`
    );
}

describe('Proof View Layout Scaling', function () {
    describe('computeAutoFitScale', function () {
        it('returns scale 1 when content fits in viewport', function () {
            const scale = computeAutoFitScale({
                viewportHeight: 800,
                contentNaturalHeight: 600,
                minScale: 0.65,
                maxScale: 2.5
            });

            assert.strictEqual(scale, 1);
        });

        it('scales down when content is taller than viewport', function () {
            const scale = computeAutoFitScale({
                viewportHeight: 500,
                contentNaturalHeight: 1000,
                minScale: 0.2,
                maxScale: 2.5
            });

            assert.strictEqual(scale, 0.5);
        });

        it('does not scale below minScale for very tall content', function () {
            const scale = computeAutoFitScale({
                viewportHeight: 200,
                contentNaturalHeight: 2000,
                minScale: 0.65,
                maxScale: 2.5
            });

            assert.strictEqual(scale, 0.65);
        });

        it('falls back safely when dimensions are invalid', function () {
            const scaleFromZero = computeAutoFitScale({
                viewportHeight: 0,
                contentNaturalHeight: 1200,
                minScale: 0.65,
                maxScale: 2.5
            });

            const scaleFromNaN = computeAutoFitScale({
                viewportHeight: Number.NaN,
                contentNaturalHeight: 1200,
                minScale: 0.65,
                maxScale: 2.5
            });

            assert.strictEqual(scaleFromZero, 1);
            assert.strictEqual(scaleFromNaN, 1);
        });
    });

    describe('computeEffectiveScale', function () {
        it('multiplies auto-fit and user scales', function () {
            const effective = computeEffectiveScale(0.9, 1.2, 0.65, 2.5);
            assertApproximatelyEqual(effective, 1.08);
        });

        it('clamps to minScale when multiplied scale is too small', function () {
            const effective = computeEffectiveScale(0.6, 0.5, 0.65, 2.5);
            assert.strictEqual(effective, 0.65);
        });

        it('clamps to maxScale when multiplied scale is too large', function () {
            const effective = computeEffectiveScale(1, 4, 0.65, 2.5);
            assert.strictEqual(effective, 2.5);
        });

        it('preserves user multiplier across successive auto-fit updates', function () {
            const userScale = 1.15;
            const first = computeEffectiveScale(1, userScale, 0.65, 2.5);
            const second = computeEffectiveScale(0.8, userScale, 0.65, 2.5);

            assertApproximatelyEqual(first, 1.15);
            assertApproximatelyEqual(second, 0.92);
        });

        it('recovers from invalid user scale input', function () {
            const effective = computeEffectiveScale(0.8, Number.NaN, 0.65, 2.5);
            assertApproximatelyEqual(effective, 0.8);
        });
    });
});
