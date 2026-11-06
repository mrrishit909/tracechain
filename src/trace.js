// Forward/backward lineage traversal over an accepted (validated, acyclic) snapshot.
// All traversal is iterative and step-bounded even though accepted snapshots are already acyclic.
import { LIMITS, UNIT, TraceChainError, checkedAdd, optionsObject } from './limits.js';
import { isAcceptedSnapshot } from './validate.js';

const sortStr = (arr) => [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function assertSnapshot(snapshot) {
  if (!isAcceptedSnapshot(snapshot)) {
    throw new TraceChainError('NO_SNAPSHOT', 'Tracing requires an accepted, immutable snapshot');
  }
}

function index(snapshot) {
  const lots = new Map(snapshot.lots.map((l) => [l.id, l]));
  const consumers = new Map(); // lotId -> transformations consuming it
  const creator = new Map(); // lotId -> transformation producing it
  const shipmentsByLot = new Map();
  for (const l of snapshot.lots) { consumers.set(l.id, []); shipmentsByLot.set(l.id, []); }
  for (const t of snapshot.transformations) {
    for (const i of t.inputs) consumers.get(i.lotId).push(t);
    for (const o of t.outputs) creator.set(o.lotId, t);
  }
  for (const s of snapshot.shipments) shipmentsByLot.get(s.lotId).push(s);
  return { lots, consumers, creator, shipmentsByLot };
}

// Display caller-supplied identifiers without invoking their toString (null-prototype objects, symbols).
const show = (v, n = 64) => (typeof v === 'string' ? v.slice(0, n) : `<${v === null ? 'null' : typeof v}>`);

function requireLot(ix, lotId) {
  if (typeof lotId !== 'string' || !ix.lots.has(lotId)) {
    throw new TraceChainError('UNKNOWN_LOT',
      `Lot "${show(lotId)}" is not in the accepted snapshot; no trace result (this is NOT a "no affected customers" result)`,
      { lotId: show(lotId) });
  }
}

function stepGuard() {
  let steps = 0;
  return () => {
    if (++steps > LIMITS.maxTraversalSteps) {
      throw new TraceChainError('TRAVERSAL_LIMIT', `Traversal exceeded ${LIMITS.maxTraversalSteps} steps`);
    }
  };
}

const pathText = (nodes) => nodes.map((n) => (n.type === 'lot' || n.type === 'customer' ? n.id : `-[${n.type}:${n.id}]->`)).join(' ');

/** Forward trace: every descendant of the affected lot, every shipment of an affected lot, every customer. */
export function traceForward(snapshot, lotId) {
  assertSnapshot(snapshot);
  const ix = index(snapshot);
  requireLot(ix, lotId);
  const tick = stepGuard();
  const affected = new Set([lotId]);
  const transformations = new Set();
  const queue = [lotId];
  while (queue.length) {
    tick();
    const cur = queue.shift();
    for (const t of ix.consumers.get(cur)) {
      transformations.add(t.eventId);
      for (const o of t.outputs) {
        if (!affected.has(o.lotId)) { affected.add(o.lotId); queue.push(o.lotId); }
      }
    }
  }
  const shipments = snapshot.shipments.filter((s) => affected.has(s.lotId));
  const perCustomer = new Map();
  let shipped = 0;
  for (const s of shipments) {
    perCustomer.set(s.customerId, checkedAdd(perCustomer.get(s.customerId) ?? 0, s.quantity));
    shipped = checkedAdd(shipped, s.quantity);
  }
  const customerName = new Map(snapshot.customers.map((c) => [c.id, c.name]));

  // Enumerate every contributing path lot -> ... -> shipment -> customer (iterative DFS, capped).
  const paths = [];
  let truncated = false;
  let budget = LIMITS.maxPathElements;
  const stack = [[{ type: 'lot', id: lotId }]];
  while (stack.length && !truncated) {
    tick();
    const nodes = stack.pop();
    const cur = nodes[nodes.length - 1].id;
    for (const s of [...ix.shipmentsByLot.get(cur)].reverse()) {
      if (paths.length >= LIMITS.maxPaths) { truncated = true; break; }
      budget -= nodes.length + 2;
      if (budget < 0) { truncated = true; break; }
      const full = [...nodes, { type: 'shipment', id: s.eventId }, { type: 'customer', id: s.customerId }];
      paths.push({ shipmentId: s.eventId, customerId: s.customerId, lotId: s.lotId, quantity: s.quantity, unit: UNIT, nodes: full, text: pathText(full) });
    }
    for (const t of ix.consumers.get(cur)) {
      for (const o of t.outputs) {
        // Charge path elements before allocating them; exhaustion truncates the listing, not the lot/customer sets.
        budget -= nodes.length + 2;
        if (budget < 0) { truncated = true; break; }
        stack.push([...nodes, { type: 'transformation', id: t.eventId }, { type: 'lot', id: o.lotId }]);
      }
      if (truncated) break;
    }
  }
  paths.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  const remaining = new Map(snapshot.inventory.remaining.map((r) => [r.lotId, r.grams]));
  const warnings = [
    { code: 'CONSERVATIVE_PROPAGATION', message: 'Every descendant lot is treated as wholly affected; no partial contamination fraction or probability is computed.' },
    { code: 'EVIDENCE_SCOPE', message: `Only evidence in accepted batch "${snapshot.batchId}" is considered. Customers not listed are NOT certified safe.` },
  ];
  for (const id of sortStr(affected)) {
    const g = remaining.get(id);
    if (g > 0) warnings.push({ code: 'AFFECTED_INVENTORY_ON_HAND', lotId: id, grams: g, message: `Affected lot "${id}" has ${g} g on hand with no shipment evidence in this batch.` });
  }
  if (truncated) {
    warnings.push({ code: 'PATHS_TRUNCATED', message: `Contributing-path listing stopped at ${LIMITS.maxPaths} paths; the path list is INCOMPLETE (lot/customer sets remain complete).` });
  }
  return {
    direction: 'forward',
    snapshotBatchId: snapshot.batchId,
    snapshotHash: snapshot.contentHash,
    affectedInputLot: lotId,
    unit: UNIT,
    lots: sortStr(affected),
    transformations: sortStr(transformations),
    shipments: shipments.map((s) => s.eventId).sort(),
    shipmentDetails: shipments.map((s) => ({ eventId: s.eventId, lotId: s.lotId, customerId: s.customerId, quantity: s.quantity, unit: UNIT, sourceRow: s.sourceRow })),
    customers: sortStr(perCustomer.keys()).map((id) => ({ customerId: id, name: customerName.get(id), affectedReceived: perCustomer.get(id), unit: UNIT })),
    affectedShippedQuantity: shipped,
    paths,
    pathsComplete: !truncated,
    warnings,
  };
}

/** Backward trace: all ancestor input lots, the transformations linking them, and root receipts. */
export function traceBackward(snapshot, lotId) {
  assertSnapshot(snapshot);
  const ix = index(snapshot);
  requireLot(ix, lotId);
  const tick = stepGuard();
  const ancestors = new Set();
  const transformations = new Set();
  const queue = [lotId];
  while (queue.length) {
    tick();
    const t = ix.creator.get(queue.shift());
    if (!t) continue;
    transformations.add(t.eventId);
    for (const i of t.inputs) {
      if (!ancestors.has(i.lotId)) { ancestors.add(i.lotId); queue.push(i.lotId); }
    }
  }
  const paths = [];
  let truncated = false;
  let budget = LIMITS.maxPathElements;
  const stack = [[{ type: 'lot', id: lotId }]];
  while (stack.length) {
    tick();
    const nodes = stack.pop();
    const head = nodes[0].id;
    const t = ix.creator.get(head);
    if (!t) {
      if (nodes.length > 1) {
        if (paths.length >= LIMITS.maxPaths) { truncated = true; break; }
        paths.push({ rootLotId: head, nodes, text: pathText(nodes) });
      }
      continue;
    }
    for (const i of t.inputs) {
      budget -= nodes.length + 2;
      if (budget < 0) { truncated = true; break; }
      stack.push([{ type: 'lot', id: i.lotId }, { type: 'transformation', id: t.eventId }, ...nodes]);
    }
    if (truncated) break;
  }
  paths.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const roots = sortStr([...ancestors].filter((id) => ix.lots.get(id).root));
  return {
    direction: 'backward',
    snapshotBatchId: snapshot.batchId,
    snapshotHash: snapshot.contentHash,
    targetLot: lotId,
    unit: UNIT,
    ancestors: sortStr(ancestors),
    transformations: sortStr(transformations),
    rootLots: roots,
    rootReceipts: snapshot.receipts.filter((r) => roots.includes(r.lotId)).map((r) => ({ ...r })),
    paths,
    pathsComplete: !truncated,
    warnings: truncated ? [{ code: 'PATHS_TRUNCATED', message: `Path listing stopped at ${LIMITS.maxPaths}; INCOMPLETE.` }] : [],
  };
}

/** Event evidence: inputs/outputs, configured loss and mass balance with source rows. */
export function eventEvidence(snapshot, eventId) {
  assertSnapshot(snapshot);
  const ev = snapshot.events.find((e) => e.id === eventId);
  if (!ev) throw new TraceChainError('UNKNOWN_EVENT', `Event "${show(eventId)}" is not in the accepted snapshot`);
  const detail =
    snapshot.transformations.find((t) => t.eventId === eventId) ??
    snapshot.shipments.find((s) => s.eventId === eventId) ??
    snapshot.receipts.find((r) => r.eventId === eventId);
  const out = { event: ev, detail };
  if (ev.type === 'transformation') {
    const inSum = detail.inputs.reduce((a, l) => checkedAdd(a, l.quantity), 0);
    const outSum = detail.outputs.reduce((a, l) => checkedAdd(a, l.quantity), 0);
    out.massBalance = { inputGrams: inSum, outputGrams: outSum, configuredLoss: detail.configuredLoss, balanced: inSum === checkedAdd(outSum, detail.configuredLoss), unit: UNIT };
  }
  return out;
}

const COLLECTIONS = new Set(['lots', 'customers', 'events', 'receipts', 'transformations', 'shipments']);

/** Minimal search/filter/sort over snapshot records. Returns copies; never mutates the snapshot. */
export function queryRecords(snapshot, query) {
  assertSnapshot(snapshot);
  const { collection, search = '', filter: rawFilter, sortBy, direction = 'asc' } = optionsObject(query, 'query');
  const filter = optionsObject(rawFilter, 'query.filter');
  if (sortBy !== undefined && typeof sortBy !== 'string') throw new TraceChainError('BAD_QUERY', 'sortBy must be a string');
  if (direction !== 'asc' && direction !== 'desc') throw new TraceChainError('BAD_QUERY', 'direction must be "asc" or "desc"');
  if (!COLLECTIONS.has(collection)) throw new TraceChainError('BAD_QUERY', `Unknown collection "${show(collection, 32)}"`);
  if (typeof search !== 'string' || search.length > LIMITS.maxTextLength) throw new TraceChainError('BAD_QUERY', 'search must be a bounded string');
  const needle = search.toLowerCase();
  let rows = snapshot[collection].filter((r) => {
    for (const [k, v] of Object.entries(filter)) if (!Object.hasOwn(r, k) || r[k] !== v) return false;
    if (!needle) return true;
    return Object.values(r).some((v) => (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().includes(needle));
  });
  if (sortBy !== undefined) {
    const sign = direction === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = Object.hasOwn(a, sortBy) ? a[sortBy] : undefined;
      const y = Object.hasOwn(b, sortBy) ? b[sortBy] : undefined;
      return (x < y ? -1 : x > y ? 1 : 0) * sign;
    });
  }
  return rows.map((r) => structuredClone(r));
}
