import * as fs from 'node:fs';
import * as path from 'node:path';
import { Capsule, FileChange, RecoveryRecord } from '../capsule/types';
import { CapsuleStorage } from '../capsule/capsuleStorage';
import { resolveInside } from '../../security/pathValidator';
import { sha256 } from '../../security/hashManager';
import { record } from '../recorder/flightRecorder';
import { readOriginal } from '../diff/diffReviewManager';

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
