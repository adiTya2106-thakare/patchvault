export const CAPSULE_SCHEMA_VERSION = 1;

export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type CapsuleStatus = 'created' | 'running' | 'review' | 'completed' | 'failed' | 'recovered';
export type RecoveryState =
  | 'Protected' | 'Needs Review' | 'Verification Failed' | 'Recovery Available' | 'Recovery Incomplete';
export type TestOutcome = 'passed' | 'failed' | 'uninterpretable' | 'could-not-execute';

export interface FileSnapshot {
  path: string;            // workspace-relative, posix separators
  sha256: string;
  size: number;
  blobId: string;          // key in capsule blob store
}

export interface GitCheckpoint {
  isGitRepo: boolean;
  head: string | null;
  branch: string | null;
  refName: string | null;  // refs/patchvault/<capsuleId>
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
}

export interface DiffHunk {
  id: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
  review: ReviewStatus;
}

export interface FileChange {
  path: string;
  kind: 'modified' | 'added' | 'deleted';
  originalSha256: string | null;
  modifiedSha256: string | null;   // hash when PATCHVAULT last inspected it
  added: number;
  removed: number;
  unifiedDiff: string;
  hunks?: DiffHunk[];
  review: ReviewStatus;
  expected: boolean | null;        // was it in the agent's planned changes? null = no plan
}

export interface TestRun {
  command: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outcome: TestOutcome;
  counts?: { passed: number; failed: number };
}

export interface RecorderEvent {
  seq: number;
  at: string;
  type: string;
  meta: Record<string, string | number | boolean | null>;
}

export interface RecoveryRecord {
  at: string;
  scope: 'file' | 'capsule';
  restored: string[];
  conflicts: string[];
  verified: boolean;
}

export interface Capsule {
  schemaVersion: number;
  id: string;
  title: string;
  prompt: string;
  createdAt: string;
  status: CapsuleStatus;
  checkpoint: GitCheckpoint;
  manifest: FileSnapshot[];
  plannedChanges: string[] | null;
  changes: FileChange[];
  tests: TestRun[];
  events: RecorderEvent[];
  recoveries: RecoveryRecord[];
  agentSession: { adapter: string; sessionId: string | null; mock: boolean } | null;
}
