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
import { ContextEngine, RetrievedFile } from '../core/context/contextEngine';

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
  'cancel',
  'inlineEdit',
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
  private activeAbortCtrl?: AbortController;

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
  <div class="subtitle">Autonomous AI Agent Harness &amp; Diff Flight Recorder</div>
</header>
<section aria-label="Agent Integration">
  <h2>TrueForge Agent Harness</h2>
  <div id="tf"></div>
</section>
<section aria-label="New Task">
  <h2>Task &amp; Context Controller</h2>
  <input id="title" placeholder="Task title (e.g. Add flask config CLI command)" aria-label="Task title">
  <textarea id="prompt" rows="3" placeholder="Instruct agent (supports @file and @symbol, or leave unprompted for automatic retrieval)..." aria-label="Task prompt"></textarea>
  <div class="button-group">
    <button data-act="create" class="secondary">1. Capture Checkpoint</button>
    <button data-act="runAgent" class="primary">2. Run Agent Mode</button>
    <button data-act="inlineEdit" class="secondary">Inline Edit (Ctrl+K)</button>
    <button data-act="demo" class="secondary">Run MOCK Agent (Demo)</button>
  </div>
</section>
<div id="status" role="status" class="status-box"></div>
<section aria-label="Current Capsule">
  <h2>Flight Recorder &amp; Diff Review</h2>
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

  cancelActiveRun(): void {
    if (this.activeAbortCtrl) {
      this.activeAbortCtrl.abort();
      this.post({ type: 'busy', text: 'Cancelling TrueForge agent run mid-flight...' });
      if (this.current) {
        record(this.current, 'agent.cancelled', { reason: 'User invoked cancel' });
        this.current.status = 'review';
        this.mgr.save(this.current);
      }
      this.push('Run cancelled. Workspace stayed consistent with zero half-applied edits.');
    }
  }

  private post(m: unknown): void {
    void this.view?.webview.postMessage(m);
  }

  async handle(raw: unknown): Promise<boolean> {
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

      case 'cancel': {
        this.cancelActiveRun();
        return;
      }

      case 'inlineEdit': {
        await vscode.commands.executeCommand('patchvault.inlineEdit');
        return;
      }

      case 'runAgent': {
        // If capsule doesn't exist, create one automatically
        let capsule = c;
        if (!capsule) {
          const title = m.title?.trim() || 'Agent Mode Task';
          const prompt = m.prompt?.trim() || 'Agent Mode execution';
          this.current = await this.mgr.create(root, title, prompt);
          capsule = this.current;
        }

        const cfg = vscode.workspace.getConfiguration('patchvault');
        const apiKey = this.credentials ? await this.credentials.getApiKey() : undefined;

        // Context Assembly with size budget
        const contextEngine = new ContextEngine();
        const assembled = await contextEngine.assembleContext(root, capsule.prompt, {
          budgetChars: cfg.get<number>('contextBudgetTokens', 4000) * 4,
        });

        record(capsule, 'context.assembled', {
          budgetChars: assembled.budgetChars,
          totalChars: assembled.totalChars,
          retrievedFiles: assembled.retrievedFiles.map((f: RetrievedFile) => f.path).join(','),
        });

        const ad = new TrueForgeAdapter({
          baseUrl: cfg.get<string>('trueforgeBaseUrl', 'http://localhost:8790'),
          model: cfg.get<string>('trueforgeModel', ''),
          apiKey,
          fallbackBaseUrl: cfg.get<string>('trueforgeFallbackBaseUrl', 'http://localhost:8790'),
          fallbackModel: cfg.get<string>('trueforgeFallbackModel', 'gemini-2.5-flash'),
          fallbackApiKey: apiKey,
          syncRemoteEdits: cfg.get<boolean>('syncRemoteEdits', false),
        });

        capsule.agentSession = { adapter: ad.name, sessionId: null, mock: false };
        capsule.status = 'running';
        this.activeAbortCtrl = new AbortController();

        this.post({
          type: 'busy',
          text: 'TrueForge agent running turn…',
          canCancel: true,
          contextSummary: assembled.rationale,
        });

        try {
          const res = await ad.run({
            workspaceRoot: root,
            prompt: capsule.prompt,
            abortSignal: this.activeAbortCtrl.signal,
            onToken: (tok) => this.post({ type: 'streamToken', token: tok }),
            onEvent: (t, meta) => record(capsule!, t, meta),
          });

          this.activeAbortCtrl = undefined;
          capsule.agentSession.sessionId = res.sessionId;
          capsule.plannedChanges = res.plannedChanges;
          record(capsule, 'agent.finished', { summary: res.summary });

          if (res.fallbackUsed) {
            record(capsule, 'resilience.fallback_used', { fallbackModel: res.fallbackModel || '' });
          }
        } catch (e) {
          this.activeAbortCtrl = undefined;
          capsule.status = 'failed';
          record(capsule, 'agent.failed', { error: (e as Error).message.slice(0, 200) });
          this.mgr.save(capsule);
          throw e;
        }

        capsule.status = 'review';
        await this.mgr.refresh(root, capsule);
        this.push('TrueForge turn finished. Workspace scanned against checkpoint.');
        return;
      }

      case 'runMockAgent': {
        if (!c) { throw new Error('Create a capsule first.'); }
        // Task B multi-file demonstration support in mock mode
        const ad = new MockAgentAdapter([
          {
            path: 'src/flask/cli.py',
            content: '# Added flask config built-in CLI command\nimport click\nimport json\n\n@click.command("config")\n@click.pass_context\ndef config_command(ctx):\n    """Print the application configuration as JSON, masking secrets."""\n    click.echo(json.dumps({"DEBUG": True, "SECRET_KEY": "***", "TOKEN": "***"}))\n'
          },
          {
            path: 'tests/test_cli.py',
            content: '# Added test_config_command\ndef test_config_command(runner, app):\n    result = runner.invoke(args=["config"])\n    assert result.exit_code == 0\n    assert "***" in result.output\n'
          },
          {
            path: 'docs/cli.rst',
            content: 'CLI Documentation\n-----------------\nBuilt-in Commands:\n- ``flask run``\n- ``flask shell``\n- ``flask routes``\n- ``flask config``: Print configuration as JSON with masked secrets.\n'
          }
        ], { iUnderstandThisIsAMock: true });

        c.agentSession = { adapter: ad.name, sessionId: null, mock: true };
        this.activeAbortCtrl = new AbortController();
        const res = await ad.run({
          workspaceRoot: root,
          prompt: c.prompt,
          abortSignal: this.activeAbortCtrl.signal,
          onToken: (tok) => this.post({ type: 'streamToken', token: tok }),
          onEvent: (t, meta) => record(c, t, meta),
        });
        this.activeAbortCtrl = undefined;
        c.agentSession.sessionId = res.sessionId;
        c.plannedChanges = res.plannedChanges;
        c.status = 'review';
        await this.mgr.refresh(root, c);
        this.push('MOCK multi-file agent finished (touched 3 files unprompted). Review hunks below.');
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
    const fallbackModel = cfg.get<string>('trueforgeFallbackModel', 'gemini-2.5-flash');
    const baseUrl = cfg.get<string>('trueforgeBaseUrl', 'http://localhost:8790');
    const hasKey = this.credentials ? await this.credentials.hasApiKey() : false;

    this.post({
      type: 'state',
      notice: notice || (history.skipped.length ? `${history.skipped.length} unreadable capsule(s) skipped.` : ''),
      integration: {
        name: 'TrueFoundry (TrueForge)',
        mock: false,
        model,
        fallbackModel,
        baseUrl,
        hasApiKey: hasKey,
        note: model !== 'None configured'
          ? `Primary: ${model} | Fallback: ${fallbackModel}`
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
