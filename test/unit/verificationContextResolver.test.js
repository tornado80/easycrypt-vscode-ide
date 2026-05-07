const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildCompileArgs,
  fingerprintVerificationContext,
  normalizeCommandArgs,
  resolveVerificationContext,
  sessionContextEquals,
} = require('../../out/verificationContextResolver');

describe('VerificationContextResolver', function () {
  it('resolves deterministic working directory, include roots, and merged user args', function () {
    const workspaceRoot = path.resolve('workspace-root');
    const moduleDir = path.join(workspaceRoot, 'kem-dem', 'left-or-right');
    const documentPath = path.join(moduleDir, 'KEMDEM_lor.ec');

    const context = resolveVerificationContext({
      documentPath,
      workspaceFolderPath: workspaceRoot,
      configArgs: ['--foo'],
      proverArgs: ['--bar'],
    });

    assert.equal(context.workingDirectory, path.normalize(moduleDir));
    assert.deepEqual(context.includeRoots, [path.normalize(moduleDir), path.normalize(workspaceRoot)]);
    assert.deepEqual(context.normalizedUserArgs, ['--foo', '--bar']);
  });

  it('deduplicates include roots and avoids reinjecting user-provided include paths', function () {
    const workspaceRoot = path.resolve('workspace-root');
    const moduleDir = path.join(workspaceRoot, 'dir-a');
    const documentPath = path.join(moduleDir, 'Main_A.ec');

    const context = resolveVerificationContext({
      documentPath,
      workspaceFolderPath: workspaceRoot,
      configArgs: ['-I', moduleDir, `-I${workspaceRoot}`],
      proverArgs: [],
    });

    assert.deepEqual(context.includeRoots, []);

    const compileArgs = buildCompileArgs(context, documentPath);
    assert.deepEqual(compileArgs, ['compile', '-script', '-I', moduleDir, `-I${workspaceRoot}`, documentPath]);
  });

  it('normalizes and compares session context fingerprints deterministically', function () {
    const workspaceRoot = path.resolve('workspace-root');
    const baseContext = resolveVerificationContext({
      documentPath: path.join(workspaceRoot, 'dir-b', 'Main_B.ec'),
      workspaceFolderPath: workspaceRoot,
      configArgs: ['--arg'],
      proverArgs: ['--prover'],
    });

    const fingerprint = fingerprintVerificationContext(baseContext);

    const equivalent = {
      workingDirectory: path.resolve(path.join(baseContext.workingDirectory, '.')),
      includeRoots: baseContext.includeRoots.map((includeRoot) =>
        path.resolve(path.join(includeRoot, '.'))
      ),
      normalizedUserArgs: [...baseContext.normalizedUserArgs],
    };

    const different = {
      ...equivalent,
      normalizedUserArgs: [...equivalent.normalizedUserArgs, '--extra'],
    };

    assert.equal(sessionContextEquals(fingerprint, equivalent), true);
    assert.equal(sessionContextEquals(fingerprint, different), false);
  });

  it('normalizes empty/whitespace command arguments while preserving order', function () {
    const normalized = normalizeCommandArgs(['  --a  ', '', '   ', '--b'], [' --c', '']);
    assert.deepEqual(normalized, ['--a', '--b', '--c']);
  });
});
