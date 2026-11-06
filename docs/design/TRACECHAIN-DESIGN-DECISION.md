# TraceChain landing page: design decision (SYNTHETIC DATA ONLY)

Scope: the public landing page only (`web/index.html`, new `web/landing.css`, and the inline SVG inside
`index.html`). The workspace (`web/workspace.html`, `web/styles.css`, `web/app.js`), `web/landing.js`, the engine,
fixtures and tests are unchanged. `scripts/build.mjs` gains one whitelist entry: `web/landing.css`.

## Provenance of the rules applied

Codex read the website-playbook `SKILL.md`, `references/quality-rubric.md` and `references/motion-and-assets.md`.
This pass did not open those files. It applies the rules the user restated from them: eight criteria (point of
view, typography, colour, hierarchy, imagery, motion, mobile, invisible quality). A criterion is Strong only after
someone has inspected real screenshots, interaction and measurements. Without that it is Mixed or Unverified.
Discovery was not repeated. The direction is the one already chosen in [`../DESIGN.md`](../DESIGN.md): the cobalt
logistics control desk. The two rejected alternatives (warehouse receiving journal, ocean operations topology) and
the reasons they lost are recorded there.

## Concept

**A printed warehouse route tag, hung on a pearl dispatch desk.** TraceChain is about physical lots moving
between facilities. The landing page's central object is one paper hang tag with a punched grommet, a printed
route, small-print ledger lines and a perforated tear-off stub. The tag traces the fixture's real input lot A
through T1 (cut), T2 (blend with lot B) and shipments S1, S2 and S5 to customers C1 and C2. The live engine result
from `landing.js` (the affected shipped total, 60,000 g on this fixture, plus per-customer grams and the unreached
customers note) prints on the stub. The tag's header strip is filled by `landing.js` (`#lot-tag`).

What it is not: no hero metric cards, no dashboard grid, no stock or generated imagery, no dark fintech canvas.

## Data honesty

| Shown | Source |
| --- | --- |
| Affected shipped total, customers reached with grams, unreached customers, snapshot label | Computed live by the unchanged `web/landing.js` (`ReviewSession.forward('A')`). Nothing is hard-coded. If the engine fails, `landing.js` shows its own error and no figure. |
| `#lot-tag` text (`LOT · A · 100,000 g`) | Set by `landing.js` from the accepted snapshot's receipt. The static placeholder is `LOT · pending`. |
| Lot sizes and per-leg quantities in the SVG and the route ledger | Transcribed statically from `fixtures/TC-SYN-001.json`: receipt R-A, transformations T1 and T2, shipments S1, S2 and S5. **Drift risk:** if the fixture changes, the SVG and ledger must be edited by hand. No test guards this. |
| Aggregates (the 60,000 g total, C1 30,000 g, C2 30,000 g) | Appear **only** in the live stub. They are not in the static markup, the SVG `<desc>` or the ledger. |

Wording rules followed:
- Lot B is labelled "outside this trace", never "unaffected" or "clean".
- All of lot M is treated as affected (conservative mixing). The page states no probability or affected share.
- The page makes no recall, safety, FDA or FSMA claim. Every record is labelled synthetic and fictional: the
  banner, the eyebrow, the stub stamp and the limitations list.

The "60,000" collision: A1, M and the affected total are all 60,000 g. The SVG labels lot sizes as
`60,000 g cut` and `60,000 g blend`. The stub's own caption from `landing.js`
("g affected shipped from input lot A") sits directly under the number, inside the same ruled block.

## Tokens

### Colour roles (5 named roles plus 3 supporting neutrals)

| Role | Token | Hex | Used for |
| --- | --- | --- | --- |
| Ground | `--pearl` | #eef1f5 | page background with a faint 32px floor grid, grommet hole |
| Tag | `--paper` | #ffffff | the tag surface, pills, customer chips |
| Ink | `--navy` | #14213d | text, tag border, root lot chip, synthetic banner |
| Route | `--cobalt` | #1f4fd1 | affected route lines, primary CTA, computed figure, focus ring, ledger IDs |
| Stamp | `--stamp` | #a3261b | "Synthetic · not a recall" stamp, "does not state" markers, engine error |
| supporting | `--ink-soft` | #3d4a63 | secondary text |
| supporting | `--cobalt-tint` | #dfe7fb | affected lot chip fill, lot-tag strip |
| supporting | `--rule` / `--line-out` | #c9d1de / #7a869b | rules and perforation / dashed "outside this trace" line (graphic only) |

