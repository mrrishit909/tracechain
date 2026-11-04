# TraceChain engine architecture, security notes and limitations

Status: engine slice for spec "TraceChain synthetic vertical slice v1" (rev 1.1). It has not been independently
audited, and it is not a verified demo or compliance determination.

## Pipeline

```
bytes/string ──decodeInput──▶ text ──normalizeJson / normalizeCsv──▶ candidate (+ collected field errors)
      ──validateCandidate──▶ { ok:true, snapshot (deep-frozen, hashed) } | { ok:false, errors } ──Workspace──▶ state
```

1. **Input boundary** (`input.js`, `csv.js`). Size and binary checks run before decoding. Decoding is strict
   UTF-8 (fatal), and NUL/control characters are rejected. The JSON parser keeps every number as its raw
   lexeme (`JsonNumber`), so `1e5`, `100.0`, `-0` and `9007199254740993` are rejected instead of being coerced.
   It also rejects duplicate keys and `__proto__`/`constructor`/`prototype` keys, bounds nesting depth, and
   builds null-prototype objects. The CSV parser follows RFC 4180, with bounded cells, columns and rows.
2. **Normalization** (`schema.js`). JSON and CSV both map onto one canonical candidate shape. Field errors are
   collected, up to 500, with the source row (`json:/shipments/4`, `csv:line 12`). Quantities must be canonical
   base-10 integer grams. Zero, negative, fractional, exponent, unit-suffixed and unsafe values each get a
   distinct code. Units must be `g`, with no conversion. Timestamps must be `YYYY-MM-DDTHH:MM:SS[.sss]Z` and a
   real calendar date (round-trip checked, 1970–9999). CSV record types are looked up as own properties only.
3. **Validation** (`validate.js`). The whole batch is accepted or rejected as a unit:
   - IDs are unique within each type. Each event has exactly one detail record of the matching type.
   - Every lot, customer and event reference must exist.
   - A transformation needs at least one input and one output, with no duplicate lines.
   - Mass balance uses checked arithmetic: `sum(inputs) = sum(outputs) + configuredLoss`, with the
     difference reported in grams.
   - Every lot has exactly one creation event: a receipt (root) or a transformation output.
   - Cycle detection uses Kahn's algorithm on a bipartite lot→transformation→lot graph, so edges are
     O(inputs + outputs) rather than inputs × outputs. A reverse-Kahn prune then names only the lots on a
     cycle. Self-loops are also reported directly.
   - Events are ordered by timestamp. Events with equal timestamps must carry distinct explicit `sequence`
     values; otherwise the batch is rejected as `AMBIGUOUS_ORDER`.
   - A nonnegative inventory ledger is replayed in event order. It reports use before creation, and
     shortfalls with the exact gram difference.
   - The ledger runs only after structural checks pass, so a structurally broken batch reports structural
     errors only.
4. **Snapshot** (`tracechain.snapshot.v2`). Records are sorted canonically and stamped with schema/rule versions
   and `inputDeclaredSynthetic` (what the input claimed; not evidence of origin). Inventory totals include a conservation check. The snapshot carries a SHA-256
   `contentHash` over canonical JSON with `sourceRow` stripped, so the JSON and CSV encodings of the same data
   hash identically. Source rows are still retained in the snapshot for findings. The snapshot is deep-frozen
   and registered in a module `WeakSet`. Trace, evidence and query functions accept only registered
   snapshots, so forged or hand-built graphs, even frozen ones, fail with `NO_SNAPSHOT`.
5. **Traces** (`trace.js`).
   - Forward: BFS through every output of every transformation that consumes an affected lot. Contamination
     propagates conservatively to whole lots, with no fractions or probabilities. Every shipment of an
     affected lot is reported, with per-customer received grams.
   - Backward: all ancestor input lots, root lots and their receipts.
   - Contributing paths are enumerated iteratively. Path elements are charged against a budget *before*
     allocation (`maxPathElements` 500k, `maxPaths` 10k). When the budget runs out, the path listing is
     truncated and flagged `pathsComplete:false` / `PATHS_TRUNCATED`, while the lot, shipment and customer
     sets stay complete.
   - An unknown or non-string lot raises `UNKNOWN_LOT`; it never returns an empty "safe" result.
