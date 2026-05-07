const assert = require('assert');

const { SessionCommandRouter } = require('../../out/sessionCommandRouter');

function createSession(key) {
    return {
        key,
        documentUri: {
            scheme: 'file',
            fsPath: `/tmp/${key}.ec`,
            toString: () => `file:/tmp/${key}.ec`
        },
        async stop() {
            // no-op
        },
        dispose() {
            // no-op
        }
    };
}

describe('SessionCommandRouter', function () {
    it('preempts in-flight commands for the same session', async function () {
        const sessionA = createSession('A');
        let activeSession = sessionA;

        const router = new SessionCommandRouter(() => activeSession);

        let firstCancelled = false;
        const first = router.runOnActiveSession('stepForward', async (_session, token) => {
            return new Promise((resolve) => {
                token.onCancellationRequested(() => {
                    firstCancelled = true;
                    resolve('first-cancelled');
                });
            });
        });

        const second = router.runOnActiveSession('stepForward', async () => {
            return 'second-result';
        });

        const secondResult = await second;
        assert.strictEqual(secondResult, 'second-result');
        assert.strictEqual(firstCancelled, true);

        await assert.rejects(first, /Command cancelled/);

        router.dispose();
    });

    it('does not cancel in-flight commands in different sessions', async function () {
        const sessionA = createSession('A');
        const sessionB = createSession('B');
        let activeSession = sessionA;

        const router = new SessionCommandRouter(() => activeSession);

        let resolveA;
        const runA = router.runOnActiveSession('stepForward', async () => {
            return new Promise((resolve) => {
                resolveA = resolve;
            });
        });

        activeSession = sessionB;
        const runB = await router.runOnActiveSession('stepForward', async () => {
            return 'B-done';
        });

        assert.strictEqual(runB, 'B-done');

        resolveA('A-done');
        const runAResult = await runA;
        assert.strictEqual(runAResult, 'A-done');

        router.dispose();
    });

    it('fails when no active session exists', async function () {
        const router = new SessionCommandRouter(() => undefined);

        await assert.rejects(
            () => router.runOnActiveSession('stepForward', async () => true),
            /No active EasyCrypt file/
        );

        router.dispose();
    });
});
