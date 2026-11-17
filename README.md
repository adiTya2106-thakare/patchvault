# PATCHVAULT &mdash; Recovery Flight Recorder for AI Code Changes

> **&ldquo;AI can write the code. PATCHVAULT makes sure developers never lose control of it.&rdquo;**

[![CI](https://github.com/adiTya2106-thakare/patchvault/actions/workflows/ci.yml/badge.svg)](https://github.com/adiTya2106-thakare)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-blue.svg)](https://code.visualstudio.com/)

A VS Code extension (TypeScript) built for the **TrueFoundry Techfest / Hackathon**. 

PATCHVAULT wraps autonomous coding agents with an immutable **Change Capsule** (a flight recorder). Every task creates a private git checkpoint, full content-addressed SHA-256 snapshot, prompt recording, ordered event timeline, per-file & hunk-level diffs, approve/reject decisions, verification test outcomes, and conflict-checked recovery history.

---

## Live Status (v0.2.0)

| Component | Status | Details |
|---|---|---|
| **Core Recovery Engine** | **Verified (19/19 tests pass)** | Checkpoints, capsules, LCS diffing, hunk-level restore, safe rollback, test runner, path security. |
| **Hunk-Level Review** | **Implemented & Tested** | Approve or reject individual hunks within a file; partial atomic restore with SHA-256 verification. |
| **TrueForge Agent Adapter** | **Implemented** | Streams events from TrueForge sessions, extracts tool-call planned edits, supports WSL & remote sandboxes. |
| **Credential Security** | **Implemented** | TrueForge API keys stored in OS keychain via `vscode.SecretStorage`. Never stored in settings, logs, or capsules. |
| **VS Code Sidebar UI** | **Verified & Polished** | Webview with strict CSP (`nonce`), hunk controls, clean test output, dark/light theme support, accessibility. |
| **Web Showcase & Simulator** | **Deployed on Vercel** | Interactive web demo in `index.html` with `vercel.json` for techfest evaluations. |

---

## Division of Responsibility

- **TrueForge** (TrueFoundry's open-source agent harness &mdash; `trueforge.dev`):
  Owns the agent loop, LLM calls, prompt iterations, sessions, and tool calls. PATCHVAULT never implements its own agent loop.
- **PATCHVAULT**:
  Owns checkpoints, capsules, change detection, diff review, hunk-level partial restore, test execution, flight recorder audit trail, and sidebar UI.

---

## How Recovery Works

1. **Pre-Task Checkpoint**:
   - A private Git reference (`refs/patchvault/<capsuleId>`) is created at `HEAD` using `git update-ref`. The index and working tree remain untouched (nothing is staged or committed).
   - Every file in the workspace (committed, uncommitted, and untracked) is snapshotted into an atomic content-addressed blob store (`blobs/<sha256>`). Files $> 5\text{ MB}$ are excluded.
2. **Hunk-Level Review & Partial Restore**:
   - Files with multiple changes are broken down into unified diff hunks.
   - Developers can approve good hunks and reject bad hunks. Rejecting a hunk atomically restores only that hunk's lines to their checkpoint state while preserving the approved changes.
3. **Safe All-or-Nothing Rollback**:
   - PATCHVAULT **never** executes `git reset --hard` or `git checkout .`.
   - Before writing any file, preflight checks ensure the file's current hash matches what was last inspected. If any concurrent modification occurred, recovery refuses immediately with zero writes.
   - Restored files are verified against original SHA-256 hashes immediately after writing.
4. **Fact-Driven Recovery Confidence**:
   - No fake percentages. Confidence states are computed directly from verifiable facts:
     - `Protected`: Original checkpoint captured; no unreviewed modifications.
     - `Needs Review`: Outstanding unreviewed modifications or files changed outside the agent's plan.
     - `Recovery Available`: All changes reviewed and originals verified in immutable storage.
     - `Verification Failed`: Verification test command failed or could not run.
     - `Recovery Incomplete`: Original content unavailable or corrupt.

---

## Quickstart & Commands

### Prerequisites
- Node.js $\ge 20$
- Git installed
- VS Code $\ge 1.90.0$

### 1. Install & Test
```bash
npm install
npm test
```
*Runs the full test suite with real temporary git repositories (19 tests, 100% pass).*

### 2. Launch the Extension (F5)
Press **F5** in VS Code to open the **Extension Development Host**. Click the **PATCHVAULT** icon on the Activity Bar.

### 3. Connect to TrueForge
Start your local TrueForge server:
```bash
npx @truefoundry/trueforge@latest
```
*(On Windows, run inside WSL 2 so TrueForge's `LocalSandboxProvider` runs natively in Linux with your project folder mounted).*

Configure in VS Code Settings:
- `patchvault.trueforgeBaseUrl`: `http://localhost:8790`
- `patchvault.trueforgeModel`: e.g. `google-gemini/gemini-2.5-flash` or `anthropic/claude-3-5-sonnet`
- Set your API key securely: run Command Palette (`Ctrl+Shift+P`) &rarr; **`PATCHVAULT: Set TrueForge API Key`**.

---

## Repository Structure

```
src/
├── core/
│   ├── capsule/          # Capsule manager, schema types, atomic JSON+blob storage
│   ├── diff/             # LCS line diff, hunk segmentation, partial reconstruction
│   ├── git/              # Checkpoint refs, safe recovery manager, git runner
│   ├── recorder/         # Append-only flight recorder with secret redaction
│   ├── runner/           # Verification test runner (TAP/Jest/Mocha heuristics)
│   └── trueforge/        # TrueForge SDK adapter + MOCK demo adapter
├── security/             # PathValidator (traversal, symlink guards), SecretStorage
├── ui/                   # Sidebar webview provider, message dispatcher
└── test/                 # Core test suite, security tests, sidebar tests, helpers
media/                    # Webview UI assets (CSS, JS, SVG icon)
.github/workflows/        # GitHub Actions CI workflow
index.html                # Interactive web demo simulator (Vercel deployment)
vercel.json               # Vercel deployment configuration
```

---

## Documentation Links

- [System Architecture & Specifications](ARCHITECTURE.md)
- [Security Architecture & Threat Model](SECURITY.md)
- [Step-by-Step Demo Script](DEMO.md)
- [Changelog](CHANGELOG.md)

---

## License

MIT &copy; Aditya Thakare. Built for the TrueFoundry Hackathon.
