import * as fs from 'node:fs';
import * as path from 'node:path';

export class PathSecurityError extends Error {}

/** Resolve a workspace-relative path and guarantee it stays inside the workspace.
 *  Rejects absolute paths, '..' traversal, NUL bytes, and symlinks that escape the root. */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) { throw new PathSecurityError('NUL byte in path'); }
  if (path.isAbsolute(rel)) { throw new PathSecurityError(`Absolute path not allowed: ${rel}`); }
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel);
  const within = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!within(target)) { throw new PathSecurityError(`Path escapes workspace: ${rel}`); }
  // Resolve the deepest existing ancestor to catch symlink escapes.
  let probe = target;
  while (!fs.existsSync(probe) && probe !== realRoot) { probe = path.dirname(probe); }
  const realProbe = fs.realpathSync(probe);
  if (!within(realProbe)) { throw new PathSecurityError(`Symlink escapes workspace: ${rel}`); }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new PathSecurityError(`Refusing to write through symlink: ${rel}`);
  }
  return target;
}

export function toPosixRel(p: string): string {
  return p.split(path.sep).join('/');
}
