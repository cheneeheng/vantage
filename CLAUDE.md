# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Vantage is a local, serverless repo explorer. Point it at a folder full of Git repos
and it renders each immediate subfolder as a card, lets you expand a card into its file
tree, pick one file from two different repos, diff them side by side, and copy/overwrite
one onto the other. Core flow: **open → find two repos → compare a file → copy across.**

## Running, building, testing

- **No build step, no package manager, no dependencies, no tests.** The entire app is
  three static files: `index.html`, `vantage.css`, `vantage.js`.
- **Run it** by opening `index.html` directly (`file://`) in **Chrome / Edge / Opera**.
  It will not work in Firefox or Safari — it depends on the File System Access API.
- On first use, click "Choose folder" and pick the projects root. The directory handle
  is persisted in IndexedDB, so reopening the page reconnects without re-prompting (the
  browser still requires a permission re-grant click via "Reconnect folder").

## Hard architectural constraints (do not violate)

These are deliberate decisions, not accidents — see `docs/planning/SKELETON.md` and its
Decisions Log before proposing changes that touch them:

- **Classic `<script>`, never `type="module"`.** ES-module `import` is CORS-blocked over
  `file://`. Everything lives in one classic script so the page works with no server. Do
  not split `vantage.js` into ES modules or add a bundler.
- **No network calls of any kind.** No CDN, no fetch to remote hosts, no analytics.
- **No new dependencies.** The line-based diff is hand-written (LCS); keep it that way.
- **Writes are confined to the chosen root folder.** Copy/overwrite is the only
  destructive action and must always name the exact target and wait for an explicit
  confirm (the `#confirm-overlay` modal). There is no delete capability.
- **Last-activity is a proxy, not precision.** Activity time comes from file mtimes
  (`.git/logs/HEAD` → `.git/HEAD` → shallow working-tree walk). Never parse git commit
  objects or pack files.

## Code structure

`vantage.js` is organized as a set of plain object namespaces (no classes), each a
cohesive module:

- **`Persist`** (~line 40) — IndexedDB: `saveHandle`/`loadHandle` (directory handle,
  survives sessions) and `saveCache`/`loadCache` (scan results).
- **`Scanner`** (~line 108) — `scanRoot(dirHandle)` enumerates child dirs as repos;
  `detectStack` reads marker files (`package.json`→Node, `Cargo.toml`→Rust, etc.);
  `lastActivity` runs the mtime fallback chain; `readTree`/`readChildren` lazily build a
  repo's file tree on expand. Respects `IGNORE_LIST` (`.git`, `node_modules`, `venv`, …).
- **`Compare`** (~line 324) — `diff(textA, textB)` (line-based LCS → `DiffLine[]`) and
  `looksBinary` (skip diffing binary files).
- **`Copy`** (~line 405) — `copyFile(srcFileHandle, dstDirHandle, name)`, behind the
  overwrite confirm.
- **`App`** (~line 454) — the controller and all UI: in-memory state (`repos`,
  `selection`, `sortMode`, `filterText`, …), DOM refs cached in `App.el`, event binding,
  and all rendering (`renderBoard`, `buildRepoCard`, `renderTreeNode`, `renderSelectionBar`,
  diff view, search palette, toasts). Bootstrapped from `App.init()` on `DOMContentLoaded`.

Data flows one way: Scanner/Persist produce plain in-memory objects (`Repo`, `TreeNode`,
`Selection` — shapes documented in SKELETON.md §02), `App` holds them as state and
re-renders the relevant region. `index.html` is static markup with fixed mount-point IDs
that `App.cacheDom()` looks up; regions are toggled via the `hidden` attribute, not routing.

## Planning docs

`docs/planning/SKELETON.md` is the authoritative v1 design (concept, architecture, the
full decisions log, and explicitly-deferred items). `docs/planning/ITER_0*.md` are the
per-iteration build plans. Read SKELETON.md before any non-trivial change.

## Conventions

- Agent decision log lives at `docs/claude_logs/DECISION_LOG.md`.
- Section banners in `vantage.js` use `/* ===== ... ===== */`; module methods are grouped
  under one namespace object. Match that style — no frameworks, no classes, no JSX.
