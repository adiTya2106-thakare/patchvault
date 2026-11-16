import * as fs from 'node:fs';
import * as path from 'node:path';
import { Capsule, CAPSULE_SCHEMA_VERSION } from './types';
import { sha256 } from '../../security/hashManager';

export type LoadResult =
  | { ok: true; capsule: Capsule }
  | { ok: false; reason: 'missing' | 'corrupt' | 'unsupported-version'; detail: string };

/** JSON-file store: <root>/capsules/<id>/capsule.json + content-addressed blobs/.
 *  Chosen over SQLite: zero native dependencies, human-inspectable, easy to ZIP. */
export class CapsuleStorage {
  constructor(private readonly root: string) {}

  private dir(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) { throw new Error('Invalid capsule id'); }
    return path.join(this.root, 'capsules', id);
  }

  save(c: Capsule): void {
    const d = this.dir(c.id);
    fs.mkdirSync(path.join(d, 'blobs'), { recursive: true });
    const tmp = path.join(d, 'capsule.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, path.join(d, 'capsule.json')); // atomic replace
  }

  load(id: string): LoadResult {
    const f = path.join(this.dir(id), 'capsule.json');
    if (!fs.existsSync(f)) { return { ok: false, reason: 'missing', detail: f }; }
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8')) as Capsule;
      if (typeof c !== 'object' || c === null || typeof c.id !== 'string' || !Array.isArray(c.changes)) {
        return { ok: false, reason: 'corrupt', detail: 'unexpected shape' };
      }
      if (c.schemaVersion !== CAPSULE_SCHEMA_VERSION) {
        return { ok: false, reason: 'unsupported-version', detail: `found v${c.schemaVersion}` };
      }
      return { ok: true, capsule: c };
    } catch (e) {
      return { ok: false, reason: 'corrupt', detail: (e as Error).message };
    }
  }

  list(): { loaded: Capsule[]; skipped: { id: string; reason: string }[] } {
    const base = path.join(this.root, 'capsules');
    const out = { loaded: [] as Capsule[], skipped: [] as { id: string; reason: string }[] };
    if (!fs.existsSync(base)) { return out; }
    for (const id of fs.readdirSync(base)) {
      const r = this.load(id);
      if (r.ok) { out.loaded.push(r.capsule); } else { out.skipped.push({ id, reason: r.reason }); }
    }
    out.loaded.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  putBlob(id: string, data: Buffer): string {
    const h = sha256(data);
    const p = path.join(this.dir(id), 'blobs', h);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) { fs.writeFileSync(p, data); }
    return h;
  }

  /** Reads a blob and re-verifies its hash; returns null if missing or tampered. */
  getBlob(id: string, blobId: string): Buffer | null {
    if (!/^[a-f0-9]{64}$/.test(blobId)) { return null; }
    const p = path.join(this.dir(id), 'blobs', blobId);
    if (!fs.existsSync(p)) { return null; }
    const b = fs.readFileSync(p);
    return sha256(b) === blobId ? b : null;
  }
}
