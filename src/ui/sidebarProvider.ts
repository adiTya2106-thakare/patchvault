import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Capsule } from '../core/capsule/types';
import { CapsuleManager } from '../core/capsule/capsuleManager';
import { setReview, readOriginal } from '../core/diff/diffReviewManager';
import { recover, rejectChange } from '../core/git/recoveryManager';
import { runTests } from '../core/runner/testRunner';
import { record } from '../core/recorder/flightRecorder';
import { MockAgentAdapter, TrueForgeAdapter } from '../core/trueforge/trueforgeAdapter';
import { resolveInside } from '../security/pathValidator';

type Msg = { type: string; title?: string; prompt?: string; path?: string; id?: string };
const KNOWN = new Set(['ready', 'createCapsule', 'runMockAgent', 'scan', 'approve', 'reject', 'openDiff', 'runTests', 'recoverAll', 'select']);

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private current?: Capsule;
  constructor(private readonly ctx: vscode.ExtensionContext, private readonly mgr: CapsuleManager) {}

  private root(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('hex');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<h1>PATCHVAULT</h1><div class="muted">Recovery Flight Recorder</div>
<h2>Agent integration</h2><div id="tf"></div>
<h2>New task</h2>
<input id="title" placeholder="Task title" aria-label="Task title"><textarea id="prompt" rows="3" placeholder="What should the agent do?" aria-label="Task prompt"></textarea>
<button data-act="create">Create capsule (checkpoint)</button><button data-act="demo" class="secondary">Run MOCK agent (demo)</button>
<div id="status" role="status" class="muted"></div>
<h2>Current capsule</h2><div id="cur"></div>
<h2>History</h2><ul id="hist" style="list-style:none;padding:0"></ul>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: unknown) => void this.handle(m));
  }

  private post(m: unknown): void { void this.view?.webview.postMessage(m); }

  private async handle(raw: unknown): Promise<void> {
    // The webview is untrusted input: validate shape before acting.
    const m = raw as Msg;
    if (!m || typeof m.type !== 'string' || !KNOWN.has(m.type)) { return; }
    for (const k of ['title', 'prompt', 'path', 'id'] as const) { if (m[k] !== undefined && typeof m[k] !== 'string') { return; } }
    try { await this.dispatch(m); } catch (e) { this.post({ type: 'error', text: (e as Error).message }); }
  }

  private async dispatch(m: Msg): Promise<void> {
    const root = this.root();
    if (!root) { throw new Error('Open a folder first.'); }
    const c = this.current;
    switch (m.type) {
      case 'ready': await this.restoreLast(); return;
      case 'createCapsule': {
        if (!m.title?.trim() || !m.prompt?.trim()) { throw new Error('Title and prompt are required.'); }
        this.post({ type: 'busy', text: 'Capturing checkpoint…' });
        this.current = await this.mgr.create(root, m.title.trim().slice(0, 120), m.prompt.slice(0, 20000));
        try { await new TrueForgeAdapter().run({ workspaceRoot: root, prompt: m.prompt, onEvent: () => undefined }); }
        catch (e) { this.push(`Checkpoint ready. ${(e as Error).message} Make the edits with your own agent/editor, then press "Scan changes".`); return; }
        break;
      }
      case 'runMockAgent': {
        if (!c) { throw new Error('Create a capsule first.'); }
        const ad = new MockAgentAdapter([
          { path: 'patchvault-demo/hello.txt', content: 'Written by the MOCK agent\n' },
          { path: 'patchvault-demo/notes.txt', content: 'Also written by the MOCK agent\n' }], { iUnderstandThisIsAMock: true });
        c.agentSession = { adapter: ad.name, sessionId: null, mock: true };
        const res = await ad.run({ workspaceRoot: root, prompt: c.prompt, onEvent: (t, meta) => record(c, t, meta) });
        c.agentSession.sessionId = res.sessionId; c.plannedChanges = res.plannedChanges; c.status = 'review';
        await this.mgr.refresh(root, c); this.push('MOCK agent finished (simulated, not TrueFoundry).'); return;
      }
      case 'scan': if (!c) { throw new Error('No capsule.'); } await this.mgr.refresh(root, c); c.status = 'review'; break;
      case 'approve': if (!c || !m.path) { throw new Error('No capsule.'); } setReview(c, m.path, 'approved'); this.mgr.save(c); break;
      case 'reject': {
        if (!c || !m.path) { throw new Error('No capsule.'); }
        const ok = await vscode.window.showWarningMessage(`Restore ${m.path} to its original content?`, { modal: true }, 'Restore');
        if (ok !== 'Restore') { break; }
        const out = rejectChange(root, c, this.mgr.storage, m.path); this.mgr.save(c);
        if (out.refused) { throw new Error('Not restored (conflict): ' + out.conflicts.join('; ')); }
        break;
      }
      case 'recoverAll': {
        if (!c) { throw new Error('No capsule.'); }
        const ok = await vscode.window.showWarningMessage(`Restore ALL ${c.changes.length} changed file(s) to their original state?`, { modal: true }, 'Restore all');
        if (ok !== 'Restore all') { break; }
        const out = recover(root, c, this.mgr.storage, 'all'); this.mgr.save(c);
        if (out.refused) { throw new Error('Recovery stopped, nothing was changed. Conflicts: ' + out.conflicts.join('; ')); }
        break;
      }
      case 'runTests': {
        if (!c) { throw new Error('No capsule.'); }
        const cmd = vscode.workspace.getConfiguration('patchvault').get<string>('testCommand', 'npm test');
        record(c, 'verification.started', { command: cmd }); this.post({ type: 'busy', text: 'Running tests…' });
        const run = await runTests(root, cmd); c.tests.push(run);
        record(c, 'verification.completed', { outcome: run.outcome, exitCode: run.exitCode }); this.mgr.save(c); break;
      }
      case 'openDiff': {
        if (!c || !m.path) { throw new Error('No capsule.'); }
        const orig = readOriginal(c, this.mgr.storage, m.path);
        const tmpDir = path.join(this.ctx.globalStorageUri.fsPath, 'diff-tmp'); fs.mkdirSync(tmpDir, { recursive: true });
        const left = path.join(tmpDir, `${c.id}-${path.basename(m.path)}`); fs.writeFileSync(left, orig ?? Buffer.alloc(0));
        const right = resolveInside(root, m.path);
        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(left), vscode.Uri.file(right), `${m.path} (original ↔ current)`);
        return;
      }
      case 'select': {
        const r = m.id ? this.mgr.storage.load(m.id) : undefined;
        if (!r || !r.ok) { throw new Error('Capsule could not be loaded.'); }
        this.current = r.capsule; break;
      }
    }
    this.push();
  }

  private async restoreLast(): Promise<void> {
    if (!this.current) { this.current = this.mgr.storage.list().loaded[0]; }
    this.push();
  }

  private push(notice = ''): void {
    const c = this.current;
    const history = this.mgr.storage.list();
    this.post({
      type: 'state', notice: notice || (history.skipped.length ? `${history.skipped.length} unreadable capsule(s) skipped.` : ''),
      integration: { name: 'TrueFoundry (TrueForge)', mock: false, note: 'Real SDK adapter not implemented yet — see README. Mock available for demo.' },
      history: history.loaded.map(h => ({ id: h.id, title: h.title, status: h.status })),
      current: c ? { ...c, manifest: c.manifest.length, recovery: this.mgr.recoveryState(c) } : null,
    });
  }
}
