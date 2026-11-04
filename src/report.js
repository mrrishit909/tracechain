// Affected-customer report export (JSON and CSV) and CSV round-trip parsing.
import {
  LIMITS, REPORT_SCHEMA_VERSION, LEGACY_REPORT_SCHEMA_VERSION, SCHEMA_VERSION, RULE_VERSION, UNIT, TraceChainError, optionsObject,
} from './limits.js';
import {
  ORIGIN_UNVERIFIED, ORIGIN_BUNDLED_FIXTURE, isOrigin, resolveOrigin, originFields, isBundledFixtureSnapshot,
} from './origin.js';
import { toCsv, parseCsv, unescapeFormula } from './csv.js';
import { isAcceptedSnapshot } from './validate.js';
import { traceForward } from './trace.js';
import { readTimestamp, ErrorCollector } from './schema.js';

// Key-order-independent serialization; null when the value is not plain JSON data (BigInt, cycles, throwing getters).
function canonical(value) {
  try {
    return JSON.stringify(value, (_k, v) => (v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
  } catch {
    return null;
  }
}

const ANNOTATION_KEYS = ['createdAt', 'id', 'note', 'reviewer', 'snapshotBatchId', 'snapshotHash', 'targetId', 'targetType'];
const TARGETS = { lot: 'lots', event: 'events', customer: 'customers' };

function checkAnnotations(snapshot, annotations) {
  if (!Array.isArray(annotations) || annotations.length > LIMITS.maxAnnotations) {
    throw new TraceChainError('BAD_ARGUMENT', `annotations must be an array of at most ${LIMITS.maxAnnotations} items`);
  }
  annotations.forEach((a, i) => {
    const bad = (why) => { throw new TraceChainError('BAD_ANNOTATION', `Annotation ${i}: ${why}`); };
    if (a === null || typeof a !== 'object' || Array.isArray(a)) bad('must be an object');
    if (canonical(Object.keys(a).sort()) !== canonical(ANNOTATION_KEYS)) bad(`must have exactly the keys ${ANNOTATION_KEYS.join(', ')}`);
    for (const k of ANNOTATION_KEYS) {
      const max = k === 'note' ? LIMITS.maxNoteLength : LIMITS.maxTextLength;
      if (typeof a[k] !== 'string' || a[k].length === 0 || a[k].length > max) bad(`${k} must be a non-empty bounded string`);
    }
    if (a.snapshotHash !== snapshot.contentHash || a.snapshotBatchId !== snapshot.batchId) bad('cites a different snapshot');
    if (!Object.hasOwn(TARGETS, a.targetType)) bad('targetType must be lot, event or customer');
    if (!snapshot[TARGETS[a.targetType]].some((r) => r.id === a.targetId)) bad(`target "${a.targetId.slice(0, 64)}" is not in the snapshot`);
    if (!readTimestamp(a.createdAt, 'createdAt', 'annotation', new ErrorCollector())) bad('createdAt must be a valid ISO UTC timestamp');
  });
}

/**
 * Build a report from an accepted snapshot and a forward trace of that snapshot.
 * A matching snapshot hash does not prove the trace content is genuine, so the authoritative trace is recomputed
 * from the accepted snapshot and the selected lot; any difference is rejected and the report uses only the
 * recomputed result.
 */
export function buildReport(snapshot, trace, annotations = [], options) {
  // origin defaults to unverified; a bundled-fixture claim is honored only for the pinned fixture snapshot.
  const { generatedAt = null, origin } = optionsObject(options, 'report options');
  if (generatedAt !== null && !readTimestamp(generatedAt, 'generatedAt', 'report', new ErrorCollector())) {
    throw new TraceChainError('BAD_ARGUMENT', 'generatedAt must be null or a valid ISO UTC timestamp');
  }
  if (!isAcceptedSnapshot(snapshot)) throw new TraceChainError('NO_SNAPSHOT', 'Report requires an accepted, immutable snapshot');
  if (trace === null || typeof trace !== 'object' || Array.isArray(trace) || trace.direction !== 'forward') {
    throw new TraceChainError('BAD_REPORT', 'Report requires a forward trace');
  }
  if (trace.snapshotHash !== snapshot.contentHash) {
    throw new TraceChainError('SNAPSHOT_MISMATCH', 'Trace was not computed on this snapshot');
  }
  if (typeof trace.affectedInputLot !== 'string') throw new TraceChainError('BAD_REPORT', 'Trace has no affected input lot');
  const supplied = canonical(trace);
  trace = traceForward(snapshot, trace.affectedInputLot);
  if (supplied === null || supplied !== canonical(trace)) {
    throw new TraceChainError('TRACE_MISMATCH',
      'Trace content differs from the trace recomputed on this snapshot; scope, customers, quantities, paths and warnings cannot be bound to it');
  }
  checkAnnotations(snapshot, annotations);
  const effectiveOrigin = resolveOrigin(origin, snapshot);
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: RULE_VERSION,
    ...originFields(effectiveOrigin),
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
  meta('dataOriginLabel', report.dataOriginLabel);
  meta('dataOrigin', report.dataOrigin);
  meta('dataOriginVerified', report.dataOriginVerified);
  meta('contentInspectionNotice', report.contentInspectionNotice);
  meta('disclaimer', report.disclaimer);
  meta('reportSchemaVersion', report.reportSchemaVersion);
  if (report.upconvertedFrom !== undefined) {
    meta('upconvertedFrom', report.upconvertedFrom);
    meta('legacyClaims', JSON.stringify(report.legacyClaims));
  }
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

/**
 * Parse an exported report CSV back into a report-shaped object (for round-trip verification). Current v2 reports
 * round-trip exactly; legacy v1 reports are upconverted to v2 with unverified origin; other versions are rejected.
 */
export function parseReportCsv(text) {
  if (typeof text !== 'string') throw new TraceChainError('BAD_REPORT', 'Report CSV must be a string');
  const { header, rows } = parseCsv(text);
  if (header.join(',') !== HEADER.join(',')) throw new TraceChainError('BAD_REPORT', 'Unexpected report CSV header');
  const cell = (r) => Object.fromEntries(HEADER.map((h, i) => [h, unescapeFormula(r.cells[i])]));
  const m = Object.create(null);
  const out = { scope: { lots: [], transformations: [], shipments: [] }, customers: [], paths: [], warnings: [], annotations: [] };
  const int = (s) => (s === '' ? undefined : Number(s));
  const SCOPE_KEYS = { lot: 'lots', transformation: 'transformations', shipment: 'shipments' };
  for (const r of rows.map(cell)) {
    if (r.section === 'meta') m[r.key] = r.value;
    else if (r.section === 'scope') {
      if (!Object.hasOwn(SCOPE_KEYS, r.key)) throw new TraceChainError('BAD_REPORT', `Unknown scope key "${r.key.slice(0, 32)}"`);
      out.scope[SCOPE_KEYS[r.key]].push(r.value);
    } else if (r.section === 'annotation') {
      try {
        out.annotations.push(JSON.parse(r.detail));
      } catch {
        throw new TraceChainError('BAD_REPORT', `Annotation ${r.key.slice(0, 32)} detail is not valid JSON`);
      }
    }
    else if (r.section === 'customer') out.customers.push({ customerId: r.customerId, name: r.value, affectedReceived: int(r.quantity), unit: r.unit });
    else if (r.section === 'path') out.paths.push({ shipmentId: r.eventId, customerId: r.customerId, lotId: r.lotId, quantity: int(r.quantity), unit: r.unit, text: r.value });
    else if (r.section === 'warning') {
      const w = { code: r.key, message: r.value };
      if (r.lotId) w.lotId = r.lotId;
      if (r.quantity) w.grams = int(r.quantity);
      out.warnings.push(w);
    } else if (!['meta', 'scope', 'annotation'].includes(r.section)) {
      throw new TraceChainError('BAD_REPORT', `Unknown report section "${r.section.slice(0, 32)}"`);
    }
  }
  const snapshot = { batchId: m.snapshotBatchId, contentHash: m.snapshotHash };
  const verified = m.dataOriginVerified === 'true' ? true : m.dataOriginVerified === 'false' ? false : m.dataOriginVerified;
  let legacyClaims = m.legacyClaims;
  if (legacyClaims !== undefined) {
    try { legacyClaims = JSON.parse(legacyClaims); } catch { throw new TraceChainError('BAD_REPORT', 'legacyClaims is not valid JSON'); }
  }
  const origin = readOrigin(m.reportSchemaVersion, {
    dataOrigin: m.dataOrigin, dataOriginVerified: verified, dataOriginLabel: m.dataOriginLabel,
    contentInspectionNotice: m.contentInspectionNotice, disclaimer: m.disclaimer,
    upconvertedFrom: m.upconvertedFrom, legacyClaims,
    // v1 CSV carried a syntheticLabel row but no synthetic flag; it is kept only as a legacy claim.
    synthetic: undefined, syntheticLabel: m.syntheticLabel,
  }, snapshot);
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    schemaVersion: m.schemaVersion,
    ruleVersion: m.ruleVersion,
    ...origin,
    generatedAt: m.generatedAt === '' ? null : m.generatedAt,
    snapshot,
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

const LEGACY_NOTE =
  `Upconverted from ${LEGACY_REPORT_SCHEMA_VERSION}. That version labeled every report SYNTHETIC regardless of where ` +
  'the data came from, so its synthetic claim is not evidence and the origin is treated as unverified user-supplied. ' +
  'Its snapshotHash was computed under the earlier snapshot format and will not match a current snapshot of the same data.';
const ORIGIN_KEYS = ['dataOrigin', 'dataOriginVerified', 'dataOriginLabel', 'contentInspectionNotice', 'disclaimer'];

/**
 * Origin fields for a report being read back from a file. The result is still only what the file says (reports are
 * unsigned and carry no origin guarantee), but:
 *  - v2 origin fields must be internally consistent, and a bundled-fixture claim must cite the pinned fixture snapshot;
 *  - v1 synthetic claims are never carried forward as an origin; v1 is upconverted to unverified user-supplied;
 *  - any other version is rejected.
 */
function readOrigin(version, c, snapshot) {
  const bad = (why) => { throw new TraceChainError('BAD_REPORT', why); };
  if (version === REPORT_SCHEMA_VERSION) {
    if (!isOrigin(c.dataOrigin)) bad('dataOrigin is missing or unknown');
    const fields = originFields(c.dataOrigin);
    for (const k of ORIGIN_KEYS) if (c[k] !== fields[k]) bad(`${k} does not match dataOrigin "${c.dataOrigin}"`);
    if (c.dataOrigin === ORIGIN_BUNDLED_FIXTURE && !isBundledFixtureSnapshot(snapshot)) {
      bad('Report claims the bundled-fixture origin but cites a different snapshot');
    }
    if (c.upconvertedFrom === undefined && c.legacyClaims === undefined) return fields;
    if (c.upconvertedFrom !== LEGACY_REPORT_SCHEMA_VERSION || c.dataOrigin !== ORIGIN_UNVERIFIED
      || c.legacyClaims === null || typeof c.legacyClaims !== 'object' || Array.isArray(c.legacyClaims)) {
      bad('Upconverted report must come from the legacy version and stay unverified');
    }
    return { ...fields, upconvertedFrom: c.upconvertedFrom, legacyClaims: c.legacyClaims };
  }
  if (version === LEGACY_REPORT_SCHEMA_VERSION) {
    return {
      ...originFields(ORIGIN_UNVERIFIED),
      upconvertedFrom: LEGACY_REPORT_SCHEMA_VERSION,
      legacyClaims: {
        synthetic: c.synthetic ?? null, syntheticLabel: c.syntheticLabel ?? null, disclaimer: c.disclaimer ?? null, note: LEGACY_NOTE,
      },
    };
  }
  return bad(`Unsupported reportSchemaVersion "${String(version).slice(0, 64)}"; expected ${REPORT_SCHEMA_VERSION} or legacy ${LEGACY_REPORT_SCHEMA_VERSION}`);
}

const BODY_KEYS = ['generatedAt', 'snapshot', 'scope', 'units', 'customers', 'affectedShippedQuantity', 'paths', 'pathsComplete', 'warnings', 'annotations'];
const V2_KEYS = ['reportSchemaVersion', 'schemaVersion', 'ruleVersion', ...ORIGIN_KEYS, ...BODY_KEYS];
const V1_KEYS = ['reportSchemaVersion', 'schemaVersion', 'ruleVersion', 'synthetic', 'syntheticLabel', 'disclaimer', ...BODY_KEYS];
const sameKeys = (obj, keys) => canonical(Object.keys(obj).sort()) === canonical([...keys].sort());

/** Parse an exported report JSON (current v2, or legacy v1 upconverted to unverified origin). */
export function parseReportJson(text) {
  if (typeof text !== 'string') throw new TraceChainError('BAD_REPORT', 'Report JSON must be a string');
  let doc;
  try { doc = JSON.parse(text); } catch { throw new TraceChainError('BAD_REPORT', 'Report JSON is not valid JSON'); }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new TraceChainError('BAD_REPORT', 'Report JSON must be an object');
  const v = doc.reportSchemaVersion;
  const upconverted = v === REPORT_SCHEMA_VERSION && Object.hasOwn(doc, 'upconvertedFrom');
  const keys = v === LEGACY_REPORT_SCHEMA_VERSION ? V1_KEYS : upconverted ? [...V2_KEYS, 'upconvertedFrom', 'legacyClaims'] : V2_KEYS;
  if ((v === REPORT_SCHEMA_VERSION || v === LEGACY_REPORT_SCHEMA_VERSION) && !sameKeys(doc, keys)) {
    throw new TraceChainError('BAD_REPORT', `Report JSON keys do not match ${v}`);
  }
  const origin = readOrigin(v, doc, doc.snapshot);
  const body = Object.fromEntries(BODY_KEYS.map((k) => [k, doc[k]]));
  return { reportSchemaVersion: REPORT_SCHEMA_VERSION, schemaVersion: doc.schemaVersion, ruleVersion: doc.ruleVersion, ...origin, ...body };
}
