// Field-level schema normalization for JSON and CSV batches into one canonical candidate shape.
// Collects every field error (bounded) instead of stopping at the first, so diagnostics are complete.
import { LIMITS, DANGEROUS_KEYS, SCHEMA_VERSION, UNIT, TraceChainError } from './limits.js';
import { JsonNumber, parseStrictJson } from './input.js';
import { parseCsv } from './csv.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const EVENT_TYPES = new Set(['receipt', 'transformation', 'shipment']);

export class ErrorCollector {
  constructor() {
    this.errors = [];
    this.truncated = false;
  }
  add(code, message, extra = {}) {
    if (this.errors.length >= LIMITS.maxErrors) {
      this.truncated = true;
      return;
    }
    this.errors.push({ code, message, ...extra });
  }
  get ok() {
    return this.errors.length === 0;
  }
}

function rawScalar(v) {
  if (v instanceof JsonNumber) return { raw: v.raw, kind: 'number' };
  if (typeof v === 'string') return { raw: v, kind: 'string' };
  return null;
}

export function readId(v, field, src, errs) {
  if (typeof v !== 'string' || v === '') {
    errs.add('MISSING_FIELD', `${field} is required and must be a non-empty string`, { sourceRow: src, field });
    return null;
  }
  if (v.length > LIMITS.maxIdLength) {
    errs.add('STRING_TOO_LONG', `${field} exceeds ${LIMITS.maxIdLength} characters`, { sourceRow: src, field });
    return null;
  }
  if (!ID_RE.test(v) || DANGEROUS_KEYS.has(v)) {
    errs.add('INVALID_ID', `${field} "${v}" must match ${ID_RE} and not be a reserved key`, { sourceRow: src, field });
    return null;
  }
  return v;
}

export function readText(v, field, src, errs, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) errs.add('MISSING_FIELD', `${field} is required`, { sourceRow: src, field });
    return required ? null : '';
  }
  if (typeof v !== 'string') {
    errs.add('INVALID_TYPE', `${field} must be a string`, { sourceRow: src, field });
    return null;
  }
  if (v.length > LIMITS.maxTextLength) {
    errs.add('STRING_TOO_LONG', `${field} exceeds ${LIMITS.maxTextLength} characters`, { sourceRow: src, field });
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) {
    errs.add('CONTROL_CHARACTERS', `${field} contains control characters or line breaks`, { sourceRow: src, field });
    return null;
  }
  return v;
}

/**
 * Integer-gram reader. Accepts only canonical base-10 integer lexemes. Rejects zero (unless allowZero),
 * negatives, fractions/decimal notation, exponent notation, unit suffixes and unsafe integers.
 */
export function readGrams(v, field, src, errs, { allowZero = false, sourceKind = 'json' } = {}) {
  const s = rawScalar(v);
  if (v === undefined || v === null || (s && s.raw === '')) {
    errs.add('MISSING_FIELD', `${field} is required`, { sourceRow: src, field });
    return null;
  }
  if (!s || (sourceKind === 'json' && s.kind !== 'number')) {
    errs.add('INVALID_QUANTITY', `${field} must be a JSON integer number of grams`, { sourceRow: src, field, observed: describe(v) });
    return null;
  }
  const raw = s.raw;
  const extra = { sourceRow: src, field, observed: raw };
  if (/^-?[0-9.]+[eE]/.test(raw)) {
    errs.add('EXPONENT_NOTATION', `${field} "${raw}" uses exponent notation; write integer grams`, extra);
    return null;
  }
  if (/^-/.test(raw)) {
    errs.add('NON_POSITIVE_QUANTITY', `${field} "${raw}" is negative`, extra);
    return null;
  }
  if (/^[0-9]*\.[0-9]*$/.test(raw)) {
    errs.add('FRACTIONAL_QUANTITY', `${field} "${raw}" is fractional/decimal; v1 requires integer grams`, extra);
    return null;
  }
  if (/^[0-9.]+\s*[A-Za-z]+$/.test(raw)) {
    errs.add('MIXED_UNIT', `${field} "${raw}" carries a unit suffix; v1 accepts integer grams only with no conversion`, extra);
    return null;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    errs.add('INVALID_QUANTITY', `${field} "${raw}" is not a canonical base-10 integer`, extra);
    return null;
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || raw.length > 16) {
    errs.add('UNSAFE_INTEGER', `${field} "${raw}" exceeds the safe integer range`, extra);
    return null;
  }
  if (num === 0 && !allowZero) {
    errs.add('NON_POSITIVE_QUANTITY', `${field} must be positive`, extra);
    return null;
  }
  return num;
}

function describe(v) {
  if (v instanceof JsonNumber) return v.raw;
  if (typeof v === 'string') return v.slice(0, 64);
  return typeof v;
}

