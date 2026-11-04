# Independent engine verification

2026-11-04 UTC. Codex inspected source and independently authored 20 behavioral tests in independent.test.mjs, using a literal fixture authored from the specification rather than production fixture helpers.

TC-A01 report integrity: reproduced false report bound to genuine snapshot hash after altering trace quantity/customers/scope/paths. Claude remediated via accepted snapshot check and authoritative recomputation/comparison. Independently retested: resolved.
TC-A02 CSV boundary: inherited recordType names caused raw TypeError. Claude remediated own-property lookup; independently retested all malicious names: resolved.

Latest independent suite:20/20 pass, 0 fail. Product suite independently rerun 18/18 pass, 0 fail. Covers golden 60000 g affected shipments/C1/C2 only / 95000 g inventory; exact 1 g mass/inventory findings; JSON/CSV semantic equivalence; ordering, dates, cycles, overflow; atomic rejected import preserving prior snapshot; inert annotations and CSV escaping; tampered report trace rejected; roundtrip.

This accepts the scoped synthetic engine candidate only. No frontend/browser/mobile/accessibility/deployment verification. No FDA compliance, actual recall, safety, authentication or multi-tenant service claim. Export hashes are not signatures; independent review does not certify arbitrary future data.

Reproduce: node --test audit/independent.test.mjs
