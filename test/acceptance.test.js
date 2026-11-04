// Spec acceptance items 1-10 for TC-SYN-001. Expected values are literals from the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importCandidate, traceForward, traceBackward, eventEvidence, queryRecords, parseReportCsv, WorkspaceRegistry,
  REJECTION_COMPLETENESS_MESSAGE, SYNTHETIC_LABEL, DISCLAIMER, RULE_VERSION, SCHEMA_VERSION, REPORT_SCHEMA_VERSION,
} from '../src/index.js';
import {
  JSON_TEXT, CSV_TEXT, NOW, fixture, codes, findErr, throwsCode, newWorkspace, acceptedWorkspace, rejectOverPrior,
  diamondBatch,
} from './helpers.js';

const GOLDEN_PATHS = [
  'A -[transformation:T1]-> A1 -[shipment:S1]-> C1',
  'A -[transformation:T1]-> A2 -[transformation:T2]-> M -[shipment:S2]-> C2',
  'A -[transformation:T1]-> A2 -[transformation:T2]-> M -[shipment:S5]-> C1',
];

function assertGolden(snapshot) {
  const f = traceForward(snapshot, 'A');
  assert.deepEqual(f.lots, ['A', 'A1', 'A2', 'M']);
  assert.deepEqual(f.transformations, ['T1', 'T2']);
  assert.deepEqual(f.shipments, ['S1', 'S2', 'S5']);
  assert.deepEqual(f.customers.map((c) => [c.customerId, c.affectedReceived, c.unit]), [['C1', 30000, 'g'], ['C2', 30000, 'g']]);
  assert.equal(f.affectedShippedQuantity, 60000);
  assert.deepEqual(f.paths.map((p) => p.text), GOLDEN_PATHS);
  assert.equal(f.pathsComplete, true);
  assert.deepEqual(snapshot.inventory.remaining, [
    { lotId: 'A', grams: 0 }, { lotId: 'A1', grams: 40000 }, { lotId: 'A2', grams: 0 },
    { lotId: 'B', grams: 20000 }, { lotId: 'M', grams: 20000 }, { lotId: 'U', grams: 15000 },
  ]);
  assert.equal(snapshot.inventory.totalReceived, 170000);
  assert.equal(snapshot.inventory.totalShipped, 75000);
  assert.equal(snapshot.inventory.totalRemaining, 95000);
  const b = traceBackward(snapshot, 'M');
  assert.deepEqual(b.ancestors, ['A', 'A2', 'B']);
  assert.deepEqual(b.rootLots, ['A', 'B']);
  assert.deepEqual(b.transformations, ['T1', 'T2']);
  return f;
}

function shuffledJson() {
  const o = fixture();
  for (const k of ['lots', 'customers', 'events', 'receipts', 'transformations', 'shipments']) o[k].reverse();
  o.events.push(o.events.shift());
  for (const t of o.transformations) { t.inputs.reverse(); t.outputs.reverse(); }
  return JSON.stringify(o);
}

test('1. golden TC-SYN-001: literal sets/quantities, JSON==CSV, order-independent', () => {
  const j = importCandidate(JSON_TEXT, { format: 'json' });
  const c = importCandidate(CSV_TEXT, { format: 'csv' });
  assert.equal(j.ok, true);
  assert.equal(c.ok, true);
  assert.equal(j.snapshot.contentHash, c.snapshot.contentHash, 'JSON and CSV fixtures must canonicalize identically');
  const f = assertGolden(j.snapshot);
  assertGolden(c.snapshot);
  // C3/C4 and U are excluded; no fictional fraction/probability is emitted.
  assert.ok(!f.customers.some((x) => x.customerId === 'C3' || x.customerId === 'C4'));
  assert.ok(!f.lots.includes('U') && !f.lots.includes('B'));
  JSON.stringify(f, (k, v) => {
    assert.doesNotMatch(k, /probab|fraction|ratio|share|percent/i, `unexpected apportioning field ${k}`);
    if (typeof v === 'number') assert.ok(Number.isInteger(v), `non-integer ${k}=${v}`);
    return v;
  });
  assert.ok(f.warnings.some((w) => w.code === 'CONSERVATIVE_PROPAGATION'));

  const sj = importCandidate(shuffledJson(), { format: 'json' });
  assert.equal(sj.ok, true);
  assert.equal(sj.snapshot.contentHash, j.snapshot.contentHash);
  assert.deepEqual(traceForward(sj.snapshot, 'A').paths.map((p) => p.text), GOLDEN_PATHS);

  const [header, ...rows] = CSV_TEXT.trim().split('\n');
  const permuted = [header, ...rows.reverse()].join('\n');
  const sc = importCandidate(permuted, { format: 'csv' });
  assert.equal(sc.ok, true);
  assert.equal(sc.snapshot.contentHash, j.snapshot.contentHash);
  assertGolden(sc.snapshot);
});