### WCAG AA contrast (computed from sRGB relative luminance, not measured in a browser)

| Pair | Ratio | Requirement |
| --- | --- | --- |
| navy on pearl | 14.1:1 | text 4.5 ✔ |
| navy on paper | 16.0:1 | text 4.5 ✔ |
| ink-soft on pearl / paper | 7.9:1 / 8.9:1 | text 4.5 ✔ |
| cobalt on paper / pearl | 6.8:1 / 6.0:1 | text 4.5 ✔ |
| white on cobalt (CTA) | 6.8:1 | text 4.5 ✔ |
| cobalt on cobalt-tint (`all of M affected`) | 5.5:1 | text 4.5 ✔ |
| navy on cobalt-tint | 12.9:1 | text 4.5 ✔ |
| cobalt-tint on navy (root chip subtext) | 12.9:1 | text 4.5 ✔ |
| stamp red on paper | 7.4:1 | text 4.5 ✔ |
| line-out on paper | 3.7:1 | non-text 3.0 ✔ |
| rule on paper | about 1.5:1 | decorative only; never the sole carrier of meaning |

### Type

The stacks are unchanged from DESIGN.md: `"Avenir Next", "Segoe UI", "Helvetica Neue", system-ui` for text and
`ui-monospace, "SF Mono", Menlo, Consolas` for IDs. No web fonts.

| Step | Size | Use |
| --- | --- | --- |
| Display | `clamp(2.25rem, 4.6vw, 4.25rem)`, weight 600, -0.028em, max 15ch | h1 |
| Figure | `clamp(3rem, 5.4vw, 4.6rem)`, weight 700, tabular-nums, cobalt | live affected total |
| Section | `clamp(1.4rem, 2.2vw, 1.75rem)`, weight 600 | h2 (stub h2 1.15rem) |
| Lede | 1.15rem / 1.5 | hero lede |
| Body | 1rem / 1.55 | lists |
| Label | 0.72–0.8rem mono, uppercase, 0.12–0.16em tracking | eyebrows, kickers, h3, ledger times |
| SVG | 14 / 12.5 / 12 / 11 user units, mono | lot IDs / leg pills / sizes / notes |

## Layout and hierarchy

Reading order:
1. synthetic banner
2. masthead (wordmark, desk name, Workspace link)
3. hero: eyebrow, h1, lede, primary CTA **Open the forward-trace workflow** → `workspace.html#trace`, and a
   secondary "Read lot A's route tag" link → `#route`
4. the tag: head with `#lot-tag`, the route figure, the route ledger, then the stub with `#proof`
5. "Reverse of the tag": h2 `What a report does and does not say`, as two columns (It states / It does not state),
   followed by a repeat of the primary CTA
6. footer

Headings: h1 `#hero-title`, then h2 `#route-title`, h2 `#proof-title` (kept), h2 `#scope-title` (kept), with h3
for the ledger and the scope columns. The ids `proof`, `lot-tag`, `proof-title`, `scope-title` and `hero-title` are
preserved for `landing.js`. All links are project-relative, with no leading `/`, so they work under a GitHub Pages
subpath.

## Three compositions

| Viewport | Composition |
| --- | --- |
| Desktop at 60rem and wider (target 1440×900) | Hero split into h1 (1.25fr) and lede plus CTA (1fr). The tag is landscape: grommet in a 4.25rem left margin, horizontal route SVG (viewBox 960×330) above the ledger, and an 18.5rem stub on the right spanning the full height. The perforation is a dashed rule with half-clipped notches biting into the top and bottom edge. Intent: the whole route and the live figure sit above the fold. |
| Tablet from 40rem to 59.99rem (target 768×1024) | Single-column hero. The tag body pairs a **vertical** route SVG (viewBox 380×590, max 22rem) with the ledger beside it. The stub tears off along the bottom: a dashed rule bleeds to the tag's left edge, with the heading on the left and the live result on the right. |
| Phone below 40rem (target 390×844) | The tag hangs vertically: grommet at top centre, top corners rounded. The vertical SVG is full width (up to 24rem), and the stub sits below a dashed tear line. The ledger uses two columns (event ID, then time over action). CTAs stack full width. The masthead wraps the desk name to its own line. |

