import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CapsuleManager } from '../core/capsule/capsuleManager';
import { CapsuleStorage } from '../core/capsule/capsuleStorage';

export function tmp(prefix = 'pv-'): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

export function makeRepo(): string {
  const d = tmp('pv-repo-');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(d, 'b.txt'), 'bee\n');
  fs.writeFileSync(path.join(d, 'c.txt'), 'sea\n');
  g('add', '.'); g('commit', '-q', '-m', 'init');
  return d;
}

export function makeManager(): { mgr: CapsuleManager; store: string; storage: CapsuleStorage } {
  const store = tmp('pv-store-');
  const storage = new CapsuleStorage(store);
  return { mgr: new CapsuleManager(storage), store, storage };
}

export const w = (root: string, rel: string, data: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};
export const r = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
