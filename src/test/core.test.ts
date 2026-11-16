import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, makeManager, w, r, tmp } from './helpers';
import { CapsuleStorage } from '../core/capsule/capsuleStorage';
import { setReview } from '../core/diff/diffReviewManager';
import { recover, rejectChange } from '../core/git/recoveryManager';
import { record } from '../core/recorder/flightRecorder';
import { runTests, classify } from '../core/runner/testRunner';
import { MockAgentAdapter, TrueForgeAdapter, IntegrationNotVerifiedError } from '../core/trueforge/trueforgeAdapter';
import { unifiedDiff } from '../core/diff/unifiedDiff';

test('checkpoint protects UNCOMMITTED and UNTRACKED work, and does not stage anything', async () => {
  const repo = makeRepo(); const { mgr } = makeManager();
  w(repo, 'a.txt', 'one\nLOCAL EDIT\nthree\n');       // uncommitted modification
  w(repo, 'notes.md', 'my untracked notes');           // untracked
  const c = await mgr.create(repo, 't', 'p');
  assert.ok(c.checkpoint.head && c.checkpoint.refName);
  assert.deepEqual(c.checkpoint.unstagedFiles, ['a.txt']);
  assert.deepEqual(c.checkpoint.untrackedFiles, ['notes.md']);
  const snap = c.manifest.find(m => m.path === 'a.txt')!;
  assert.equal(mgr.storage.getBlob(c.id, snap.blobId)!.toString(), 'one\nLOCAL EDIT\nthree\n');
  assert.ok(c.manifest.some(m => m.path === 'notes.md'));
  assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo }).toString(), ''); // nothing staged
  assert.equal(execFileSync('git', ['rev-parse', c.checkpoint.refName!], { cwd: repo }).toString().trim(), c.checkpoint.head);
});

test('capsule persists across a new storage instance; corrupt and outdated capsules are handled safely', async () => {
  const repo = makeRepo(); const { mgr, store } = makeManager();
  const c = await mgr.create(repo, 'persist', 'do it');
  const again = new CapsuleStorage(store).load(c.id);
  assert.ok(again.ok && again.capsule.prompt === 'do it' && again.capsule.events.length >= 2);
  fs.mkdirSync(path.join(store, 'capsules', 'bad'), { recursive: true });
  fs.writeFileSync(path.join(store, 'capsules', 'bad', 'capsule.json'), '{not json');
  fs.mkdirSync(path.join(store, 'capsules', 'old'), { recursive: true });
  fs.writeFileSync(path.join(store, 'capsules', 'old', 'capsule.json'), JSON.stringify({ id: 'old', changes: [], schemaVersion: 0 }));
  const l = new CapsuleStorage(store).list();
  assert.equal(l.loaded.length, 1);
  assert.deepEqual(l.skipped.map(s => s.reason).sort(), ['corrupt', 'unsupported-version']);
  assert.throws(() => new CapsuleStorage(store).load('../evil'));
});

test('detects modified/added/deleted files with correct diff counts', async () => {
  const repo = makeRepo(); const { mgr } = makeManager();
  const c = await mgr.create(repo, 't', 'p');
  w(repo, 'a.txt', 'one\nTWO\nthree\nfour\n'); w(repo, 'new.txt', 'hello\n'); fs.rmSync(path.join(repo, 'c.txt'));
  await mgr.refresh(repo, c);
  const by = Object.fromEntries(c.changes.map(x => [x.path, x]));
  assert.equal(by['a.txt'].kind, 'modified'); assert.equal(by['a.txt'].added, 2); assert.equal(by['a.txt'].removed, 1);
  assert.equal(by['new.txt'].kind, 'added'); assert.equal(by['c.txt'].kind, 'deleted');
  assert.equal(c.changes.length, 3);
  assert.match(by['a.txt'].unifiedDiff, /\+TWO/);
});

