import { execFile } from 'node:child_process';

export interface GitResult { stdout: string; stderr: string; code: number }

function ensureGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    const gitCmd = 'C:\\Program Files\\Git\\cmd';
    if (!env.PATH?.toLowerCase().includes('git\\cmd')) {
      env.PATH = `${gitCmd};${env.PATH || ''}`;
    }
  }
  return env;
}

/** Runs git without a shell (no injection). Arguments are passed as an array. */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: ensureGitEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ stdout, stderr, code });
    });
  });
}
