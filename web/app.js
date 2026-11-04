// Review desk controller. Untrusted text is only ever written with textContent (never HTML-string sinks).
import { ReviewSession, buildChallenge, MAX_FILE_BYTES } from './state.js';

const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; };
const g = (n) => `${n.toLocaleString('en-US')} g`;
const session = new ReviewSession();

function table(caption, headers, rows) {
  const wrap = el('div', undefined, 'table-wrap');
  const t = el('table');
  t.append(el('caption', caption));
  const tr = el('tr');
  for (const h of headers) { const th = el('th', h); th.scope = 'col'; tr.append(th); }
  const thead = el('thead');
  thead.append(tr);
  t.append(thead);
  const tb = el('tbody');
  for (const r of rows) { const row = el('tr'); for (const c of r) row.append(el('td', c ?? '—')); tb.append(row); }
  t.append(tb);
  wrap.append(t);
  return wrap;
}

function fail(target, e) { target.replaceChildren(el('p', `Error: ${e.message}`, 'error')); }

async function fetchText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`could not load ${path} (HTTP ${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

function showImport(res) {
  const box = $('import-status');
  box.replaceChildren();
  if (res.status === 'error') { box.append(el('p', res.message, 'error')); return; }
  if (res.status === 'accepted') {
    box.append(el('p', `Accepted batch "${res.batchId}" from ${res.sourceLabel}.`, 'ok'), el('p', `Content hash (not a signature): ${res.contentHash}`, 'hash'));
    const inv = res.snapshot.inventory;
    box.append(table('Snapshot inventory ledger (grams)', ['Received', 'Shipped', 'Configured loss', 'Remaining'],
      [[g(inv.totalReceived), g(inv.totalShipped), g(inv.totalConfiguredLoss), g(inv.totalRemaining)]]));
  } else {
    box.append(el('p', `Rejected candidate "${res.submittedBatchId ?? 'unknown'}" from ${res.sourceLabel}. ${res.completeness}.`, 'error'));
    box.append(el('p', res.priorSnapshot.label, 'prior'), el('p', res.note));
    const ul = el('ul', undefined, 'diag');
    for (const e of res.errors) ul.append(el('li', `${e.code}: ${e.message}`));
    box.append(el('h3', `Diagnostics (${res.errorCount}${res.errorsTruncated ? '+, truncated' : ''})`), ul);
    const b = el('button', 'Restore valid sample TC-SYN-001');
    b.type = 'button';
    b.addEventListener('click', () => loadSample('json'));
    box.append(b);
  }
  renderAll();
}

function fillSelect(sel, items, value) {
  sel.replaceChildren(...items.map((i) => { const o = el('option', i.label); o.value = i.value; return o; }));
  sel.disabled = items.length === 0;
  if (value) sel.value = value;
}

function renderAll() {
  const s = session.snapshot();
  if (!s) return;
  fillSelect($('lot-select'), s.lots.map((l) => ({ value: l.id, label: `${l.id} · ${l.productId}${l.root ? ' (received)' : ''}` })), session.selectedLot);
  fillSelect($('back-select'), [{ value: '', label: 'Choose a target lot' }, ...s.lots.map((l) => ({ value: l.id, label: l.id }))], session.backwardTarget ?? '');
  fillSelect($('ev-select'), [{ value: '', label: 'Choose an event' }, ...s.events.map((e) => ({ value: e.id, label: `${e.id} · ${e.type}` }))], '');
  renderForward(); renderBackward(); renderEvidence(''); renderRecords(); renderAnnotations();
}

function renderForward() {
  const out = $('trace-out');
  try {
    const fwd = session.forward();
    if (!fwd) { out.replaceChildren(el('p', 'Select a lot.', 'empty')); return; }
    const r = fwd.result;
    out.replaceChildren(el('p', fwd.snapshotLabel, 'prior'), el('p', `${g(r.affectedShippedQuantity)} affected shipped from lot ${r.affectedInputLot}`, 'figure'));
    out.append(table('Affected customers', ['Customer', 'Name', 'Affected received'], r.customers.map((c) => [c.customerId, c.name, g(c.affectedReceived)])));
    const un = session.unreachedCustomers(fwd);
    out.append(el('p', `Not reached by this trace: ${un.map((c) => c.id).join(', ') || 'none'}. Outside this trace only — NOT certified safe.`, 'note'));
    out.append(el('h3', 'Shipment paths (accessible route list)'));
    const ol = el('ol', undefined, 'routes');
    for (const p of r.paths) ol.append(el('li', `${p.text} · ${g(p.quantity)}`));
    out.append(ol);
    if (!r.pathsComplete) out.append(el('p', 'Path list truncated by limits; totals above remain complete.', 'error'));
    const wl = el('ul', undefined, 'warnings');
    for (const w of r.warnings) wl.append(el('li', w.message));
    out.append(el('h3', 'Scope, inventory and propagation notes'), wl);
  } catch (e) { fail(out, e); }
}

function renderBackward() {
  const out = $('back-out');
  try {
    const b = session.backward();
    if (!b) { out.replaceChildren(el('p', 'Choose a target lot.', 'empty')); return; }
    const r = b.result;
    out.replaceChildren(el('p', b.snapshotLabel, 'prior'), el('p', `Ancestors of ${r.targetLot}: ${r.ancestors.join(', ') || 'none (received lot)'}`));
    out.append(table('Root receipts', ['Receipt', 'Lot', 'Quantity', 'Source row'], r.rootReceipts.map((x) => [x.eventId, x.lotId, g(x.quantity), x.sourceRow])));
    const ol = el('ol', undefined, 'routes');
    for (const p of r.paths) ol.append(el('li', p.text));
    out.append(ol);
  } catch (e) { fail(out, e); }
}

function renderEvidence(id) {
  const out = $('ev-out');
  if (!id) { out.replaceChildren(el('p', 'Choose an event.', 'empty')); return; }
  try {
    const ev = session.evidence(id);
    const { event, detail, massBalance } = ev.result;
    out.replaceChildren(el('p', ev.snapshotLabel, 'prior'));
    out.append(table(`Event ${event.id}`, ['Type', 'Timestamp (UTC)', 'Facility', 'Source reference', 'Source row'], [[event.type, event.timestamp, event.facilityId, event.sourceReference, event.sourceRow]]));
    if (detail?.inputs) {
      const lines = [...detail.inputs.map((i) => ['input', i.lotId, g(i.quantity), i.sourceRow]), ...detail.outputs.map((o) => ['output', o.lotId, g(o.quantity), o.sourceRow])];
      out.append(table('Transformation lines', ['Role', 'Lot', 'Quantity', 'Source row'], lines));
    }
    if (massBalance) out.append(el('p', `Mass balance: in ${g(massBalance.inputGrams)}, out ${g(massBalance.outputGrams)}, configured loss ${g(massBalance.configuredLoss)} — ${massBalance.balanced ? 'balanced' : 'NOT balanced'}.`));
  } catch (e) { fail(out, e); }
}

function renderRecords() {
  const out = $('rec-out');
  try {
    const field = $('q-field').value, value = $('q-value').value.trim();
    const filter = field && value ? { [field]: value } : undefined;
    const rows = session.query($('q-coll').value, $('q-search').value, $('q-sort').value.trim(), $('q-dir').value, filter);
    if (!rows.length) { out.replaceChildren(el('p', 'No records match.', 'empty')); return; }
    const keys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object' || rows[0][k] === null);
    out.replaceChildren(table(`${rows.length} ${$('q-coll').value}`, keys, rows.map((r) => keys.map((k) => r[k]))));
  } catch (e) { fail(out, e); }
}

function renderAnnotations() {
  const list = session.annotations();
  const out = $('ann-out');
  if (!list.length) { out.replaceChildren(el('p', 'No annotations in this workspace.', 'empty')); return; }
  out.replaceChildren(table('Annotations stored in this workspace (cite snapshot hash)', ['ID', 'Reviewer', 'Target', 'Note', 'Created (UTC)'],
    list.map((a) => [a.id, a.reviewer, `${a.targetType} ${a.targetId}`, a.note, a.createdAt])));
}

async function loadSample(fmt) {
  $('import-status').replaceChildren(el('p', 'Loading sample…', 'loading'));
  try { showImport(session.importInput(await fetchText(`fixtures/TC-SYN-001.${fmt}`), fmt, `sample TC-SYN-001.${fmt}`)); } catch (e) { fail($('import-status'), e); }
}

document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => loadSample(b.dataset.sample)));
$('challenge').addEventListener('click', async () => {
  try {
    const text = buildChallenge(new TextDecoder().decode(await fetchText('fixtures/TC-SYN-001.json')));
    showImport(session.importInput(text, 'json', 'challenge (sample with T2 removed)'));
  } catch (e) { fail($('import-status'), e); }
});
$('file-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = $('file').files[0];
  if (!f) { $('import-status').replaceChildren(el('p', 'Choose a file first.', 'error')); return; }
  if (f.size > MAX_FILE_BYTES) { showImport({ status: 'error', message: `File is ${f.size} bytes; limit is ${MAX_FILE_BYTES} bytes. Nothing imported.` }); return; }
  const fmt = document.querySelector('input[name=fmt]:checked').value;
  showImport(session.importInput(new Uint8Array(await f.arrayBuffer()), fmt, `file ${f.name}`));
});
$('lot-select').addEventListener('change', (e) => { session.selectedLot = e.target.value; renderForward(); });
$('back-select').addEventListener('change', (e) => { session.backwardTarget = e.target.value || null; renderBackward(); });
$('ev-select').addEventListener('change', (e) => renderEvidence(e.target.value));
$('query').addEventListener('submit', (e) => { e.preventDefault(); if (session.snapshot()) renderRecords(); });
$('ann-form').addEventListener('submit', (e) => {
  e.preventDefault();
  try { session.annotate($('ann-reviewer').value, $('ann-type').value, $('ann-target').value.trim(), $('ann-note').value); $('ann-note').value = ''; renderAnnotations(); } catch (err) { fail($('ann-out'), err); }
});
document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
  try {
    const fmt = b.dataset.export;
    const text = session.exportReport(fmt);
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([text], { type: fmt === 'json' ? 'application/json' : 'text/csv' }));
    a.download = `tracechain-report-${session.selectedLot}.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('export-status').textContent = `Downloaded ${a.download} (${text.length} characters, synthetic).`;
  } catch (e) { $('export-status').textContent = `Export unavailable: ${e.message}`; }
}));
// The landing's primary action names this workflow: open it with the labeled sample already loaded.
if (location.hash === '#trace') loadSample('json');