Only one SVG is displayed at a time. The other is `display:none`, which also removes it from the accessibility
tree, so screen readers hear one `role="img"` title and description. The route ledger is the full text equivalent
at every size.

## Motion

- **Load sequence:** route lines draw in event order (R-A, T1, T2, then the shipments) using
  `stroke-dasharray/offset` in user units (1200). Each line takes 900ms, staggered 180ms, finishing by about
  1.95s. Chips, process marks and pills fade in alongside their legs.
- **Data arrival:** when `landing.js` swaps the loading line for results, each new child of `#proof` rises 6px
  and fades in over 480ms, with the customers and note staggered.
- **Microinteraction:** the CTA arrow nudges 4px on hover or focus, and the background shifts over 160ms.
- **Default and reduced motion:** with no animation, everything is fully drawn and visible. Every animation and
  transition, plus smooth scrolling, sits inside `@media (prefers-reduced-motion: no-preference)`.

There is no scroll-jacking, looping or parallax. Only opacity, transform and stroke-dashoffset are animated.

## Rubric evidence (honest status)

`npm run build` passed. Chrome screenshots were inspected at 1440×1000, 768×1024 and 390×844 after the bundled
engine finished. The engine rendered 60,000 g affected shipped, C1 and C2 at 30,000 g each, and C3/C4 outside the
trace. Desktop, tablet and phone route-tag compositions were inspected, including the full phone SVG and text
ledger. Document/body widths measured 1425/1425 at desktop (scrollbar), 753/753 at tablet, and 390/390 at phone.
All three CTAs resolve to `workspace.html#trace`; no browser exceptions were observed. No tests were run.

| # | Criterion | What was applied | Evidence available now | Status |
| --- | --- | --- | --- | --- |
| 1 | Point of view | One coherent printed route tag derived from physical lot and tag lineage | Desktop, tablet, and mobile renders preserve the printed-route concept | Strong |
| 2 | Typography | Chosen display/body stacks, mono IDs and deliberate scale | Rendered at all three widths; fine table and smallest SVG labels still need close legibility review | Mixed |
| 3 | Colour | Five named roles with computed AA ratios | Rendered consistently on pearl and paper; contrast was not instrumentally measured | Mixed |
| 4 | Hierarchy and CTA | Headline, illustrated tag, live total, then limits and forward-trace action | Hero and tag reviewed at all three widths, mobile scope checked; CTA path resolves | Strong |
| 5 | Imagery | Original inline SVG of the exact fixture route | Desktop, tablet and dedicated mobile composition inspected; text ledger preserves the route | Strong |
| 6 | Motion | Ordered route draw-in and live proof arrival; reduced motion disables it | Still frames only; animation and reduced-motion state not recorded | Unverified |
| 7 | Mobile (390px) | Vertical route-tag composition and stacked route; no sideways scroll | 390px screenshots of hero, complete route and scope; 390px width measured | Strong |
| 8 | Invisible quality | Semantic SVG and equivalent ledger, live computed proof, local links and a scoped production build | Build, local CTA targets and no browser exceptions checked; keyboard, axe, performance and hosted Pages remain unchecked | Mixed |

### Remaining checks
- Inspect the 768px layout and the smallest SVG labels; the design contains a text-equivalent route ledger.
- Record the load sequence and check `prefers-reduced-motion: reduce` in the browser.
- Check keyboard order/focus, run axe and Lighthouse, and check the engine-failure state.
- Verify the live GitHub Pages URL once this product is deployed.

## Known limitations of this design
- The SVG and ledger copy the fixture by hand (see Data honesty). A fixture change needs a manual edit.
- Desktop SVG text renders at about 10–11px CSS at 60rem, at the smallest end of legible. The ledger carries the
  same facts at full size.
- `serve.mjs` has no `.svg` MIME type. That is why the illustration is inline rather than a separate file.