test('2. S5 = 30001 g after S2 rejects with exact 1 g shortfall; no partial import', () => {
  const o = fixture();
  o.batchId = 'TC-SYN-001-BAD2';
  o.shipments.find((s) => s.eventId === 'S5').quantity = 30001;
  const { r } = rejectOverPrior(JSON.stringify(o));
  assert.equal(r.submittedBatchId, 'TC-SYN-001-BAD2');
  const e = findErr(r, 'INSUFFICIENT_INVENTORY');
  assert.ok(e, `expected INSUFFICIENT_INVENTORY in ${codes(r)}`);
  assert.equal(e.eventId, 'S5');
  assert.equal(e.lotId, 'M');
  assert.equal(e.observed, 30001);
  assert.equal(e.expected, 30000);
  assert.equal(e.difference, 1);
  assert.equal(e.unit, 'g');
  assert.equal(e.sourceRow, 'json:/shipments/4');
  assert.match(e.message, /short by 1 g/);
});

test('3. T2 output 59999: loss 0 is a 1 g mismatch; loss 1 passes and preserves provenance', () => {
  const o = fixture();
  o.batchId = 'TC-SYN-001-BAD3';
  o.transformations[1].outputs[0].quantity = 59999;
  const { r } = rejectOverPrior(JSON.stringify(o));
  const e = findErr(r, 'MASS_BALANCE_MISMATCH');
  assert.ok(e);
  assert.equal(e.eventId, 'T2');
  assert.equal(e.observed, 60000);
  assert.equal(e.expected, 59999);
  assert.equal(e.difference, 1);
  assert.equal(e.sourceRow, 'json:/transformations/1');

  o.batchId = 'TC-SYN-001-LOSS1';
  o.transformations[1].configuredLoss = 1;
  const ws = newWorkspace();
  const ok = ws.importBatch(JSON.stringify(o), { format: 'json' });
  assert.equal(ok.status, 'accepted');
  const ev = ws.evidence('T2').result;
  assert.deepEqual(ev.detail.inputs.map((l) => [l.lotId, l.quantity, l.sourceRow]),
    [['A2', 40000, 'json:/transformations/1/inputs/0'], ['B', 20000, 'json:/transformations/1/inputs/1']]);
  assert.deepEqual(ev.detail.outputs.map((l) => [l.lotId, l.quantity]), [['M', 59999]]);
  assert.deepEqual(ev.massBalance, { inputGrams: 60000, outputGrams: 59999, configuredLoss: 1, balanced: true, unit: 'g' });
  assert.equal(ev.event.sourceReference, 'SYN-DOC-T2');
  const s = ok.snapshot;
  assert.equal(s.inventory.totalConfiguredLoss, 1);
  assert.equal(s.inventory.totalRemaining, 94999);
  assert.deepEqual(traceBackward(s, 'M').ancestors, ['A', 'A2', 'B']);
  assert.deepEqual(traceForward(s, 'A').customers.map((c) => c.customerId), ['C1', 'C2']);
});

