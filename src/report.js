// Affected-customer report export (JSON and CSV) and CSV round-trip parsing.
import {
  REPORT_SCHEMA_VERSION, SCHEMA_VERSION, RULE_VERSION, SYNTHETIC_LABEL, DISCLAIMER, UNIT, TraceChainError,
} from './limits.js';
import { toCsv, parseCsv, unescapeFormula } from './csv.js';

/** Build a report object from an accepted snapshot and a forward trace on that same snapshot. */
export function buildReport(snapshot, trace, annotations = [], { generatedAt } = {}) {
  if (!trace || trace.direction !== 'forward') throw new TraceChainError('BAD_REPORT', 'Report requires a forward trace');
  if (trace.snapshotHash !== snapshot.contentHash) {
    throw new TraceChainError('SNAPSHOT_MISMATCH', 'Trace was not computed on this snapshot');
  }
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: RULE_VERSION,
    synthetic: true,
    syntheticLabel: SYNTHETIC_LABEL,
    disclaimer: DISCLAIMER,
    generatedAt: generatedAt ?? null,
    snapshot: { batchId: snapshot.batchId, contentHash: snapshot.contentHash },
    scope: {
      direction: 'forward',
      affectedInputLot: trace.affectedInputLot,
      unit: UNIT,
      lots: [...trace.lots],
      transformations: [...trace.transformations],
      shipments: [...trace.shipments],
    },
    units: UNIT,
    customers: trace.customers.map((c) => ({ ...c })),
    affectedShippedQuantity: trace.affectedShippedQuantity,
    paths: trace.paths.map((p) => ({ shipmentId: p.shipmentId, customerId: p.customerId, lotId: p.lotId, quantity: p.quantity, unit: p.unit, text: p.text })),
    pathsComplete: trace.pathsComplete,
    warnings: trace.warnings.map((w) => ({ ...w })),
    annotations: annotations.map((a) => ({ ...a })),
  };
}

export function reportToJson(report) {
  return JSON.stringify(report, null, 2);
}

const HEADER = ['section', 'key', 'value', 'customerId', 'lotId', 'eventId', 'quantity', 'unit', 'detail'];

/** Flatten the report into one CSV table. Text cells are formula-escaped by csvCell. */
export function reportToCsv(report) {
  const rows = [];
  const meta = (k, v) => rows.push(['meta', k, String(v), '', '', '', '', '', '']);
  meta('syntheticLabel', report.syntheticLabel);
  meta('disclaimer', report.disclaimer);
  meta('reportSchemaVersion', report.reportSchemaVersion);
  meta('schemaVersion', report.schemaVersion);
  meta('ruleVersion', report.ruleVersion);
  meta('snapshotBatchId', report.snapshot.batchId);
  meta('snapshotHash', report.snapshot.contentHash);
  meta('generatedAt', report.generatedAt ?? '');
  meta('units', report.units);
  meta('affectedInputLot', report.scope.affectedInputLot);
  meta('affectedShippedQuantity', report.affectedShippedQuantity);
  meta('pathsComplete', report.pathsComplete);
  for (const l of report.scope.lots) rows.push(['scope', 'lot', l, '', l, '', '', '', '']);
  for (const t of report.scope.transformations) rows.push(['scope', 'transformation', t, '', '', t, '', '', '']);
  for (const s of report.scope.shipments) rows.push(['scope', 'shipment', s, '', '', s, '', '', '']);
  for (const c of report.customers) rows.push(['customer', c.customerId, c.name, c.customerId, '', '', c.affectedReceived, c.unit, '']);
  for (const p of report.paths) rows.push(['path', p.shipmentId, p.text, p.customerId, p.lotId, p.shipmentId, p.quantity, p.unit, '']);
  for (const w of report.warnings) rows.push(['warning', w.code, w.message, '', w.lotId ?? '', '', w.grams ?? '', w.grams !== undefined ? UNIT : '', '']);
  for (const a of report.annotations) rows.push(['annotation', a.id, a.note, '', a.targetType === 'lot' ? a.targetId : '', a.targetType === 'event' ? a.targetId : '', '', '', JSON.stringify(a)]);
  return toCsv(HEADER, rows);
}

/** Parse an exported report CSV back into a report-shaped object (for round-trip verification). */
export function parseReportCsv(text) {
  const { header, rows } = parseCsv(text);
  if (header.join(',') !== HEADER.join(',')) throw new TraceChainError('BAD_REPORT', 'Unexpected report CSV header');
  const cell = (r) => Object.fromEntries(HEADER.map((h, i) => [h, unescapeFormula(r.cells[i])]));
  const m = {};
  const out = { scope: { lots: [], transformations: [], shipments: [] }, customers: [], paths: [], warnings: [], annotations: [] };
  const int = (s) => (s === '' ? undefined : Number(s));
  for (const r of rows.map(cell)) {
    if (r.section === 'meta') m[r.key] = r.value;
    else if (r.section === 'scope') out.scope[`${r.key}s`].push(r.value);
    else if (r.section === 'customer') out.customers.push({ customerId: r.customerId, name: r.value, affectedReceived: int(r.quantity), unit: r.unit });
    else if (r.section === 'path') out.paths.push({ shipmentId: r.eventId, customerId: r.customerId, lotId: r.lotId, quantity: int(r.quantity), unit: r.unit, text: r.value });
    else if (r.section === 'warning') {
      const w = { code: r.key, message: r.value };
      if (r.lotId) w.lotId = r.lotId;
      if (r.quantity) w.grams = int(r.quantity);
      out.warnings.push(w);
    } else if (r.section === 'annotation') out.annotations.push(JSON.parse(r.detail));
  }
  return {
    reportSchemaVersion: m.reportSchemaVersion,
    schemaVersion: m.schemaVersion,
    ruleVersion: m.ruleVersion,
    synthetic: m.syntheticLabel === SYNTHETIC_LABEL,
    syntheticLabel: m.syntheticLabel,
    disclaimer: m.disclaimer,
    generatedAt: m.generatedAt === '' ? null : m.generatedAt,
    snapshot: { batchId: m.snapshotBatchId, contentHash: m.snapshotHash },
    scope: { direction: 'forward', affectedInputLot: m.affectedInputLot, unit: m.units, ...out.scope },
    units: m.units,
    customers: out.customers,
    affectedShippedQuantity: Number(m.affectedShippedQuantity),
    paths: out.paths,
    pathsComplete: m.pathsComplete === 'true',
    warnings: out.warnings,
    annotations: out.annotations,
  };
}
