// Pure workflow state for the TraceChain review desk (no DOM). Every figure comes from the real engine.
// SYNTHETIC DEMO DATA ONLY: not a recall tool, safety certification or FDA/FSMA determination.
// '../src/' resolves to the repo engine in Node and to /src/ in dist when served from the site root.
import { Workspace, LIMITS, queryRecords } from '../src/index.js';

export const MAX_FILE_BYTES = LIMITS.maxInputBytes;

/** Build the missing-T2 challenge at runtime from the real sample (T2 event row and its transformation removed). */
export function buildChallenge(sampleJsonText) {
  const doc = JSON.parse(sampleJsonText);
  doc.batchId = 'TC-SYN-001-MISSING-T2';
  doc.transformations = doc.transformations.filter((t) => t.eventId !== 'T2');
  doc.events = doc.events.filter((e) => e.id !== 'T2');
  return JSON.stringify(doc, null, 2);
}

export class ReviewSession {
  constructor() {
    this.ws = new Workspace();
    this.lastImport = null;
    this.selectedLot = null;
    this.backwardTarget = null;
  }

  /** @param {string|Uint8Array} input  @param {'json'|'csv'} format  @param {string} sourceLabel */
  importInput(input, format, sourceLabel) {
    if (input instanceof Uint8Array && input.byteLength > MAX_FILE_BYTES) {
      this.lastImport = { status: 'error', sourceLabel, message: `File is ${input.byteLength} bytes; the limit is ${MAX_FILE_BYTES} bytes (1 MiB). Nothing was imported.` };
      return this.lastImport;
    }
    const res = this.ws.importBatch(input, { format });
    this.lastImport = { ...res, sourceLabel };
    if (res.status === 'accepted') {
      const s = res.snapshot;
      if (!s.lots.some((l) => l.id === this.selectedLot)) this.selectedLot = s.lots.find((l) => l.root)?.id ?? null;
      if (!s.lots.some((l) => l.id === this.backwardTarget)) this.backwardTarget = null;
    }
    return this.lastImport;
  }

  snapshot() { return this.ws.currentSnapshot(); }

  forward(lotId = this.selectedLot) {
    if (!lotId) return null;
    this.selectedLot = lotId;
    return this.ws.traceForward(lotId);
  }

  backward(lotId = this.backwardTarget) {
    if (!lotId) return null;
    this.backwardTarget = lotId;
    return this.ws.traceBackward(lotId);
  }

  /** Customers in the snapshot that the engine did NOT reach. Not certified safe; only outside this trace. */
  unreachedCustomers(fwd) {
    const reached = new Set(fwd.result.customers.map((c) => c.customerId));
    return this.snapshot().customers.filter((c) => !reached.has(c.id));
  }

  evidence(eventId) { return this.ws.evidence(eventId); }

  query(collection, search, sortBy, direction, filter) {
    return queryRecords(this.snapshot(), { collection, search, filter, sortBy: sortBy || undefined, direction });
  }

  annotate(reviewer, targetType, targetId, note) {
    return this.ws.addAnnotation({ reviewer, targetType, targetId, note });
  }

  annotations() { return this.ws.annotations(); }

  exportReport(format) {
    return this.ws.exportReport(this.selectedLot, { format });
  }
}
