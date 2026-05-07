const assert = require('assert');
const path = require('path');

const { SessionRegistry } = require('../../out/sessionRegistry');

function makeUri(fsPath) {
    return {
        scheme: 'file',
        fsPath,
        toString: () => `file:${fsPath}`
    };
}

function makeDocument(fsPath, languageId = 'easycrypt') {
    return {
        uri: makeUri(fsPath),
        languageId
    };
}

class FakeSession {
    constructor(key, uri) {
        this.key = key;
        this.documentUri = uri;
        this.stopReasons = [];
        this.disposed = false;
    }

    async stop(reason) {
        this.stopReasons.push(reason);
    }

    dispose() {
        this.disposed = true;
    }
}

describe('SessionRegistry', function () {
    it('reuses sessions for the same document key', async function () {
        const created = [];
        const registry = new SessionRegistry({
            createSession: (document, key) => {
                const session = new FakeSession(key, document.uri);
                created.push(session);
                return session;
            }
        });

        const doc = makeDocument(path.join(process.cwd(), 'test', 'A.ec'));
        const first = await registry.getOrCreate(doc);
        const second = await registry.getOrCreate(doc);

        assert.strictEqual(first, second);
        assert.strictEqual(created.length, 1);

        await registry.disposeAll('shutdown');
    });

    it('creates distinct sessions for distinct document URIs', async function () {
        const registry = new SessionRegistry({
            createSession: (document, key) => new FakeSession(key, document.uri)
        });

        const a = await registry.getOrCreate(makeDocument(path.join(process.cwd(), 'test', 'A.ec')));
        const b = await registry.getOrCreate(makeDocument(path.join(process.cwd(), 'test', 'B.ec')));

        assert.notStrictEqual(a, b);
        assert.notStrictEqual(a.key, b.key);

        await registry.disposeAll('shutdown');
    });

    it('tracks and publishes active-session changes', async function () {
        const registry = new SessionRegistry({
            createSession: (document, key) => new FakeSession(key, document.uri)
        });

        const seen = [];
        const disposable = registry.onDidChangeActiveSession((session) => {
            seen.push(session ? session.key : undefined);
        });

        const docA = makeDocument(path.join(process.cwd(), 'test', 'activeA.ec'));
        const docB = makeDocument(path.join(process.cwd(), 'test', 'activeB.ec'));

        const sessionA = await registry.setActiveDocument(docA);
        const sessionB = await registry.setActiveDocument(docB);
        await registry.setActiveDocument(undefined);

        assert.ok(sessionA);
        assert.ok(sessionB);
        assert.deepStrictEqual(seen, [sessionA.key, sessionB.key, undefined]);

        disposable.dispose();
        await registry.disposeAll('shutdown');
    });

    it('emits deterministic dispose events with reason', async function () {
        const registry = new SessionRegistry({
            createSession: (document, key) => new FakeSession(key, document.uri)
        });

        const events = [];
        const disposable = registry.onDidDisposeSession((event) => {
            events.push(event);
        });

        const doc = makeDocument(path.join(process.cwd(), 'test', 'dispose.ec'));
        const session = await registry.getOrCreate(doc);
        const disposed = await registry.disposeSessionByUri(doc.uri, 'file-close');

        assert.strictEqual(disposed, true);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].key, session.key);
        assert.strictEqual(events[0].reason, 'file-close');

        disposable.dispose();
        await registry.disposeAll('shutdown');
    });

    it('rejects unsupported document language', async function () {
        const registry = new SessionRegistry({
            createSession: (document, key) => new FakeSession(key, document.uri)
        });

        await assert.rejects(
            () => registry.getOrCreate(makeDocument(path.join(process.cwd(), 'test', 'notes.txt'), 'plaintext')),
            /Unsupported language/
        );

        await registry.disposeAll('shutdown');
    });
});