export function readUnit(v, field, src, errs, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) errs.add('MISSING_FIELD', `${field} is required (must be "${UNIT}")`, { sourceRow: src, field });
    return UNIT;
  }
  if (v !== UNIT) {
    errs.add('MIXED_UNIT', `${field} "${describe(v)}" is not "${UNIT}"; no implicit unit conversion in v1`, { sourceRow: src, field, observed: describe(v), expected: UNIT });
    return null;
  }
  return UNIT;
}

/** Strict ISO-8601 UTC timestamp with a real calendar date. Returns { iso, ms } or null. */
export function readTimestamp(v, field, src, errs) {
  if (typeof v !== 'string' || v === '') {
    errs.add('MISSING_FIELD', `${field} is required`, { sourceRow: src, field });
    return null;
  }
  const m = TS_RE.exec(v);
  if (!m) {
    errs.add('INVALID_TIMESTAMP', `${field} "${v.slice(0, 64)}" must be ISO-8601 UTC like 2026-01-05T08:00:00Z`, { sourceRow: src, field, observed: v.slice(0, 64) });
    return null;
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const frac = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s, frac);
  const dt = new Date(ms);
  const real =
    y >= 1970 && y <= 9999 &&
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d &&
    dt.getUTCHours() === h && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === s;
  if (!real) {
    errs.add('INVALID_TIMESTAMP', `${field} "${v}" is not a real UTC date/time`, { sourceRow: src, field, observed: v });
    return null;
  }
  return { iso: v, ms };
}

function checkKeys(obj, allowed, src, errs) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errs.add('UNKNOWN_FIELD', `Unknown field "${k}"`, { sourceRow: src, field: k });
  }
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNumber);
}

// ---------- canonical record builders (shared by JSON and CSV) ----------

function buildLot(o, src, errs) {
  return {
    id: readId(o.id, 'lot.id', src, errs),
    productId: readId(o.productId, 'lot.productId', src, errs),
    unit: readUnit(o.unit, 'lot.unit', src, errs, { required: true }),
    label: readText(o.label, 'lot.label', src, errs, { required: false }),
    sourceRow: src,
  };
}
function buildCustomer(o, src, errs) {
  return {
    id: readId(o.id, 'customer.id', src, errs),
    name: readText(o.name, 'customer.name', src, errs),
    sourceRow: src,
  };
}
function buildEvent(o, src, errs, sourceKind) {
  let type = o.type;
  if (!EVENT_TYPES.has(type)) {
    errs.add('INVALID_EVENT_TYPE', `event.type "${describe(type)}" must be receipt, transformation or shipment`, { sourceRow: src });
    type = null;
  }
  const hasSeq = o.sequence !== undefined && o.sequence !== null && o.sequence !== '';
  return {
    id: readId(o.id, 'event.id', src, errs),
    type,
    timestamp: readTimestamp(o.timestamp, 'event.timestamp', src, errs),
    sequence: hasSeq ? readGrams(o.sequence, 'event.sequence', src, errs, { allowZero: true, sourceKind }) : null,
    facilityId: readId(o.facilityId, 'event.facilityId', src, errs),
    sourceReference: readText(o.sourceReference, 'event.sourceReference', src, errs),
    sourceRow: src,
  };
}
function buildLine(o, field, src, errs, sourceKind) {
  readUnit(o.unit, `${field}.unit`, src, errs);
  return {
    lotId: readId(o.lotId, `${field}.lotId`, src, errs),
    quantity: readGrams(o.quantity, `${field}.quantity`, src, errs, { sourceKind }),
    sourceRow: src,
  };
}
function buildReceipt(o, src, errs, sourceKind) {
  readUnit(o.unit, 'receipt.unit', src, errs);
  return {
    eventId: readId(o.eventId, 'receipt.eventId', src, errs),
    lotId: readId(o.lotId, 'receipt.lotId', src, errs),
    quantity: readGrams(o.quantity, 'receipt.quantity', src, errs, { sourceKind }),
    sourceRow: src,
  };
}
function buildShipment(o, src, errs, sourceKind) {
  readUnit(o.unit, 'shipment.unit', src, errs);
  return {
    eventId: readId(o.eventId, 'shipment.eventId', src, errs),
    lotId: readId(o.lotId, 'shipment.lotId', src, errs),
    quantity: readGrams(o.quantity, 'shipment.quantity', src, errs, { sourceKind }),
    customerId: readId(o.customerId, 'shipment.customerId', src, errs),
    sourceRow: src,
  };
}

