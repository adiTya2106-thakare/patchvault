import { execFile } from 'node:child_process';

export interface GitResult { stdout: string; stderr: string; code: number }

/** Runs git without a shell (no injection). Arguments are passed as an array. */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ stdout, stderr, code });
    });
  });
}
