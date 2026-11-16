(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cls = { 'Protected': 'ok', 'Recovery Available': 'ok', 'Needs Review': 'warn', 'Verification Failed': 'bad', 'Recovery Incomplete': 'bad' };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'create') send('createCapsule', { title: $('title').value, prompt: $('prompt').value });
    else if (act === 'demo') send('runMockAgent');
    else send(act, { path: b.dataset.path, id: b.dataset.id });
  });

  window.addEventListener('message', (e) => {
    const m = e.data; if (m.type === 'busy') { $('status').textContent = m.text; return; }
    if (m.type === 'error') { $('status').innerHTML = '<span class="err">' + esc(m.text) + '</span>'; return; }
    if (m.type !== 'state') return;
    $('status').textContent = m.notice || '';
    $('tf').innerHTML = esc(m.integration.name) + (m.integration.mock ? ' <span class="badge mock">MOCK</span>' : '') +
      '<div class="muted">' + esc(m.integration.note) + '</div>';
    const c = m.current;
    if (!c) { $('cur').innerHTML = '<div class="muted">No active Change Capsule. Create one before an agent runs.</div>'; }
    else {
      const files = c.changes.map((f) =>
        '<div class="file"><div class="path">' + esc(f.path) + ' <span class="badge">' + f.kind + '</span></div>' +
        '<div><span class="add">+' + f.added + '</span> <span class="del">-' + f.removed + '</span> · ' + f.review +
        (f.expected === false ? ' · <span class="err">outside plan</span>' : '') + '</div>' +
        '<button data-act="approve" data-path="' + esc(f.path) + '">Approve</button>' +
        '<button data-act="reject" data-path="' + esc(f.path) + '" class="secondary">Reject &amp; restore</button>' +
        '<button data-act="openDiff" data-path="' + esc(f.path) + '" class="secondary">Open diff</button></div>').join('');
      const t = c.tests[c.tests.length - 1];
      $('cur').innerHTML = '<div><b>' + esc(c.title) + '</b> <span class="muted">' + esc(c.id) + '</span></div>' +
        '<div><span class="badge ' + (cls[c.recovery.state] || '') + '">' + esc(c.recovery.state) + '</span></div>' +
        '<ul class="muted">' + c.recovery.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' +
        '<div class="muted">Git: ' + (c.checkpoint.isGitRepo ? esc((c.checkpoint.branch || '?') + ' @ ' + (c.checkpoint.head || 'no commits').slice(0, 8)) : 'not a git repo (content snapshot only)') +
        ' · ' + c.manifest + ' files captured</div>' +
        '<h2>Modified files (' + c.changes.length + ')</h2>' + (files || '<div class="muted">No changes detected yet.</div>') +
        '<button data-act="scan" class="secondary">Scan changes</button><button data-act="runTests">Run tests</button>' +
        '<button data-act="recoverAll" class="secondary">Recover everything</button>' +
        '<h2>Tests</h2>' + (t ? '<div>' + esc(t.outcome) + (t.counts ? ' (' + t.counts.passed + ' passed, ' + t.counts.failed + ' failed)' : '') +
          ' · exit ' + t.exitCode + ' · ' + t.durationMs + ' ms</div><pre>' + esc((t.stdout + t.stderr).slice(-1500)) + '</pre>' : '<div class="muted">No test runs.</div>') +
        '<h2>Flight recorder</h2><ol>' + c.events.slice(-30).map((ev) => '<li>' + esc(ev.at.slice(11, 19)) + ' ' + esc(ev.type) + '</li>').join('') + '</ol>';
    }
    $('hist').innerHTML = m.history.map((h) => '<li><button class="secondary" data-act="select" data-id="' + esc(h.id) + '">' + esc(h.title) + '</button> <span class="muted">' + esc(h.status) + '</span></li>').join('') || '<li class="muted">None</li>';
  });
  send('ready');
})();
