import * as fs from 'node:fs';
import * as path from 'node:path';
import { git } from './gitRunner';
import { Capsule, FileSnapshot, GitCheckpoint } from '../capsule/types';
import { CapsuleStorage } from '../capsule/capsuleStorage';
import { sha256 } from '../../security/hashManager';
import { resolveInside } from '../../security/pathValidator';

export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.patchvault']);

/** Lists workspace files (posix-relative). Uses git (tracked + untracked, honoring .gitignore)
 *  when available; otherwise walks the directory. */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const r = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (r.code === 0) {
    return r.stdout.split('\0').filter(Boolean).filter(f => fs.existsSync(path.join(root, f)));
  }
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || e.isSymbolicLink()) { continue; }
      const r2 = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r2); } else if (e.isFile()) { out.push(r2); }
    }
  };
  walk(root, '');
  return out;
}

export async function captureGit(root: string, capsuleId: string): Promise<GitCheckpoint> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) {
    return { isGitRepo: false, head: null, branch: null, refName: null, stagedFiles: [], unstagedFiles: [], untrackedFiles: [] };
  }
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const staged = await git(root, ['diff', '--cached', '--name-only', '-z']);
  const unstaged = await git(root, ['diff', '--name-only', '-z']);
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  let refName: string | null = null;
  if (head.code === 0) {
    // A private ref keeps the HEAD commit reachable. It does NOT touch the index or working tree.
    const ref = `refs/patchvault/${capsuleId}`;
    const u = await git(root, ['update-ref', ref, head.stdout.trim()]);
    if (u.code === 0) { refName = ref; }
  }
  const split = (s: string) => s.split('\0').filter(Boolean);
  return {
    isGitRepo: true,
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    refName,
    stagedFiles: split(staged.stdout), unstagedFiles: split(unstaged.stdout), untrackedFiles: split(untracked.stdout),
  };
}

/** Copies every workspace file (including uncommitted edits) into the capsule blob store. */
export async function snapshotWorkspace(root: string, c: Capsule, storage: CapsuleStorage): Promise<FileSnapshot[]> {
  const files = await listWorkspaceFiles(root);
  const out: FileSnapshot[] = [];
  for (const f of files) {
    const abs = resolveInside(root, f);
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) { continue; }
    const data = fs.readFileSync(abs);
    out.push({ path: f, sha256: sha256(data), size: st.size, blobId: storage.putBlob(c.id, data) });
  }
  return out;
}
