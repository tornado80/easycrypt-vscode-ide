const assert = require('assert');

const { computeProjectedStates } = require('../out/decorationProjectionModel');

describe('decorationProjectionService model', function () {
    it('projects only the active URI state', function () {
        const stateByKey = new Map([
            ['file:/A.ec', { verifiedRange: 'A-verified' }],
            ['file:/B.ec', { verifiedRange: 'B-verified' }]
        ]);

        const projected = computeProjectedStates(
            'file:/A.ec',
            ['file:/A.ec', 'file:/B.ec'],
            stateByKey
        );

        assert.deepStrictEqual(projected.get('file:/A.ec'), { verifiedRange: 'A-verified' });
        assert.strictEqual(projected.get('file:/B.ec'), undefined);
    });

    it('clears all projections when no active URI exists', function () {
        const stateByKey = new Map([
            ['file:/A.ec', { verifiedRange: 'A-verified' }]
        ]);

        const projected = computeProjectedStates(
            undefined,
            ['file:/A.ec', 'file:/B.ec'],
            stateByKey
        );

        assert.strictEqual(projected.get('file:/A.ec'), undefined);
        assert.strictEqual(projected.get('file:/B.ec'), undefined);
    });

    it('returns undefined projection when active URI has no state', function () {
        const stateByKey = new Map([
            ['file:/A.ec', { verifiedRange: 'A-verified' }]
        ]);

        const projected = computeProjectedStates(
            'file:/B.ec',
            ['file:/A.ec', 'file:/B.ec'],
            stateByKey
        );

        assert.strictEqual(projected.get('file:/A.ec'), undefined);
        assert.strictEqual(projected.get('file:/B.ec'), undefined);
    });
});