test('4. missing reference, duplicate ID, duplicate creation, missing customer reject; labels never merge', () => {
  const missingA2 = fixture();
  missingA2.batchId = 'TC-SYN-001-BAD4A';
  missingA2.lots = missingA2.lots.filter((l) => l.id !== 'A2');
  let { r } = rejectOverPrior(JSON.stringify(missingA2));
  assert.ok(r.errors.some((e) => e.code === 'MISSING_REFERENCE' && e.lotId === 'A2' && e.eventId === 'T1'));
  assert.ok(r.errors.some((e) => e.code === 'MISSING_REFERENCE' && e.lotId === 'A2' && e.eventId === 'T2'));

  const dupS1 = fixture();
  dupS1.batchId = 'TC-SYN-001-BAD4B';
  dupS1.events.push({ ...dupS1.events.find((e) => e.id === 'S1'), timestamp: '2026-01-10T08:00:00Z' });
  ({ r } = rejectOverPrior(JSON.stringify(dupS1)));
  const d = findErr(r, 'DUPLICATE_ID');
  assert.equal(d.id, 'S1');
  assert.equal(d.kind, 'event');
  assert.equal(d.sourceRow, 'json:/events/10');

  const dupCreate = fixture();
  dupCreate.batchId = 'TC-SYN-001-BAD4C';
  dupCreate.events.push({ id: 'R-M', type: 'receipt', timestamp: '2026-01-05T11:00:00Z', facilityId: 'FAC-SYN-1', sourceReference: 'SYN-DOC-R-M' });
  dupCreate.receipts.push({ eventId: 'R-M', lotId: 'M', quantity: 5 });
  ({ r } = rejectOverPrior(JSON.stringify(dupCreate)));
  const dc = findErr(r, 'DUPLICATE_CREATION');
  assert.equal(dc.lotId, 'M');
  assert.deepEqual([...dc.eventIds].sort(), ['R-M', 'T2']);

  const noCustomer = fixture();
  noCustomer.batchId = 'TC-SYN-001-BAD4D';
  delete noCustomer.shipments[2].customerId;
  ({ r } = rejectOverPrior(JSON.stringify(noCustomer)));
  assert.ok(r.errors.some((e) => e.code === 'MISSING_FIELD' && e.field === 'shipment.customerId' && e.sourceRow === 'json:/shipments/2'));

  const unknownCustomer = fixture();
  unknownCustomer.batchId = 'TC-SYN-001-BAD4E';
  unknownCustomer.shipments[2].customerId = 'C9';
  ({ r } = rejectOverPrior(JSON.stringify(unknownCustomer)));
  assert.ok(r.errors.some((e) => e.code === 'MISSING_REFERENCE' && e.customerId === 'C9'));

  const sameLabels = fixture();
  for (const c of sameLabels.customers) c.name = 'Fictional Shared Display Name';
  for (const l of sameLabels.lots) l.label = 'Same Label';
  const res = importCandidate(JSON.stringify(sameLabels), { format: 'json' });
  assert.equal(res.ok, true);
  const f = traceForward(res.snapshot, 'A');
  assert.deepEqual(f.customers.map((c) => [c.customerId, c.affectedReceived]), [['C1', 30000], ['C2', 30000]]);
  assert.equal(res.snapshot.lots.length, 6);
  assert.equal(res.snapshot.customers.length, 4);
});

