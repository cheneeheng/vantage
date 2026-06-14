# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Vantage is a local, serverless repo explorer. Point it at a folder full of Git repos
and it renders each immediate subfolder as a card, lets you expand a card into its file
tree, pick one file from two different repos, diff them in a slide-in sidebar, and
copy/overwrite one onto the other. Each expanded card can also open its repo in VSCode.
Core flow: **open → find two repos → compare a file → copy across.**

## Running, building, testing

- **No build step, no package manager, no dependencies, no tests.** The entire app is
  **a single static file: `index.html`** (CSS and the classic script are inlined). The
  v1 three-file split (`vantage.css` + `vantage.js`) was collapsed in v2.
- **Run it** by opening `index.html` directly (`file://`) in **Chrome / Edge / Opera**.
  It will not work in Firefox or Safari — it depends on the File System Access API.
- On first use, click **"Change folder"** and pick the projects root. The directory handle
  is persisted in IndexedDB, so reopening the page reconnects without re-prompting (the
  browser still requires a permission re-grant click via "Reconnect folder").
- **Optional:** click **"Set root path"** and paste the absolute path of the projects root
  to enable the per-card "Open in VSCode" buttons. The File System Access API never exposes
  the real filesystem path of a picked folder, so this must be entered separately; the app
  works fully without it.

## Hard architectural constraints (do not violate)

These are deliberate decisions, not accidents — see `docs/planning/SKELETON_v2.md` and the
`DECISION_LOG.md` before proposing changes that touch them:

- **Single file, classic `<script>`, never `type="module"`.** Everything (brand CSS +
  app CSS + the entire script) is inlined into `index.html`. ES-module `import` is
  CORS-blocked over `file://`, so the page works with no server. Do not split the script
  back into separate files or ES modules, and do not add a bundler.
- **No network calls of any kind.** No CDN, no fetch to remote hosts, no analytics. The
  inlined brand sheet's Google-Fonts `@import` was intentionally dropped for this reason;
  the type tokens fall back to Georgia / system-ui / monospace. Do not reintroduce remote
  fonts or assets.
- **No new dependencies.** The line-based diff is hand-written (LCS); keep it that way.
- **Writes are confined to the chosen root folder.** Copy/overwrite is the only
  destructive action and must always name the exact target and wait for an explicit
  confirm (the `#confirm-overlay` modal). There is no delete capability.
- **Last-activity is a proxy, not precision.** Activity time comes from file mtimes
  (`.git/logs/HEAD` → `.git/HEAD` → shallow working-tree walk). Never parse git commit
  objects or pack files.

## Code structure

`index.html` is one file: inlined `<style>` (brand tokens + app component CSS), static
markup with fixed mount-point IDs, then one inlined classic `<script>`. The script is a
set of plain object namespaces (no classes), each a cohesive module (line numbers are
approximate — they drift as the file changes):

- **`Persist`** (~line 682) — IndexedDB: `saveHandle`/`loadHandle` (directory handle,
  survives sessions), `saveCache`/`loadCache` (scan results), and `saveRootPath`/
  `loadRootPath` (the optional absolute path used only to build VSCode links).
- **`Scanner`** (~line 745) — `scanRoot(dirHandle)` enumerates child dirs as repos;
  `detectStack` reads marker files (`package.json`→Node, `Cargo.toml`→Rust, etc.);
  `lastActivity` runs the mtime fallback chain; `readTree`/`readChildren` lazily build a
  repo's file tree on expand. Respects `IGNORE_LIST` (`.git`, `node_modules`, `venv`, …).
- **`Compare`** (~line 870) — `diff(textA, textB)` (line-based LCS → `DiffLine[]`) and
  `looksBinary` (skip diffing binary files).
- **`Copy`** (~line 915) — `copyFile(srcFileHandle, dstDirHandle, name)`, behind the
  overwrite confirm.
- **`Editor`** (~line 943) — `vscodeUri(rootPath, repoName)` composes
  `vscode://file/<rootPath>/<repoName>` (normalizing slashes / Windows drive letters);
  returns `null` when no root path is set, which keeps the "Open in VSCode" button disabled.
- **`App`** (~line 965) — the controller and all UI: in-memory state (`repos`,
  `selection`, `filterText`, `sidebarMode`, `lastDiff`, …), DOM refs cached in `App.el`,
  event binding, and all rendering (`renderBoard`, `buildRepoCard`, `renderTreeNode`,
  `buildVscodeButton`, the slide-in diff sidebar + floating puck, root-path/confirm modals,
  toasts). Bootstrapped from `App.init()` on `DOMContentLoaded`. The board sorts by last
  activity (no sort control); there is **no** jump-to-repo search — both removed in v2.

Data flows one way: Scanner/Persist produce plain in-memory objects (`Repo`, `TreeNode`,
`Selection` — shapes documented in SKELETON_v2.md §02), `App` holds them as state and
re-renders the relevant region. The markup has fixed mount-point IDs that `App.cacheDom()`
looks up; regions and the sidebar are toggled via the `hidden` attribute and class toggles,
not routing. The diff sidebar is presentation-only — close and minimize never clear the
selection; only a file pick (or the explicit Clear button) changes A/B.

## Planning docs

`docs/planning/SKELETON_v2.md` + `ITER_01_v2.md` + `ITER_02_v2.md` are the authoritative
**current (v2)** design — the single-file reshape. `docs/planning/SKELETON.md` and
`ITER_0*.md` (untagged) are the superseded v1 three-file design, kept for history. Read the
v2 skeleton before any non-trivial change.

## Conventions

- Agent decision log lives at `docs/claude_logs/DECISION_LOG.md`.
- Section banners in the inlined script use `/* ===== ... ===== */`; module methods are
  grouped under one namespace object. Match that style — no frameworks, no classes, no JSX.
