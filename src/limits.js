// Central resource limits and version identifiers. Frozen; no module-level mutable state.
export const LIMITS = Object.freeze({
  maxInputBytes: 1024 * 1024, // 1 MiB
  maxRecords: 5000,
  maxJsonDepth: 8,
  maxIdLength: 64,
  maxTextLength: 256,
  maxNoteLength: 2000,
  maxCsvColumns: 32,
  maxTraversalSteps: 200000,
  maxPaths: 10000,
  maxPathElements: 500000, // total path nodes allocated while enumerating contributing paths
  maxAnnotations: 1000,
  maxErrors: 500,
  maxSessions: 1000,
});

export const SCHEMA_VERSION = 'tracechain.batch.v1';
export const RULE_VERSION = 'tracechain.rules.v1.1';
// v2: origin comes from the control path (dataOrigin*), not a hardcoded synthetic claim. v1 is read as legacy only.
export const REPORT_SCHEMA_VERSION = 'tracechain.report.v2';
export const LEGACY_REPORT_SCHEMA_VERSION = 'tracechain.report.v1';
// v2: the snapshot records inputDeclaredSynthetic instead of synthetic/syntheticLabel/disclaimer (changes contentHash).
export const SNAPSHOT_VERSION = 'tracechain.snapshot.v2';
export const UNIT = 'g';
export const SYNTHETIC_LABEL = 'SYNTHETIC DEMO DATA';
export const DISCLAIMER =
  'SYNTHETIC DEMO DATA. Fictional lots, facilities and customers. Not a live recall, safety certification, ' +
  'FDA/FSMA compliance determination or regulatory export format. Customers absent from this report are NOT certified safe.';
export const REJECTION_COMPLETENESS_MESSAGE =
  'Trace completeness cannot be evaluated for this rejected batch';

export const DANGEROUS_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

export class TraceChainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TraceChainError';
    this.code = code;
    this.details = details;
  }
}

/** Normalize an optional options argument; malformed caller values get a predictable BAD_ARGUMENT. */
export function optionsObject(value, name) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TraceChainError('BAD_ARGUMENT', `${name} must be a plain options object`);
  }
  return value;
}

/** Checked integer addition: both operands and result must be safe integers. */
export function checkedAdd(a, b) {
  const r = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(r)) {
    throw new TraceChainError('ARITHMETIC_OVERFLOW', `Integer overflow adding ${a} + ${b}`);
  }
  return r;
}

export function checkedSub(a, b) {
  const r = a - b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(r)) {
    throw new TraceChainError('ARITHMETIC_OVERFLOW', `Integer overflow subtracting ${a} - ${b}`);
  }
  return r;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