6. **Workspace** (`workspace.js`).
   - Each workspace keeps private state (`#current`, `#annotations`); there is no shared module state
     except the snapshot `WeakSet`.
   - A rejection returns a frozen diagnostic with:
     - the exact completeness text "Trace completeness cannot be evaluated for this rejected batch";
     - `acceptedGraph:null`;
     - the submitted row IDs, for diagnosis only;
     - the retained prior snapshot, labeled with its batch ID and hash and stated not to be this import's
       result.
   - Annotations sit beside the snapshot and never inside it. They cite its batch ID and hash, and use an
     injectable clock.
   - `WorkspaceRegistry` maps validated session IDs to separate workspaces through a `Map`.
7. **Reports** (`report.js`). A report contains:
   - scope (input lot, unit, lots, transformations, shipments) and units;
   - customers, the affected shipped quantity, and all contributing paths with `pathsComplete`;
   - warnings (conservative propagation, evidence scope, affected inventory on hand, path truncation);
   - schema, rule and report versions (`tracechain.report.v2`), the data-origin fields (`dataOrigin`,
     `dataOriginVerified`, `dataOriginLabel`, `contentInspectionNotice`, origin-specific `disclaimer`), and the
     snapshot batch ID and hash. See **Data origin** below;
   - annotations and an optional caller-supplied `generatedAt`.

   The CSV export round-trips through `parseReportCsv` to exactly the same object as the JSON export; this is
   tested.

   **Report integrity.** `buildReport(snapshot, trace, annotations, options)` does not trust caller-supplied trace
   content. A matching `snapshotHash` only shows that the trace *names* the snapshot, not that its scope, customers,
   quantities, paths or warnings are correct. Therefore `buildReport`:
   - requires an accepted snapshot (`isAcceptedSnapshot`, else `NO_SNAPSHOT`), a forward trace object (`BAD_REPORT`)
     and a matching hash (`SNAPSHOT_MISMATCH`);
   - recomputes the authoritative forward trace from that snapshot and the trace's `affectedInputLot`, and compares
     a key-order-independent JSON serialization of the supplied trace with it, rejecting differences (and
     unserializable values such as BigInt or cycles) with `TRACE_MISMATCH`. This is a rejection check only: values
     the JSON serializer ignores or rewrites (undefined, functions, symbols, `NaN`, a `toJSON` method) are not compared;
   - always builds the report from the recomputed trace, never from supplied content, so such values cannot reach it;
   - validates `options` (plain object; `generatedAt` null or a valid ISO UTC timestamp, else `BAD_ARGUMENT`) and
     `annotations` (an array of at most `maxAnnotations`; each must have exactly the workspace annotation fields as
     bounded strings, cite this snapshot's batch ID and hash, and target an existing lot/event/customer, else
     `BAD_ANNOTATION`).

   `contentHash` is an unkeyed SHA-256 **content hash** used to identify and compare snapshots. It is **not a
   signature or MAC**. Anyone can recompute it, so a report, the CSV/JSON export, or a `parseReportCsv` result
   carries **no authenticity, integrity or origin guarantee** once it leaves the process. The recomputation
   guarantee covers only reports built in-process by `buildReport`. Edited exported files are not detected.

## Data origin (`origin.js`)

Origin comes from the control path that loaded the data, never from the content. The engine does not inspect
content and cannot detect or prevent real or sensitive data. A `synthetic: true` flag (still required by the batch
schema), a batch ID, a file name or a byte-identical copy of the fixture is not evidence.

- `bundled-synthetic-fixture`: only the app's own loader (`ReviewSession.loadBundledSample`) fetches a fixed
  bundled path and claims this origin. The workspace and `buildReport` honor the claim only when the accepted
  snapshot equals the pinned `BUNDLED_FIXTURE` (batch ID and content hash). Otherwise they downgrade it.
- `unverified-user-supplied`: the default for everything else, including local file imports
  (`importUserFile`), `importInput`, and direct `Workspace.importBatch`/`buildReport` callers.