function checkMeta(meta, errs) {
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    errs.add('SCHEMA_VERSION', `schemaVersion must be "${SCHEMA_VERSION}"`, { sourceRow: meta.src, observed: describe(meta.schemaVersion) });
  }
  if (meta.synthetic !== true) {
    errs.add('NOT_SYNTHETIC', 'Batch must declare synthetic: true; this slice accepts only fictional demo data', { sourceRow: meta.src });
  }
}

// ---------- JSON ----------

const TOP_KEYS = ['schemaVersion', 'batchId', 'synthetic', 'lots', 'customers', 'events', 'receipts', 'transformations', 'shipments'];
const KEYS = {
  lot: ['id', 'productId', 'unit', 'label'],
  customer: ['id', 'name'],
  event: ['id', 'type', 'timestamp', 'sequence', 'facilityId', 'sourceReference'],
  receipt: ['eventId', 'lotId', 'quantity', 'unit'],
  transformation: ['eventId', 'inputs', 'outputs', 'configuredLoss', 'unit'],
  line: ['lotId', 'quantity', 'unit'],
  shipment: ['eventId', 'lotId', 'quantity', 'customerId', 'unit'],
};

export function normalizeJson(text) {
  const errs = new ErrorCollector();
  const root = parseStrictJson(text);
  if (!isObj(root)) throw new TraceChainError('JSON_SHAPE', 'Top-level JSON must be an object');
  checkKeys(root, TOP_KEYS, 'json:/', errs);
  checkMeta({ schemaVersion: root.schemaVersion, synthetic: root.synthetic, src: 'json:/' }, errs);
  const batchId = readId(root.batchId, 'batchId', 'json:/batchId', errs);
  let count = 0;
  const list = (name, kind, build) => {
    const arr = root[name];
    if (!Array.isArray(arr)) {
      errs.add('JSON_SHAPE', `"${name}" must be an array`, { sourceRow: `json:/${name}` });
      return [];
    }
    count += arr.length;
    return arr.map((o, idx) => {
      const src = `json:/${name}/${idx}`;
      if (!isObj(o)) {
        errs.add('JSON_SHAPE', `${name}[${idx}] must be an object`, { sourceRow: src });
        return null;
      }
      checkKeys(o, KEYS[kind], src, errs);
      return build(o, src);
    }).filter(Boolean);
  };
  const lots = list('lots', 'lot', (o, s) => buildLot(o, s, errs));
  const customers = list('customers', 'customer', (o, s) => buildCustomer(o, s, errs));
  const events = list('events', 'event', (o, s) => buildEvent(o, s, errs, 'json'));
  const receipts = list('receipts', 'receipt', (o, s) => buildReceipt(o, s, errs, 'json'));
  const shipments = list('shipments', 'shipment', (o, s) => buildShipment(o, s, errs, 'json'));
  const transformations = list('transformations', 'transformation', (o, src) => {
    readUnit(o.unit, 'transformation.unit', src, errs);
    const lines = (key) => {
      if (!Array.isArray(o[key])) {
        errs.add('JSON_SHAPE', `transformation.${key} must be an array`, { sourceRow: src });
        return [];
      }
      count += o[key].length;
      return o[key].map((l, j) => {
        const lsrc = `${src}/${key}/${j}`;
        if (!isObj(l)) {
          errs.add('JSON_SHAPE', `transformation.${key}[${j}] must be an object`, { sourceRow: lsrc });
          return null;
        }
        checkKeys(l, KEYS.line, lsrc, errs);
        return buildLine(l, `transformation.${key}`, lsrc, errs, 'json');
      }).filter(Boolean);
    };
    return {
      eventId: readId(o.eventId, 'transformation.eventId', src, errs),
      inputs: lines('inputs'),
      outputs: lines('outputs'),
      configuredLoss: o.configuredLoss === undefined
        ? (errs.add('MISSING_FIELD', 'transformation.configuredLoss must be explicit (use 0 for no loss)', { sourceRow: src, field: 'configuredLoss' }), null)
        : readGrams(o.configuredLoss, 'transformation.configuredLoss', src, errs, { allowZero: true }),
      sourceRow: src,
    };
  });
  if (count > LIMITS.maxRecords) {
    throw new TraceChainError('TOO_MANY_RECORDS', `Batch has ${count} records; limit is ${LIMITS.maxRecords}`);
  }
  return { batchId, lots, customers, events, receipts, transformations, shipments, errors: errs };
}

// ---------- CSV ----------

export const CSV_COLUMNS = [
  'recordType', 'id', 'schemaVersion', 'synthetic', 'type', 'timestamp', 'sequence', 'facilityId',
  'sourceReference', 'eventId', 'lotId', 'productId', 'unit', 'quantity', 'customerId', 'name', 'label', 'configuredLoss',
];
const CSV_ALLOWED = {
  batch: ['id', 'schemaVersion', 'synthetic'],
  lot: KEYS.lot,
  customer: KEYS.customer,
  event: KEYS.event,
  receipt: KEYS.receipt,
  transformation: ['eventId', 'configuredLoss', 'unit'],
  transformation_input: ['eventId', ...KEYS.line],
  transformation_output: ['eventId', ...KEYS.line],
  shipment: KEYS.shipment,
};

