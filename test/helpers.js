// Shared test fixtures and builders. Golden expectations live in the tests as literals, not here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Workspace, REJECTION_COMPLETENESS_MESSAGE, SCHEMA_VERSION } from '../src/index.js';

export const JSON_TEXT = readFileSync(new URL('../fixtures/TC-SYN-001.json', import.meta.url), 'utf8');
export const CSV_TEXT = readFileSync(new URL('../fixtures/TC-SYN-001.csv', import.meta.url), 'utf8');
export const NOW = '2026-11-03T12:00:00Z';

export const fixture = () => JSON.parse(JSON_TEXT);
export const codes = (res) => res.errors.map((e) => e.code);
export const findErr = (res, code) => res.errors.find((e) => e.code === code);

export function throwsCode(fn, code) {
  assert.throws(fn, (e) => {
    assert.equal(e.name, 'TraceChainError', `expected TraceChainError, got ${e.name}: ${e.message}`);
    assert.equal(e.code, code);
    return true;
  });
}

export function newWorkspace() {
  return new Workspace({ now: () => NOW });
}

export function acceptedWorkspace() {
  const ws = newWorkspace();
  const r = ws.importBatch(JSON_TEXT, { format: 'json' });
  assert.equal(r.status, 'accepted');
  return ws;
}

/** Import a bad batch over an accepted TC-SYN-001 workspace and assert atomic rejection semantics. */
export function rejectOverPrior(text, format = 'json') {
  const ws = acceptedWorkspace();
  const prior = ws.currentSnapshot();
  const r = ws.importBatch(text, { format });
  assert.equal(r.status, 'rejected', 'batch should be rejected');
  assert.equal(r.acceptedGraph, null);
  assert.equal(r.completeness, REJECTION_COMPLETENESS_MESSAGE);
  assert.equal(ws.currentSnapshot(), prior, 'prior snapshot must be retained unchanged');
  assert.equal(r.priorSnapshot.batchId, 'TC-SYN-001');
  assert.equal(r.priorSnapshot.contentHash, prior.contentHash);
  assert.match(r.priorSnapshot.label, /NOT the result of this rejected import/);
  assert.equal('snapshot' in r, false);
  return { ws, r, prior };
}

const BASE = () => ({ schemaVersion: SCHEMA_VERSION, synthetic: true, lots: [], customers: [], events: [], receipts: [], transformations: [], shipments: [] });

/** k chained diamonds (split 2 g -> 1+1, merge back to 2 g): 2^k contributing paths, ~15k records/1000. */
export function diamondBatch(k) {
  const b = { ...BASE(), batchId: 'TC-SYN-DIAMOND', customers: [{ id: 'C1', name: 'Fictional Diamond Customer' }] };
  let t = Date.UTC(2026, 0, 1);
  const ev = (id, type) => {
    t += 60000;
    b.events.push({ id, type, timestamp: new Date(t).toISOString().replace('.000Z', 'Z'), facilityId: 'FAC-SYN-D', sourceReference: `SYN-${id}` });
  };
  b.lots.push({ id: 'L0', productId: 'P-SYN-D', unit: 'g' });
  ev('R0', 'receipt');
  b.receipts.push({ eventId: 'R0', lotId: 'L0', quantity: 2 });
  for (let i = 1; i <= k; i++) {
    for (const id of [`X${i}`, `Y${i}`, `L${i}`]) b.lots.push({ id, productId: 'P-SYN-D', unit: 'g' });
    ev(`SP${i}`, 'transformation');
    b.transformations.push({ eventId: `SP${i}`, inputs: [{ lotId: `L${i - 1}`, quantity: 2 }], outputs: [{ lotId: `X${i}`, quantity: 1 }, { lotId: `Y${i}`, quantity: 1 }], configuredLoss: 0 });
    ev(`MG${i}`, 'transformation');
    b.transformations.push({ eventId: `MG${i}`, inputs: [{ lotId: `X${i}`, quantity: 1 }, { lotId: `Y${i}`, quantity: 1 }], outputs: [{ lotId: `L${i}`, quantity: 2 }], configuredLoss: 0 });
  }
  ev('SHIP', 'shipment');
  b.shipments.push({ eventId: 'SHIP', lotId: `L${k}`, quantity: 2, customerId: 'C1' });
  return b;
}

/** One transformation with n inputs and n outputs (receipts share a timestamp, ordered by explicit sequence). */
export function wideBatch(n) {
  const b = { ...BASE(), batchId: 'TC-SYN-WIDE' };
  const inputs = [];
  const outputs = [];
  for (let i = 0; i < n; i++) {
    b.lots.push({ id: `I${i}`, productId: 'P-SYN-W', unit: 'g' }, { id: `O${i}`, productId: 'P-SYN-W', unit: 'g' });
    b.events.push({ id: `R${i}`, type: 'receipt', timestamp: '2026-01-01T00:00:00Z', sequence: i, facilityId: 'FAC-SYN-W', sourceReference: `SYN-R${i}` });
    b.receipts.push({ eventId: `R${i}`, lotId: `I${i}`, quantity: 1 });
    inputs.push({ lotId: `I${i}`, quantity: 1 });
    outputs.push({ lotId: `O${i}`, quantity: 1 });
  }
  b.events.push({ id: 'TW', type: 'transformation', timestamp: '2026-01-02T00:00:00Z', facilityId: 'FAC-SYN-W', sourceReference: 'SYN-TW' });
  b.transformations.push({ eventId: 'TW', inputs, outputs, configuredLoss: 0 });
  return b;
}
