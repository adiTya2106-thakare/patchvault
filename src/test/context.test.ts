import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractMentions, ContextEngine } from '../core/context/contextEngine';
import { makeRepo, w } from './helpers';

test('ContextEngine: extracts @file and @symbol mentions cleanly', () => {
  const prompt = 'Please inspect @file:src/flask/helpers.py and update @symbol:get_debug_flag to support off';
  const { mentions, cleanedPrompt } = extractMentions(prompt);

  assert.equal(mentions.length, 2);
  assert.equal(mentions[0].type, 'file');
  assert.equal(mentions[0].target, 'src/flask/helpers.py');
  assert.equal(mentions[1].type, 'symbol');
  assert.equal(mentions[1].target, 'get_debug_flag');

  assert.equal(cleanedPrompt, 'Please inspect and update to support off');
});

test('ContextEngine: assembles context with size budget and keyword scoring', async () => {
  const repo = makeRepo();
  w(repo, 'src/flask/cli.py', 'def cli_command():\n    """Built-in CLI command handling"""\n    pass\n');
  w(repo, 'tests/test_cli.py', 'def test_cli_command():\n    """Covered by a test"""\n    pass\n');
  w(repo, 'docs/cli.rst', 'Documented alongside other built-in commands.\n');
  w(repo, 'unrelated.py', 'def unrelated():\n    return 42\n');

  const engine = new ContextEngine();
  const assembled = await engine.assembleContext(
    repo,
    'Add a new built-in CLI command flask config covered by a test and documented',
    { budgetChars: 500 }
  );

  // Checks that files are retrieved unprompted
  assert.ok(assembled.retrievedFiles.length >= 2, 'Should retrieve relevant files');
  assert.ok(assembled.retrievedFiles.some(f => f.path.includes('cli.py')));
  assert.ok(assembled.totalChars <= 500, 'Must respect size budget');
  assert.ok(assembled.rationale.length > 0, 'Must provide selection rationale');

  const formatted = engine.formatContextForPrompt(assembled);
  assert.ok(formatted.includes('CONTEXT ASSEMBLY REPORT'));
  assert.ok(formatted.includes('Budget'));
});