test('5. self-loop and A->A1->A cycle reject before traversal; traversal is resource-bounded', () => {
  const self = fixture();
  self.batchId = 'TC-SYN-001-SELF';
  self.transformations[0].outputs.push({ lotId: 'A', quantity: 1 });
  self.transformations[0].outputs[0].quantity = 59999;
  let { r } = rejectOverPrior(JSON.stringify(self));
  assert.ok(r.errors.some((e) => e.code === 'CYCLE' && e.lotId === 'A' && e.eventId === 'T1'));

  const cyc = fixture();
  cyc.batchId = 'TC-SYN-001-CYCLE';
  cyc.events.push({ id: 'T3', type: 'transformation', timestamp: '2026-01-06T09:00:00Z', facilityId: 'FAC-SYN-2', sourceReference: 'SYN-DOC-T3' });
  cyc.transformations.push({ eventId: 'T3', inputs: [{ lotId: 'A1', quantity: 1000 }], outputs: [{ lotId: 'A', quantity: 1000 }], configuredLoss: 0 });
  ({ r } = rejectOverPrior(JSON.stringify(cyc)));
  const ce = r.errors.find((e) => e.code === 'CYCLE');
  assert.ok(ce);
  assert.deepEqual(ce.lotIds, ['A', 'A1']);
  assert.ok(!codes(r).includes('INSUFFICIENT_INVENTORY'), 'ledger/traversal must not run on a cyclic batch');

  // A forged frozen cyclic graph never reaches traversal code.
  const forged = Object.freeze({ kind: 'tracechain.snapshot', lots: [{ id: 'A' }], transformations: [{ eventId: 'T', inputs: [{ lotId: 'A' }], outputs: [{ lotId: 'A' }] }], shipments: [], customers: [] });
  throwsCode(() => traceForward(forged, 'A'), 'NO_SNAPSHOT');
  throwsCode(() => traceBackward(forged, 'A'), 'NO_SNAPSHOT');

  // 2^20 contributing paths: listing is truncated and flagged, lot/customer sets stay complete, no hang.
  const res = importCandidate(JSON.stringify(diamondBatch(20)), { format: 'json' });
  assert.equal(res.ok, true);
  const t0 = Date.now();
  const f = traceForward(res.snapshot, 'L0');
  const b = traceBackward(res.snapshot, 'L20');
  assert.ok(Date.now() - t0 < 5000, 'bounded traversal should finish quickly');
  assert.equal(f.lots.length, 61);
  assert.deepEqual(f.customers.map((c) => [c.customerId, c.affectedReceived]), [['C1', 2]]);
  assert.equal(f.pathsComplete, false);
  assert.ok(f.paths.length > 0 && f.paths.length <= 10000);
  assert.ok(f.warnings.some((w) => w.code === 'PATHS_TRUNCATED'));
  assert.equal(b.ancestors.length, 60);
  assert.equal(b.pathsComplete, false);
  assert.ok(b.warnings.some((w) => w.code === 'PATHS_TRUNCATED'));
});

test('6. shipment before creation, ambiguous equal timestamps and invalid dates reject', () => {
  const early = fixture();
  early.batchId = 'TC-SYN-001-EARLY';
  early.events.find((e) => e.id === 'S1').timestamp = '2026-01-06T07:59:59Z';
  let { r } = rejectOverPrior(JSON.stringify(early));
  const e = findErr(r, 'SHIPMENT_BEFORE_CREATION');
  assert.equal(e.eventId, 'S1');
  assert.equal(e.lotId, 'A1');

  const tie = fixture();
  tie.batchId = 'TC-SYN-001-TIE';
  tie.events.find((x) => x.id === 'S1').timestamp = '2026-01-06T08:00:00Z';
  ({ r } = rejectOverPrior(JSON.stringify(tie)));
  assert.deepEqual(findErr(r, 'AMBIGUOUS_ORDER').eventIds, ['S1', 'T1']);

  tie.events.find((x) => x.id === 'T1').sequence = 1;
  tie.events.find((x) => x.id === 'S1').sequence = 2;
  const ordered = importCandidate(JSON.stringify(tie), { format: 'json' });
  assert.equal(ordered.ok, true);
  assertGolden(ordered.snapshot);

  tie.events.find((x) => x.id === 'T1').sequence = 2;
  tie.events.find((x) => x.id === 'S1').sequence = 1;
  ({ r } = rejectOverPrior(JSON.stringify(tie)));
  assert.equal(findErr(r, 'SHIPMENT_BEFORE_CREATION').eventId, 'S1');

  for (const ts of ['2026-02-30T08:00:00Z', '2025-02-29T08:00:00Z', '2026-13-01T08:00:00Z', '2026-01-05T24:00:00Z',
    '2026-01-05T08:60:00Z', '2026-01-05 08:00:00Z', '2026-01-05T08:00:00+01:00', '2026-01-05T08:00:00', 'yesterday', '1969-12-31T23:59:59Z']) {
    const bad = fixture();
    bad.batchId = 'TC-SYN-001-DATE';
    bad.events[0].timestamp = ts;
    ({ r } = rejectOverPrior(JSON.stringify(bad)));
    assert.ok(r.errors.some((x) => x.code === 'INVALID_TIMESTAMP' && x.sourceRow === 'json:/events/0'), ts);
  }
  const leap = fixture();
  leap.events[0].timestamp = '2024-02-29T08:00:00Z';
  assert.equal(importCandidate(JSON.stringify(leap), { format: 'json' }).ok, true);
});

