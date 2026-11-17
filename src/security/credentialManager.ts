import * as vscode from 'vscode';

/**
 * Manages sensitive credentials (e.g. TrueForge API keys/tokens)
 * using VS Code's native SecretStorage.
 * Credentials are stored in the OS keychain and are NEVER saved
 * to settings, git, logs, or capsule flight recorder.
 */
export class CredentialManager {
  private static readonly KEY_TRUEFORGE_API_KEY = 'patchvault.trueforge.apiKey';

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(): Promise<string | undefined> {
    const key = await this.secrets.get(CredentialManager.KEY_TRUEFORGE_API_KEY);
    return key?.trim() ? key.trim() : undefined;
  }

  async setApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed) {
      await this.secrets.store(CredentialManager.KEY_TRUEFORGE_API_KEY, trimmed);
    } else {
      await this.deleteApiKey();
    }
  }

  async deleteApiKey(): Promise<void> {
    await this.secrets.delete(CredentialManager.KEY_TRUEFORGE_API_KEY);
  }

  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return Boolean(key && key.length > 0);
  }
}
