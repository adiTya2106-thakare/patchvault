import { spawn } from 'node:child_process';
import { TestOutcome, TestRun } from '../capsule/types';

const MAX_OUT = 200_000;

/** Heuristic parsers for common runners. Returns null if counts cannot be read reliably. */
export function parseCounts(out: string): { passed: number; failed: number } | null {
  let m = /^# pass (\d+)[\s\S]*?^# fail (\d+)/m.exec(out);                    // node:test (TAP-ish)
  if (!m) { m = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(out); }               // node:test (spec)
  if (m) { return { passed: +m[1], failed: +m[2] }; }
  const jp = /Tests:\s+(?:(\d+) failed, )?(\d+) passed/.exec(out);            // jest
  if (jp) { return { passed: +jp[2], failed: +(jp[1] ?? 0) }; }
  const mp = /(\d+) passing/.exec(out); const mf = /(\d+) failing/.exec(out); // mocha
  if (mp) { return { passed: +mp[1], failed: mf ? +mf[1] : 0 }; }
  return null;
}

export function classify(exitCode: number | null, out: string, spawnFailed: boolean): { outcome: TestOutcome; counts?: { passed: number; failed: number } } {
  if (spawnFailed || exitCode === null) { return { outcome: 'could-not-execute' }; }
  const counts = parseCounts(out);
  if (exitCode !== 0) { return { outcome: 'failed', counts: counts ?? undefined }; }
  if (!counts) { return { outcome: 'uninterpretable' }; }  // exit 0 but nothing readable: do not claim "passed"
  return counts.failed === 0 && counts.passed > 0 ? { outcome: 'passed', counts } : { outcome: 'uninterpretable', counts };
}

/** Runs the user-configured command in the workspace. The command is the user's own setting;
 *  it is run through the shell only because test commands (e.g. "npm test") need it. */
export function runTests(cwd: string, command: string, timeoutMs = 300_000): Promise<TestRun> {
  const startedAt = new Date();
  return new Promise(resolve => {
    let stdout = '', stderr = '', spawnFailed = false;
    const child = spawn(command, { cwd, shell: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { if (stdout.length < MAX_OUT) { stdout += d; } });
    child.stderr.on('data', d => { if (stderr.length < MAX_OUT) { stderr += d; } });
    child.on('error', () => { spawnFailed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      const done = new Date();
      const { outcome, counts } = classify(code, stdout + '\n' + stderr, spawnFailed);
      resolve({ command, startedAt: startedAt.toISOString(), completedAt: done.toISOString(),
        durationMs: done.getTime() - startedAt.getTime(), exitCode: code, stdout, stderr, outcome, counts });
    });
  });
}
