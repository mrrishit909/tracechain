# TraceChain synthetic vertical slice (engine only)

> **SYNTHETIC DEMO DATA ONLY.** Fictional lots, facilities and customers. This is not a live recall tool,
> safety certification, FDA/FSMA compliance determination or regulatory export format. Customers absent
> from a report are **not** certified safe.

Dependency-free ESM JavaScript (Node >= 20) implementing the TraceChain v1 lot-lineage engine:
strict JSON/UTF-8 CSV import, integer-gram validation, atomic batch acceptance into immutable snapshots,
forward/backward traces with every contributing path, reviewer annotations and JSON/CSV report export
with spreadsheet-formula escaping. The engine itself has no network access, file access or persistence. A static
browser interface in `web/` calls it directly (see below); there is no backend, auth or persistence.

## Run the tests

```sh
npm test            # = node --test test/*.test.js  (no installs needed)
```

## Static browser interface (unverified in a browser)

```sh
npm run build       # copies an explicit whitelist (web/, src/*.js, fixtures) to dist/ (18 files, 110187 bytes)
npm run serve       # rebuilds dist/ then serves http://127.0.0.1:8080/  (PORT=… to change; 127.0.0.1 only, GET/HEAD, CSP + nosniff, no dotfiles/traversal)
```

`dist/index.html` is the landing page. It runs the real engine on the sample and shows the computed affected grams
and customers, or an explicit failure. `dist/workspace.html` is the review desk. It covers sample JSON/CSV loading,
UTF-8 file import up to 1 MiB with an explicit format choice, forward and backward traces, customers the trace did
not reach (not certified safe), event evidence with source rows, search/filter/sort, the missing-T2 challenge
(built at runtime from the sample), restoring the valid sample, reviewer annotations stored in the in-memory
workspace, and JSON/CSV downloads. Workflow logic lives in `web/state.js` and is tested in Node
(`test/web-workflow.test.js`). **No browser, mobile or screen-reader run has happened yet.** See `docs/DESIGN.md`.

The snapshot `contentHash` now comes from `src/sha256.js`, a dependency-free synchronous SHA-256, so the same engine
runs in browsers. `test/sha256.test.js` checks it against `node:crypto` and checks that the fixture keeps its prior
hash. This is a content hash, not a signature.

## Fixture TC-SYN-001

`fixtures/TC-SYN-001.json` and `fixtures/TC-SYN-001.csv` encode the same literal fixture from the spec;
the tests assert that both canonicalize to the identical snapshot `contentHash`. Tracing input lot `A` yields
lots {A, A1, A2, M}, transformations {T1, T2}, shipments {S1, S2, S5}, customers {C1: 30000 g, C2: 30000 g},
60000 g affected shipped, remaining inventory 95000 g (170000 received − 75000 shipped); ancestors of M are
{A, A2, B}.

## Usage

```js
import { readFileSync } from 'node:fs';
import { Workspace } from './src/index.js';

const ws = new Workspace();                       // one per visitor/session (see WorkspaceRegistry)
const res = ws.importBatch(readFileSync('fixtures/TC-SYN-001.json'), { format: 'json' });
// res.status === 'accepted' | 'rejected' (rejections keep the prior snapshot, labeled with its batch ID)
const fwd = ws.traceForward('A');                 // { snapshotBatchId, snapshotLabel, result: {...} }
const back = ws.traceBackward('M');
const t2 = ws.evidence('T2');                     // inputs/outputs, configured loss, mass balance, source rows
ws.addAnnotation({ reviewer: 'QA-REVIEWER-1', targetType: 'event', targetId: 'T2', note: 'Checked T2.' });
const csv = ws.exportReport('A', { format: 'csv', generatedAt: '2026-11-03T12:00:00Z' });
```

The caller must state the format explicitly; input is always treated as content (a string that looks like a
URL or path is parsed as text and rejected, never fetched or opened).

### Batch schema (`tracechain.batch.v1`)

JSON top level: `schemaVersion`, `batchId`, `synthetic: true`, and arrays `lots` (id, productId, unit `"g"`,
optional label), `customers` (id, name), `events` (id, type receipt|transformation|shipment, timestamp ISO UTC
`YYYY-MM-DDTHH:MM:SS[.sss]Z`, optional integer `sequence`, facilityId, sourceReference), `receipts`
(eventId, lotId, quantity), `transformations` (eventId, inputs[{lotId, quantity}], outputs[{lotId, quantity}],
explicit `configuredLoss`), `shipments` (eventId, lotId, quantity, customerId). Quantities are JSON integer
numbers of grams; optional `unit` fields must be `"g"`.

CSV: one table whose header is any subset of the columns in `CSV_COLUMNS` (`src/schema.js`) including
`recordType`. Record types: `batch` (exactly one), `lot`, `customer`, `event`, `receipt`, `transformation`,
`transformation_input`, `transformation_output`, `shipment`. Cells not belonging to a record type must be empty.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.js` | Public API |
| `src/input.js` | Byte/size limits, binary rejection, strict UTF-8, strict JSON parser (raw number lexemes) |
| `src/csv.js` | Bounded RFC 4180 parser; formula-escaping serializer |
| `src/schema.js` | Field normalization for JSON and CSV into one candidate shape |
| `src/validate.js` | Relationships, lineage, cycles, ordering, ledger; mints immutable snapshots |
| `src/trace.js` | Forward/backward traces, event evidence, search/filter/sort |
| `src/report.js` | Report build, JSON/CSV export, CSV round-trip parser |
| `src/workspace.js` | Per-session workspace, atomic import, annotations, registry |
| `docs/ARCHITECTURE.md` | Design, security notes and limitations |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design decisions, security notes and the list of open
release gates. The spec's release gates are not satisfied by this engine slice.