test('approve one, reject another: reject restores the original; approval persists', async () => {
  const repo = makeRepo(); const { mgr } = makeManager();
  const c = await mgr.create(repo, 't', 'p');
  w(repo, 'a.txt', 'changed\n'); w(repo, 'b.txt', 'changed b\n');
  await mgr.refresh(repo, c);
  setReview(c, 'a.txt', 'approved');
  const out = rejectChange(repo, c, mgr.storage, 'b.txt');
  assert.ok(!out.refused && out.verified);
  assert.equal(r(repo, 'b.txt'), 'bee\n');
  assert.equal(r(repo, 'a.txt'), 'changed\n');                         // approved edit untouched
  await mgr.refresh(repo, c);
  assert.equal(c.changes.find(x => x.path === 'a.txt')!.review, 'approved');   // decision survives re-scan
  assert.ok(c.events.some(e => e.type === 'change.rejected') && c.events.some(e => e.type === 'change.approved'));
});

test('rollback detects external edits (conflict) and writes NOTHING', async () => {
  const repo = makeRepo(); const { mgr } = makeManager();
  const c = await mgr.create(repo, 't', 'p');
  w(repo, 'a.txt', 'agent\n'); w(repo, 'b.txt', 'agent b\n');
  await mgr.refresh(repo, c);
  w(repo, 'b.txt', 'USER TYPED THIS AFTER\n');                          // edit after inspection
  const out = recover(repo, c, mgr.storage, 'all');
  assert.ok(out.refused); assert.match(out.conflicts[0], /b\.txt/);
  assert.equal(r(repo, 'a.txt'), 'agent\n');                            // all-or-nothing
  assert.equal(r(repo, 'b.txt'), 'USER TYPED THIS AFTER\n');
  assert.equal(c.recoveries.at(-1)!.verified, false);
});

