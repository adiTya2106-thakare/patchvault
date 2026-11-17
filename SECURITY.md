# PATCHVAULT &mdash; Security Architecture & Threat Model

PATCHVAULT operates directly within developer workspaces alongside autonomous AI agents. Security and integrity are central design tenets.

---

## 1. Path Traversal & Symlink Defense (`pathValidator.ts`)

Every filesystem read and write performed by PATCHVAULT is validated through `resolveInside(root, relPath)`:
1. **NUL Byte Guard**: Rejects any path containing `\0` (preventing C string truncation exploits).
2. **Absolute Path Rejection**: Absolute paths are strictly rejected.
3. **Workspace Boundary Enforcement**: Real-path canonical resolution (`fs.realpathSync`) verifies that the target path cannot escape the workspace root via `..` traversal.
4. **Symlink Escape Guard**: Resolves the deepest existing parent directory to ensure symlinks cannot point to locations outside the workspace root.
5. **Symlink Write Prohibition**: Refuses to write through symbolic links, preventing arbitrary file overwrite attacks outside the repository.

---

## 2. Secrets Management & Credential Security (`credentialManager.ts`)

1. **Native SecretStorage**: TrueForge API keys and authentication tokens are stored exclusively in VS Code's `vscode.SecretStorage`, backed by the OS keychain (Windows Credential Manager, macOS Keychain, or Linux Secret Service via GNOME Keyring/libsecret).
2. **Never in Settings**: API keys are never placed in VS Code settings (`settings.json`).
3. **Flight Recorder Redaction**: The append-only flight recorder (`flightRecorder.ts`) filters all metadata through a strict regex:
   `/(key|token|secret|password|authorization)/i`
   Any matching key value is automatically replaced with `[redacted]` before reaching disk.
4. **Never in Change Capsules**: Credentials are excluded from capsule manifests, blobs, and diff history.

---

## 3. Webview Security & Content Security Policy

The sidebar webview is treated as an untrusted client:
1. **Strict Content Security Policy (CSP)**:
   ```http
   default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';
   ```
   No external scripts, styles, or network connections can be initiated from the webview.
2. **Message Allow-Listing**:
   The webview communicates via `vscode.postMessage`. The extension host validates every message against an explicit allow-list:
   ```ts
   export const KNOWN_WEBVIEW_MESSAGES = new Set([
     'ready', 'createCapsule', 'runMockAgent', 'runAgent', 'scan',
     'approve', 'reject', 'approveHunk', 'rejectHunk', 'openDiff',
     'runTests', 'recoverAll', 'select', 'setApiKey', 'clearApiKey'
   ]);
   ```
3. **Strict Type Assertion**:
   Every message payload parameter (`title`, `prompt`, `path`, `id`, `hunkId`) must be a string. Non-string, unexpected, or prototype-pollution payloads are rejected immediately.

---

## 4. Safe Recovery Invariants

1. **Preflight Content Verification**: A file is only overwritten if its current hash matches `modifiedSha256` (the hash recorded during PATCHVAULT's last inspection).
2. **All-or-Nothing Rollback**: If a conflict is discovered on any single file in a multi-file recovery, the entire recovery is refused. Zero files are touched.
3. **Destructive Action Confirmation**: Full rollback and file/hunk rejections require modal user confirmation.
4. **Untracked File Protection**: Recovery removes agent-created files only if they were created during that specific capsule and remain unmodified. Unrelated untracked user files are never deleted.
5. **No Dangerous Git Operations**: PATCHVAULT never executes `git reset --hard` or `git checkout .`. All restorations are done via atomic hash-verified file writes (`atomicWrite`).
