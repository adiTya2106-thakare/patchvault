import * as fs from 'node:fs';
import * as path from 'node:path';
import { Capsule, FileChange, RecoveryRecord } from '../capsule/types';
import { CapsuleStorage } from '../capsule/capsuleStorage';
import { resolveInside } from '../../security/pathValidator';
import { sha256 } from '../../security/hashManager';
import { record } from '../recorder/flightRecorder';
import { readOriginal } from '../diff/diffReviewManager';
import { reconstructFromHunks, unifiedDiff } from '../diff/unifiedDiff';

export interface RecoveryOutcome { restored: string[]; conflicts: string[]; verified: boolean; refused: boolean }

function currentHash(abs: string): string | null {
  try { return fs.lstatSync(abs).isFile() ? sha256(fs.readFileSync(abs)) : null; } catch { return null; }
}

function atomicWrite(abs: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.pv-tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

/** Preflight: a file is safe to overwrite only if it still has the content PATCHVAULT last inspected.
 *  Anything else means someone (user, tool, another agent) edited it since -> conflict, nothing is touched. */
function preflight(root: string, c: Capsule, storage: CapsuleStorage, changes: FileChange[]) {
  const conflicts: string[] = [];
  for (const ch of changes) {
    const abs = resolveInside(root, ch.path);
    if (currentHash(abs) !== ch.modifiedSha256) { conflicts.push(`${ch.path}: changed since last inspection`); }
    if (ch.kind !== 'added' && !readOriginal(c, storage, ch.path)) { conflicts.push(`${ch.path}: original content unavailable or corrupt`); }
  }
  return conflicts;
}

/** Restores the given changes to their original state. All-or-nothing: if any conflict is found,
 *  no file is written. Never uses `git reset`/`checkout`; never touches files outside the change list. */
export function recover(root: string, c: Capsule, storage: CapsuleStorage, paths: string[] | 'all'): RecoveryOutcome {
  const targets = paths === 'all' ? c.changes : c.changes.filter(x => paths.includes(x.path));
  const scope: RecoveryRecord['scope'] = paths === 'all' ? 'capsule' : 'file';
  record(c, 'recovery.initiated', { scope, files: targets.length });
  const conflicts = preflight(root, c, storage, targets);
  if (conflicts.length) {
    record(c, 'recovery.refused', { conflicts: conflicts.length });
    c.recoveries.push({ at: new Date().toISOString(), scope, restored: [], conflicts, verified: false });
    return { restored: [], conflicts, verified: false, refused: true };
  }
  const restored: string[] = [];
  for (const ch of targets) {
    const abs = resolveInside(root, ch.path);
    if (ch.kind === 'added') { fs.rmSync(abs, { force: true }); }   // only a file the agent created and we inspected
    else { atomicWrite(abs, readOriginal(c, storage, ch.path) as Buffer); }
    restored.push(ch.path);
  }
  const verified = targets.every(ch => currentHash(resolveInside(root, ch.path)) === ch.originalSha256);
  c.recoveries.push({ at: new Date().toISOString(), scope, restored, conflicts: [], verified });
  c.changes = c.changes.filter(x => !restored.includes(x.path));
  record(c, 'recovery.completed', { scope, restored: restored.length, verified });
  if (scope === 'capsule' && verified) { c.status = 'recovered'; }
  return { restored, conflicts: [], verified, refused: false };
}

/** Rejecting a change == recovering that single file, with the same safety checks. */
export function rejectChange(root: string, c: Capsule, storage: CapsuleStorage, rel: string): RecoveryOutcome {
  const out = recover(root, c, storage, [rel]);
  if (!out.refused) { record(c, 'change.rejected', { path: rel }); }
  return out;
}

/** Rejecting an individual hunk restores that hunk's original lines while keeping the rest.
 *  Hash-verified: verifies file hash before and after write, all-or-nothing. */
export function rejectHunk(root: string, c: Capsule, storage: CapsuleStorage, rel: string, hunkId: string): RecoveryOutcome {
  const ch = c.changes.find(x => x.path === rel);
  if (!ch) {
    return { restored: [], conflicts: [`${rel}: not in change list`], verified: false, refused: true };
  }
  const abs = resolveInside(root, rel);
  if (currentHash(abs) !== ch.modifiedSha256) {
    const conflicts = [`${rel}: changed since last inspection`];
    record(c, 'recovery.refused', { conflicts: 1 });
    return { restored: [], conflicts, verified: false, refused: true };
  }
  const origBuf = readOriginal(c, storage, rel);
  if (!origBuf) {
    const conflicts = [`${rel}: original content unavailable or corrupt`];
    record(c, 'recovery.refused', { conflicts: 1 });
    return { restored: [], conflicts, verified: false, refused: true };
  }
  const hunk = ch.hunks?.find(h => h.id === hunkId);
  if (!hunk) {
    return { restored: [], conflicts: [`${rel}: hunk ${hunkId} not found`], verified: false, refused: true };
  }

  // Mark hunk rejected
  hunk.review = 'rejected';
  const origStr = origBuf.toString('utf8');
  const curStr = fs.readFileSync(abs, 'utf8');

  const allRejected = ch.hunks && ch.hunks.every(h => h.review === 'rejected');
  let newContentBuf: Buffer;
  if (allRejected) {
    newContentBuf = origBuf;
  } else {
    const reconstructed = reconstructFromHunks(origStr, curStr, ch.hunks!);
    newContentBuf = Buffer.from(reconstructed, 'utf8');
  }

  atomicWrite(abs, newContentBuf);
  const writtenHash = currentHash(abs);
  const expectedHash = sha256(newContentBuf);
  const verified = writtenHash === expectedHash;

  if (!verified) {
    return { restored: [], conflicts: [`${rel}: hash verification failed after partial restore`], verified: false, refused: true };
  }

  record(c, 'hunk.rejected', { path: rel, hunkId });

  if (allRejected || writtenHash === ch.originalSha256) {
    c.changes = c.changes.filter(x => x.path !== rel);
    record(c, 'change.rejected', { path: rel });
  } else {
    ch.modifiedSha256 = writtenHash;
    const reDiff = unifiedDiff(rel, origStr, newContentBuf.toString('utf8'));
    ch.added = reDiff.added;
    ch.removed = reDiff.removed;
    ch.unifiedDiff = reDiff.text;
    ch.hunks = reDiff.hunks;
    ch.review = 'pending';
  }

  c.recoveries.push({
    at: new Date().toISOString(),
    scope: 'file',
    restored: [`${rel}#${hunkId}`],
    conflicts: [],
    verified: true,
  });

  return { restored: [`${rel}#${hunkId}`], conflicts: [], verified: true, refused: false };
}