test('full capsule recovery restores originals, removes agent-created files, preserves unrelated untracked files', async () => {
  const repo = makeRepo(); const { mgr } = makeManager();
  w(repo, 'mine.txt', 'my untracked work\n');
  const c = await mgr.create(repo, 't', 'p');
  w(repo, 'a.txt', 'x\n'); w(repo, 'agent-new.txt', 'y\n'); fs.rmSync(path.join(repo, 'c.txt'));
  await mgr.refresh(repo, c);
  const out = recover(repo, c, mgr.storage, 'all');
  assert.ok(!out.refused && out.verified && out.restored.length === 3);
  assert.equal(r(repo, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(r(repo, 'c.txt'), 'sea\n');
  assert.ok(!fs.existsSync(path.join(repo, 'agent-new.txt')));
  assert.equal(r(repo, 'mine.txt'), 'my untracked work\n');
  assert.equal(c.status, 'recovered');
  assert.equal(c.recoveries.length, 1);
});

test('recovery refuses when blob store is tampered with', async () => {
  const repo = makeRepo(); const { mgr, store } = makeManager();
  const c = await mgr.create(repo, 't', 'p');
  w(repo, 'a.txt', 'x\n'); await mgr.refresh(repo, c);
  const blob = c.manifest.find(m => m.path === 'a.txt')!.blobId;
  fs.writeFileSync(path.join(store, 'capsules', c.id, 'blobs', blob), 'tampered');
  const out = recover(repo, c, mgr.storage, 'all');
  assert.ok(out.refused); assert.match(out.conflicts.join(), /unavailable or corrupt/);
  assert.equal(mgr.recoveryState(c).state, 'Recovery Incomplete');
  assert.equal(r(repo, 'a.txt'), 'x\n');
});

test('works in a non-git folder too (flagged as no git checkpoint)', async () => {
  const dir = tmp('pv-nogit-'); const { mgr } = makeManager();
  w(dir, 'f.txt', 'orig\n');
  const c = await mgr.create(dir, 't', 'p');
  assert.equal(c.checkpoint.isGitRepo, false); assert.equal(c.manifest.length, 1);
  w(dir, 'f.txt', 'new\n'); await mgr.refresh(dir, c);
  assert.ok(!recover(dir, c, mgr.storage, 'all').refused); assert.equal(r(dir, 'f.txt'), 'orig\n');
});

test('recovery confidence states are driven by facts', async () => {
  const repo = makeRepo(); const { mgr } = makeManager();
  const c = await mgr.create(repo, 't', 'p');
  assert.equal(mgr.recoveryState(c).state, 'Protected');
  w(repo, 'a.txt', 'x\n'); await mgr.refresh(repo, c);
  assert.equal(mgr.recoveryState(c).state, 'Needs Review');
  setReview(c, 'a.txt', 'approved');
  assert.equal(mgr.recoveryState(c).state, 'Recovery Available');
  c.tests.push({ command: 'x', startedAt: '', completedAt: '', durationMs: 1, exitCode: 1, stdout: '', stderr: '', outcome: 'failed' });
  assert.equal(mgr.recoveryState(c).state, 'Verification Failed');
  c.tests.length = 0; c.plannedChanges = ['other.txt']; await mgr.refresh(repo, c);
  assert.equal(mgr.recoveryState(c).state, 'Needs Review');   // unexpected file outside plan
});

test('flight recorder is ordered and redacts secret-looking keys', () => {
  const c = { events: [] } as never as Parameters<typeof record>[0];
  record(c, 'a', { apiKey: 'sk-123', path: 'x' }); record(c, 'b');
  assert.equal(c.events[0].meta.apiKey, '[redacted]'); assert.equal(c.events[0].meta.path, 'x');
  assert.deepEqual(c.events.map(e => e.seq), [1, 2]);
});

test('test runner distinguishes passed / failed / uninterpretable / could-not-execute', async () => {
  const d = tmp();
  const pass = await runTests(d, `node -e "console.log('# pass 3\\n# fail 0')"`);
  assert.equal(pass.outcome, 'passed'); assert.deepEqual(pass.counts, { passed: 3, failed: 0 });
  const fail = await runTests(d, `node -e "console.log('# pass 1\\n# fail 2'); process.exit(1)"`);
  assert.equal(fail.outcome, 'failed'); assert.equal(fail.exitCode, 1);
  const unk = await runTests(d, `node -e "console.log('ok')"`);
  assert.equal(unk.outcome, 'uninterpretable');
  assert.equal(classify(null, '', true).outcome, 'could-not-execute');
  const missing = await runTests(d, 'definitely-not-a-command-xyz');
  assert.equal(missing.outcome, 'failed');   // shell exits 127; reported as failed, never as passed
  assert.ok(pass.durationMs >= 0 && pass.startedAt <= pass.completedAt);
});

test('mock adapter must be explicit and is labelled; real adapter refuses to fake success', async () => {
  const repo = makeRepo(); const { mgr } = makeManager();
  assert.throws(() => new MockAgentAdapter([], {} as never));
  const c = await mgr.create(repo, 't', 'p');
  const events: string[] = [];
  const ad = new MockAgentAdapter([{ path: 'a.txt', content: 'mocked\n' }, { path: 'deep/new.ts', content: 'x' }], { iUnderstandThisIsAMock: true });
  const res = await ad.run({ workspaceRoot: repo, prompt: 'p', onEvent: t => events.push(t) });
  assert.equal(ad.isMock, true); assert.match(ad.name, /MOCK/); assert.deepEqual(res.plannedChanges, ['a.txt', 'deep/new.ts']);
  assert.deepEqual(events, ['agent.session.started', 'agent.file.modified', 'agent.file.modified']);
  await mgr.refresh(repo, c); assert.equal(c.changes.length, 2);
  await assert.rejects(() => new TrueForgeAdapter().run({ workspaceRoot: repo, prompt: 'p', onEvent: () => {} }), IntegrationNotVerifiedError);
  await assert.rejects(() => new MockAgentAdapter([{ path: '../escape.txt', content: 'x' }], { iUnderstandThisIsAMock: true })
    .run({ workspaceRoot: repo, prompt: 'p', onEvent: () => {} }));
});

test('unified diff basics', () => {
  const d = unifiedDiff('f', 'a\nb\n', 'a\nc\n');
  assert.equal(d.added, 1); assert.equal(d.removed, 1); assert.ok(d.text.includes('\n-b') && d.text.includes('\n+c'));
});
