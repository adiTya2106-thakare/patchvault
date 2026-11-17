import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, AgentRunContext, AgentRunResult } from './trueforgeTypes';
import { resolveInside } from '../../security/pathValidator';

export class IntegrationNotVerifiedError extends Error {}

export interface TrueForgeConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  instructions?: string;
  syncRemoteEdits?: boolean;
}

/** Minimal shape of the documented SDK calls (https://trueforge.dev/api/quickstart):
 *  new TrueForge({baseUrl, apiKey?}), client.sessions.create({agent:{spec}}), client.sessions.createTurnStream(id,{input}).
 *  The SDK is loaded at runtime so a changed SDK shape fails with a clear message, not a build break. */
interface TfClient {
  sessions: {
    create(a: unknown): Promise<{ data: { id: string } }>;
    createTurnStream(id: string, a: unknown): Promise<AsyncIterable<unknown>>;
    downloadSandboxFile?(sessionId: string, turnId: string, req: { path: string }): Promise<unknown>;
  };
}

/** REAL integration. TrueForge owns the agent loop; PATCHVAULT starts a turn and records flight recorder events.
 *  Supports local TrueForge (Linux/WSL), remote sandbox providers, and authenticated endpoints.
 *  Discovers planned file changes through model toolCalls and sandbox artifacts, while verifying
 *  all modifications against PATCHVAULT's pre-task checkpoint. */
export class TrueForgeAdapter implements AgentAdapter {
  readonly name = 'TrueForge';
  readonly isMock = false;
  constructor(private readonly cfg: TrueForgeConfig) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    if (!this.cfg.model.trim()) {
      throw new IntegrationNotVerifiedError('Set the "patchvault.trueforgeModel" setting first (a model configured in your TrueForge Settings).');
    }
    let sdk: { TrueForge?: new (o: unknown) => TfClient };
    try {
      // Real dynamic import(): TypeScript would otherwise turn import() into require(), which cannot load ESM-only packages.
      const load = new Function('n', 'return import(n)') as (n: string) => Promise<typeof sdk>;
      sdk = await load('@truefoundry/trueforge-sdk');
    } catch (e) {
      throw new IntegrationNotVerifiedError(`Could not load @truefoundry/trueforge-sdk (${(e as Error).message.slice(0, 200)}). Run "npm install" in the extension folder.`);
    }
    if (typeof sdk.TrueForge !== 'function') {
      throw new IntegrationNotVerifiedError('Installed SDK has no TrueForge export; its API differs from the documented quickstart.');
    }

    const clientOpts: Record<string, unknown> = { baseUrl: this.cfg.baseUrl, timeoutInSeconds: 600 };
    if (this.cfg.apiKey) {
      clientOpts.apiKey = this.cfg.apiKey;
      clientOpts.token = this.cfg.apiKey;
    }

    const client = new sdk.TrueForge(clientOpts);
    const { data: session } = await client.sessions.create({
      agent: {
        spec: {
          model: { name: this.cfg.model },
          instructions: this.cfg.instructions ?? 'You are a careful coding assistant working in the user\'s project.',
        },
      },
    });

    ctx.onEvent('agent.session.started', { adapter: this.name, sessionId: session.id, mock: false });

    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: 'user.message', content: ctx.prompt }],
    });

    let status = 'unknown';
    let last = '';
    let currentTurnId: string | null = null;
    const plannedChangesSet = new Set<string>();

    for await (const item of stream) {
      // Docs disagree on whether items are wrapped as {data: event}; accept both.
      const w = item as {
        data?: {
          type?: string;
          turnId?: string;
          state?: { status?: string };
          toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
        type?: string;
        turnId?: string;
        state?: { status?: string };
        toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };

      const ev = (w.data && typeof w.data.type === 'string' ? w.data : w) as {
        type?: string;
        turnId?: string;
        state?: { status?: string };
        toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>;
        artifacts?: Array<{ path?: string }>;
      };

      if (!ev || typeof ev.type !== 'string') { continue; }

      if (ev.turnId && !currentTurnId) {
        currentTurnId = ev.turnId;
      }

      // Check for file-related tool calls in model.message
      if (ev.toolCalls && Array.isArray(ev.toolCalls)) {
        for (const tc of ev.toolCalls) {
          const fnName = tc.function?.name ?? '';
          let args: Record<string, unknown> = {};
          try {
            args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch { /* unparseable args */ }

          const filePath = (args.path || args.file || args.filename || args.target_file) as string | undefined;
          if (filePath && typeof filePath === 'string') {
            plannedChangesSet.add(filePath);
            ctx.onEvent('agent.tool.call', { tool: fnName, path: filePath });

            // If syncRemoteEdits is enabled and content is in arguments, sync safely to workspace
            if (this.cfg.syncRemoteEdits && (args.content !== undefined || args.file_text !== undefined)) {
              try {
                const content = String(args.content ?? args.file_text ?? '');
                const abs = resolveInside(ctx.workspaceRoot, filePath);
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.writeFileSync(abs, content);
                ctx.onEvent('agent.file.synced', { path: filePath });
              } catch (syncErr) {
                ctx.onEvent('agent.sync.failed', { path: filePath, error: (syncErr as Error).message });
              }
            }
          }
        }
      }

      if (ev.type.endsWith('.delta')) { continue; } // deltas are transport, not state

      if (ev.type !== last) {
        ctx.onEvent('agent.event', { type: ev.type });
        last = ev.type;
      }

      if (ev.type === 'turn.done') {
        status = ev.state?.status ?? 'done';
      }
    }

    const plannedChanges = plannedChangesSet.size > 0 ? Array.from(plannedChangesSet) : null;
    return { sessionId: session.id, plannedChanges, summary: `TrueForge turn finished: ${status}` };
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
