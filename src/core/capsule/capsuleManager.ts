import { randomBytes } from 'node:crypto';
import { Capsule, CAPSULE_SCHEMA_VERSION, RecoveryState } from './types';
import { CapsuleStorage } from './capsuleStorage';
import { captureGit, snapshotWorkspace } from '../git/checkpointManager';
import { record } from '../recorder/flightRecorder';
import { detectChanges } from '../diff/diffReviewManager';
import { readOriginal } from '../diff/diffReviewManager';

export class CapsuleManager {
  constructor(public readonly storage: CapsuleStorage) {}

  /** Captures the pre-task state and persists a new capsule. Throws if the workspace is unusable. */
  async create(root: string, title: string, prompt: string): Promise<Capsule> {
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const c: Capsule = {
      schemaVersion: CAPSULE_SCHEMA_VERSION, id, title, prompt, createdAt: new Date().toISOString(),
      status: 'created',
      checkpoint: { isGitRepo: false, head: null, branch: null, refName: null, stagedFiles: [], unstagedFiles: [], untrackedFiles: [] },
      manifest: [], plannedChanges: null, changes: [], tests: [], events: [], recoveries: [], agentSession: null,
    };
    record(c, 'task.initiated', { title });
    c.checkpoint = await captureGit(root, id);
    c.manifest = await snapshotWorkspace(root, c, this.storage);
    record(c, 'checkpoint.captured', { files: c.manifest.length, git: c.checkpoint.isGitRepo, head: c.checkpoint.head });
    this.storage.save(c);
    return c;
  }

  async refresh(root: string, c: Capsule): Promise<void> {
    await detectChanges(root, c, this.storage);
    for (const ch of c.changes) { record(c, 'diff.generated', { path: ch.path, added: ch.added, removed: ch.removed }); }
    this.storage.save(c);
  }

  save(c: Capsule): void { this.storage.save(c); }

  /** Deterministic, explainable state. No percentages: every state lists the facts behind it. */
  recoveryState(c: Capsule): { state: RecoveryState; reasons: string[] } {
    const reasons: string[] = [];
    if (c.manifest.length === 0) { return { state: 'Recovery Incomplete', reasons: ['No original files were captured'] }; }
    const missing = c.changes.filter(ch => ch.kind !== 'added' && !readOriginal(c, this.storage, ch.path));
    if (missing.length) { return { state: 'Recovery Incomplete', reasons: missing.map(m => `Original content unavailable: ${m.path}`) }; }
    const lastTest = c.tests[c.tests.length - 1];
    if (lastTest && (lastTest.outcome === 'failed' || lastTest.outcome === 'could-not-execute')) {
      return { state: 'Verification Failed', reasons: [`Last test run: ${lastTest.outcome}`] };
    }
    const pending = c.changes.filter(ch => ch.review === 'pending');
    const unexpected = c.changes.filter(ch => ch.expected === false);
    if (pending.length) { reasons.push(`${pending.length} change(s) not yet reviewed`); }
    if (unexpected.length) { reasons.push(`${unexpected.length} file(s) changed outside the agent's plan`); }
    if (reasons.length) { return { state: 'Needs Review', reasons }; }
    if (c.changes.length) { return { state: 'Recovery Available', reasons: ['All changes reviewed; originals verified and restorable'] }; }
    return { state: 'Protected', reasons: ['Original state captured; no outstanding changes'] };
  }
}
