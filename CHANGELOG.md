# PATCHVAULT &mdash; Changelog

All notable changes to the PATCHVAULT project are documented in this file.

---

## [0.2.0] &mdash; 2026-11-17

### Added
- **Hunk-Level Review & Partial Restore**:
  - Implemented LCS-based hunk segmentation in `unifiedDiff.ts` with context lines.
  - Added `reconstructFromHunks` for atomic partial file reconstruction.
  - Implemented `rejectHunk()` in `recoveryManager.ts` with hash-checked preflight conflict detection.
  - Added UI controls in `media/sidebar.js` and `sidebarProvider.ts` to approve/reject individual hunks.
- **VS Code Native SecretStorage**:
  - Created `CredentialManager` in `src/security/credentialManager.ts` storing TrueForge API keys securely in the OS keychain.
  - Registered `patchvault.setApiKey` and `patchvault.clearApiKey` commands.
  - Added UI indicator in sidebar showing authentication status without revealing keys.
- **Enhanced TrueForge Adapter**:
  - Added tool-call inspection parsing `model.message` events for file-editing tools (`write_file`, `str_replace_editor`, etc.).
  - Added `plannedChanges` extraction populated directly from agent tool calls.
  - Added support for authenticated TrueForge servers via API keys.
  - Added `syncRemoteEdits` capability for synchronizing remote sandbox edits into the workspace.
- **Security & Validation Tests**:
  - Added `src/test/sidebar.test.ts` covering webview message validation, allow-listing, parameter type verification, and `CredentialManager` storage operations.
  - Added unit test in `src/test/core.test.ts` verifying hunk-level review and partial rollback.
  - Added `src/test/mockVscode.ts` enabling offline test execution without requiring a running Electron binary.
- **Techfest & Web Showcase**:
  - Added interactive web simulator in `index.html` replicating Change Capsule lifecycle in the browser.
  - Added `vercel.json` for one-click Vercel deployment.
  - Added GitHub Actions CI workflow in `.github/workflows/ci.yml`.

### Fixed
- **Windows Environment Path Issue**:
  - Resolved `spawnSync git ENOENT` in subprocess calls by automatically ensuring `C:\Program Files\Git\cmd` is present in `process.env.PATH`.
- **Windows Symlink Privileges**:
  - Gracefully skipped symlink creation test in `security.test.ts` when running under unprivileged Windows user accounts without Developer Mode.
- **Stale Sidebar Status Text**:
  - Replaced outdated status text with live adapter state and model configuration details.
- **Linux Sandbox Artifacts**:
  - Removed obsolete `/opt/npm-tools/...` typeRoots from `tsconfig.core.json`.

---

## [0.1.0] &mdash; 2026-11-16

### Initial Release
- Core Change Capsule storage with content-addressed blobs.
- Pre-task git checkpoints (`refs/patchvault/<id>`).
- Safe all-or-nothing rollback engine.
- Heuristic test runner with TAP, Jest, and Mocha output classification.
- Append-only flight recorder with secret key redaction.
- VS Code Webview sidebar provider.
