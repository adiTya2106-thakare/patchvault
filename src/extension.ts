import * as vscode from 'vscode';
import * as path from 'node:path';
import { CapsuleStorage } from './core/capsule/capsuleStorage';
import { CapsuleManager } from './core/capsule/capsuleManager';
import { SidebarProvider } from './ui/sidebarProvider';

export function activate(ctx: vscode.ExtensionContext): void {
  const storage = new CapsuleStorage(path.join(ctx.globalStorageUri.fsPath, 'patchvault'));
  const provider = new SidebarProvider(ctx, new CapsuleManager(storage));
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('patchvault.sidebar', provider));
}

export function deactivate(): void { /* nothing to clean up */ }
