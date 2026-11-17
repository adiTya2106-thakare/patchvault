(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const stateClass = {
    'Protected': 'ok',
    'Recovery Available': 'ok',
    'Needs Review': 'warn',
    'Verification Failed': 'bad',
    'Recovery Incomplete': 'bad',
  };

  const testOutcomeClass = {
    'passed': 'ok',
    'failed': 'bad',
    'uninterpretable': 'warn',
    'could-not-execute': 'bad',
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'create') {
      send('createCapsule', { title: $('title').value, prompt: $('prompt').value });
    } else if (act === 'runAgent') {
      send('runAgent');
    } else if (act === 'demo') {
      send('runMockAgent');
    } else if (act === 'approveHunk' || act === 'rejectHunk') {
      send(act, { path: b.dataset.path, hunkId: b.dataset.hunk });
    } else {
      send(act, { path: b.dataset.path, id: b.dataset.id });
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'busy') {
      $('status').innerHTML = '<div class="spinner"></div> <span>' + esc(m.text) + '</span>';
      return;
    }
    if (m.type === 'error') {
      $('status').innerHTML = '<div class="alert error">' + esc(m.text) + '</div>';
      return;
    }
    if (m.type !== 'state') return;

    $('status').innerHTML = m.notice ? '<div class="alert info">' + esc(m.notice) + '</div>' : '';

    // Render Integration Info
    const it = m.integration;
    const authPill = it.hasApiKey
      ? '<span class="badge ok">Authenticated (SecretStorage)</span> <button class="small-btn" data-act="clearApiKey">Clear Key</button>'
      : '<button class="small-btn" data-act="setApiKey">Set API Key</button>';

    $('tf').innerHTML = `
      <div class="integration-card">
        <div class="integration-title">
          <b>${esc(it.name)}</b>
          <span class="badge ${it.mock ? 'mock' : 'real'}">${it.mock ? 'MOCK' : 'REAL ADAPTER'}</span>
        </div>
        <div class="muted small">${esc(it.note)}</div>
        <div class="auth-row">${authPill}</div>
      </div>
    `;

    const c = m.current;
    if (!c) {
      $('cur').innerHTML = '<div class="empty-state">No active Change Capsule. Enter a task title and prompt above to start flight recording.</div>';
    } else {
      const isMock = c.agentSession?.mock ?? false;
      const agentBadge = `<span class="badge ${isMock ? 'mock' : 'real'}">${isMock ? 'MOCK AGENT' : 'REAL AGENT'}</span>`;

      // Render File Changes + Hunks
      const filesHtml = c.changes.map((f) => {
        const hunksHtml = (f.hunks && f.hunks.length > 0)
          ? `<div class="hunks-container">
              <div class="hunks-title">Hunks (${f.hunks.length}):</div>
              ${f.hunks.map(h => `
                <div class="hunk-card">
                  <div class="hunk-header">
                    <span class="hunk-id">${esc(h.id)}</span>
                    <span class="hunk-range">${esc(h.lines[0] || '')}</span>
                    <span class="badge hunk-status ${h.review === 'approved' ? 'ok' : (h.review === 'rejected' ? 'bad' : 'warn')}">${esc(h.review)}</span>
                  </div>
                  <pre class="hunk-diff">${esc(h.lines.slice(1, 8).join('\n'))}${h.lines.length > 8 ? '\n...' : ''}</pre>
                  <div class="hunk-actions">
                    <button class="small-btn" data-act="approveHunk" data-path="${esc(f.path)}" data-hunk="${esc(h.id)}">Approve Hunk</button>
                    <button class="small-btn danger" data-act="rejectHunk" data-path="${esc(f.path)}" data-hunk="${esc(h.id)}">Reject Hunk</button>
                  </div>
                </div>
              `).join('')}
            </div>`
          : '';

        return `
          <div class="file-card">
            <div class="file-header">
              <span class="file-path">${esc(f.path)}</span>
              <span class="badge file-kind">${esc(f.kind)}</span>
            </div>
            <div class="file-stats">
              <span class="add">+${f.added}</span> <span class="del">-${f.removed}</span>
              <span class="review-status">· Review: <b>${esc(f.review)}</b></span>
              ${f.expected === false ? ' <span class="badge warn">outside agent plan</span>' : ''}
            </div>
            <div class="file-actions">
              <button class="small-btn" data-act="approve" data-path="${esc(f.path)}">Approve File</button>
              <button class="small-btn danger" data-act="reject" data-path="${esc(f.path)}">Reject &amp; Restore</button>
              <button class="small-btn secondary" data-act="openDiff" data-path="${esc(f.path)}">Open Diff</button>
            </div>
            ${hunksHtml}
          </div>
        `;
      }).join('');

      // Render Tests
      const lastTest = c.tests && c.tests.length > 0 ? c.tests[c.tests.length - 1] : null;
      let testHtml = '<div class="muted small">No test runs recorded for this capsule yet.</div>';
      if (lastTest) {
        const outCls = testOutcomeClass[lastTest.outcome] || '';
        const countsStr = lastTest.counts
          ? ` (${lastTest.counts.passed} passed, ${lastTest.counts.failed} failed)`
          : '';
        testHtml = `
          <div class="test-card">
            <div class="test-header">
              <span class="badge ${outCls}">${esc(lastTest.outcome.toUpperCase())}</span>
              <span class="test-details">${esc(lastTest.command)} · ${lastTest.durationMs}ms</span>
            </div>
            <div class="small muted">Exit code: ${lastTest.exitCode !== null ? lastTest.exitCode : 'None'}${countsStr}</div>
            <details class="test-log-details">
              <summary>View Output (${lastTest.stdout.length + lastTest.stderr.length} bytes)</summary>
              <pre class="test-output">${esc((lastTest.stdout + '\n' + lastTest.stderr).trim().slice(-2000))}</pre>
            </details>
          </div>
        `;
      }

      // Render Flight Recorder Events
      const eventsHtml = c.events && c.events.length > 0
        ? `<ol class="event-list">
            ${c.events.slice(-20).map(ev => `
              <li class="event-item">
                <span class="event-time">${esc(ev.at.slice(11, 19))}</span>
                <span class="event-type">${esc(ev.type)}</span>
              </li>
            `).join('')}
          </ol>`
        : '<div class="muted small">No events logged.</div>';

      $('cur').innerHTML = `
        <div class="capsule-card">
          <div class="capsule-title-row">
            <h3 class="capsule-title">${esc(c.title)}</h3>
            ${agentBadge}
          </div>
          <div class="muted small id-row">ID: <code>${esc(c.id)}</code> · Status: <b>${esc(c.status)}</b></div>

          <div class="confidence-box">
            <span class="badge ${stateClass[c.recovery.state] || ''}">${esc(c.recovery.state)}</span>
            <ul class="reason-list">
              ${c.recovery.reasons.map(r => `<li>${esc(r)}</li>`).join('')}
            </ul>
          </div>

          <div class="checkpoint-info small muted">
            Git: ${c.checkpoint.isGitRepo
              ? `<code>${esc(c.checkpoint.branch || 'detached')} @ ${(c.checkpoint.head || '').slice(0, 7)}</code>`
              : 'Snapshot only (non-git directory)'}
            · ${c.manifest} files captured
          </div>

          <div class="actions-toolbar">
            <button class="secondary" data-act="scan">Scan Workspace</button>
            <button class="primary" data-act="runTests">Run Tests</button>
            ${c.changes.length > 0 ? '<button class="danger" data-act="recoverAll">Recover Everything</button>' : ''}
          </div>

          <h4>Modified Files (${c.changes.length})</h4>
          ${filesHtml || '<div class="muted small">No changes detected vs checkpoint.</div>'}

          <h4>Verification Tests</h4>
          ${testHtml}

          <h4>Flight Recorder Timeline</h4>
          ${eventsHtml}
        </div>
      `;
    }

    // Render History
    if (!m.history || m.history.length === 0) {
      $('hist').innerHTML = '<li class="muted small">No past capsules recorded.</li>';
    } else {
      $('hist').innerHTML = m.history.map(h => {
        const isCurrent = c && c.id === h.id;
        return `
          <li class="history-item ${isCurrent ? 'active' : ''}">
            <button class="history-btn ${isCurrent ? 'active-btn' : 'secondary'}" data-act="select" data-id="${esc(h.id)}">
              <span class="history-title">${esc(h.title)}</span>
              <span class="badge ${h.mock ? 'mock' : 'real'} small-badge">${h.mock ? 'MOCK' : 'REAL'}</span>
              <span class="muted small">${esc(h.status)}</span>
            </button>
          </li>
        `;
      }).join('');
    }
  });

  send('ready');
})();