test('7. zero/negative/fractional/exponent/unsafe/overflow quantities and mixed units reject (raw lexemes)', () => {
  const s1 = '"lotId": "A1", "quantity": 20000';
  const cases = [
    ['0', 'NON_POSITIVE_QUANTITY'], ['-5', 'NON_POSITIVE_QUANTITY'], ['-0', 'NON_POSITIVE_QUANTITY'],
    ['20000.5', 'FRACTIONAL_QUANTITY'], ['20000.0', 'FRACTIONAL_QUANTITY'], ['2e4', 'EXPONENT_NOTATION'],
    ['2E+4', 'EXPONENT_NOTATION'], ['9007199254740993', 'UNSAFE_INTEGER'], ['123456789012345678901234567890', 'UNSAFE_INTEGER'],
    ['"20000"', 'INVALID_QUANTITY'], ['"20 kg"', 'INVALID_QUANTITY'], ['null', 'MISSING_FIELD'], ['true', 'INVALID_QUANTITY'],
  ];
  for (const [lexeme, code] of cases) {
    const text = JSON_TEXT.replace(s1, `"lotId": "A1", "quantity": ${lexeme}`).replace('"TC-SYN-001"', '"TC-SYN-001-Q"');
    assert.notEqual(text, JSON_TEXT);
    const { r } = rejectOverPrior(text);
    assert.ok(r.errors.some((e) => e.code === code && e.sourceRow === 'json:/shipments/0'), `${lexeme} -> ${code}; got ${codes(r)}`);
  }
  // Mixed units: never converted (20 kg is not inferred as 20000 g).
  const kg = fixture();
  kg.batchId = 'TC-SYN-001-KG';
  kg.shipments[0].quantity = 20;
  kg.shipments[0].unit = 'kg';
  let { r } = rejectOverPrior(JSON.stringify(kg));
  assert.ok(r.errors.some((e) => e.code === 'MIXED_UNIT' && e.observed === 'kg'));
  const lotKg = fixture();
  lotKg.batchId = 'TC-SYN-001-KG2';
  lotKg.lots[0].unit = 'kg';
  ({ r } = rejectOverPrior(JSON.stringify(lotKg)));
  assert.ok(r.errors.some((e) => e.code === 'MIXED_UNIT' && e.field === 'lot.unit'));

  const csvRow = 'shipment,,,,,,,,S1,A1,,,20000,C1,,';
  for (const [cell, code] of [['20kg', 'MIXED_UNIT'], ['20 kg', 'MIXED_UNIT'], ['2e4', 'EXPONENT_NOTATION'], ['20000.0', 'FRACTIONAL_QUANTITY'],
    ['"20,000"', 'INVALID_QUANTITY'], ['+20000', 'INVALID_QUANTITY'], ['0x4e20', 'INVALID_QUANTITY'], ['-1', 'NON_POSITIVE_QUANTITY'],
    ['0', 'NON_POSITIVE_QUANTITY'], ['9007199254740992', 'UNSAFE_INTEGER']]) {
    const text = CSV_TEXT.replace(csvRow, `shipment,,,,,,,,S1,A1,,,${cell},C1,,`).replace('batch,TC-SYN-001,', 'batch,TC-SYN-001-CSVQ,');
    assert.notEqual(text, CSV_TEXT);
    ({ r } = rejectOverPrior(text, 'csv'));
    assert.ok(r.errors.some((e) => e.code === code), `csv ${cell} -> ${code}; got ${codes(r)}`);
  }

  // Each value is a safe integer but the sums overflow: checked arithmetic rejects instead of rounding.
  const big = fixture();
  big.batchId = 'TC-SYN-001-OVF';
  big.receipts[0].quantity = 9007199254740991;
  big.receipts[1].quantity = 9007199254740991;
  ({ r } = rejectOverPrior(JSON.stringify(big)));
  assert.ok(codes(r).includes('ARITHMETIC_OVERFLOW'), String(codes(r)));
  const bigMass = fixture();
  bigMass.batchId = 'TC-SYN-001-OVF2';
  bigMass.transformations[1].inputs[0].quantity = 9007199254740991;
  ({ r } = rejectOverPrior(JSON.stringify(bigMass)));
  assert.ok(r.errors.some((e) => e.code === 'ARITHMETIC_OVERFLOW' && e.eventId === 'T2'));
});

