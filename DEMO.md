# PATCHVAULT &mdash; Demonstration Guide

This guide walks through demonstrating PATCHVAULT for the TrueFoundry Techfest presentation and hackathon evaluation.

---

## 1. Quick Launch (F5 Extension Host)

1. Open `patchvault-vscode` in VS Code.
2. Run `npm test` in the terminal to verify all automated test suites pass:
   ```bash
   npm test
   ```
3. Press **F5** to launch the **Extension Development Host**.
4. In the Extension Development Host window, open any project folder (e.g. a sample repository or new folder).
5. Click the **PATCHVAULT** icon on the Activity Bar.

---

## 2. Interactive Demo Script (5 Minutes)

### Step 1: Create a Change Capsule (Checkpoint)
1. In the sidebar under **New Task**:
   - **Task title**: `Add rate limiting to auth service`
   - **Task prompt**: `Create a rate limiter in src/rateLimiter.ts and attach it to authService.ts`
2. Click **Create Capsule**.
3. Observe:
   - Capsule is generated with a unique ID (e.g. `m12a9x-3f82`).
   - Private ref `refs/patchvault/<id>` is captured at HEAD.
   - All workspace files are snapshotted into content-addressed blobs.
   - Status transitions to **`Protected`**.
   - Flight recorder logs `task.initiated` and `checkpoint.captured`.

### Step 2: Run the Agent (Simulated or Real TrueForge)
- **Offline / Fast Demo**: Click **Run MOCK agent (demo)**.
- **Live TrueForge**: If running a TrueForge server (`npx @truefoundry/trueforge@latest`), click **Run TrueForge agent**.
- Observe:
   - Status updates to **`Needs Review`** with explicit reasons.
   - The modified files appear in the list with `+added` and `-removed` line counts.
   - If files were edited outside the agent's planned changes, the `outside agent plan` warning badge is shown.

### Step 3: Inspect Diff & Hunk-Level Review
1. Click **Open Diff** next to any changed file.
   - VS Code's native side-by-side diff editor opens (`Original (Checkpoint) ↔ Current`).
2. In the sidebar, view the **Hunks** section under the file.
   - Notice the distinct hunks broken down by line range.
3. Click **Reject Hunk** on one of the hunks:
   - Modal confirmation appears: `Restore hunk hunk-1 in <file> to original content?`
   - Click **Restore Hunk**.
   - Observe: Only that specific hunk is reverted on disk! The other hunks in the file remain intact.
   - Re-diff confirms the partial revert succeeded with hash verification.

### Step 4: Run Verification Tests
1. Click **Run tests**.
2. PATCHVAULT executes the configured test command (e.g. `npm test`) in the workspace.
3. Observe:
   - Test outcome is parsed into `PASSED` / `FAILED` / `UNINTERPRETABLE`.
   - Pass and fail counts are displayed along with execution duration in milliseconds.
   - Expandable console output view shows stdout and stderr.
   - If tests pass and all changes are approved, the Recovery Confidence transitions to **`Recovery Available`**.

### Step 5: Test All-or-Nothing Rollback
1. Click **Recover everything**.
2. Modal prompt confirms restoring all changed files.
3. Click **Restore all**.
4. Observe:
   - All files are atomically reverted to their original checkpoint content.
   - Agent-created files are cleanly deleted.
   - Any untracked files you had before the agent ran are completely preserved.
   - Status transitions back to **`Protected`**.

---

## 3. Web Showcase & Vercel Demo
If running without VS Code:
1. Open `index.html` in any browser or visit the deployed Vercel URL.
2. The web simulator replicates the complete capsule lifecycle, diffing, hunk rejection, test outcome parsing, and flight recorder stream directly in the browser!
