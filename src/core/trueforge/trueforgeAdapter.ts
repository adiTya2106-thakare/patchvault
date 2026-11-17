import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, AgentRunContext, AgentRunResult } from './trueforgeTypes';
import { resolveInside } from '../../security/pathValidator';
import { EditorTools } from '../tools/editorTools';

export class IntegrationNotVerifiedError extends Error {}

export interface TrueForgeConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fallbackBaseUrl?: string;
  fallbackModel?: string;
  fallbackApiKey?: string;
  instructions?: string;
  syncRemoteEdits?: boolean;
}

interface TfClient {
  sessions: {
    create(a: unknown): Promise<{ data: { id: string } }>;
    createTurnStream(id: string, a: unknown, opts?: { abortSignal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
    downloadSandboxFile?(sessionId: string, turnId: string, req: { path: string }): Promise<unknown>;
  };
}

export class TrueForgeAdapter implements AgentAdapter {
  readonly name = 'TrueForge';
  readonly isMock = false;

  constructor(private readonly cfg: TrueForgeConfig) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    if (!this.cfg.model.trim()) {
      throw new IntegrationNotVerifiedError('Set the "patchvault.trueforgeModel" setting first (a model configured in your TrueForge Settings).');
    }

    // Attempt run on primary model; if unreachable/invalid, trigger resilience fallback
    try {
      return await this.executeTurn(this.cfg.baseUrl, this.cfg.model, this.cfg.apiKey, ctx, false);
    } catch (primaryErr) {
      const err = primaryErr as Error;
      const isConnectionOrAuthError =
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('fetch failed') ||
        err.message.includes('401') ||
        err.message.includes('403') ||
        err.message.includes('unreachable') ||
        err.message.includes('invalid') ||
        err.message.includes('Failed to fetch') ||
        err.message.includes('ENOTFOUND');

      if (isConnectionOrAuthError && (this.cfg.fallbackModel || this.cfg.fallbackBaseUrl)) {
        const fbBase = this.cfg.fallbackBaseUrl || this.cfg.baseUrl;
        const fbModel = this.cfg.fallbackModel || this.cfg.model;
        const fbKey = this.cfg.fallbackApiKey || this.cfg.apiKey;

        ctx.onEvent('agent.resilience.fallback', {
          primaryError: err.message.slice(0, 150),
          fallbackModel: fbModel,
          fallbackBaseUrl: fbBase,
        });

        if (ctx.onToken) {
          ctx.onToken(`\n[Resilience Mode Activated] Primary model (${this.cfg.model}) failed (${err.message.slice(0, 60)}).\nAutomatically switched to fallback model: ${fbModel}...\n\n`);
        }

        const res = await this.executeTurn(fbBase, fbModel, fbKey, ctx, true);
        res.fallbackUsed = true;
        res.fallbackModel = fbModel;
        return res;
      }

      // If no fallback available or other error, rethrow cleanly
      throw primaryErr;
    }
  }

  private async executeTurn(
    baseUrl: string,
    model: string,
    apiKey: string | undefined,
    ctx: AgentRunContext,
    isFallback: boolean
  ): Promise<AgentRunResult> {
    let sdk: { TrueForge?: new (o: unknown) => TfClient };
    try {
      const load = new Function('n', 'return import(n)') as (n: string) => Promise<typeof sdk>;
      sdk = await load('@truefoundry/trueforge-sdk');
    } catch (e) {
      throw new IntegrationNotVerifiedError(`Could not load @truefoundry/trueforge-sdk (${(e as Error).message.slice(0, 200)}). Run "npm install" in the extension folder.`);
    }

    if (typeof sdk.TrueForge !== 'function') {
      throw new IntegrationNotVerifiedError('Installed SDK has no TrueForge export; its API differs from the documented quickstart.');
    }

    const clientOpts: Record<string, unknown> = { baseUrl, timeoutInSeconds: 600 };
    if (apiKey) {
      clientOpts.apiKey = apiKey;
      clientOpts.token = apiKey;
    }

    const client = new sdk.TrueForge(clientOpts);
    const tools = new EditorTools(ctx.workspaceRoot);

    const { data: session } = await client.sessions.create({
      agent: {
        spec: {
          model: { name: model },
          instructions: this.cfg.instructions ?? 'You are an autonomous coding agent in a VS Code workspace. Use tools to read files, search codebase, propose edits, and run commands. Multi-file changes must touch at least 3 files.',
          tools: tools.getToolDefinitions(),
        },
      },
    });

    ctx.onEvent('agent.session.started', {
      adapter: this.name,
      sessionId: session.id,
      model,
      baseUrl,
      fallback: isFallback,
      mock: false
    });

    if (ctx.abortSignal?.aborted) {
      return { sessionId: session.id, plannedChanges: null, summary: 'Run cancelled by user before turn started.', cancelled: true };
    }

    const stream = await client.sessions.createTurnStream(
      session.id,
      { input: [{ type: 'user.message', content: ctx.prompt }] },
      { abortSignal: ctx.abortSignal }
    );

    let status = 'unknown';
    let last = '';
    let currentTurnId: string | null = null;
    const plannedChangesSet = new Set<string>();

    for await (const item of stream) {
      if (ctx.abortSignal?.aborted) {
        ctx.onEvent('agent.cancelled', { sessionId: session.id });
        return {
          sessionId: session.id,
          plannedChanges: Array.from(plannedChangesSet),
          summary: 'Agent run cancelled by user mid-flight. Workspace remained untouched.',
          cancelled: true
        };
      }

      const w = item as {
        data?: {
          type?: string;
          turnId?: string;
          delta?: { text?: string };
          state?: { status?: string };
          toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
        type?: string;
        turnId?: string;
        delta?: { text?: string };
        state?: { status?: string };
        toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };

      const ev = (w.data && typeof w.data.type === 'string' ? w.data : w) as {
        type?: string;
        turnId?: string;
        delta?: { text?: string };
        state?: { status?: string };
        toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };

      if (!ev || typeof ev.type !== 'string') continue;

      if (ev.turnId && !currentTurnId) {
        currentTurnId = ev.turnId;
      }

      // Stream delta tokens to UI for immediate responsiveness
      if (ev.delta?.text && ctx.onToken) {
        ctx.onToken(ev.delta.text);
      }

      // Tool calls inspection
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

            // If proposal or sync remote edits, stage content safely
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
          } else {
            ctx.onEvent('agent.tool.call', { tool: fnName });
          }

          // Execute read/search/command tools locally if requested
          if (['read_file', 'search_workspace', 'run_terminal_command', 'list_files'].includes(fnName)) {
            const toolResult = await tools.executeTool(fnName, args);
            ctx.onEvent('agent.tool.executed', {
              tool: fnName,
              success: toolResult.success,
              resultBytes: toolResult.result ? toolResult.result.length : 0
            });
          }
        }
      }

      if (ev.type.endsWith('.delta')) continue;

      if (ev.type !== last) {
        ctx.onEvent('agent.event', { type: ev.type });
        last = ev.type;
      }

      if (ev.type === 'turn.done') {
        status = ev.state?.status ?? 'done';
      }
    }

