// Regression tests for review findings: prototype-named CSV record types, cross-product graph size,
// malformed caller values on public APIs, and malformed report CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importCandidate, traceForward, traceBackward, queryRecords, parseReportCsv, eventEvidence, Workspace, WorkspaceRegistry,
} from '../src/index.js';
import { JSON_TEXT, CSV_TEXT, NOW, codes, throwsCode, acceptedWorkspace, rejectOverPrior, wideBatch } from './helpers.js';

test('CSV recordType __proto__/constructor/toString/hasOwnProperty/valueOf is a diagnostic, not a TypeError', () => {
  for (const rt of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
    const text = CSV_TEXT.replace('customer,C4,', `${rt},C4,`).replace('batch,TC-SYN-001,', 'batch,TC-SYN-001-RT,');
    const { r } = rejectOverPrior(text, 'csv');
    assert.ok(r.errors.some((e) => e.code === 'UNKNOWN_RECORD_TYPE' && e.sourceRow === 'csv:line 12'), `${rt}: ${codes(r)}`);
  }
  assert.equal({}.C4, undefined);
});

test('wide 800x800 transformation imports without an inputs x outputs edge blow-up', () => {
  const t0 = Date.now();
  const res = importCandidate(JSON.stringify(wideBatch(800)), { format: 'json' });
  assert.equal(res.ok, true, JSON.stringify(res.errors?.slice(0, 3)));
  const f = traceForward(res.snapshot, 'I0');
  const b = traceBackward(res.snapshot, 'O0');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(f.lots.length, 801);
  assert.deepEqual(f.customers, []);
  assert.equal(b.ancestors.length, 800);
  assert.equal(b.pathsComplete, true);
  assert.equal(b.paths.length, 800);
  // Explicit sequences order the 800 same-timestamp receipts deterministically.
  assert.deepEqual(res.snapshot.events.slice(0, 3).map((e) => e.id), ['R0', 'R1', 'R2']);
  const dup = wideBatch(3);
  dup.events[2].sequence = 0;
  assert.ok(codes(importCandidate(JSON.stringify(dup), { format: 'json' })).includes('AMBIGUOUS_ORDER'));
});

