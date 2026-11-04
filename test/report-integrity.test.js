// Regression tests for report integrity: a matching snapshot hash must not let callers bind altered
// scope/customer/quantity/path/warning content to a genuine snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importCandidate, traceForward, traceBackward, buildReport, reportToJson, reportToCsv, parseReportCsv,
} from '../src/index.js';
import { NOW, fixture, throwsCode, acceptedWorkspace } from './helpers.js';

const setup = () => {
  const ws = acceptedWorkspace();
  const s = ws.currentSnapshot();
  return { ws, s, t: traceForward(s, 'A') };
};

test('reported independent case: altered quantity/customers/shipments/paths is rejected, not bound to the hash', () => {
  const { s, t } = setup();
  const altered = { ...t, affectedShippedQuantity: 1, customers: [], shipments: [], paths: [] };
  throwsCode(() => buildReport(s, altered), 'TRACE_MISMATCH');
});

test('every single-field alteration of a genuine trace is rejected', () => {
  const { s, t } = setup();
  const edits = {
    quantity: (x) => { x.affectedShippedQuantity = 59999; },
    customerDropped: (x) => { x.customers = x.customers.filter((c) => c.customerId !== 'C2'); },
    customerQuantity: (x) => { x.customers[0].affectedReceived = 1; },
    customerAdded: (x) => { x.customers.push({ customerId: 'C3', name: 'x', affectedReceived: 0, unit: 'g' }); },
    scopeLot: (x) => { x.lots = x.lots.filter((l) => l !== 'M'); },
    scopeTransformation: (x) => { x.transformations = ['T1']; },
    scopeShipment: (x) => { x.shipments = ['S1']; },
    shipmentDetail: (x) => { x.shipmentDetails[0].quantity = 1; },
    pathDropped: (x) => { x.paths.pop(); },
    pathText: (x) => { x.paths[0].text = 'A safe'; },
    pathsComplete: (x) => { x.pathsComplete = false; },
    warningsDropped: (x) => { x.warnings = []; },
    warningText: (x) => { x.warnings[1].message = 'All other customers certified safe.'; },
    batchId: (x) => { x.snapshotBatchId = 'OTHER'; },
    unit: (x) => { x.unit = 'kg'; },
    extraField: (x) => { x.verdict = 'safe'; },
    missingField: (x) => { delete x.warnings; },
    scopeSwap: (x) => { x.affectedInputLot = 'U'; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const x = structuredClone(t);
    edit(x);
    assert.throws(() => buildReport(s, x), (e) => e.code === 'TRACE_MISMATCH', name);
  }
  // Mutating the genuine object in place is also caught.
  t.customers[1].affectedReceived = 0;
  throwsCode(() => buildReport(s, t), 'TRACE_MISMATCH');
  throwsCode(() => buildReport(s, { ...t, snapshotHash: 'f'.repeat(64) }), 'SNAPSHOT_MISMATCH');
});

test('trace from another accepted snapshot, malformed traces and malformed snapshots are rejected', () => {
  const { s, t } = setup();
  const f = fixture();
  f.batchId = 'TC-SYN-001-B';
  const other = importCandidate(JSON.stringify(f), { format: 'json' });
  assert.equal(other.ok, true);
  throwsCode(() => buildReport(s, traceForward(other.snapshot, 'A')), 'SNAPSHOT_MISMATCH');
  throwsCode(() => buildReport(other.snapshot, t), 'SNAPSHOT_MISMATCH');
  for (const bad of [null, undefined, 42, 'A', [], traceBackward(s, 'M'), { ...t, direction: 'backward' }]) {
    throwsCode(() => buildReport(s, bad), 'BAD_REPORT');
  }
  throwsCode(() => buildReport(s, { ...t, affectedInputLot: 7 }), 'BAD_REPORT');
  throwsCode(() => buildReport(s, { ...t, affectedInputLot: 'NOPE' }), 'UNKNOWN_LOT');
  throwsCode(() => buildReport(s, { ...t, affectedShippedQuantity: 60000n }), 'TRACE_MISMATCH');
  const cyclic = structuredClone(t);
  cyclic.self = cyclic;
  throwsCode(() => buildReport(s, cyclic), 'TRACE_MISMATCH');
  for (const forged of [null, undefined, {}, JSON.parse(JSON.stringify(s)), Object.freeze({ ...s })]) {
    throwsCode(() => buildReport(forged, t), 'NO_SNAPSHOT');
  }
});

test('annotations and report options are validated; genuine report round-trips', () => {
  const { ws, s, t } = setup();
  const ann = ws.addAnnotation({ reviewer: 'QA-1', targetType: 'event', targetId: 'T2', note: '=HYPERLINK("x") <script>' });
  for (const opts of [null, 'x', []]) throwsCode(() => buildReport(s, t, [], opts), 'BAD_ARGUMENT');
  throwsCode(() => buildReport(s, t, [], { generatedAt: '2026-02-30T00:00:00Z' }), 'BAD_ARGUMENT');
  throwsCode(() => buildReport(s, t, null), 'BAD_ARGUMENT');
  throwsCode(() => buildReport(s, t, 'ann'), 'BAD_ARGUMENT');
  for (const bad of [null, [], { ...ann, extra: 1 }, { ...ann, note: 5 }, { ...ann, snapshotHash: 'f'.repeat(64) },
    { ...ann, targetId: 'NOPE' }, { ...ann, targetType: 'shipment' }, { ...ann, createdAt: 'yesterday' }]) {
    throwsCode(() => buildReport(s, t, [bad]), 'BAD_ANNOTATION');
  }

  // A structurally identical copy (any key order) is accepted; the report carries the recomputed golden values.
  const reordered = Object.fromEntries(Object.entries(structuredClone(t)).reverse());
  const report = buildReport(s, reordered, ws.annotations(), { generatedAt: NOW });
  assert.equal(report.affectedShippedQuantity, 60000);
  assert.deepEqual(report.customers.map((c) => [c.customerId, c.affectedReceived]), [['C1', 30000], ['C2', 30000]]);
  assert.deepEqual(report.scope.shipments, ['S1', 'S2', 'S5']);
  assert.deepEqual(report.snapshot, { batchId: s.batchId, contentHash: s.contentHash });
  const json = JSON.parse(reportToJson(report));
  assert.deepEqual(parseReportCsv(reportToCsv(report)), json);
  assert.deepEqual(JSON.parse(ws.exportReport('A', { generatedAt: NOW })), json);
});