test('8. removing T2 but keeping M shipments rejects atomically with completeness diagnostic; unknown lot is an error', () => {
  const o = fixture();
  o.batchId = 'TC-SYN-001-NO-T2';
  o.events = o.events.filter((e) => e.id !== 'T2');
  o.transformations = o.transformations.filter((t) => t.eventId !== 'T2');
  const { ws, r, prior } = rejectOverPrior(JSON.stringify(o));
  const m = findErr(r, 'MISSING_CREATION_LINEAGE');
  assert.equal(m.lotId, 'M');
  assert.equal(m.sourceRow, 'json:/lots/5');
  assert.equal(r.completeness, 'Trace completeness cannot be evaluated for this rejected batch');
  assert.equal(r.submittedBatchId, 'TC-SYN-001-NO-T2');
  assert.ok(r.submittedRowIds.lots.some((x) => x.id === 'M'));
  assert.ok(!('customers' in r) && !('paths' in r) && !('trace' in r));
  assert.ok(Object.isFrozen(r));
  // Subsequent traces come from the prior snapshot and say so; they are never the rejected batch's result.
  const t = ws.traceForward('A');
  assert.equal(t.snapshotBatchId, 'TC-SYN-001');
  assert.equal(t.snapshotHash, prior.contentHash);
  assert.match(t.snapshotLabel, /TC-SYN-001/);
  // The rejected candidate itself cannot be traced.
  const pure = importCandidate(JSON.stringify(o), { format: 'json' });
  assert.equal(pure.ok, false);
  throwsCode(() => traceForward(pure.candidate, 'A'), 'NO_SNAPSHOT');
  // No prior snapshot: label says so and tracing is an explicit error.
  const fresh = newWorkspace();
  const fr = fresh.importBatch(JSON.stringify(o), { format: 'json' });
  assert.equal(fr.priorSnapshot.batchId, null);
  assert.match(fr.priorSnapshot.label, /No prior accepted snapshot/);
  throwsCode(() => fresh.traceForward('A'), 'NO_SNAPSHOT');
  // Unknown lot: explicit error, never an empty "safe" result.
  for (const bad of ['ZZZ', 'a', 42, undefined, null, { id: 'A' }]) {
    throwsCode(() => ws.traceForward(bad), 'UNKNOWN_LOT');
    throwsCode(() => ws.traceBackward(bad), 'UNKNOWN_LOT');
  }
  assert.throws(() => ws.traceForward('ZZZ'), /NOT a "no affected customers" result/);
  // Restore: a valid import is accepted again.
  assert.equal(ws.importBatch(CSV_TEXT, { format: 'csv' }).status, 'accepted');
});