test('public APIs reject malformed caller values with TraceChainError codes', () => {
  for (const opts of [null, 'json', 42, ['json']]) {
    assert.deepEqual(codes(importCandidate(JSON_TEXT, opts)), ['BAD_ARGUMENT']);
  }
  assert.deepEqual(codes(importCandidate(JSON_TEXT)), ['FORMAT']);
  assert.deepEqual(codes(importCandidate(JSON_TEXT, { format: 'xml' })), ['FORMAT']);
  for (const input of [undefined, null, 42, {}, ['x']]) {
    assert.deepEqual(codes(importCandidate(input, { format: 'json' })), ['INPUT_TYPE']);
  }
  assert.deepEqual(codes(importCandidate('', { format: 'csv' })), ['CSV_EMPTY']);
  assert.deepEqual(codes(importCandidate('[]', { format: 'json' })), ['JSON_SHAPE']);
  assert.deepEqual(codes(importCandidate('{"a":1} x', { format: 'json' })), ['JSON_SYNTAX']);
  assert.deepEqual(codes(importCandidate(`${'['.repeat(50)}${']'.repeat(50)}`, { format: 'json' })), ['JSON_TOO_DEEP']);

  throwsCode(() => new Workspace(null), 'BAD_ARGUMENT');
  throwsCode(() => new Workspace({ now: 'today' }), 'BAD_ARGUMENT');
  throwsCode(() => new WorkspaceRegistry(7), 'BAD_ARGUMENT');
  const ws = acceptedWorkspace();
  assert.equal(ws.importBatch(JSON_TEXT, null).status, 'rejected');
  throwsCode(() => ws.addAnnotation(null), 'BAD_ARGUMENT');
  throwsCode(() => ws.addAnnotation({ reviewer: 'QA-1', targetType: 'lot', targetId: 'NOPE', note: 'x' }), 'UNKNOWN_TARGET');
  throwsCode(() => ws.addAnnotation({ reviewer: 'QA-1', targetType: 'shipment', targetId: 'S1', note: 'x' }), 'INVALID_TARGET');
  throwsCode(() => ws.addAnnotation({ reviewer: 'QA-1', targetType: 'lot', targetId: 'A', note: 'bad\u0000note' }), 'CONTROL_CHARACTERS');
  throwsCode(() => ws.addAnnotation({ reviewer: 'QA-1', targetType: 'lot', targetId: 'A', note: '   ' }), 'INVALID_NOTE');
  throwsCode(() => ws.addAnnotation({ reviewer: 'QA-1', targetType: 'lot', targetId: 'A', note: 'n'.repeat(2001) }), 'INVALID_NOTE');
  assert.deepEqual(ws.annotations(), []);
  throwsCode(() => ws.exportReport('A', null), 'BAD_ARGUMENT');
  throwsCode(() => ws.exportReport('A', { generatedAt: 'yesterday' }), 'BAD_ARGUMENT');
  throwsCode(() => ws.exportReport('A', { generatedAt: '2026-02-30T00:00:00Z' }), 'BAD_ARGUMENT');
  throwsCode(() => ws.exportReport('A', { format: 'xml' }), 'FORMAT');
  throwsCode(() => ws.exportReport('NOPE'), 'UNKNOWN_LOT');
  throwsCode(() => ws.evidence('NOPE'), 'UNKNOWN_EVENT');
  for (const odd of [Object.create(null), Symbol('A'), 10n]) {
    throwsCode(() => ws.traceForward(odd), 'UNKNOWN_LOT');
    throwsCode(() => ws.evidence(odd), 'UNKNOWN_EVENT');
    throwsCode(() => queryRecords(ws.currentSnapshot(), { collection: odd }), 'BAD_QUERY');
  }
  throwsCode(() => new Workspace().exportReport('A'), 'NO_SNAPSHOT');

  const s = ws.currentSnapshot();
  throwsCode(() => queryRecords(s, null), 'BAD_ARGUMENT');
  throwsCode(() => queryRecords(s, { collection: 'lots', filter: null }), 'BAD_ARGUMENT');
  throwsCode(() => queryRecords(s, { collection: '__proto__' }), 'BAD_QUERY');
  throwsCode(() => queryRecords(s, { collection: 'lots', search: 5 }), 'BAD_QUERY');
  throwsCode(() => queryRecords(s, { collection: 'lots', sortBy: {} }), 'BAD_QUERY');
  throwsCode(() => queryRecords(s, { collection: 'lots', direction: 'sideways' }), 'BAD_QUERY');
  assert.equal(queryRecords(s, { collection: 'lots', sortBy: '__proto__' }).length, 6);
  assert.deepEqual(queryRecords(s, { collection: 'lots', filter: { constructor: Object } }), []);
  for (const forged of [null, undefined, {}, JSON.parse(JSON.stringify(s)), Object.freeze({ ...s })]) {
    throwsCode(() => traceForward(forged, 'A'), 'NO_SNAPSHOT');
    throwsCode(() => eventEvidence(forged, 'T1'), 'NO_SNAPSHOT');
    throwsCode(() => queryRecords(forged, { collection: 'lots' }), 'NO_SNAPSHOT');
  }
});

test('report CSV parser rejects unknown sections/scope keys and malformed annotation JSON', () => {
  const ws = acceptedWorkspace();
  ws.addAnnotation({ reviewer: 'QA-1', targetType: 'lot', targetId: 'A', note: 'ok' });
  const csv = ws.exportReport('A', { format: 'csv', generatedAt: NOW });
  throwsCode(() => parseReportCsv(csv.replace('scope,lot,A,', 'scope,__proto__,A,')), 'BAD_REPORT');
  throwsCode(() => parseReportCsv(csv.replace('scope,lot,A,', 'bogus,lot,A,')), 'BAD_REPORT');
  const annLine = csv.split('\r\n').find((l) => l.startsWith('annotation,'));
  throwsCode(() => parseReportCsv(csv.replace(annLine, 'annotation,ANN-1,ok,,A,,,,{not json')), 'BAD_REPORT');
  throwsCode(() => parseReportCsv('a,b\r\n1,2\r\n'), 'BAD_REPORT');
  throwsCode(() => parseReportCsv(42), 'BAD_REPORT');
});
