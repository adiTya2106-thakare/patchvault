import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveInside, PathSecurityError } from '../security/pathValidator';
import { sha256 } from '../security/hashManager';
import { tmp } from './helpers';

test('path traversal, absolute and NUL paths are rejected', () => {
  const root = tmp();
  assert.throws(() => resolveInside(root, '../x'), PathSecurityError);
  assert.throws(() => resolveInside(root, 'a/../../x'), PathSecurityError);
  assert.throws(() => resolveInside(root, '/etc/passwd'), PathSecurityError);
  assert.throws(() => resolveInside(root, 'a\0b'), PathSecurityError);
  assert.ok(resolveInside(root, 'ok/file.txt').startsWith(fs.realpathSync(root)));
});

test('symlink escaping the workspace is rejected', (t) => {
  const root = tmp(); const outside = tmp();
  try {
    fs.symlinkSync(outside, path.join(root, 'link'));
  } catch (err: any) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      t.skip(`Symlink creation not permitted on this Windows environment without elevated privilege (${err.code})`);
      return;
    }
    throw err;
  }
  assert.throws(() => resolveInside(root, 'link/file.txt'), PathSecurityError);
  fs.writeFileSync(path.join(outside, 'f'), 'x');
  fs.symlinkSync(path.join(outside, 'f'), path.join(root, 'flink'));
  assert.throws(() => resolveInside(root, 'flink'), PathSecurityError);
});

test('sha256 is correct and stable', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
