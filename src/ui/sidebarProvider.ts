import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Capsule } from '../core/capsule/types';
import { CapsuleManager } from '../core/capsule/capsuleManager';
import { setReview, setHunkReview, readOriginal } from '../core/diff/diffReviewManager';
import { recover, rejectChange, rejectHunk } from '../core/git/recoveryManager';
import { runTests } from '../core/runner/testRunner';
import { record } from '../core/recorder/flightRecorder';
import { MockAgentAdapter, TrueForgeAdapter } from '../core/trueforge/trueforgeAdapter';
import { CredentialManager } from '../security/credentialManager';
import { resolveInside } from '../security/pathValidator';

type Msg = {
  type: string;
  title?: string;
  prompt?: string;
  path?: string;
  id?: string;
  hunkId?: string;
  apiKey?: string;
};

export const KNOWN_WEBVIEW_MESSAGES = new Set([
  'ready',
  'createCapsule',
  'runMockAgent',
  'runAgent',
  'scan',
  'approve',
  'reject',
  'approveHunk',
  'rejectHunk',
  'openDiff',
  'runTests',
  'recoverAll',
  'select',
  'setApiKey',
  'clearApiKey',
]);

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private current?: Capsule;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly mgr: CapsuleManager,
    private readonly credentials?: CredentialManager
  ) {}

  private root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('hex');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));

    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>PATCHVAULT</title></head><body>
<header>
  <h1>PATCHVAULT</h1>
  <div class="subtitle">Recovery Flight Recorder for AI Code Changes</div>
</header>
<section aria-label="Agent Integration">
  <h2>Agent Integration</h2>
  <div id="tf"></div>
</section>
<section aria-label="New Task">
  <h2>New Task</h2>
  <input id="title" placeholder="Task title (e.g. Implement user auth)" aria-label="Task title">
  <textarea id="prompt" rows="3" placeholder="What should the agent do?" aria-label="Task prompt"></textarea>
  <div class="button-group">
    <button data-act="create" class="primary">Create Capsule</button>
    <button data-act="runAgent" class="primary">Run TrueForge Agent</button>
    <button data-act="demo" class="secondary">Run MOCK Agent (Demo)</button>
  </div>
</section>
<div id="status" role="status" class="status-box"></div>
<section aria-label="Current Capsule">
  <h2>Current Capsule</h2>
  <div id="cur"></div>
</section>
<section aria-label="Capsule History">
  <h2>History</h2>
  <ul id="hist" class="history-list"></ul>