test('9. security: size/record/string bounds, no fetch/binary, inert script, formula escaping, session isolation', () => {
  const big = `{"pad":"${'x'.repeat(1024 * 1024)}"}`;
  assert.deepEqual(codes(importCandidate(big, { format: 'json' })), ['INPUT_TOO_LARGE']);
  const many = fixture();
  many.customers = Array.from({ length: 5001 }, (_, i) => ({ id: `C${i}`, name: 'Fictional' }));
  assert.deepEqual(codes(importCandidate(JSON.stringify(many), { format: 'json' })), ['TOO_MANY_RECORDS']);
  const longName = fixture();
  longName.customers[0].name = 'n'.repeat(257);
  assert.ok(codes(importCandidate(JSON.stringify(longName), { format: 'json' })).includes('STRING_TOO_LONG'));
  const longId = fixture();
  longId.lots[0].id = 'L'.repeat(65);
  assert.ok(codes(importCandidate(JSON.stringify(longId), { format: 'json' })).includes('STRING_TOO_LONG'));
  assert.deepEqual(codes(importCandidate(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { format: 'json' })), ['INVALID_UTF8']);
  for (const magic of [[0x50, 0x4b, 0x03, 0x04], [0x25, 0x50, 0x44, 0x46], [0x4d, 0x5a, 0x90, 0x00], [0x1f, 0x8b, 0x08]]) {
    assert.deepEqual(codes(importCandidate(new Uint8Array(magic), { format: 'csv' })), ['BINARY_INPUT']);
  }
  // Strings are content, never URLs/paths to fetch or read.
  assert.deepEqual(codes(importCandidate('https://example.invalid/batch.json', { format: 'json' })), ['JSON_SYNTAX']);
  assert.deepEqual(codes(importCandidate('./fixtures/TC-SYN-001.json', { format: 'json' })), ['JSON_SYNTAX']);
  assert.deepEqual(codes(importCandidate(new URL('file:///etc/hosts'), { format: 'json' })), ['INPUT_TYPE']);
  // Dangerous keys and duplicate keys.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const text = JSON_TEXT.replace('"synthetic": true,', `"synthetic": true, "${key}": {"polluted": true},`);
    assert.deepEqual(codes(importCandidate(text, { format: 'json' })), ['DANGEROUS_KEY']);
  }
  assert.equal({}.polluted, undefined);
  assert.deepEqual(codes(importCandidate(JSON_TEXT.replace('"synthetic": true,', '"synthetic": true, "synthetic": true,'), { format: 'json' })), ['DUPLICATE_KEY']);
  assert.ok(codes(importCandidate(JSON_TEXT.replace('"synthetic": true', '"synthetic": false'), { format: 'json' })).includes('NOT_SYNTHETIC'));

  // Script text stays inert data; formula prefixes are escaped in CSV and round-trip exactly.
  const hostile = fixture();
  hostile.customers[0].name = '=HYPERLINK("http://example.invalid","x")';
  hostile.customers[1].name = '<script>alert(1)</script>';
  const ws = newWorkspace();
  assert.equal(ws.importBatch(JSON.stringify(hostile), { format: 'json' }).status, 'accepted');
  ws.addAnnotation({ reviewer: 'QA-REVIEWER-1', targetType: 'event', targetId: 'T2', note: '+cmd|calc; @SUM(1,2) -2 check' });
  const csv = ws.exportReport('A', { format: 'csv', generatedAt: NOW });
  for (const line of csv.split('\r\n')) {
    for (const cell of line.split(',')) assert.doesNotMatch(cell, /^"?[=+\-@]/, `unescaped formula cell: ${cell}`);
  }
  assert.ok(csv.includes(`"'=HYPERLINK(""http://example.invalid"",""x"")"`));
  assert.ok(csv.includes("'+cmd|calc; @SUM(1,2) -2 check"));
  const back = parseReportCsv(csv);
  assert.equal(back.customers.find((c) => c.customerId === 'C1').name, '=HYPERLINK("http://example.invalid","x")');
  assert.equal(back.customers.find((c) => c.customerId === 'C2').name, '<script>alert(1)</script>');
  assert.equal(back.annotations[0].note, '+cmd|calc; @SUM(1,2) -2 check');
  const json = JSON.parse(ws.exportReport('A', { format: 'json', generatedAt: NOW }));
  assert.equal(json.customers[1].name, '<script>alert(1)</script>');

  // Fixture is fictional: no emails, secrets or real-looking names.
  assert.doesNotMatch(JSON_TEXT + CSV_TEXT, /@|password|secret|api[_-]?key|token/i);
  assert.ok(fixture().customers.every((c) => c.name.startsWith('Fictional ')));

  // Session isolation: one visitor's imports/annotations never touch another's.
  const reg = new WorkspaceRegistry({ now: () => NOW });
  const a = reg.get('visitor-aaaa-1');
  const b = reg.get('visitor-bbbb-2');
  a.importBatch(JSON_TEXT, { format: 'json' });
  a.addAnnotation({ reviewer: 'QA-A', targetType: 'lot', targetId: 'A', note: 'A only' });
  const bad = fixture();
  bad.batchId = 'TC-SYN-001-B';
  bad.lots.pop();
  assert.equal(b.importBatch(JSON.stringify(bad), { format: 'json' }).status, 'rejected');
  assert.equal(a.currentSnapshot().batchId, 'TC-SYN-001');
  assert.equal(b.currentSnapshot(), null);
  assert.deepEqual(b.annotations(), []);
  assert.equal(a.annotations().length, 1);
  assert.equal(reg.get('visitor-aaaa-1'), a);
  for (const id of ['../../a', 'short', '', 42, null, 'x'.repeat(65), 'visitor a b']) throwsCode(() => reg.get(id), 'INVALID_SESSION');
  // Prototype-like session names are ordinary isolated keys (Map-backed), not object-prototype lookups.
  const proto = reg.get('__proto__');
  assert.notEqual(proto, a);
  assert.equal(proto.currentSnapshot(), null);
  const snap = a.currentSnapshot();
  assert.throws(() => { snap.lots[0].id = 'HACK'; }, TypeError);
  assert.throws(() => { snap.shipments.push({}); }, TypeError);
  assert.equal(snap.lots[0].id, 'A');
});

