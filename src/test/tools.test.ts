import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EditorTools } from '../core/tools/editorTools';
import { makeRepo, w } from './helpers';

test('EditorTools: exposes schemas and executes read_file safely', async () => {
  const repo = makeRepo();
  w(repo, 'sample.py', 'line1\nline2\nline3\nline4\nline5\n');

  const tools = new EditorTools(repo);
  const defs = tools.getToolDefinitions();
  assert.ok(defs.some(d => d.function.name === 'read_file'));
  assert.ok(defs.some(d => d.function.name === 'search_workspace'));
  assert.ok(defs.some(d => d.function.name === 'propose_file_edit'));
  assert.ok(defs.some(d => d.function.name === 'run_terminal_command'));

  // Test read_file slice
  const res = await tools.executeTool('read_file', { path: 'sample.py', start_line: 2, end_line: 4 });
  assert.equal(res.success, true);
  assert.ok(res.result?.includes('2: line2'));
  assert.ok(res.result?.includes('4: line4'));
  assert.ok(!res.result?.includes('5: line5'));
});

test('EditorTools: search_workspace discovers keyword matches', async () => {
  const repo = makeRepo();
  w(repo, 'src/helpers.py', 'def get_debug_flag():\n    return False\n');
  w(repo, 'src/cli.py', 'def cli_config():\n    pass\n');

  const tools = new EditorTools(repo);
  const searchRes = await tools.executeTool('search_workspace', { query: 'get_debug_flag' });
  assert.equal(searchRes.success, true);
  assert.ok(searchRes.result?.includes('src/helpers.py:1: def get_debug_flag()'));
});

test('EditorTools: propose_file_edit rejects path traversal attempts', async () => {
  const repo = makeRepo();
  const tools = new EditorTools(repo);
  const evilRes = await tools.executeTool('propose_file_edit', {
    path: '../../evil.sh',
    content: 'rm -rf /'
  });
  assert.equal(evilRes.success, false);
  assert.ok(evilRes.error?.includes('escapes workspace'));
});
