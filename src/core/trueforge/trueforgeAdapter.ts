import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, AgentRunContext, AgentRunResult } from './trueforgeTypes';
import { resolveInside } from '../../security/pathValidator';

export class IntegrationNotVerifiedError extends Error {}

export interface TrueForgeConfig { baseUrl: string; model: string; instructions?: string }

/** Minimal shape of the documented SDK calls (https://trueforge.dev/api/quickstart):
 *  new TrueForge({baseUrl}), client.sessions.create({agent:{spec}}), client.sessions.createTurnStream(id,{input}).
 *  The SDK is loaded at runtime so a changed SDK shape fails with a clear message, not a build break. */
interface TfClient {
  sessions: {
    create(a: unknown): Promise<{ data: { id: string } }>;
    createTurnStream(id: string, a: unknown): Promise<AsyncIterable<unknown>>;
  };
}

/** REAL integration. TrueForge owns the agent loop; PATCHVAULT only starts a turn and records events.
 *  UNTESTED against a live server: no TrueForge server/model key was available during development.
 *  Where the agent writes files (local folder vs. TrueForge sandbox) is unverified, so changes are
 *  discovered by scanning the workspace, never assumed from events. */
export class TrueForgeAdapter implements AgentAdapter {
  readonly name = 'TrueForge';
  readonly isMock = false;
  constructor(private readonly cfg: TrueForgeConfig) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    if (!this.cfg.model.trim()) { throw new IntegrationNotVerifiedError('Set the "patchvault.trueforgeModel" setting first (a model configured in your TrueForge Settings).'); }
    let sdk: { TrueForge?: new (o: unknown) => TfClient };
    try { const name = '@truefoundry/trueforge-sdk'; sdk = await import(name); }
    catch { throw new IntegrationNotVerifiedError('Could not load @truefoundry/trueforge-sdk. Run "npm install" in the extension folder.'); }
    if (typeof sdk.TrueForge !== 'function') { throw new IntegrationNotVerifiedError('Installed SDK has no TrueForge export; its API differs from the documented quickstart.'); }
    const client = new sdk.TrueForge({ baseUrl: this.cfg.baseUrl, timeoutInSeconds: 600 });
    const { data: session } = await client.sessions.create({
      agent: { spec: { model: { name: this.cfg.model }, instructions: this.cfg.instructions ?? 'You are a careful coding assistant working in the user\'s project.' } },
    });
    ctx.onEvent('agent.session.started', { adapter: this.name, sessionId: session.id, mock: false });
    const stream = await client.sessions.createTurnStream(session.id, { input: [{ type: 'user.message', content: ctx.prompt }] });
    let status = 'unknown'; let last = '';
    for await (const item of stream) {
      // Docs disagree on whether items are wrapped as {data: event}; accept both.
      const w = item as { data?: { type?: string; state?: { status?: string } }; type?: string; state?: { status?: string } };
      const ev = w.data && typeof w.data.type === 'string' ? w.data : w;
      if (!ev || typeof ev.type !== 'string') { continue; }
      if (ev.type.endsWith('.delta')) { continue; }          // deltas are transport, not state
      if (ev.type !== last) { ctx.onEvent('agent.event', { type: ev.type }); last = ev.type; }
      if (ev.type === 'turn.done') { status = ev.state?.status ?? 'done'; }
    }
    return { sessionId: session.id, plannedChanges: null, summary: `TrueForge turn finished: ${status}` };
  }
}

export interface ScriptedEdit { path: string; content: string | null } // null = delete

/** CLEARLY A MOCK. Applies scripted edits so PATCHVAULT can be developed and demoed offline.
 *  It must be constructed explicitly; nothing selects it automatically. */
export class MockAgentAdapter implements AgentAdapter {
  readonly name = 'MOCK (not TrueFoundry)';
  readonly isMock = true;
  constructor(private readonly edits: ScriptedEdit[], opts: { iUnderstandThisIsAMock: true }) {
    if (!opts || opts.iUnderstandThisIsAMock !== true) { throw new Error('Mock adapter must be opted into explicitly'); }
  }
  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    ctx.onEvent('agent.session.started', { adapter: this.name, mock: true });
    for (const e of this.edits) {
      const abs = resolveInside(ctx.workspaceRoot, e.path);
      if (e.content === null) { fs.rmSync(abs, { force: true }); }
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, e.content); }
      ctx.onEvent('agent.file.modified', { path: e.path, mock: true });
    }
    return { sessionId: 'mock-session', plannedChanges: this.edits.map(e => e.path), summary: 'Simulated agent run' };
  }
}
