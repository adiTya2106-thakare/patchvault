# PATCHVAULT — Recovery Flight Recorder for AI code changes

*AI can write the code. PATCHVAULT makes sure developers never lose control of it.*

## Honest status (v0.1.0)

| Area | Status |
|---|---|
| Core engine: checkpoints, Change Capsules, diffs, review, safe recovery, test runner, flight recorder, path security | Implemented. **16/16 automated tests pass** (`npm run test:core`), using real temporary Git repos |
| VS Code sidebar + extension (`src/extension.ts`, `src/ui`, `media/`) | Written, **NOT yet compiled or run** (needs `npm install` for `@types/vscode`) |
| TrueForge agent adapter (`src/core/trueforge`) | Written from the official SDK quickstart; **untested against a live server**. Needs a running TrueForge server + model key. Unknown whether the agent edits your local folder, so changes are found by scanning |
| Hunk-level review, SecretStorage credentials, VS Code integration tests | Not implemented yet |

## How recovery works
- Checkpoint = a private git ref (`refs/patchvault/<id>`) at HEAD **plus** a SHA-256 content snapshot of every workspace file (committed, uncommitted and untracked, honoring `.gitignore`). Nothing is staged or committed.
- Recovery never runs `git reset`/`checkout`. It re-checks each file's hash against what PATCHVAULT last inspected; if anything differs (you or another tool edited it) it stops **before writing anything** and lists conflicts.
- Files over 5 MB are not snapshotted. Agent-created files are only deleted on recovery if their content is unchanged since inspection.
- Recovery states (Protected / Needs Review / Verification Failed / Recovery Available / Recovery Incomplete) come from explicit rules and list their reasons. No percentages.

## Run it (Windows, VS Code terminal, project folder open)
```
npm install
npm test
```
Then press **F5** to launch the Extension Development Host and click the PATCHVAULT icon.
Offline/no VS Code types: `npm run test:core`.

## Design notes
- Git is called via `execFile` (no shell). `simple-git` was planned but could not be installed offline; swapping `src/core/git/gitRunner.ts` for it is straightforward.
- Tests use Node's built-in `node:test` instead of Mocha (Mocha was not installable offline).
- Storage is JSON + content-addressed blobs (no native dependencies).
