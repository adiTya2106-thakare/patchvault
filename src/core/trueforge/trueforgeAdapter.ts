import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, AgentRunContext, AgentRunResult } from './trueforgeTypes';
import { resolveInside } from '../../security/pathValidator';

export class IntegrationNotVerifiedError extends Error {}

/** REAL integration placeholder.
 *  TrueForge (open source, @truefoundry/trueforge-sdk) was found in public docs, but the exact SDK call
 *  signatures and the way file edits are surfaced have NOT been verified against the installed package.
 *  Until they are, this adapter refuses to run instead of faking success. */
export class TrueForgeAdapter implements AgentAdapter {
  readonly name = 'TrueForge';
  readonly isMock = false;
  async run(_ctx: AgentRunContext): Promise<AgentRunResult> {
    throw new IntegrationNotVerifiedError(
      'TrueForge SDK integration is not implemented yet: SDK methods were not verified against the installed package.');
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
