// Pure workflow state for the TraceChain review desk (no DOM). Every figure comes from the real engine.
// Not a recall tool, safety certification or FDA/FSMA determination. Only the bundled sample is synthetic demo data;
// anything a user imports is labeled UNVERIFIED USER-SUPPLIED, whatever its content, flags or file name say.
// '../src/' resolves to the repo engine in Node and to /src/ in dist when served from the site root.
import { Workspace, LIMITS, queryRecords, ORIGIN_BUNDLED_FIXTURE, ORIGIN_UNVERIFIED } from '../src/index.js';

export const MAX_FILE_BYTES = LIMITS.maxInputBytes;
/** Fixed, app-owned paths of the bundled sample (page-relative, as served from dist). Not caller-selectable. */
export const BUNDLED_SAMPLE_PATHS = Object.freeze({ json: 'fixtures/TC-SYN-001.json', csv: 'fixtures/TC-SYN-001.csv' });

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

  /**
   * The only trusted path: the app fetches its own bundled fixture from a fixed path and imports it.
   * The engine additionally downgrades the claim unless the bytes produce the pinned fixture snapshot.
   * @param {'json'|'csv'} format  @param {typeof fetch} [fetchImpl]
   */
  async loadBundledSample(format, fetchImpl = globalThis.fetch) {
    if (!Object.hasOwn(BUNDLED_SAMPLE_PATHS, format)) throw new Error('bundled sample format must be "json" or "csv"');
    const path = BUNDLED_SAMPLE_PATHS[format];
    const r = await fetchImpl(path);
    if (!r.ok) throw new Error(`could not load ${path} (HTTP ${r.status})`);
    return this.#import(new Uint8Array(await r.arrayBuffer()), format, `bundled sample TC-SYN-001.${format}`, ORIGIN_BUNDLED_FIXTURE);
  }

  /** A local file chosen by the user. Always unverified: file name, content and synthetic flags are not evidence. */
  importUserFile(bytes, format, fileName) {
    return this.#import(bytes, format, `local file "${String(fileName).slice(0, 128)}" (unverified user-supplied)`, ORIGIN_UNVERIFIED);
  }

  /** Any other caller-supplied input (kept for compatibility). Always unverified. */
  importInput(input, format, sourceLabel) {
    return this.#import(input, format, sourceLabel, ORIGIN_UNVERIFIED);
  }

  #import(input, format, sourceLabel, origin) {
    if (input instanceof Uint8Array && input.byteLength > MAX_FILE_BYTES) {
      this.lastImport = { status: 'error', sourceLabel, message: `File is ${input.byteLength} bytes; the limit is ${MAX_FILE_BYTES} bytes (1 MiB). Nothing was imported.` };
      return this.lastImport;
    }
    const res = this.ws.importBatch(input, { format, origin });
    this.lastImport = { ...res, sourceLabel };
    if (res.status === 'accepted') {
      const s = res.snapshot;
      if (!s.lots.some((l) => l.id === this.selectedLot)) this.selectedLot = s.lots.find((l) => l.root)?.id ?? null;
      if (!s.lots.some((l) => l.id === this.backwardTarget)) this.backwardTarget = null;
    }
    return this.lastImport;
  }

  snapshot() { return this.ws.currentSnapshot(); }

  /** Origin label fields of the current snapshot (null before any accepted import). */
  dataOrigin() { return this.ws.dataOrigin(); }

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
