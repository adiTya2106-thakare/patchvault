import * as fs from 'node:fs';
import * as path from 'node:path';
import { Capsule, FileChange } from '../capsule/types';
import { CapsuleStorage } from '../capsule/capsuleStorage';
import { listWorkspaceFiles, MAX_SNAPSHOT_BYTES } from '../git/checkpointManager';
import { isBinary, unifiedDiff, DiffResult } from './unifiedDiff';
import { sha256 } from '../../security/hashManager';
import { resolveInside } from '../../security/pathValidator';
import { record } from '../recorder/flightRecorder';

const MAX_DIFF_CELLS = 4_000_000; // guard against O(n*m) blowups on huge files

function readOrNull(abs: string): Buffer | null {
  try { const st = fs.lstatSync(abs); return st.isFile() && st.size <= MAX_SNAPSHOT_BYTES ? fs.readFileSync(abs) : null; }
  catch { return null; }
}

function makeDiff(rel: string, before: Buffer | null, after: Buffer | null): DiffResult {
  if ((before && isBinary(before)) || (after && isBinary(after))) {
    return { added: 0, removed: 0, text: `Binary file ${rel} differs`, hunks: [] };
  }
  const a = before ? before.toString('utf8') : '';
  const b = after ? after.toString('utf8') : '';
  if ((a.split('\n').length) * (b.split('\n').length) > MAX_DIFF_CELLS) {
    return { added: 0, removed: 0, text: `File too large to diff inline: ${rel}`, hunks: [] };
  }
  return unifiedDiff(rel, a, b);
}

/** Compares the workspace to the capsule's original manifest and (re)builds the change list.
 *  Review decisions are preserved only when the file content has not changed since the decision. */
export async function detectChanges(root: string, c: Capsule, storage: CapsuleStorage): Promise<FileChange[]> {
  const original = new Map(c.manifest.map(s => [s.path, s]));
  const now = new Set(await listWorkspaceFiles(root));
  const prev = new Map(c.changes.map(x => [x.path, x]));
  const next: FileChange[] = [];
  const consider = new Set<string>([...original.keys(), ...now]);
  for (const rel of [...consider].sort()) {
    const abs = resolveInside(root, rel);
    const cur = now.has(rel) ? readOrNull(abs) : null;
    const orig = original.get(rel);
    const curHash = cur ? sha256(cur) : null;
    if (orig && curHash === orig.sha256) { continue; }          // unchanged
    if (!orig && !cur) { continue; }                            // skipped (too large) and not in manifest
    if (orig && now.has(rel) && !cur) { continue; }             // grew beyond snapshot limit: not diffable
    const before = orig ? storage.getBlob(c.id, orig.blobId) : null;
    const d = makeDiff(rel, before, cur);
    const old = prev.get(rel);
    const keep = old && old.modifiedSha256 === curHash;
    const preservedHunks = d.hunks.map(h => {
      const oldHunk = keep ? old?.hunks?.find(oh => oh.id === h.id) : undefined;
      return oldHunk ? { ...h, review: oldHunk.review } : h;
    });
    next.push({
      path: rel,
      kind: !orig ? 'added' : cur ? 'modified' : 'deleted',
      originalSha256: orig ? orig.sha256 : null,
      modifiedSha256: curHash,
      added: d.added, removed: d.removed, unifiedDiff: d.text,
      hunks: preservedHunks,
      review: keep ? old.review : 'pending',
      expected: c.plannedChanges ? c.plannedChanges.includes(rel) : null,
    });
  }
  // Keep rejected entries visible as history only if still differing; otherwise they are resolved.
  c.changes = next;
  return next;
}

export function setReview(c: Capsule, rel: string, status: 'approved' | 'pending'): void {
  const ch = c.changes.find(x => x.path === rel);
  if (!ch) { throw new Error(`No such change: ${rel}`); }
  ch.review = status;
  if (ch.hunks) {
    for (const h of ch.hunks) {
      h.review = status;
    }
  }
  record(c, status === 'approved' ? 'change.approved' : 'change.review-reset', { path: rel });
}

export function setHunkReview(c: Capsule, rel: string, hunkId: string, status: 'approved' | 'pending'): void {
  const ch = c.changes.find(x => x.path === rel);
  if (!ch) { throw new Error(`No such change: ${rel}`); }
  const hunk = ch.hunks?.find(h => h.id === hunkId);
  if (!hunk) { throw new Error(`No such hunk: ${hunkId} in ${rel}`); }
  hunk.review = status;
  if (ch.hunks && ch.hunks.every(h => h.review === 'approved')) {
    ch.review = 'approved';
  } else {
    ch.review = 'pending';
  }
  record(c, status === 'approved' ? 'hunk.approved' : 'hunk.review-reset', { path: rel, hunkId });
}

export function readOriginal(c: Capsule, storage: CapsuleStorage, rel: string): Buffer | null {
  const s = c.manifest.find(x => x.path === rel);
  return s ? storage.getBlob(c.id, s.blobId) : null;
}

export function ensureDir(abs: string): void { fs.mkdirSync(path.dirname(abs), { recursive: true }); }
