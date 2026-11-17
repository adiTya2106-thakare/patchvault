import * as vscode from 'vscode';
import * as path from 'node:path';
import { CapsuleStorage } from './core/capsule/capsuleStorage';
import { CapsuleManager } from './core/capsule/capsuleManager';
import { CredentialManager } from './security/credentialManager';
import { SidebarProvider } from './ui/sidebarProvider';
import { InlineEditProvider } from './core/inline/inlineEditProvider';

export function activate(ctx: vscode.ExtensionContext): void {
  const storage = new CapsuleStorage(path.join(ctx.globalStorageUri.fsPath, 'patchvault'));
  const mgr = new CapsuleManager(storage);
  const credentials = new CredentialManager(ctx.secrets);
  const provider = new SidebarProvider(ctx, mgr, credentials);
  const inlineEditProvider = new InlineEditProvider(ctx, mgr, credentials);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('patchvault.sidebar', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    // Capability 1: Inline edit with keybinding
    vscode.commands.registerCommand('patchvault.inlineEdit', async () => {
      await inlineEditProvider.triggerInlineEdit();
    }),

    // Capability 4 & 5: Revert & Safe Undo
    vscode.commands.registerCommand('patchvault.undoLastChange', async () => {
      await inlineEditProvider.undoLastChange();
    }),

    // Capability 5: Immediate cancellation
    vscode.commands.registerCommand('patchvault.cancelRun', () => {
      provider.cancelActiveRun();
      vscode.window.showInformationMessage('PATCHVAULT: Generation cancelled. Workspace remained consistent.');
    }),

    vscode.commands.registerCommand('patchvault.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'PATCHVAULT: TrueForge API Key',
        prompt: 'Enter your TrueForge API key or token (stored securely in OS keychain)',
        password: true,
      });
      if (key !== undefined) {
        await credentials.setApiKey(key);
        vscode.window.showInformationMessage('TrueForge API Key saved securely to SecretStorage.');
        provider.refreshView();
      }
    }),

    vscode.commands.registerCommand('patchvault.clearApiKey', async () => {
      await credentials.deleteApiKey();
      vscode.window.showInformationMessage('TrueForge API Key removed from SecretStorage.');
      provider.refreshView();
    })
  );
}

export function deactivate(): void { /* nothing to clean up */ }
