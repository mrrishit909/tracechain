// Relationship, lineage, ordering and inventory-ledger validation. Produces an immutable snapshot only
// when the whole candidate batch is valid (atomic acceptance).
import { createHash } from 'node:crypto';
import {
  LIMITS, SCHEMA_VERSION, RULE_VERSION, SYNTHETIC_LABEL, DISCLAIMER, UNIT,
  TraceChainError, checkedAdd, checkedSub, deepFreeze,
} from './limits.js';

/** Deterministic JSON with sorted keys (for content hashing). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stripSourceRows(value) {
  if (Array.isArray(value)) return value.map(stripSourceRows);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) if (k !== 'sourceRow') out[k] = stripSourceRows(value[k]);
    return out;
  }
  return value;
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Snapshots minted by validateCandidate. Traversal accepts only these, so a forged (even frozen) object
// cannot reach graph code. Holds no data itself; a session cannot reach another's snapshot without the reference.
const ACCEPTED = new WeakSet();
export function isAcceptedSnapshot(s) {
  return s !== null && typeof s === 'object' && ACCEPTED.has(s);
}

/**
 * Validate a normalized candidate. Returns { ok: true, snapshot } or { ok: false, errors, truncated }.
 * Never returns a partial graph on failure.
 */
export function validateCandidate(c) {
  const errs = c.errors;
  const err = (code, message, extra) => errs.add(code, message, extra);
  const safe = (fn, extra) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof TraceChainError && e.code === 'ARITHMETIC_OVERFLOW') {
        err('ARITHMETIC_OVERFLOW', e.message, extra);
        return null;
      }
      throw e;
    }
  };

  // --- identity: unique within type; display labels never merge identities ---
  const uniq = (records, key, kind) => {
    const m = new Map();
    for (const r of records) {
      const id = r[key];
      if (id === null) continue;
      if (m.has(id)) {
        err('DUPLICATE_ID', `Duplicate ${kind} ID "${id}" (first at ${m.get(id).sourceRow})`, { sourceRow: r.sourceRow, id, kind });
      } else {
        m.set(id, r);
      }
    }
    return m;
  };
  const lots = uniq(c.lots, 'id', 'lot');
  const customers = uniq(c.customers, 'id', 'customer');
  const events = uniq(c.events, 'id', 'event');
  const details = new Map(); // eventId -> { kind, rec }
  const addDetail = (rec, kind) => {
    if (rec.eventId === null) return;
    if (details.has(rec.eventId)) {
      err('DUPLICATE_ID', `Event "${rec.eventId}" has more than one ${kind}/detail record`, { sourceRow: rec.sourceRow, eventId: rec.eventId, kind });
      return;
    }
    details.set(rec.eventId, { kind, rec });
  };
  c.receipts.forEach((r) => addDetail(r, 'receipt'));
  c.transformations.forEach((r) => addDetail(r, 'transformation'));
  c.shipments.forEach((r) => addDetail(r, 'shipment'));

  // --- detail <-> event consistency; a shipment is an endpoint, never a transformation ---
  for (const [eventId, { kind, rec }] of details) {
    const ev = events.get(eventId);
    if (!ev) {
      err('MISSING_REFERENCE', `${kind} references missing event "${eventId}"`, { sourceRow: rec.sourceRow, eventId });
    } else if (ev.type !== null && ev.type !== kind) {
      err('EVENT_TYPE_MISMATCH', `Event "${eventId}" has type ${ev.type} but carries ${kind} detail`, { sourceRow: rec.sourceRow, eventId, observed: kind, expected: ev.type });
    }
  }
  for (const ev of events.values()) {
    if (!details.has(ev.id)) err('MISSING_EVENT_DETAIL', `Event "${ev.id}" (${ev.type}) has no ${ev.type} record`, { sourceRow: ev.sourceRow, eventId: ev.id });
  }

  const lotRef = (lotId, rec, eventId, role) => {
    if (lotId !== null && !lots.has(lotId)) {
      err('MISSING_REFERENCE', `${role} in event "${eventId}" references undeclared lot "${lotId}"`, { sourceRow: rec.sourceRow, eventId, lotId });
    }
  };
  for (const r of c.receipts) lotRef(r.lotId, r, r.eventId, 'receipt');
  for (const s of c.shipments) {
    lotRef(s.lotId, s, s.eventId, 'shipment');
    if (s.customerId !== null && !customers.has(s.customerId)) {
      err('MISSING_REFERENCE', `shipment "${s.eventId}" references undeclared customer "${s.customerId}"`, { sourceRow: s.sourceRow, eventId: s.eventId, customerId: s.customerId });
    }
  }

  // --- transformation shape, self-loops, mass balance ---
  for (const t of c.transformations) {
    if (t.inputs.length === 0 || t.outputs.length === 0) {
      err('EMPTY_TRANSFORMATION', `Transformation "${t.eventId}" needs at least one input and one output`, { sourceRow: t.sourceRow, eventId: t.eventId });
    }
    for (const [role, lines] of [['input', t.inputs], ['output', t.outputs]]) {
      const seen = new Set();
      for (const l of lines) {
        lotRef(l.lotId, l, t.eventId, `transformation ${role}`);
        if (l.lotId !== null && seen.has(l.lotId)) {
          err('DUPLICATE_LINE', `Transformation "${t.eventId}" lists ${role} lot "${l.lotId}" more than once`, { sourceRow: l.sourceRow, eventId: t.eventId, lotId: l.lotId });
        }
        seen.add(l.lotId);
      }
    }
    const inIds = new Set(t.inputs.map((l) => l.lotId));
    for (const o of t.outputs) {
      if (o.lotId !== null && inIds.has(o.lotId)) {
        err('CYCLE', `Self-loop: transformation "${t.eventId}" consumes and produces lot "${o.lotId}"`, { sourceRow: o.sourceRow, eventId: t.eventId, lotId: o.lotId, cycle: [o.lotId, o.lotId] });
      }
    }
    const nums = [...t.inputs, ...t.outputs].map((l) => l.quantity);
    if (t.configuredLoss !== null && nums.every((q) => q !== null)) {
      safe(() => {
        const inSum = t.inputs.reduce((a, l) => checkedAdd(a, l.quantity), 0);
        const outSum = t.outputs.reduce((a, l) => checkedAdd(a, l.quantity), 0);
        const expected = checkedAdd(outSum, t.configuredLoss);
        if (inSum !== expected) {
          err('MASS_BALANCE_MISMATCH',
            `Transformation "${t.eventId}": inputs ${inSum} g != outputs ${outSum} g + configured loss ${t.configuredLoss} g (difference ${Math.abs(checkedSub(inSum, expected))} g)`,
            { sourceRow: t.sourceRow, eventId: t.eventId, observed: inSum, expected, difference: Math.abs(checkedSub(inSum, expected)), unit: UNIT });
        }
      }, { sourceRow: t.sourceRow, eventId: t.eventId });
    }
  }

  // --- creation lineage: every lot has exactly one creation event; roots have receipts ---
  const creators = new Map();
  const addCreator = (lotId, eventId, kind, rec) => {
    if (lotId === null || !lots.has(lotId)) return;
    if (!creators.has(lotId)) creators.set(lotId, []);
    creators.get(lotId).push({ eventId, kind, sourceRow: rec.sourceRow });
  };
  for (const r of c.receipts) addCreator(r.lotId, r.eventId, 'receipt', r);
  for (const t of c.transformations) for (const o of t.outputs) addCreator(o.lotId, t.eventId, 'transformation', o);
  for (const lot of lots.values()) {
    const cs = creators.get(lot.id) || [];
    if (cs.length === 0) {
      err('MISSING_CREATION_LINEAGE', `Lot "${lot.id}" has no receipt or transformation output creating it`, { sourceRow: lot.sourceRow, lotId: lot.id });
    } else if (cs.length > 1) {
      err('DUPLICATE_CREATION', `Lot "${lot.id}" has ${cs.length} creation events (${cs.map((x) => x.eventId).join(', ')})`, { sourceRow: cs[1].sourceRow, lotId: lot.id, eventIds: cs.map((x) => x.eventId) });
    }
  }

  // --- acyclic lot graph (Kahn), iterative. Bipartite lot -> transformation -> lot graph keeps edges
  // O(inputs + outputs) instead of an inputs x outputs cross product. Transformation nodes are keyed by
  // record index (not eventId) because duplicate event IDs and lot/event ID collisions are possible here.
  const lotNode = (id) => `L:${id}`;
  const txNode = (idx) => `T:${idx}`;
  const out = new Map();
  const indeg = new Map();
  for (const id of lots.keys()) { out.set(lotNode(id), []); indeg.set(lotNode(id), 0); }
  c.transformations.forEach((t, idx) => {
    const tn = txNode(idx);
    out.set(tn, []);
    indeg.set(tn, 0);
    for (const i of t.inputs) {
      if (!lots.has(i.lotId)) continue;
      out.get(lotNode(i.lotId)).push(tn);
      indeg.set(tn, indeg.get(tn) + 1);
    }
    for (const o of t.outputs) {
      if (!lots.has(o.lotId)) continue;
      out.get(tn).push(lotNode(o.lotId));
      indeg.set(lotNode(o.lotId), indeg.get(lotNode(o.lotId)) + 1);
    }
  });
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.pop();
    visited++;
    for (const nx of out.get(id)) {
      indeg.set(nx, indeg.get(nx) - 1);
      if (indeg.get(nx) === 0) queue.push(nx);
    }
  }
  if (visited !== indeg.size) {
    // Nodes left after Kahn are on a cycle or downstream of one; prune nodes with no outgoing edge
    // inside the leftover set (reverse Kahn) so the diagnostic names cycle members only.
    const left = new Set([...indeg].filter(([, d]) => d > 0).map(([k]) => k));
    const outdeg = new Map();
    const preds = new Map([...left].map((k) => [k, []]));
    for (const k of left) {
      const nx = out.get(k).filter((x) => left.has(x));
      outdeg.set(k, nx.length);
      for (const x of nx) preds.get(x).push(k);
    }
    const prune = [...left].filter((k) => outdeg.get(k) === 0);
    while (prune.length) {
      const k = prune.pop();
      left.delete(k);
      for (const p of preds.get(k)) {
        outdeg.set(p, outdeg.get(p) - 1);
        if (outdeg.get(p) === 0) prune.push(p);
      }
    }
    const cyc = [...left].filter((k) => k.startsWith('L:')).map((k) => k.slice(2)).sort();
    err('CYCLE', `Lot lineage contains a cycle among lots ${cyc.join(', ')}; traversal refused`, { lotIds: cyc });
  }

  // --- deterministic chronological order; equal timestamps need explicit distinct sequences ---
  const evs = [...events.values()].filter((e) => e.timestamp !== null);
  const byMs = new Map();
  for (const e of evs) {
    if (!byMs.has(e.timestamp.ms)) byMs.set(e.timestamp.ms, []);
    byMs.get(e.timestamp.ms).push(e);
  }
  let orderOk = evs.length === events.size;
  for (const group of byMs.values()) {
    if (group.length < 2) continue;
    const seqs = group.map((e) => e.sequence);
    if (seqs.some((s) => s === null) || new Set(seqs).size !== seqs.length) {
      orderOk = false;
      err('AMBIGUOUS_ORDER', `Events ${group.map((e) => e.id).sort().join(', ')} share timestamp ${group[0].timestamp.iso} without distinct explicit sequence numbers`, { eventIds: group.map((e) => e.id).sort(), sourceRow: group[0].sourceRow });
    }
  }
  evs.sort((a, b) => a.timestamp.ms - b.timestamp.ms || (a.sequence ?? 0) - (b.sequence ?? 0));

  // --- inventory ledger in event order (nonnegative, checked arithmetic) ---
  const inv = new Map();
  let totalReceived = 0, totalShipped = 0, totalLoss = 0;
  if (orderOk && errs.ok) {
    const consume = (lotId, qty, eventId, rec, kind) => {
      if (!inv.has(lotId)) {
        err(kind === 'shipment' ? 'SHIPMENT_BEFORE_CREATION' : 'CONSUMED_BEFORE_CREATION',
          `Event "${eventId}" uses lot "${lotId}" before the lot's creation event`, { sourceRow: rec.sourceRow, eventId, lotId });
        return;
      }
      const available = inv.get(lotId);
      if (available < qty) {
        err('INSUFFICIENT_INVENTORY',
          `Event "${eventId}" takes ${qty} g of lot "${lotId}" but only ${available} g remain (short by ${qty - available} g)`,
          { sourceRow: rec.sourceRow, eventId, lotId, observed: qty, expected: available, available, difference: qty - available, unit: UNIT });
        return;
      }
      inv.set(lotId, available - qty);
    };
    for (const ev of evs) {
      const { kind, rec } = details.get(ev.id);
      safe(() => {
        if (kind === 'receipt') {
          inv.set(rec.lotId, rec.quantity);
          totalReceived = checkedAdd(totalReceived, rec.quantity);
        } else if (kind === 'transformation') {
          for (const l of rec.inputs) consume(l.lotId, l.quantity, ev.id, l, kind);
          for (const l of rec.outputs) inv.set(l.lotId, l.quantity);
          totalLoss = checkedAdd(totalLoss, rec.configuredLoss);
        } else {
          consume(rec.lotId, rec.quantity, ev.id, rec, kind);
          totalShipped = checkedAdd(totalShipped, rec.quantity);
        }
      }, { sourceRow: rec.sourceRow, eventId: ev.id });
    }
  }

  if (c.batchId === null) err('MISSING_FIELD', 'batchId is required', { sourceRow: 'batch' });
  if (!errs.ok) return { ok: false, errors: errs.errors, truncated: errs.truncated };

  // --- immutable snapshot ---
  const order = new Map(evs.map((e, i) => [e.id, i]));
  const eventsOut = evs.map((e, i) => ({
    id: e.id, type: e.type, timestamp: e.timestamp.iso, sequence: e.sequence, order: i,
    facilityId: e.facilityId, sourceReference: e.sourceReference, sourceRow: e.sourceRow,
  }));
  const byOrder = (a, b) => order.get(a.eventId) - order.get(b.eventId);
  const line = (l) => ({ lotId: l.lotId, quantity: l.quantity, unit: UNIT, sourceRow: l.sourceRow });
  const remaining = [...lots.keys()].sort().map((lotId) => ({ lotId, grams: inv.get(lotId) }));
  const totalRemaining = remaining.reduce((a, r) => checkedAdd(a, r.grams), 0);
  const body = {
    kind: 'tracechain.snapshot',
    batchId: c.batchId,
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: RULE_VERSION,
    synthetic: true,
    syntheticLabel: SYNTHETIC_LABEL,
    disclaimer: DISCLAIMER,
    unit: UNIT,
    lots: [...lots.values()].sort(byId).map((l) => ({
      id: l.id, productId: l.productId, unit: l.unit, label: l.label,
      createdBy: creators.get(l.id)[0].eventId, root: creators.get(l.id)[0].kind === 'receipt', sourceRow: l.sourceRow,
    })),
    customers: [...customers.values()].sort(byId).map((x) => ({ id: x.id, name: x.name, sourceRow: x.sourceRow })),
    events: eventsOut,
    receipts: [...c.receipts].sort(byOrder).map((r) => ({ eventId: r.eventId, lotId: r.lotId, quantity: r.quantity, unit: UNIT, sourceRow: r.sourceRow })),
    transformations: [...c.transformations].sort(byOrder).map((t) => ({
      eventId: t.eventId,
      inputs: [...t.inputs].sort((a, b) => (a.lotId < b.lotId ? -1 : 1)).map(line),
      outputs: [...t.outputs].sort((a, b) => (a.lotId < b.lotId ? -1 : 1)).map(line),
      configuredLoss: t.configuredLoss, unit: UNIT, sourceRow: t.sourceRow,
    })),
    shipments: [...c.shipments].sort(byOrder).map((s) => ({ eventId: s.eventId, lotId: s.lotId, quantity: s.quantity, unit: UNIT, customerId: s.customerId, sourceRow: s.sourceRow })),
    inventory: {
      unit: UNIT, totalReceived, totalShipped, totalConfiguredLoss: totalLoss, remaining, totalRemaining,
      conservationHolds: totalRemaining === checkedSub(checkedSub(totalReceived, totalShipped), totalLoss),
    },
  };
  if (!body.inventory.conservationHolds) throw new TraceChainError('INTERNAL', 'Inventory conservation failed');
  body.contentHash = `sha256:${createHash('sha256').update(canonicalJson(stripSourceRows(body))).digest('hex')}`;
  deepFreeze(body);
  ACCEPTED.add(body);
  return { ok: true, snapshot: body };
}

export { stripSourceRows, LIMITS };
