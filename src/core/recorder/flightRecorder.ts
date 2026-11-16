import { Capsule, RecorderEvent } from '../capsule/types';

const SECRET_KEYS = /(key|token|secret|password|authorization)/i;

/** Append-only chronological event log stored inside the capsule. Never records secrets. */
export function record(c: Capsule, type: string, meta: RecorderEvent['meta'] = {}): RecorderEvent {
  const safe: RecorderEvent['meta'] = {};
  for (const [k, v] of Object.entries(meta)) { safe[k] = SECRET_KEYS.test(k) ? '[redacted]' : v; }
  const ev: RecorderEvent = { seq: c.events.length + 1, at: new Date().toISOString(), type, meta: safe };
  c.events.push(ev);
  return ev;
}