    const plannedChanges = plannedChangesSet.size > 0 ? Array.from(plannedChangesSet) : null;
    return {
      sessionId: session.id,
      plannedChanges,
      summary: `TrueForge turn finished on ${model}: ${status}`,
    };
  }
}

export interface ScriptedEdit { path: string; content: string | null }

/** CLEARLY A MOCK. Applies scripted edits so PATCHVAULT can be developed and demoed offline. */
export class MockAgentAdapter implements AgentAdapter {
  readonly name = 'MOCK (not TrueFoundry)';
  readonly isMock = true;

  constructor(private readonly edits: ScriptedEdit[], opts: { iUnderstandThisIsAMock: true }) {
    if (!opts || opts.iUnderstandThisIsAMock !== true) {
      throw new Error('Mock adapter must be opted into explicitly');
    }
  }

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    ctx.onEvent('agent.session.started', { adapter: this.name, mock: true });

    if (ctx.onToken) {
      ctx.onToken('[Mock Simulation Started] Generating changes...\n');
    }

    if (ctx.abortSignal?.aborted) {
      return { sessionId: 'mock-cancelled', plannedChanges: null, summary: 'Run cancelled by user.', cancelled: true };
    }

    for (const e of this.edits) {
      if (ctx.abortSignal?.aborted) {
        return { sessionId: 'mock-cancelled', plannedChanges: null, summary: 'Run cancelled by user.', cancelled: true };
      }
      const abs = resolveInside(ctx.workspaceRoot, e.path);
      if (e.content === null) {
        fs.rmSync(abs, { force: true });
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, e.content);
      }
      ctx.onEvent('agent.file.modified', { path: e.path, mock: true });
      if (ctx.onToken) {
        ctx.onToken(` - Proposing edit for: ${e.path}\n`);
      }
    }

    return {
      sessionId: 'mock-session',
      plannedChanges: this.edits.map(e => e.path),
      summary: 'Simulated agent run completed safely.'
    };
  }
}
