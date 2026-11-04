// Browser workflow state (DOM-free), build whitelist and localhost server hardening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { ReviewSession, buildChallenge } from '../web/state.js';
import { build, WHITELIST } from '../scripts/build.mjs';
import { createServer } from '../scripts/serve.mjs';
import { parseReportCsv } from '../src/index.js';

const fx = (f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url));

test('workflow: sample -> trace -> challenge rejected with prior label -> restore -> annotate -> export', () => {
  const s = new ReviewSession();
  assert.equal(s.importInput(new Uint8Array(fx('TC-SYN-001.csv')), 'csv', 'sample csv').status, 'accepted');
  const fwd = s.forward('A');
  assert.equal(fwd.result.affectedShippedQuantity, 60000);
  assert.deepEqual(fwd.result.customers.map((c) => c.customerId), ['C1', 'C2']);
  assert.deepEqual(s.unreachedCustomers(fwd).map((c) => c.id), ['C3', 'C4']);
  assert.equal(s.snapshot().inventory.totalRemaining, 95000);
  assert.deepEqual(s.backward('M').result.ancestors, ['A', 'A2', 'B']);
  assert.equal(s.evidence('T2').result.event.sourceReference, 'SYN-DOC-T2');
  assert.deepEqual(s.query('events', 'shipment', 'timestamp', 'desc').map((e) => e.id), ['S5', 'S4', 'S3', 'S2', 'S1']);
  assert.deepEqual(s.query('shipments', '', 'eventId', 'asc', { customerId: 'C1' }).map((x) => x.eventId), ['S1', 'S5']);

  const rej = s.importInput(buildChallenge(fx('TC-SYN-001.json').toString('utf8')), 'json', 'challenge');
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.submittedBatchId, 'TC-SYN-001-MISSING-T2');
  assert.match(rej.completeness, /cannot be evaluated/);
  assert.match(rej.priorSnapshot.label, /TC-SYN-001.*NOT the result/);
  assert.ok(rej.errorCount > 0);
  assert.equal(s.forward().snapshotBatchId, 'TC-SYN-001', 'prior snapshot still serves traces, labeled');

  assert.equal(s.importInput(new Uint8Array(fx('TC-SYN-001.json')), 'json', 'restore').status, 'accepted');
  const ann = s.annotate('QA-REVIEWER-1', 'event', 'T2', '<img src=x onerror=alert(1)> checked');
  assert.equal(s.annotations().length, 1);
  assert.equal(ann.snapshotBatchId, 'TC-SYN-001');
  const json = JSON.parse(s.exportReport('json'));
  assert.equal(json.affectedShippedQuantity, 60000);
  assert.equal(json.scope.affectedInputLot, 'A');
  assert.ok(JSON.stringify(json).includes('checked'));
  assert.ok(parseReportCsv(s.exportReport('csv')));
});

test('oversize file is refused before parsing and keeps the prior snapshot', () => {
  const s = new ReviewSession();
  s.importInput(new Uint8Array(fx('TC-SYN-001.json')), 'json', 'sample');
  const r = s.importInput(new Uint8Array(1024 * 1024 + 1), 'json', 'big');
  assert.equal(r.status, 'error');
  assert.equal(s.snapshot().batchId, 'TC-SYN-001');
});

test('web sources never use HTML-string sinks', () => {
  for (const f of ['app.js', 'landing.js', 'state.js']) {
    const src = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f);
  }
});

test('build copies exactly the whitelist', () => {
  const out = build(join(tmpdir(), `tc-dist-${process.pid}`));
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(out, join(d, n))]));
  assert.deepEqual(walk(out).sort(), WHITELIST.map(([, to]) => to).sort());
});

test('server: 127.0.0.1 only, GET/HEAD, headers, traversal and dotfile refusal', async () => {
  const out = build(join(tmpdir(), `tc-serve-${process.pid}`));
  const srv = createServer(out);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await fetch(`${base}/state.js`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/javascript/);
    assert.match(ok.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${base}/`)).status, 200);
    const post = await fetch(`${base}/index.html`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    for (const p of ['/%2e%2e/package.json', '/.git/config', '/src/%2e%2e%2f%2e%2e%2fpackage.json', '/%00', '/..%5cpackage.json']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  } finally { srv.close(); }
});
