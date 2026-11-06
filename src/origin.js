// Data-origin labels. Origin comes from the control path that loaded the data, never from the data itself:
// a "synthetic": true flag, batch ID, file name or byte-identical copy of the fixture is NOT evidence of origin.
import { SYNTHETIC_LABEL, DISCLAIMER, TraceChainError } from './limits.js';

/** The app itself fetched and imported its own bundled fixture TC-SYN-001 (and the bytes match the pin). */
export const ORIGIN_BUNDLED_FIXTURE = 'bundled-synthetic-fixture';
/** Anything else: local file imports, caller-supplied strings/bytes, or a bundled claim that fails the pin. */
export const ORIGIN_UNVERIFIED = 'unverified-user-supplied';

export const UNVERIFIED_LABEL = 'UNVERIFIED USER-SUPPLIED DATA';
export const CONTENT_INSPECTION_NOTICE =
  'TraceChain does not inspect the content of imported data and cannot detect or prevent real, personal, ' +
  'confidential or otherwise sensitive data. A "synthetic": true flag, batch ID or file name in the input is not ' +
  'evidence of where the data came from.';
export const UNVERIFIED_DISCLAIMER =
  'UNVERIFIED USER-SUPPLIED DATA. Imported from a local file or caller-supplied input; its origin, accuracy and ' +
  'synthetic status are not verified, even if it declares synthetic: true. Not a live recall, safety certification, ' +
  'FDA/FSMA compliance determination or regulatory export format. Customers absent from this report are NOT certified safe.';

/**
 * Snapshot identity of the bundled fixture (fixtures/TC-SYN-001.json and .csv canonicalize to the same snapshot).
 * A bundled-fixture claim is honored only when the accepted snapshot is exactly this one, so a tampered or replaced
 * fixture file served to the app cannot inherit the synthetic label. test/provenance.test.js recomputes this pin.
 */
export const BUNDLED_FIXTURE = Object.freeze({
  batchId: 'TC-SYN-001',
  contentHash: 'sha256:c327cddd1fb34aa4fb3ce31c635d461b8ccfd360b15f3cf953df9b2b16ea9605',
});

const FIELDS = Object.freeze({
  [ORIGIN_BUNDLED_FIXTURE]: Object.freeze({
    dataOrigin: ORIGIN_BUNDLED_FIXTURE,
    dataOriginVerified: true,
    dataOriginLabel: `${SYNTHETIC_LABEL} (bundled fixture TC-SYN-001 loaded by the app itself)`,
    contentInspectionNotice: CONTENT_INSPECTION_NOTICE,
    disclaimer: DISCLAIMER,
  }),
  [ORIGIN_UNVERIFIED]: Object.freeze({
    dataOrigin: ORIGIN_UNVERIFIED,
    dataOriginVerified: false,
    dataOriginLabel: UNVERIFIED_LABEL,
    contentInspectionNotice: CONTENT_INSPECTION_NOTICE,
    disclaimer: UNVERIFIED_DISCLAIMER,
  }),
});

export function isOrigin(value) {
  return value === ORIGIN_BUNDLED_FIXTURE || value === ORIGIN_UNVERIFIED;
}

/** Validate a caller's claimed origin option (undefined means unverified). */
export function checkClaimedOrigin(claimed) {
  if (claimed !== undefined && !isOrigin(claimed)) {
    throw new TraceChainError('BAD_ARGUMENT', `origin must be "${ORIGIN_UNVERIFIED}" or "${ORIGIN_BUNDLED_FIXTURE}"`);
  }
  return claimed ?? ORIGIN_UNVERIFIED;
}

export function isBundledFixtureSnapshot(snapshot) {
  return snapshot?.batchId === BUNDLED_FIXTURE.batchId && snapshot?.contentHash === BUNDLED_FIXTURE.contentHash;
}

/** Resolve the effective origin: a bundled claim is downgraded to unverified unless the snapshot is the pinned fixture. */
export function resolveOrigin(claimed, snapshot) {
  const c = checkClaimedOrigin(claimed);
  return c === ORIGIN_BUNDLED_FIXTURE && isBundledFixtureSnapshot(snapshot) ? ORIGIN_BUNDLED_FIXTURE : ORIGIN_UNVERIFIED;
}

/** Label fields carried on results, reports and exports. */
export function originFields(origin) {
  if (!isOrigin(origin)) throw new TraceChainError('BAD_ARGUMENT', 'unknown data origin');
  return { ...FIELDS[origin] };
}
