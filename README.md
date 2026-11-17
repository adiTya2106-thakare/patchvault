# PATCHVAULT &mdash; Autonomous AI Coding Agent & Diff Flight Recorder
### Powered by TrueForge | Built for Techfest 2026-27 TrueFoundry Forge-a-thon

> **"AI can write the code. PATCHVAULT ensures developers never lose control of what touches disk."**

[![CI](https://github.com/adiTya2106-thakare/patchvault/actions/workflows/ci.yml/badge.svg)](https://github.com/adiTya2106-thakare/patchvault)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-blue.svg)](https://code.visualstudio.com/)
[![TrueForge](https://img.shields.io/badge/Harness-TrueForge%20v0.185-blueviolet)](https://trueforge.dev)

PATCHVAULT is a production-grade VS Code extension whose autonomous agent loop runs natively on **TrueForge** (TrueFoundry's open-source agent harness). It finds the right code in repositories larger than any model's context window, performs multi-file changes unprompted, presents every hunk for interactive review before it touches disk, and maintains workspace consistency with automatic resilience fallback when models fail.

---

## The 5 Mandatory Capabilities (Evaluation Criteria)

| # | Capability | Description & Implementation |
|---|---|---|
| **1** | **Inline Edit** | Select code in active editor & press **`Ctrl+K`** (`Cmd+K`). Streams proposed edits, renders a diff directly in the editor, and provides per-hunk accept and reject. Undoable via **`Ctrl+Alt+Z`**. |
| **2** | **Agent Mode** | Panel where an instruction drives TrueForge through a full tool loop (`read_file`, `search_workspace`, `propose_file_edit`, `run_terminal_command`). Carries out changes across $\ge 3$ files unprompted without user naming them. |
| **3** | **Context Assembly** | Dual-phase engine: parses explicit `@file` and `@symbol` mentions, plus BM25/term-frequency ranked automatic retrieval within a strict **16KB size budget (~4,000 tokens)**. Displays rationale on screen. |
| **4** | **Diff Review & Safety** | Hunk-by-hunk review with preview. Zero silent disk writes. Changes are verified against content-addressed SHA-256 snapshots with preflight conflict guards. Full all-or-nothing rollback. |
| **5** | **Streaming & Cancellation** | Tokens stream in real time via Server-Sent Events. User can cancel generation mid-flight via **`Escape`** or the Cancel button. Aborted runs leave the workspace 100% clean and consistent. |

---

## Quickstart & Setup from Clean Clone

### Prerequisites
- Node.js $\ge 20$
- Git CLI installed
- VS Code $\ge 1.90.0$
- TrueForge CLI: `npx @truefoundry/trueforge@latest`

### 1. Clone & Build
```bash
git clone https://github.com/adiTya2106-thakare/patchvault.git
cd patchvault
npm install
npm test
```
*Runs the full test suite (24 automated tests covering context budgeting, tools, diff reconstruction, and checkpoints with 100% pass rate).*

### 2. Start TrueForge Locally & Load Agent Definition
In your terminal, launch the local TrueForge agent harness:
```bash
npx @truefoundry/trueforge@latest
```
TrueForge runs locally on `http://localhost:8790`. The agent definition is located at **`agent.yaml`** in the repository root.

### 3. Launch the Extension (F5)
1. Open this repository in VS Code and press **F5** to open the **Extension Development Host**.
2. Open any repository (e.g. `pallets/flask`).
3. Click the **PATCHVAULT** icon on the Activity Bar.
4. Set your API Key securely in SecretStorage via Command Palette (`Ctrl+Shift+P`) &rarr; **`PATCHVAULT: Set TrueForge API Key`**. (Never committed to git; see `trueforge.config.example.json`).

---

## Verifying the Three Fixed Benchmark Tasks

Benchmark Repository: [`pallets/flask`](https://github.com/pallets/flask), tag `3.1.3` (commit `22d92470`).

### Task A: Inline Edit (Single File)
1. Open `src/flask/helpers.py`, highlight function `get_debug_flag`, and press **`Ctrl+K`**.
2. Instruct:
   > `"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."`
3. Review proposed diff in editor and click **Accept All Hunks**.
4. **Verification**:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   **Output**: `False`

### Task B: Agent Mode (Three or More Files, None Named)
1. Open PATCHVAULT sidebar panel. With **no files mentioned**, instruct:
   > `"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."`
2. Click **Run Agent Mode**.
3. Observe:
   - Context Assembly displays retrieved files (`src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`) with scores and rationale.
   - TrueForge executes turns and tool calls (`read_file`, `search_workspace`).
   - Diff preview is shown covering all 3 files before writing. Click **Approve File** on each.
4. **Verification**:
   ```bash
   pytest tests/test_cli.py -q
   ```
   Passes cleanly. Run `flask --help` to show `config` listed, then run against a Flask app to show masked JSON.

### Task C: Resilience & Model Fallback
1. Configure `patchvault.trueforgeBaseUrl` to an unreachable endpoint (`http://localhost:9999`) or an invalid API key.
2. Repeat Task A (`Ctrl+K` on `get_debug_flag`).
3. Observe:
   - Editor stays fully responsive.
   - Non-blocking alert notifies developer and automatically falls back to secondary configured model (`gemini-2.5-flash`).
   - `git status` confirms zero files corrupted or half-modified.

---

## Starting Point & Fork Declaration

- **Fork Declaration**: Built from scratch as a clean VS Code extension and client for TrueForge.
- **Upstream Agent Harness**: TrueForge (`github.com/truefoundry/trueforge`). The extension never runs its own agent loop; all turns and tools run through TrueForge's SDK.
- **License**: MIT License preserved (see [`LICENSE`](LICENSE)).

---

## Repository Structure

```
├── agent.yaml                   # TrueForge Agent Definition (tools, instructions, context budget)
├── trueforge.config.example.json# Example model configuration (Primary, Fallback, Local Ollama)
├── WRITEUP.md                   # 1-to-3 page PDF-ready technical write-up (8 mandatory headings)
├── DEMO_GUIDE.md                # 4-minute demo video recording walkthrough & script
├── src/
│   ├── core/
│   │   ├── capsule/             # Checkpoint flight recorder, schemas, atomic JSON+blob store
│   │   ├── context/             # ContextEngine: @file, @symbol, BM25 retrieval, 16KB budget
│   │   ├── diff/                # Unified LCS diffing, hunk clustering, partial reconstruction
│   │   ├── git/                 # Safe checkpoint refs (refs/patchvault/<id>), conflict rollback
│   │   ├── inline/              # InlineEditProvider (Ctrl+K keybinding, editor diff review)
│   │   ├── recorder/            # Append-only flight recorder with secret key redaction
│   │   ├── runner/              # Test runner with TAP/Jest/Pytest heuristics
│   │   ├── tools/               # Editor capabilities exposed as MCP / TrueForge tools
│   │   └── trueforge/           # TrueForge SDK adapter, SSE token streaming, resilience fallback
│   ├── security/                # PathValidator (symlink & traversal guards), SecretStorage
│   ├── ui/                      # Sidebar webview provider, message dispatcher
│   └── test/                    # 24 automated unit tests
├── media/                       # UI assets (sidebar.css, sidebar.js, icon.svg)
└── package.json                 # Extension manifest, commands, keybindings, settings
```

---

## Authors & Team

- **Aditya Thakare (Team Lead)** &mdash; Ramdeobaba University, Nagpur
- **Aryan Dubey** &mdash; Ramdeobaba University, Nagpur
- **Kartik Gavhane** &mdash; Ramdeobaba University, Nagpur

---

## License

MIT &copy; 2026 Aditya Thakare, Aryan Dubey, Kartik Gavhane. Built for the Techfest TrueFoundry Forge-a-thon.
