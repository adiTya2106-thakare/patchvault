# PATCHVAULT &mdash; Video Recording & Demonstration Guide
### Techfest 2026-27 TrueFoundry Forge-a-thon (4-Minute Demo Script)

Follow this exact walkthrough when recording your demo video to guarantee maximum scores on Criteria A1, A2, A3, B1, B2, B3, B4, and C1.

---

## Pre-Recording Checklist
1. **Repository Setup**:
   Clone `pallets/flask` and checkout release tag `3.1.3`:
   ```bash
   git clone https://github.com/pallets/flask.git flask-eval
   cd flask-eval
   git checkout 3.1.3
   ```
2. **TrueForge Local Server**:
   Start TrueForge in another terminal window:
   ```bash
   npx @truefoundry/trueforge@latest
   ```
   Open browser to `http://localhost:8790` to have the session UI ready to switch to.
3. **Launch Extension**:
   Open `patchvault-vscode` in VS Code, press **F5** to open the Extension Development Host, and open the `flask-eval` repository.

---

## Step-by-Step Recording Timeline (Max 4 Minutes)

### [00:00 &ndash; 01:10] Task A: Inline Edit (Single File)
1. In the editor, open `src/flask/helpers.py`.
2. Scroll to the `get_debug_flag()` function and highlight it.
3. Press **`Ctrl+K`** (or `Cmd+K` on Mac) to trigger PATCHVAULT Inline Edit.
4. Paste the exact instruction from the prompt:
   > `"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."`
5. Press **Enter**.
6. **On-Screen Display**:
   - The status bar shows TrueForge streaming.
   - Proposed diff is presented with hunk review (`Accept All Hunks` / `Review Hunk by Hunk`).
   - Click **Accept All Hunks**.
7. **Verification on Screen**:
   In the integrated terminal, run:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   Show that the output prints **`False`**.

---

### [01:10 &ndash; 02:30] Task B: Agent Mode (Multi-File, None Named)
1. Click the **PATCHVAULT** icon on the Activity Bar.
2. In the sidebar under **New Task**, do **not** name any files. Paste the exact instruction:
   > `"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."`
3. Click **Run Agent Mode**.
4. **On-Screen Display**:
   - **Context Engine Rationale**: Point out the displayed selection rationale showing that `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst` were discovered unprompted with relevance scores within the 16KB budget!
   - **Streaming**: Show real-time streaming tokens.
   - **Brief TrueForge Session (MANDATORY)**: Switch for 5 seconds to your browser at `http://localhost:8790` showing the active session, turns, and tool calls (`read_file`, `search_workspace`).
   - Return to VS Code: The diff appears covering 3 files!
   - Review hunks and click **Approve File** on each.
5. **Verification on Screen**:
   In the terminal, run:
   ```bash
   pytest tests/test_cli.py -q
   ```
   Show it **passing**!
   Then run the new command:
   ```bash
   flask --help
   ```
   Show `config` in the help output, and show the masked JSON output:
   `{"SECRET_KEY": "***", ...}`.

---

### [02:30 &ndash; 03:20] Demonstration of Safe Cancellation & Undo
1. Start a new generation, then click **Cancel Run** (or press `Escape`).
2. Show that generation immediately halts, no half-applied edits exist, and `git status` remains 100% clean.
3. Test safe Undo (`Ctrl+Alt+Z` or **Recover Everything** in sidebar) showing files safely restored from content-addressed SHA-256 storage.

---

### [03:20 &ndash; 04:00] Task C: Resilience & Model Fallback
1. In VS Code Settings, configure `patchvault.trueforgeBaseUrl` to an unreachable endpoint: `http://localhost:9999` (or an invalid API key).
2. Repeat Task A: select `get_debug_flag` and press **`Ctrl+K`**.
3. **On-Screen Display**:
   - Show that the editor stays completely responsive (no hang, no crash).
   - Show the clean message or automatic fallback to the secondary model (`gemini-2.5-flash`).
   - In terminal, run:
     ```bash
     git status
     ```
     Show that **no files were modified or corrupted**.

---

## Exporting & Submitting
1. Upload your recording to YouTube (Unlisted) or Google Drive ("Anyone with the link can view").
2. Ensure video length is **under 4 minutes**.
3. Fill in the timestamps in your `WRITEUP.md` scorecard table to match your recording.
