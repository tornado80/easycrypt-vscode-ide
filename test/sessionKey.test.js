const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    canonicalizeFileSystemPathForSessionKey,
    createFileSessionKey,
    normalizeFileSystemPathForSessionKey
} = require('../out/sessionKey');

describe('sessionKey', function () {
    it('normalizes file paths deterministically', function () {
        const rawPath = path.join(process.cwd(), '.', 'tmp', '..', 'tmp', 'test.ec');
        const normalized = normalizeFileSystemPathForSessionKey(rawPath);
        const normalizedAgain = normalizeFileSystemPathForSessionKey(rawPath);

        assert.strictEqual(normalized, normalizedAgain);
    });

    it('supports explicit platform normalization policy', function () {
        const p = 'C:\\Users\\Amir\\Project\\File.EC';
        const winNormalized = normalizeFileSystemPathForSessionKey(p, 'win32');
        const posixNormalized = normalizeFileSystemPathForSessionKey(p, 'linux');

        assert.strictEqual(winNormalized, winNormalized.toLowerCase());
        assert.ok(posixNormalized.includes('File.EC'));
    });

    it('uses uri.toString for non-file schemes', async function () {
        const uri = {
            scheme: 'untitled',
            toString: () => 'untitled:proof.ec'
        };

        const key = await createFileSessionKey(uri);
        assert.strictEqual(key, 'untitled:proof.ec');
    });

    it('builds stable file keys for equivalent file URIs', async function () {
        const filePath = path.join(process.cwd(), 'test', 'fixtures', 'diagnostics_test.ec');
        const keyA = await createFileSessionKey({
            scheme: 'file',
            fsPath: filePath,
            toString: () => `file:${filePath}`
        });
        const keyB = await createFileSessionKey({
            scheme: 'file',
            fsPath: path.normalize(filePath),
            toString: () => `file:${path.normalize(filePath)}`
        });

        assert.strictEqual(keyA, keyB);
    });

    it('canonicalizes via realpath when available', async function () {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycrypt-session-key-'));
        const targetFile = path.join(tmpDir, 'target.ec');
        const symlinkFile = path.join(tmpDir, 'alias.ec');

        fs.writeFileSync(targetFile, 'lemma t : true.\n', 'utf8');

        let symlinkCreated = false;
        try {
            fs.symlinkSync(targetFile, symlinkFile);
            symlinkCreated = true;
        } catch {
            // Some environments disallow symlink creation.
        }

        try {
            if (!symlinkCreated) {
                this.skip();
                return;
            }

            const targetCanonical = await canonicalizeFileSystemPathForSessionKey(targetFile);
            const aliasCanonical = await canonicalizeFileSystemPathForSessionKey(symlinkFile);
            assert.strictEqual(targetCanonical, aliasCanonical);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