test('10. export round-trip: scope, units, all paths, warnings, versions, synthetic label, snapshot, annotations', () => {
  const ws = acceptedWorkspace();
  const snapBefore = JSON.stringify(ws.currentSnapshot());
  const evBefore = JSON.stringify(ws.evidence('T2'));
  const ann = ws.addAnnotation({ reviewer: 'QA-REVIEWER-1', targetType: 'event', targetId: 'T2', note: 'Inspected T2 input/output evidence.' });
  assert.equal(ann.createdAt, NOW);
  assert.equal(ann.snapshotBatchId, 'TC-SYN-001');
  // Annotations sit beside the snapshot; source records are untouched.
  assert.equal(JSON.stringify(ws.currentSnapshot()), snapBefore);
  assert.equal(JSON.stringify(ws.evidence('T2')), evBefore);

  const json = JSON.parse(ws.exportReport('A', { format: 'json', generatedAt: NOW }));
  assert.equal(json.reportSchemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(json.schemaVersion, SCHEMA_VERSION);
  assert.equal(json.ruleVersion, RULE_VERSION);
  assert.equal(json.synthetic, true);
  assert.equal(json.syntheticLabel, SYNTHETIC_LABEL);
  assert.equal(json.disclaimer, DISCLAIMER);
  assert.match(json.disclaimer, /NOT certified safe/);
  assert.deepEqual(json.snapshot, { batchId: 'TC-SYN-001', contentHash: ws.currentSnapshot().contentHash });
  assert.deepEqual(json.scope, { direction: 'forward', affectedInputLot: 'A', unit: 'g', lots: ['A', 'A1', 'A2', 'M'], transformations: ['T1', 'T2'], shipments: ['S1', 'S2', 'S5'] });
  assert.equal(json.units, 'g');
  assert.equal(json.affectedShippedQuantity, 60000);
  assert.deepEqual(json.paths.map((p) => p.text), GOLDEN_PATHS);
  assert.equal(json.pathsComplete, true);
  assert.deepEqual(json.warnings.map((w) => [w.code, w.lotId, w.grams]), [
    ['CONSERVATIVE_PROPAGATION', undefined, undefined], ['EVIDENCE_SCOPE', undefined, undefined],
    ['AFFECTED_INVENTORY_ON_HAND', 'A1', 40000], ['AFFECTED_INVENTORY_ON_HAND', 'M', 20000],
  ]);
  assert.deepEqual(json.annotations, [{ ...ann }]);

  const csv = ws.exportReport('A', { format: 'csv', generatedAt: NOW });
  assert.deepEqual(parseReportCsv(csv), json, 'CSV export must round-trip to the JSON report exactly');
  // Deterministic output for the same snapshot, annotations and clock.
  assert.equal(ws.exportReport('A', { format: 'csv', generatedAt: NOW }), csv);
  // Search / filter / sort over the accepted snapshot returns copies.
  const s = ws.currentSnapshot();
  const rows = queryRecords(s, { collection: 'shipments', filter: { customerId: 'C1' }, sortBy: 'quantity', direction: 'desc' });
  assert.deepEqual(rows.map((x) => [x.eventId, x.quantity]), [['S1', 20000], ['S5', 10000]]);
  assert.deepEqual(queryRecords(s, { collection: 'events', search: 'syn-doc-t2' }).map((e) => e.id), ['T2']);
  rows[0].quantity = 1;
  assert.equal(s.shipments.find((x) => x.eventId === 'S1').quantity, 20000);
  assert.equal(eventEvidence(s, 'T2').massBalance.balanced, true);
});
