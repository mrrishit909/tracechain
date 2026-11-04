// Data provenance: origin comes from the control path, never from content, flags or file names.
// Only the app's own bundled-fixture loader yields the synthetic label; every other import is UNVERIFIED USER-SUPPLIED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Workspace, importCandidate, traceForward, buildReport, reportToJson, reportToCsv, parseReportCsv, parseReportJson,
  ORIGIN_BUNDLED_FIXTURE, ORIGIN_UNVERIFIED, UNVERIFIED_LABEL, UNVERIFIED_DISCLAIMER, CONTENT_INSPECTION_NOTICE,
  BUNDLED_FIXTURE, SYNTHETIC_LABEL, DISCLAIMER, REPORT_SCHEMA_VERSION, LEGACY_REPORT_SCHEMA_VERSION, originFields,
} from '../src/index.js';
import { ReviewSession, BUNDLED_SAMPLE_PATHS } from '../web/state.js';
import { NOW, JSON_TEXT, CSV_TEXT, fixture, throwsCode } from './helpers.js';

const fxBytes = (f) => new Uint8Array(readFileSync(new URL(`../fixtures/${f}`, import.meta.url)));
// Test stand-in for the browser fetch of the app's own fixed paths (served from dist/fixtures).
const bundledFetch = async (path) => {
  const name = Object.entries(BUNDLED_SAMPLE_PATHS).find(([, p]) => p === path);
  if (!name) return { ok: false, status: 404 };
  return { ok: true, status: 200, arrayBuffer: async () => fxBytes(`TC-SYN-001.${name[0]}`).buffer };
};
// A server that serves something else at the bundled path (tampered or replaced fixture).
const tamperedFetch = (text) => async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer });

const assertUnverified = (x, what) => {
  assert.equal(x.dataOrigin, ORIGIN_UNVERIFIED, what);
  assert.equal(x.dataOriginVerified, false, what);
  assert.equal(x.dataOriginLabel, UNVERIFIED_LABEL, what);
  assert.equal(x.contentInspectionNotice, CONTENT_INSPECTION_NOTICE, what);
};
const assertBundled = (x, what) => {
  assert.equal(x.dataOrigin, ORIGIN_BUNDLED_FIXTURE, what);
  assert.equal(x.dataOriginVerified, true, what);
  assert.match(x.dataOriginLabel, /^SYNTHETIC DEMO DATA \(bundled fixture TC-SYN-001 loaded by the app itself\)$/, what);
  assert.equal(x.contentInspectionNotice, CONTENT_INSPECTION_NOTICE, what);
};
const noSyntheticClaim = (text, what) => {
  assert.doesNotMatch(text, /SYNTHETIC DEMO DATA/, `${what} must not carry the synthetic label`);
  assert.doesNotMatch(text, /"synthetic"\s*:/, `${what} must not carry a synthetic flag`);
};

test('labels state that content is not inspected and real/sensitive data cannot be detected or prevented', () => {
  assert.match(CONTENT_INSPECTION_NOTICE, /does not inspect the content/);
  assert.match(CONTENT_INSPECTION_NOTICE, /cannot detect or prevent real, personal, confidential or otherwise sensitive data/);
  assert.match(CONTENT_INSPECTION_NOTICE, /"synthetic": true flag, batch ID or file name in the input is not evidence/);
  assert.match(UNVERIFIED_DISCLAIMER, /^UNVERIFIED USER-SUPPLIED DATA\./);
  assert.match(UNVERIFIED_DISCLAIMER, /NOT certified safe/);
  for (const o of [ORIGIN_BUNDLED_FIXTURE, ORIGIN_UNVERIFIED]) assert.equal(originFields(o).contentInspectionNotice, CONTENT_INSPECTION_NOTICE);
});

test('pinned bundled-fixture snapshot matches both bundled fixture files', () => {
  for (const [f, text] of [['json', JSON_TEXT], ['csv', CSV_TEXT]]) {
    const r = importCandidate(text, { format: f });
    assert.equal(r.ok, true);
    assert.deepEqual({ batchId: r.snapshot.batchId, contentHash: r.snapshot.contentHash }, { ...BUNDLED_FIXTURE }, f);
    // The snapshot records the input's own claim, not an origin.
    assert.equal(r.snapshot.inputDeclaredSynthetic, true);
    for (const k of ['synthetic', 'syntheticLabel', 'disclaimer']) assert.equal(k in r.snapshot, false, k);
  }
});