export function normalizeCsv(text) {
  const errs = new ErrorCollector();
  const { header, rows } = parseCsv(text);
  const seen = new Set();
  for (const h of header) {
    if (!CSV_COLUMNS.includes(h)) throw new TraceChainError('CSV_HEADER', `Unknown CSV column "${h.slice(0, 64)}"`);
    if (seen.has(h)) throw new TraceChainError('CSV_HEADER', `Duplicate CSV column "${h}"`);
    seen.add(h);
  }
  if (!seen.has('recordType')) throw new TraceChainError('CSV_HEADER', 'CSV header must include recordType');
  if (rows.length > LIMITS.maxRecords) {
    throw new TraceChainError('TOO_MANY_RECORDS', `Batch has ${rows.length} records; limit is ${LIMITS.maxRecords}`);
  }
  const out = { batchId: null, lots: [], customers: [], events: [], receipts: [], transformations: [], shipments: [], errors: errs };
  const tx = new Map();
  const pendingLines = [];
  let batchRows = 0;
  for (const r of rows) {
    const src = `csv:line ${r.line}`;
    const o = Object.create(null);
    header.forEach((h, idx) => { if (r.cells[idx] !== '') o[h] = r.cells[idx]; });
    const rt = o.recordType;
    // Own-property lookup only: recordType values like __proto__/constructor/toString must not hit Object.prototype.
    const allowed = typeof rt === 'string' && Object.hasOwn(CSV_ALLOWED, rt) ? CSV_ALLOWED[rt] : null;
    if (!allowed) {
      errs.add('UNKNOWN_RECORD_TYPE', `recordType "${String(rt ?? '').slice(0, 32)}" is not recognized`, { sourceRow: src });
      continue;
    }
    for (const k of Object.keys(o)) {
      if (k !== 'recordType' && !allowed.includes(k)) {
        errs.add('UNEXPECTED_FIELD', `Column "${k}" must be empty for recordType ${rt}`, { sourceRow: src, field: k });
      }
    }
    switch (rt) {
      case 'batch':
        batchRows++;
        out.batchId = readId(o.id, 'batchId', src, errs);
        checkMeta({ schemaVersion: o.schemaVersion, synthetic: o.synthetic === 'true' ? true : o.synthetic, src }, errs);
        break;
      case 'lot': out.lots.push(buildLot(o, src, errs)); break;
      case 'customer': out.customers.push(buildCustomer(o, src, errs)); break;
      case 'event': out.events.push(buildEvent(o, src, errs, 'csv')); break;
      case 'receipt': out.receipts.push(buildReceipt(o, src, errs, 'csv')); break;
      case 'shipment': out.shipments.push(buildShipment(o, src, errs, 'csv')); break;
      case 'transformation': {
        readUnit(o.unit, 'transformation.unit', src, errs);
        const t = {
          eventId: readId(o.eventId, 'transformation.eventId', src, errs),
          inputs: [], outputs: [],
          configuredLoss: o.configuredLoss === undefined
            ? (errs.add('MISSING_FIELD', 'transformation.configuredLoss must be explicit (use 0 for no loss)', { sourceRow: src, field: 'configuredLoss' }), null)
            : readGrams(o.configuredLoss, 'transformation.configuredLoss', src, errs, { allowZero: true, sourceKind: 'csv' }),
          sourceRow: src,
        };
        out.transformations.push(t);
        if (t.eventId && !tx.has(t.eventId)) tx.set(t.eventId, t);
        break;
      }
      default: { // transformation_input / transformation_output
        const field = rt === 'transformation_input' ? 'transformation.inputs' : 'transformation.outputs';
        pendingLines.push({ rt, eventId: readId(o.eventId, `${field}.eventId`, src, errs), line: buildLine(o, field, src, errs, 'csv'), src });
      }
    }
  }
  if (batchRows !== 1) errs.add('CSV_BATCH_ROW', `CSV must contain exactly one batch row; found ${batchRows}`, { sourceRow: 'csv' });
  for (const p of pendingLines) {
    const t = p.eventId && tx.get(p.eventId);
    if (!t) {
      errs.add('MISSING_REFERENCE', `${p.rt} references transformation event "${p.eventId}" with no transformation row`, { sourceRow: p.src, eventId: p.eventId });
      continue;
    }
    (p.rt === 'transformation_input' ? t.inputs : t.outputs).push(p.line);
  }
  return out;
}