Report readers: `parseReportCsv` and `parseReportJson` accept v2 only when its origin fields are consistent, and a
bundled claim must cite the pinned snapshot. They upconvert legacy `tracechain.report.v1` to v2 with
`unverified-user-supplied` origin, `upconvertedFrom` and `legacyClaims`, because v1 labeled every report synthetic.
They reject other versions. A report read from a file still carries no origin guarantee (see above).

## Security notes

- **Bounds** (`limits.js`):

  | Limit | Value |
  | --- | --- |
  | Input size | 1 MiB |
  | Records | 5000 (JSON counts transformation lines too; CSV counts data rows) |
  | ID length | 64 |
  | Text length | 256 |
  | Note length | 2000 |
  | JSON depth | 8 |
  | CSV columns | 32 |
  | Collected errors | 500 |
  | Sessions per registry | 1000 |
  | Annotations per workspace | 1000 |
  | Traversal steps | 200k |
  | Path elements | 500k |
  | Paths | 10k |

- **No fetching or execution.** Input must be a string or `Uint8Array` and is always treated as content.
  URLs, paths and objects are never fetched, opened or evaluated. ZIP/Office, PDF, gzip, OLE, RAR, 7z, MZ and
  ELF magic bytes are rejected. There is no `eval`, no dynamic import and no archive or document handling.
- **Prototype safety.** Dangerous JSON keys are rejected. Parsed objects have null prototypes, indexes are
  `Map`s, and the CSV record-type and report-scope lookups use `Object.hasOwn`. IDs `constructor` and
  `prototype` are reserved.
- **CSV formula injection.** Text cells beginning with `=`, `+`, `-`, `@`, TAB, CR or `'` get an apostrophe
  prefix, and numbers are written as plain integers. `parseReportCsv` strips exactly one prefix.
- **Inert text.** Text such as `<script>` in names or notes is stored and exported verbatim as data. This
  engine renders no HTML. **Any future UI must still contextually escape output.**
- **Isolation and immutability.** Snapshots and `Workspace.importBatch` results, including rejections, are
  deep-frozen. The pure `importCandidate` result is not frozen. Queries return structured clones.
- **Malformed caller values.** Null or non-object options passed to `importCandidate`/`importBatch` come back
  as a coded rejection (`BAD_ARGUMENT`, `FORMAT`, `INPUT_TYPE`). The other APIs throw a `TraceChainError` with
  a code instead of a raw `TypeError`, covering bad options, formats, clocks, `generatedAt` and IDs.
- **No real data.** The fixtures use fictional IDs and names; a test checks for emails and secret-like tokens.

## Limitations and open gates (not satisfied by this slice)

- **Frontend gates not done.** No UI was built in this task. The spec's journey gates are all open: keyboard
  and mobile workflow, explicit empty/error states, reduced motion, Playwright, accessibility checks, live
  browser smoke test, deployment/cost gate, and a separate audit (CRITICAL/HIGH findings block release).
- **Deferred regulatory work.** FDA rule mapping, coverage/exemptions, effective dates, FDA export-format
  conformity, supplier integrations, real recalls and customer notifications are out of scope. Nothing here is
  compliance certification.
- **In-memory only.** There is no persistence or session eviction/TTL; the registry stops at 1000 sessions.
  After a new import, annotations made on an earlier snapshot are kept in memory but no longer listed or
  exported.
- **Incomplete diagnostics in some cases.** Syntax and shape failures (CSV/JSON syntax, CSV header, size,
  encoding) abort with a single error and are not collected. Ledger findings appear only after structural
  validation passes. The error list is capped at 500 and flagged `truncated`.
- **Truncated path listings.** Very large path counts (e.g. chained diamonds) give a truncated path listing,
  flagged `PATHS_TRUNCATED`. The lot, shipment and customer sets are still complete.
- **Timestamp constraints.** Timestamps are UTC `Z` only, with at most millisecond precision, no offsets and
  no leap seconds. `sequence` only breaks ties between identical timestamps.
- **Lone surrogates.** JSON `\u` escapes can produce lone UTF-16 surrogates in text fields, and these are not
  rejected.
- **Snapshot recognition.** Snapshots are recognized only by the module instance that minted them, because the
  registry is a `WeakSet`. A duplicated copy of the package will not accept another copy's snapshots.
- **Round-trip parser scope.** `parseReportCsv` exists to verify report round-trips. It is not a general
  import path.
