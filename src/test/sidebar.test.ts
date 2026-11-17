import './mockVscode';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SidebarProvider, KNOWN_WEBVIEW_MESSAGES } from '../ui/sidebarProvider';
import { CapsuleManager } from '../core/capsule/capsuleManager';
import { CapsuleStorage } from '../core/capsule/capsuleStorage';
import { CredentialManager } from '../security/credentialManager';
import { tmp } from './helpers';

class MockSecretStorage {
  private storageMap = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.storageMap.get(key); }
  async store(key: string, value: string): Promise<void> { this.storageMap.set(key, value); }
  async delete(key: string): Promise<void> { this.storageMap.delete(key); }
  onDidChange = { event: () => ({ dispose: () => {} }) } as unknown as any;
}

test('sidebar rejects unknown or malformed webview messages', async () => {
  const store = tmp('pv-sidebar-store-');
  const mgr = new CapsuleManager(new CapsuleStorage(store));
  const secrets = new MockSecretStorage();
  const creds = new CredentialManager(secrets as any);
  const mockCtx = { extensionUri: { fsPath: '/mock' }, globalStorageUri: { fsPath: store } } as any;

  const provider = new SidebarProvider(mockCtx, mgr, creds);

  // 1. null / undefined / primitives
  assert.equal(await provider.handle(null), false);
  assert.equal(await provider.handle(undefined), false);
  assert.equal(await provider.handle(42), false);
  assert.equal(await provider.handle('malicious string'), false);

  // 2. Unknown message types
  assert.equal(await provider.handle({ type: 'evilCommand' }), false);
  assert.equal(await provider.handle({ type: 'executeScript' }), false);
  assert.equal(await provider.handle({ type: '__proto__' }), false);

  // 3. Known type but invalid property types
  assert.equal(await provider.handle({ type: 'createCapsule', title: 12345 }), false);
  assert.equal(await provider.handle({ type: 'createCapsule', title: 't', prompt: { nested: 'obj' } }), false);
  assert.equal(await provider.handle({ type: 'rejectHunk', path: ['invalid', 'array'] }), false);
  assert.equal(await provider.handle({ type: 'select', id: true }), false);

  // 4. Verify KNOWN_WEBVIEW_MESSAGES allow-list completeness
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('createCapsule'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('runAgent'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('runMockAgent'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('scan'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('approve'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('reject'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('approveHunk'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('rejectHunk'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('openDiff'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('runTests'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('recoverAll'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('select'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('setApiKey'));
  assert.ok(KNOWN_WEBVIEW_MESSAGES.has('clearApiKey'));
});

test('CredentialManager stores, retrieves, and clears API keys in SecretStorage', async () => {
  const secrets = new MockSecretStorage();
  const creds = new CredentialManager(secrets as any);

  assert.equal(await creds.hasApiKey(), false);
  assert.equal(await creds.getApiKey(), undefined);

  // Store key
  await creds.setApiKey('sk-trueforge-secret-token-12345');
  assert.equal(await creds.hasApiKey(), true);
  assert.equal(await creds.getApiKey(), 'sk-trueforge-secret-token-12345');

  // Clear key
  await creds.deleteApiKey();
  assert.equal(await creds.hasApiKey(), false);
  assert.equal(await creds.getApiKey(), undefined);
});