</section>
<script nonce="${nonce}" src="${js}"></script></body></html>`;

    view.webview.onDidReceiveMessage((m: unknown) => void this.handle(m));
  }

  refreshView(): void {
    this.push();
  }

  private post(m: unknown): void {
    void this.view?.webview.postMessage(m);
  }

  async handle(raw: unknown): Promise<boolean> {
    // Untrusted input from webview: validate shape before acting.
    const m = raw as Msg;
    if (!m || typeof m.type !== 'string' || !KNOWN_WEBVIEW_MESSAGES.has(m.type)) {
      return false;
    }
    for (const k of ['title', 'prompt', 'path', 'id', 'hunkId', 'apiKey'] as const) {
      if (m[k] !== undefined && typeof m[k] !== 'string') {
        return false;
      }
    }
    try {
      await this.dispatch(m);
      return true;
    } catch (e) {
      this.post({ type: 'error', text: (e as Error).message });
      return false;
    }
  }

  private async dispatch(m: Msg): Promise<void> {
    const root = this.root();
    if (!root) { throw new Error('Open a folder in VS Code first.'); }
    const c = this.current;

    switch (m.type) {
      case 'ready':
        await this.restoreLast();
        return;

      case 'createCapsule': {
        if (!m.title?.trim() || !m.prompt?.trim()) {
          throw new Error('Title and prompt are required.');
        }
        this.post({ type: 'busy', text: 'Capturing workspace checkpoint…' });
        this.current = await this.mgr.create(root, m.title.trim().slice(0, 120), m.prompt.slice(0, 20000));
        this.push('Checkpoint captured. Ready for agent run or manual edits.');
        return;
      }

      case 'runAgent': {
        if (!c) { throw new Error('Create a capsule first.'); }
        const cfg = vscode.workspace.getConfiguration('patchvault');
        const apiKey = this.credentials ? await this.credentials.getApiKey() : undefined;
        const ad = new TrueForgeAdapter({
          baseUrl: cfg.get<string>('trueforgeBaseUrl', 'http://localhost:8790'),
          model: cfg.get<string>('trueforgeModel', ''),
          apiKey,
          syncRemoteEdits: cfg.get<boolean>('syncRemoteEdits', false),
        });

        c.agentSession = { adapter: ad.name, sessionId: null, mock: false };
        c.status = 'running';
        this.post({ type: 'busy', text: 'TrueForge agent running turn…' });

        try {
          const res = await ad.run({
            workspaceRoot: root,
            prompt: c.prompt,
            onEvent: (t, meta) => record(c, t, meta),
          });
          c.agentSession.sessionId = res.sessionId;
          c.plannedChanges = res.plannedChanges;
          record(c, 'agent.finished', { summary: res.summary });
        } catch (e) {
          c.status = 'failed';
          record(c, 'agent.failed', { error: (e as Error).message.slice(0, 200) });
          this.mgr.save(c);
          throw e;
        }

        c.status = 'review';
        await this.mgr.refresh(root, c);
        this.push('TrueForge turn finished. Workspace scanned against checkpoint.');
        return;
      }

      case 'runMockAgent': {
        if (!c) { throw new Error('Create a capsule first.'); }
        const ad = new MockAgentAdapter([
          { path: 'patchvault-demo/hello.txt', content: 'Written by the MOCK agent\n' },
          { path: 'patchvault-demo/notes.txt', content: 'Also written by the MOCK agent\n' },
        ], { iUnderstandThisIsAMock: true });

        c.agentSession = { adapter: ad.name, sessionId: null, mock: true };
        const res = await ad.run({
          workspaceRoot: root,
          prompt: c.prompt,
          onEvent: (t, meta) => record(c, t, meta),
        });
        c.agentSession.sessionId = res.sessionId;
        c.plannedChanges = res.plannedChanges;
        c.status = 'review';
        await this.mgr.refresh(root, c);
        this.push('MOCK agent finished (simulated offline). Changes detected.');
        return;
      }

      case 'scan': {
        if (!c) { throw new Error('No active capsule to scan.'); }
        this.post({ type: 'busy', text: 'Scanning workspace changes…' });
        await this.mgr.refresh(root, c);
        c.status = 'review';
        break;
      }

      case 'approve': {
        if (!c || !m.path) { throw new Error('No capsule or path specified.'); }
        setReview(c, m.path, 'approved');
        this.mgr.save(c);
        break;
      }

      case 'reject': {
        if (!c || !m.path) { throw new Error('No capsule or path specified.'); }
        const ok = await vscode.window.showWarningMessage(
          `Restore ${m.path} to its original checkpoint content?`,
          { modal: true },
          'Restore'
        );
        if (ok !== 'Restore') { break; }
        const out = rejectChange(root, c, this.mgr.storage, m.path);
        this.mgr.save(c);
        if (out.refused) {
          throw new Error('Not restored (conflict): ' + out.conflicts.join('; '));
        }
        break;
      }

      case 'approveHunk': {
        if (!c || !m.path || !m.hunkId) { throw new Error('Missing capsule, path, or hunkId.'); }
        setHunkReview(c, m.path, m.hunkId, 'approved');
        this.mgr.save(c);
        break;
      }

      case 'rejectHunk': {
        if (!c || !m.path || !m.hunkId) { throw new Error('Missing capsule, path, or hunkId.'); }
        const ok = await vscode.window.showWarningMessage(
          `Restore hunk ${m.hunkId} in ${m.path} to original content?`,
          { modal: true },
          'Restore Hunk'
        );
        if (ok !== 'Restore Hunk') { break; }
        const out = rejectHunk(root, c, this.mgr.storage, m.path, m.hunkId);
        this.mgr.save(c);
        if (out.refused) {
          throw new Error('Hunk not restored (conflict): ' + out.conflicts.join('; '));
        }
        break;
      }

      case 'recoverAll': {
        if (!c) { throw new Error('No capsule to recover.'); }
        const ok = await vscode.window.showWarningMessage(
          `Restore ALL ${c.changes.length} changed file(s) to original checkpoint state?`,
          { modal: true },
          'Restore All'
        );
        if (ok !== 'Restore All') { break; }
        const out = recover(root, c, this.mgr.storage, 'all');
        this.mgr.save(c);
        if (out.refused) {
          throw new Error('Recovery stopped, nothing changed. Conflicts: ' + out.conflicts.join('; '));
        }
        break;
      }

      case 'runTests': {
        if (!c) { throw new Error('No active capsule.'); }
        const cmd = vscode.workspace.getConfiguration('patchvault').get<string>('testCommand', 'npm test');
        record(c, 'verification.started', { command: cmd });
        this.post({ type: 'busy', text: `Running verification tests (${cmd})…` });
        const run = await runTests(root, cmd);
        c.tests.push(run);
        record(c, 'verification.completed', { outcome: run.outcome, exitCode: run.exitCode });
        this.mgr.save(c);
        break;
      }

      case 'openDiff': {
        if (!c || !m.path) { throw new Error('No capsule or file specified.'); }
        const orig = readOriginal(c, this.mgr.storage, m.path);
        const tmpDir = path.join(this.ctx.globalStorageUri.fsPath, 'diff-tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const left = path.join(tmpDir, `${c.id}-${path.basename(m.path)}`);
        fs.writeFileSync(left, orig ?? Buffer.alloc(0));
        const right = resolveInside(root, m.path);
        await vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.file(left),
          vscode.Uri.file(right),
          `${m.path} (Original ↔ Current)`
        );
        return;
      }

      case 'select': {
        const r = m.id ? this.mgr.storage.load(m.id) : undefined;
        if (!r || !r.ok) { throw new Error('Capsule could not be loaded.'); }
        this.current = r.capsule;
        break;
      }

      case 'setApiKey': {
        if (this.credentials) {
          await vscode.commands.executeCommand('patchvault.setApiKey');
        }
        return;
      }

      case 'clearApiKey': {
        if (this.credentials) {
          await vscode.commands.executeCommand('patchvault.clearApiKey');
        }
        return;
      }
    }
    this.push();
  }

  private async restoreLast(): Promise<void> {
    if (!this.current) {
      this.current = this.mgr.storage.list().loaded[0];
    }
    this.push();
  }

  private async push(notice = ''): Promise<void> {
    const c = this.current;
    const history = this.mgr.storage.list();
    const cfg = vscode.workspace.getConfiguration('patchvault');
    const model = cfg.get<string>('trueforgeModel', '') || 'None configured';
    const baseUrl = cfg.get<string>('trueforgeBaseUrl', 'http://localhost:8790');
    const hasKey = this.credentials ? await this.credentials.hasApiKey() : false;

    this.post({
      type: 'state',
      notice: notice || (history.skipped.length ? `${history.skipped.length} unreadable capsule(s) skipped.` : ''),
      integration: {
        name: 'TrueFoundry (TrueForge)',
        mock: false,
        model,
        baseUrl,
        hasApiKey: hasKey,
        note: model !== 'None configured'
          ? `Adapter: ${model} @ ${baseUrl}`
          : 'Set "patchvault.trueforgeModel" in Settings or use MOCK agent for demo.',
      },
      history: history.loaded.map(h => ({
        id: h.id,
        title: h.title,
        status: h.status,
        mock: h.agentSession?.mock ?? false,
        createdAt: h.createdAt,
      })),
      current: c ? {
        ...c,
        manifest: c.manifest.length,
        recovery: this.mgr.recoveryState(c),
      } : null,
    });
  }
}
