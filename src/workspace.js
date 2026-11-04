// Per-session workspace: atomic imports, retained prior snapshot, reviewer annotations, report export.
// Each workspace holds its own private state; there is no module-level mutable state shared between sessions.
import { LIMITS, REJECTION_COMPLETENESS_MESSAGE, TraceChainError, deepFreeze } from './limits.js';
import { decodeInput } from './input.js';
import { normalizeJson, normalizeCsv, readId, readText, readTimestamp, ErrorCollector } from './schema.js';
import { validateCandidate } from './validate.js';
import { traceForward, traceBackward, eventEvidence } from './trace.js';
import { buildReport, reportToJson, reportToCsv } from './report.js';

/** Pure import: returns { ok, snapshot } or { ok:false, errors, candidate } without touching any workspace. */
export function importCandidate(input, { format } = {}) {
  let candidate = null;
  try {
    if (format !== 'json' && format !== 'csv') {
      throw new TraceChainError('FORMAT', 'format must be explicitly "json" or "csv" (no sniffing, URLs or files)');
    }
    const text = decodeInput(input);
    candidate = format === 'json' ? normalizeJson(text) : normalizeCsv(text);
    const res = validateCandidate(candidate);
    return res.ok ? res : { ...res, candidate };
  } catch (e) {
    if (!(e instanceof TraceChainError)) throw e;
    return { ok: false, errors: [{ code: e.code, message: e.message }], truncated: false, candidate };
  }
}

function submittedRowIds(candidate) {
  if (!candidate) return { lots: [], customers: [], events: [] };
  const ids = (arr) => arr.filter((r) => r.id !== null).map((r) => ({ id: r.id, sourceRow: r.sourceRow }));
  return { lots: ids(candidate.lots), customers: ids(candidate.customers), events: ids(candidate.events) };
}

export class Workspace {
  #current = null;
  #annotations = [];
  #nextAnnotation = 1;
  #now;

  /** @param {{ now?: () => string }} opts  injectable ISO-UTC clock for deterministic annotations */
  constructor({ now } = {}) {
    this.#now = now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }

  /** Atomic import. On rejection the previous snapshot is retained and labeled, never presented as this result. */
  importBatch(input, { format } = {}) {
    const res = importCandidate(input, { format });
    if (res.ok) {
      this.#current = res.snapshot;
      return deepFreeze({ status: 'accepted', batchId: res.snapshot.batchId, contentHash: res.snapshot.contentHash, snapshot: res.snapshot });
    }
    const prior = this.#current;
    return deepFreeze({
      status: 'rejected',
      submittedBatchId: res.candidate?.batchId ?? null,
      completeness: REJECTION_COMPLETENESS_MESSAGE,
      acceptedGraph: null,
      errorCount: res.errors.length,
      errorsTruncated: res.truncated,
      errors: res.errors.map((e) => ({ ...e })),
      submittedRowIds: submittedRowIds(res.candidate),
      note: 'Submitted rows are shown for diagnosis only. They are not an accepted partial graph and cannot produce an affected-customer report.',
      priorSnapshot: prior
        ? { batchId: prior.batchId, contentHash: prior.contentHash, label: `Prior accepted snapshot from batch "${prior.batchId}" is retained unchanged. It is NOT the result of this rejected import.` }
        : { batchId: null, contentHash: null, label: 'No prior accepted snapshot exists; no trace is available.' },
    });
  }

  currentSnapshot() {
    return this.#current;
  }

  #requireSnapshot() {
    if (!this.#current) throw new TraceChainError('NO_SNAPSHOT', 'No accepted snapshot; import a valid batch first');
    return this.#current;
  }

  #label(s) {
    return { snapshotBatchId: s.batchId, snapshotHash: s.contentHash, snapshotLabel: `Results from accepted snapshot batch "${s.batchId}"` };
  }

  traceForward(lotId) {
    const s = this.#requireSnapshot();
    return { ...this.#label(s), result: traceForward(s, lotId) };
  }

  traceBackward(lotId) {
    const s = this.#requireSnapshot();
    return { ...this.#label(s), result: traceBackward(s, lotId) };
  }

  evidence(eventId) {
    const s = this.#requireSnapshot();
    return { ...this.#label(s), result: eventEvidence(s, eventId) };
  }

  /** Annotations are stored beside (never inside) the immutable snapshot and cite it by batch ID and hash. */
  addAnnotation({ reviewer, targetType, targetId, note } = {}) {
    const s = this.#requireSnapshot();
    if (this.#annotations.length >= LIMITS.maxAnnotations) throw new TraceChainError('ANNOTATION_LIMIT', 'Too many annotations');
    const errs = new ErrorCollector();
    const r = readId(reviewer, 'reviewer', 'annotation', errs);
    const tid = readId(targetId, 'targetId', 'annotation', errs);
    if (typeof note !== 'string' || note.trim() === '' || note.length > LIMITS.maxNoteLength) {
      errs.add('INVALID_NOTE', `note must be a non-empty string up to ${LIMITS.maxNoteLength} characters`);
    } else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
      errs.add('CONTROL_CHARACTERS', 'note contains control characters');
    }
    const at = this.#now();
    readTimestamp(at, 'createdAt', 'annotation', errs);
    const exists =
      targetType === 'lot' ? s.lots.some((l) => l.id === tid)
        : targetType === 'event' ? s.events.some((e) => e.id === tid)
          : targetType === 'customer' ? s.customers.some((c) => c.id === tid) : null;
    if (exists === null) errs.add('INVALID_TARGET', 'targetType must be lot, event or customer');
    else if (tid !== null && !exists) errs.add('UNKNOWN_TARGET', `${targetType} "${tid}" is not in the accepted snapshot`);
    if (!errs.ok) throw new TraceChainError(errs.errors[0].code, errs.errors.map((e) => e.message).join('; '), { errors: errs.errors });
    readText(r, 'reviewer', 'annotation', errs);
    const ann = Object.freeze({
      id: `ANN-${this.#nextAnnotation++}`, reviewer: r, targetType, targetId: tid, note, createdAt: at,
      snapshotBatchId: s.batchId, snapshotHash: s.contentHash,
    });
    this.#annotations.push(ann);
    return ann;
  }

  annotations() {
    const s = this.#current;
    return s ? this.#annotations.filter((a) => a.snapshotHash === s.contentHash) : [];
  }

  exportReport(lotId, { format = 'json', generatedAt } = {}) {
    const s = this.#requireSnapshot();
    const report = buildReport(s, traceForward(s, lotId), this.annotations(), { generatedAt });
    if (format === 'json') return reportToJson(report);
    if (format === 'csv') return reportToCsv(report);
    throw new TraceChainError('FORMAT', 'format must be "json" or "csv"');
  }
}

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Session-isolated registry: each visitor's session ID maps to its own Workspace. */
export class WorkspaceRegistry {
  #sessions = new Map();
  #opts;
  constructor(opts = {}) {
    this.#opts = opts;
  }
  get(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) {
      throw new TraceChainError('INVALID_SESSION', 'Session ID must be 8-64 characters of [A-Za-z0-9_-]');
    }
    let ws = this.#sessions.get(sessionId);
    if (!ws) {
      if (this.#sessions.size >= LIMITS.maxSessions) throw new TraceChainError('SESSION_LIMIT', 'Too many demo sessions');
      ws = new Workspace(this.#opts);
      this.#sessions.set(sessionId, ws);
    }
    return ws;
  }
}
