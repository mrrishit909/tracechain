# TraceChain static interface: design plan (SYNTHETIC DATA ONLY)

> **Update:** the landing page has been redesigned as a printed route tag. Its tokens, layout, three
> compositions, motion and rubric evidence are in
> [`design/TRACECHAIN-DESIGN-DECISION.md`](design/TRACECHAIN-DESIGN-DECISION.md). That document supersedes the
> landing bullets below. This file still governs the workspace (`workspace.html`, `styles.css`).

Skills consulted under the hard time stop. The website-playbook `SKILL.md` was **not read**: the one attempt was
blocked by a permission prompt. Of `references/quality-rubric.md`, only the first 40 lines were read: the grading
rules and criteria 1–2. Of `references/motion-and-assets.md`, only the first 25 lines were read; no generated media is
used. The frontend-design `SKILL.md` was **not read**. This plan was written during implementation, not before coding. References (ComponentGallery tree/list alternatives,
SaaSFrame import/table/state IA, Mobbin end-to-end task journey) were researched at program level and used only as
inspiration. No assets or logos were copied.

## Concept
"A cobalt logistics control desk": a physical lot tag leads into a numbered route of review steps. TraceChain is
about product physically moving between facilities, so the interface reads like a dispatch desk, not a document
desk. This keeps it deliberately distinct from PayGuard's ivory/rust document desk.

## Three alternatives considered
1. **Cobalt logistics control desk (chosen).** Pearl-gray ground, navy ink, cobalt route accent, lot-tag motif,
   and route lists with a cobalt rail. Feedback is a restrained flow highlight on the active panel.
2. **Warehouse receiving journal.** Sage and paper tones, serif ledger headings, and a stamped-entry feel. Rejected
   because a serif ledger leans toward a document desk and moves closer to PayGuard.
3. **Ocean operations topology.** A dark navy canvas with a glowing network map. Rejected because it is dark and
   decorative, gives weaker contrast for dense tables, and pushes toward a canvas-heavy diagram that needs a richer
   accessible fallback.

## Colour roles
| Token | Hex | Role |
| --- | --- | --- |
| `--pearl` | #eef1f5 | page ground, table header fill |
| `--paper` | #ffffff | panels, lot tag |
| `--navy` | #14213d | ink, synthetic banner, structural rules |
| `--ink-soft` | #3d4a63 | secondary text, labels for snapshot provenance |
| `--cobalt` | #1f4fd1 | the one accent: primary action, route rail, computed figures, focus ring |
| `--cobalt-tint` | #dfe7fb | hover fill |
| `--alert` | #a3261b | rejection and errors |
| `--ok` | #1d6b45 | accepted import |

## Type
Candidates: Avenir Next (humanist geometric, ships with macOS), Segoe UI (Windows humanist), Helvetica Neue (fallback),
and system-ui. No web-font downloads. Chosen stack: `"Avenir Next", "Segoe UI", "Helvetica Neue", system-ui`, with
`ui-monospace` for lot IDs, paths and hashes.
Scale: h1 `clamp(1.9rem, 5vw, 3.2rem)` at -0.02em tracking. The proof figure is `clamp(2.6rem, 9vw, 4.5rem)`, h2 is
1.25rem, body is 1rem/1.55, and table and route text is 0.9rem.

## Composition
- **Landing (superseded):** previously a synthetic banner, lot tag, headline, primary action, live engine proof and
  scope list. It is now the route-tag composition in `design/TRACECHAIN-DESIGN-DECISION.md`, which uses its own
  `web/landing.css`.
- **Workspace:** a single column of six numbered route panels (load, forward, backward, evidence, search, annotate and
  export) with a cobalt left rail.
- **Mobile at 390px:** the same single column. Form grids collapse to one column below 40rem. Tables sit in
  `overflow-x:auto` wrappers. Hashes and paths use `overflow-wrap:anywhere`, and the body uses `overflow-x:hidden`
  as a backstop.
- **Diagram:** this build ships the accessible route list (`<ol class="routes">`, path text plus grams) as the
  diagram. A graphical SVG route schematic was cut for time *in the workspace*. The landing page now has an
  inline SVG route schematic of lot A plus a text ledger (see the decision doc).
- **Motion:** only colour transitions (160ms), applied only under `prefers-reduced-motion: no-preference`.

## Rubric status (website-playbook)
None of the visual criteria has been inspected in a rendered browser. No browser or Playwright run happened in this
session. **All eight rubric criteria are Unverified.** A Playwright or manual browser pass would settle them: desktop
and 390x844 screenshots plus keyboard and screen-reader checks. In the workspace, the graphical SVG route
schematic is still **not implemented**; only the accessible route list exists. Landing-page rubric status is
tracked in the decision doc and is likewise unverified until screenshots are inspected.
