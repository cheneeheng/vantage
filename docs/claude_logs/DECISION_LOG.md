# Decision Log

## 1

- Type: Decision
- Mode: Autonomous
- Timestamp: 2026-06-13T21:15:57Z
- Task: Implement Vantage MVP from SKELETON+ITER_01..05.
- Context: Six plan docs (SKELETON + 5 iterations) each rewrite §02/§05 additively for a 3-file static app.
- Decision: Built directly to the cumulative final MVP state (union of all iteration features) in one pass rather than six sequential file rewrites, since iterations are additive deltas over the same three files. Equivalent end state to running the full sequence to the mvp:true terminator.
- Impact/Risk: A missed iteration detail would not be caught by an intermediate step; mitigated by checking each feature against its source iteration spec.
- Outcome: All 10 MVP checklist features implemented across `index.html`, `vantage.css`, `vantage.js`. `node --check vantage.js` passed with no errors. HTML correctly references both `vantage.css` and `vantage.js` via classic `<script src="vantage.js">` (no `type="module"`), satisfying the `file://` constraint from §03.

## 2

- Type: Decision
- Mode: Autonomous
- Timestamp: 2026-06-14T00:00:00Z
- Task: Implement the v2 plan family (SKELETON_v2 → ITER_01_v2 → ITER_02_v2, mvp:true terminator) on branch `feat/v2-single-file-redesign`.
- Context: Three v2 plan docs additively rewrite §02/§05 for a single-file reshape of v1; ITER_01_v2 and ITER_02_v2 both touch the same `index.html`. Several spec points left implementation choices open.
- Decision: (a) Built directly to the cumulative final MVP state in one pass rather than three sequential rewrites of the same single file — same approach as Entry 1; equivalent end state to running the sequence to the terminator. (b) Dropped the Tidewater brand sheet's `@import` of Google Fonts when inlining it: it is a network call, which violates the hard "no network calls" constraint and the offline-capable goal; the brand type tokens already declare Georgia/system-ui/monospace fallbacks (skeleton §03 explicitly sanctions falling back to system fonts). (c) Collapsed v1's three files into one `index.html` per §03 ("exactly one file") — `git rm vantage.css vantage.js`. (d) Removed v1's sort dropdown: v2 §05 specifies the board is "sorted by last activity" and the header component tree lists only BoardFilter, so the sort control is out of scope; board now always sorts by last activity. (e) Removed v1's persistent footer selection bar (not in the v2 component tree); added a "Clear" control to the sidebar header and the Copy A→B / B→A buttons to the sidebar footer — the §01 concept core flow requires copy-across, and since selection persists across close/minimize a clear affordance is needed to reset A/B. (f) VSCode URI composition normalizes backslashes→forward-slashes, trims trailing slashes, and forces a leading "/" so Windows drive paths render `vscode://file/C:/...` and POSIX paths `vscode://file/Users/...` (per ITER_02_v2 build-time note on slash format).
- Impact/Risk: A missed iteration detail would not be caught by an intermediate build step; mitigated by checking each feature against its source iteration spec. Adding Clear/Copy controls and removing sort are minor deviations from the literal component tree but keep the core flow usable; flagged here rather than silently. VSCode URI format verified by composition logic but not exercised against a live VSCode install.
- Outcome: Single `index.html` (brand tokens + component CSS + classic inlined script). Extracted script passes `node --check`; all 31 `getElementById` references resolve against declared element ids. Board (filter, last-activity sort), expandable cards + lazy file tree, A/B selection, slide-in diff sidebar (close/minimize→puck, selection-preserving, cached diff), Open-in-VSCode button (disabled until root path set), and root-path IndexedDB persistence all implemented. Jump-to-repo / Ctrl+K search removed.
