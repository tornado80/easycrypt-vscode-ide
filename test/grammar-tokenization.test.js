const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vscodeTextmate = require('vscode-textmate');
const vscodeOniguruma = require('vscode-oniguruma');

function repoPath(...parts) {
  return path.join(__dirname, '..', ...parts);
}

function loadWasm() {
  // vscode-oniguruma ships the wasm here
  const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
  return fs.promises.readFile(wasmPath).then((buf) => buf.buffer);
}

async function createRegistry() {
  const wasmBin = await loadWasm();
  await vscodeOniguruma.loadWASM(wasmBin);

  const onigLib = {
    createOnigScanner: (sources) => new vscodeOniguruma.OnigScanner(sources),
    createOnigString: (str) => new vscodeOniguruma.OnigString(str),
  };

  const grammarPath = repoPath('syntaxes', 'easycrypt.tmLanguage.json');
  const grammarContent = await fs.promises.readFile(grammarPath, 'utf8');

  const registry = new vscodeTextmate.Registry({
    onigLib,
    loadGrammar: async (scopeName) => {
      if (scopeName !== 'source.easycrypt') return null;
      return vscodeTextmate.parseRawGrammar(grammarContent, grammarPath);
    },
  });

  return registry;
}

function tokenizeLines(grammar, text) {
  const lines = text.split(/\r?\n/);
  let ruleStack = null;
  const tokenized = [];

  for (const line of lines) {
    const r = grammar.tokenizeLine(line, ruleStack);
    ruleStack = r.ruleStack;
    tokenized.push({ line, tokens: r.tokens });
  }

  return tokenized;
}

function scopesAtPosition(tokenizeResultForLine, position) {
  const { tokens } = tokenizeResultForLine;
  const token = tokens.find((t) => position >= t.startIndex && position < t.endIndex);
  if (!token) return [];
  return token.scopes;
}

function indexOfOrThrow(haystack, needle) {
  const idx = haystack.indexOf(needle);
  if (idx === -1) {
    throw new Error(`Could not find substring '${needle}' in line: ${haystack}`);
  }
  return idx;
}

describe('EasyCrypt TextMate grammar', function () {
  this.timeout(15_000);

  it('package.json contributes language and grammar', async () => {
    const pkg = JSON.parse(await fs.promises.readFile(repoPath('package.json'), 'utf8'));

    assert.ok(pkg.contributes);
    assert.ok(Array.isArray(pkg.contributes.languages));
    assert.ok(Array.isArray(pkg.contributes.grammars));

    const lang = pkg.contributes.languages.find((l) => l.id === 'easycrypt');
    assert.ok(lang);
    assert.ok(lang.extensions.includes('.ec'));
    assert.ok(lang.extensions.includes('.eca'));

    const grammar = pkg.contributes.grammars.find((g) => g.scopeName === 'source.easycrypt');
    assert.ok(grammar);
    assert.equal(grammar.language, 'easycrypt');
  });

  it('tokenizes the sample file and highlights core constructs', async () => {
    const registry = await createRegistry();
    const grammar = await registry.loadGrammar('source.easycrypt');
    assert.ok(grammar);

    const sample = await fs.promises.readFile(repoPath('test', 'test_sample.ec'), 'utf8');
    const tokenized = tokenizeLines(grammar, sample);

    // 1) Nested comments (any inner word in the nested comment line should be comment scoped)
    {
      const lineObj = tokenized.find((x) => x.line.includes('This is a nested comment'));
      assert.ok(lineObj, 'nested comment line present');
      const pos = indexOfOrThrow(lineObj.line, 'nested');
      const scopes = scopesAtPosition(lineObj, pos);
      assert.ok(scopes.includes('comment.block.easycrypt'));
    }

    // 2) Keywords: lemma
    {
      const lineObj = tokenized.find((x) => x.line.startsWith('lemma example_lemma'));
      assert.ok(lineObj, 'lemma line present');
      const pos = indexOfOrThrow(lineObj.line, 'lemma') + 1;
      const scopes = scopesAtPosition(lineObj, pos);
      assert.ok(scopes.includes('keyword.control.directive.easycrypt'));
    }

    // 3) Dangerous: admit
    {
      const lineObj = tokenized.find((x) => x.line.trim() === 'admit.');
      assert.ok(lineObj, 'admit line present');
      const pos = indexOfOrThrow(lineObj.line, 'admit') + 1;
      const scopes = scopesAtPosition(lineObj, pos);
      assert.ok(scopes.includes('invalid.deprecated.dangerous.easycrypt'));
    }

    // 4) Strings
    {
      const lineObj = tokenized.find((x) => x.line.includes('"Hello, EasyCrypt!"'));
      assert.ok(lineObj, 'string example line present');
      const pos = indexOfOrThrow(lineObj.line, 'Hello');
      const scopes = scopesAtPosition(lineObj, pos);
      assert.ok(scopes.includes('string.quoted.double.easycrypt'));
    }

    // 5) Numeric literals: negative int
    {
      const lineObj = tokenized.find((x) => x.line.includes('= -17'));
      assert.ok(lineObj, 'negative int literal line present');
      const pos = indexOfOrThrow(lineObj.line, '-17') + 1;
      const scopes = scopesAtPosition(lineObj, pos);
      assert.ok(scopes.includes('constant.numeric.integer.easycrypt'));
    }

    // 6) Operators: /\
    {
      const lineObj = tokenized.find((x) => x.line.includes('P /\\ Q =>'));
      assert.ok(lineObj, 'operator /\\ line present');
      const pos = indexOfOrThrow(lineObj.line, '/\\') + 1;
      const scopes = scopesAtPosition(lineObj, pos);
      assert.ok(scopes.includes('keyword.operator.logical.easycrypt'));
    }

    // 7) Pragmas: keyword and args are distinct
    {
      const lineObj = tokenized.find((x) => x.line.startsWith('pragma '));
      assert.ok(lineObj, 'pragma line present');

      const pragmaPos = indexOfOrThrow(lineObj.line, 'pragma') + 1;
      const pragmaScopes = scopesAtPosition(lineObj, pragmaPos);
      assert.ok(pragmaScopes.includes('keyword.other.pragma.easycrypt'));

      const argPos = indexOfOrThrow(lineObj.line, 'Goals:printall') + 1;
      const argScopes = scopesAtPosition(lineObj, argPos);
      assert.ok(argScopes.includes('meta.directive.pragma.arguments.easycrypt'));
    }

    // 8) Built-in types: int
    {
      const lineObj = tokenized.find((x) => x.line.includes('(x y : int)'));
      assert.ok(lineObj, 'int type usage line present');
      const pos = indexOfOrThrow(lineObj.line, 'int') + 1;
      const scopes = scopesAtPosition(lineObj, pos);
      assert.ok(scopes.includes('storage.type.easycrypt'));
    }
  });
});