test('bundled fixture loaded by the app itself is the only synthetic-labeled path (JSON and CSV)', async () => {
  for (const fmt of ['json', 'csv']) {
    const s = new ReviewSession();
    const res = await s.loadBundledSample(fmt, bundledFetch);
    assert.equal(res.status, 'accepted');
    assertBundled(res, `import ${fmt}`);
    assert.equal(res.sourceLabel, `bundled sample TC-SYN-001.${fmt}`);
    const fwd = s.forward('A');
    assertBundled(fwd, `trace ${fmt}`);
    assert.match(fwd.snapshotLabel, /SYNTHETIC DEMO DATA \(bundled fixture/);
    assertBundled(s.backward('M'), 'backward');
    assertBundled(s.evidence('T2'), 'evidence');
    const json = JSON.parse(s.exportReport('json'));
    assertBundled(json, `report json ${fmt}`);
    assert.equal(json.disclaimer, DISCLAIMER);
    assert.equal(json.reportSchemaVersion, REPORT_SCHEMA_VERSION);
    const csv = s.exportReport('csv');
    assert.match(csv.split('\n')[1], /^meta,dataOriginLabel,SYNTHETIC DEMO DATA \(bundled fixture/);
    assert.deepEqual(parseReportCsv(csv), json);
    assert.deepEqual(parseReportJson(s.exportReport('json')), json);
  }
  await assert.rejects(new ReviewSession().loadBundledSample('../../etc/passwd', bundledFetch), /format must be/);
});

test('arbitrary local files are UNVERIFIED in results, JSON and CSV, including spoofed flag, file name and content', () => {
  const spoofed = fixture();
  spoofed.batchId = 'TC-SYN-001-LOOKS-SYNTHETIC';
  spoofed.customers[0].name = 'Real Person, 1 Real Street'; // the engine cannot tell, and must not claim otherwise
  const cases = {
    'synthetic:true + fixture file name': [new TextEncoder().encode(JSON.stringify(spoofed)), 'json', 'TC-SYN-001.json'],
    'byte-identical copy of the fixture JSON': [fxBytes('TC-SYN-001.json'), 'json', 'TC-SYN-001.json'],
    'byte-identical copy of the fixture CSV': [fxBytes('TC-SYN-001.csv'), 'csv', 'fixtures/TC-SYN-001.csv'],
    'name claiming bundled origin': [fxBytes('TC-SYN-001.json'), 'json', 'bundled sample TC-SYN-001.json'],
  };
  for (const [what, [bytes, fmt, name]] of Object.entries(cases)) {
    const s = new ReviewSession();
    const res = s.importUserFile(bytes, fmt, name);
    assert.equal(res.status, 'accepted', what);
    assertUnverified(res, what);
    assert.match(res.sourceLabel, /\(unverified user-supplied\)$/, what);
    assertUnverified(s.forward('A'), what);
    assert.match(s.forward('A').snapshotLabel, /UNVERIFIED USER-SUPPLIED DATA$/, what);
    const jsonText = s.exportReport('json');
    const json = JSON.parse(jsonText);
    assertUnverified(json, what);
    assert.equal(json.disclaimer, UNVERIFIED_DISCLAIMER, what);
    noSyntheticClaim(jsonText, `${what} JSON`);
    const csv = s.exportReport('csv');
    noSyntheticClaim(csv, `${what} CSV`);
    assert.match(csv.split('\n')[1], /^meta,dataOriginLabel,UNVERIFIED USER-SUPPLIED DATA/, what);
    assert.deepEqual(parseReportCsv(csv), json, what);
    // Calculations are unaffected by origin.
    assert.equal(json.affectedShippedQuantity, 60000, what);
  }
  // Generic caller input (strings, the challenge path) is also unverified.
  const s = new ReviewSession();
  assertUnverified(s.importInput(JSON_TEXT, 'json', 'sample TC-SYN-001.json'), 'importInput');
});

test('bundled origin is not inherited across imports, and a later user import of identical bytes is unverified', async () => {
  const s = new ReviewSession();
  await s.loadBundledSample('json', bundledFetch);
  assertBundled(s.dataOrigin(), 'after bundled');
  assertUnverified(s.importUserFile(fxBytes('TC-SYN-001.json'), 'json', 'TC-SYN-001.json'), 'user copy');
  assertUnverified(JSON.parse(s.exportReport('json')), 'export after user copy');
  // A rejected user import keeps the prior snapshot and its (unverified) origin, labeled as such.
  const rej = s.importUserFile(new TextEncoder().encode('{'), 'json', 'x.json');
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.priorSnapshot.dataOrigin, ORIGIN_UNVERIFIED);
  assert.match(rej.priorSnapshot.label, /\(UNVERIFIED USER-SUPPLIED DATA\)/);
  await s.loadBundledSample('csv', bundledFetch);
  assertBundled(s.dataOrigin(), 'bundled again');
});

test('a tampered/replaced file served at the bundled path cannot inherit the synthetic label', async () => {
  const t = fixture();
  t.shipments[0].quantity = 20001;
  t.receipts[0].quantity += 1;
  const s = new ReviewSession();
  const res = await s.loadBundledSample('json', tamperedFetch(JSON.stringify(t)));
  assert.equal(res.status, 'accepted');
  assertUnverified(res, 'tampered bundled path');
  assertUnverified(JSON.parse(s.exportReport('json')), 'tampered export');
});

test('engine API: default and spoofed origin claims, report options and bad origin values', () => {
  const ws = new Workspace({ now: () => NOW });
  assertUnverified(ws.importBatch(JSON_TEXT, { format: 'json' }), 'default origin');
  const changed = fixture();
  changed.batchId = 'TC-SYN-001';
  changed.customers[0].name = 'Someone Else';
  assertUnverified(ws.importBatch(JSON.stringify(changed), { format: 'json', origin: ORIGIN_BUNDLED_FIXTURE }), 'claimed bundled, other content');
  for (const bad of ['synthetic', true, 'BUNDLED', null]) {
    throwsCode(() => ws.importBatch(JSON_TEXT, { format: 'json', origin: bad }), 'BAD_ARGUMENT');
  }
  // Malformed options are still a rejection, not an exception.
  assert.equal(ws.importBatch(JSON_TEXT, null).status, 'rejected');

  const s = importCandidate(JSON_TEXT, { format: 'json' }).snapshot;
  const t = traceForward(s, 'A');
  assertUnverified(buildReport(s, t), 'buildReport default');
  assertBundled(buildReport(s, t, [], { origin: ORIGIN_BUNDLED_FIXTURE }), 'buildReport bundled on pinned snapshot');
  const other = importCandidate(JSON.stringify(changed), { format: 'json' }).snapshot;
  assertUnverified(buildReport(other, traceForward(other, 'A'), [], { origin: ORIGIN_BUNDLED_FIXTURE }), 'buildReport bundled claim on other snapshot');
  throwsCode(() => buildReport(s, t, [], { origin: 'synthetic' }), 'BAD_ARGUMENT');
});

// ---- legacy v1 reports and report-reader hardening ----

/** Reconstruct a v1 report exactly as the previous exporter wrote it (synthetic: true for every import). */
function legacyV1(report) {
  const { dataOrigin, dataOriginVerified, dataOriginLabel, contentInspectionNotice, disclaimer, ...rest } = report;
  return {
    reportSchemaVersion: LEGACY_REPORT_SCHEMA_VERSION, schemaVersion: rest.schemaVersion, ruleVersion: rest.ruleVersion,
    synthetic: true, syntheticLabel: SYNTHETIC_LABEL,
    disclaimer: 'SYNTHETIC DEMO DATA. Fictional lots, facilities and customers. Not a live recall, safety certification, FDA/FSMA compliance determination or regulatory export format. Customers absent from this report are NOT certified safe.',
    ...Object.fromEntries(Object.entries(rest).filter(([k]) => !['reportSchemaVersion', 'schemaVersion', 'ruleVersion'].includes(k))),
  };
}
/** The v1 CSV layout: v1 began with syntheticLabel, disclaimer and reportSchemaVersion meta rows, then the same body. */
function legacyV1Csv(v2csv, v1) {
  const [header, ...lines] = v2csv.split('\r\n');
  const body = lines.filter((l) => !/^meta,(dataOriginLabel|dataOrigin|dataOriginVerified|contentInspectionNotice|disclaimer|reportSchemaVersion),/.test(l));
  const v1meta = [`meta,syntheticLabel,${v1.syntheticLabel},,,,,,`, `meta,disclaimer,"${v1.disclaimer}",,,,,,`, `meta,reportSchemaVersion,${LEGACY_REPORT_SCHEMA_VERSION},,,,,,`];
  return [header, ...v1meta, ...body].join('\r\n');
}
function currentArgs() {
  const s = importCandidate(JSON_TEXT, { format: 'json' }).snapshot;
  return [s, traceForward(s, 'A'), [], { generatedAt: NOW, origin: ORIGIN_BUNDLED_FIXTURE }];
}

test('legacy v1 JSON/CSV reports are upconverted to UNVERIFIED; their synthetic claim is kept only as a legacy claim', () => {
  const current = buildReport(...currentArgs());
  const v1 = legacyV1(current);
  for (const [what, read] of [['json', () => parseReportJson(JSON.stringify(v1))], ['csv', () => parseReportCsv(legacyV1Csv(reportToCsv(current), v1))]]) {
    const up = read();
    assert.equal(up.reportSchemaVersion, REPORT_SCHEMA_VERSION, what);
    assertUnverified(up, what);
    assert.equal(up.disclaimer, UNVERIFIED_DISCLAIMER, what);
    assert.equal(up.upconvertedFrom, LEGACY_REPORT_SCHEMA_VERSION, what);
    assert.equal(up.legacyClaims.syntheticLabel, SYNTHETIC_LABEL, what);
    assert.match(up.legacyClaims.note, /not evidence/, what);
    assert.equal('synthetic' in up, false, what);
    assert.equal('syntheticLabel' in up, false, what);
    // Data content is preserved.
    assert.equal(up.affectedShippedQuantity, 60000, what);
    assert.deepEqual(up.customers, current.customers, what);
    assert.deepEqual(up.paths, current.paths, what);
    assert.deepEqual(up.scope, current.scope, what);
    // An upconverted report stays unverified through another JSON and CSV round-trip.
    assert.deepEqual(parseReportJson(reportToJson(up)), up, what);
    assert.deepEqual(parseReportCsv(reportToCsv(up)), up, what);
  }
  assert.equal(parseReportJson(JSON.stringify(v1)).legacyClaims.synthetic, true);
});

test('report readers reject unknown versions, inconsistent origin claims and forged upconversions', () => {
  const bundled = buildReport(...currentArgs());
  const bad = (doc, what) => throwsCode(() => parseReportJson(JSON.stringify(doc)), 'BAD_REPORT', what);
  bad({ ...bundled, reportSchemaVersion: 'tracechain.report.v9' });
  bad({ ...bundled, reportSchemaVersion: undefined });
  bad({ ...bundled, dataOrigin: 'synthetic' });
  bad({ ...bundled, dataOriginLabel: SYNTHETIC_LABEL, dataOrigin: ORIGIN_UNVERIFIED }); // label/origin mismatch
  bad({ ...bundled, dataOriginVerified: false });
  bad({ ...bundled, synthetic: true }); // v2 does not carry a synthetic flag
  bad({ ...bundled, snapshot: { batchId: 'OTHER', contentHash: 'sha256:00' } }); // bundled claim on another snapshot
  bad({ ...bundled, upconvertedFrom: LEGACY_REPORT_SCHEMA_VERSION, legacyClaims: {} }); // upconverted must be unverified
  bad({ ...bundled, ...originFields(ORIGIN_UNVERIFIED), upconvertedFrom: 'tracechain.report.v0', legacyClaims: {} });
  const v1 = legacyV1(bundled);
  bad({ ...v1, dataOrigin: ORIGIN_BUNDLED_FIXTURE }); // v1 cannot smuggle a v2 origin
  for (const t of ['', '[]', 'null', '{', 42]) {
    assert.throws(() => parseReportJson(t), (e) => e.code === 'BAD_REPORT');
  }
  const csv = reportToCsv(bundled);
  throwsCode(() => parseReportCsv(csv.replace(REPORT_SCHEMA_VERSION, 'tracechain.report.v9')), 'BAD_REPORT');
  throwsCode(() => parseReportCsv(csv.replace(`meta,dataOrigin,${ORIGIN_BUNDLED_FIXTURE}`, `meta,dataOrigin,${ORIGIN_UNVERIFIED}`)), 'BAD_REPORT');
  throwsCode(() => parseReportCsv(csv.replace('meta,dataOriginVerified,true', 'meta,dataOriginVerified,false')), 'BAD_REPORT');
  throwsCode(() => parseReportCsv(csv.replace(BUNDLED_FIXTURE.contentHash, 'sha256:00')), 'BAD_REPORT');
});
