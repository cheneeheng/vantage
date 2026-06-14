/* ===================================================================
   Vantage — local repo explorer
   Classic script (no ES modules) so the page works over file://.
   Modules below are organized as plain object namespaces:
     Persist, Scanner, Board, Compare, Copy, App
   =================================================================== */

'use strict';

/* ===================================================================
   Shared constants
   =================================================================== */

const IGNORE_LIST = new Set([
  '.git',
  'node_modules',
  'venv',
  '.venv',
  'target',
  'dist',
  'build',
  '.next',
  '__pycache__',
]);

const STACK_MARKERS = [
  { files: ['pyproject.toml', 'requirements.txt'], label: 'Python' },
  { files: ['package.json'], label: 'Node' },
  { files: ['Cargo.toml'], label: 'Rust' },
  { files: ['go.mod'], label: 'Go' },
  { files: ['pom.xml', 'build.gradle'], label: 'JVM' },
];

const FALLBACK_WALK_MAX_DEPTH = 3;

/* ===================================================================
   Persist — IndexedDB read/write for the directory handle + scan cache
   =================================================================== */

const Persist = {
  DB_NAME: 'vantage',
  DB_VERSION: 1,
  STORE: 'vantage',
  HANDLE_KEY: 'rootHandle',
  CACHE_KEY: 'scanCache',

  _dbPromise: null,

  _openDb() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(Persist.STORE)) {
          db.createObjectStore(Persist.STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  },

  async _get(key) {
    const db = await this._openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readonly');
      const store = tx.objectStore(this.STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async _set(key, value) {
    const db = await this._openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readwrite');
      const store = tx.objectStore(this.STORE);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async saveHandle(handle) {
    return this._set(this.HANDLE_KEY, handle);
  },

  async loadHandle() {
    return this._get(this.HANDLE_KEY);
  },

  async saveCache(cache) {
    return this._set(this.CACHE_KEY, cache);
  },

  async loadCache() {
    return this._get(this.CACHE_KEY);
  },
};

/* ===================================================================
   Scanner — enumerate repos, detect stack, last-activity, file trees
   =================================================================== */

const Scanner = {
  /**
   * Iterate the root directory's immediate children that are directories,
   * gather per-repo metadata in parallel, and write the result to the cache.
   * Returns Repo[] with live dirHandle attached.
   */
  async scanRoot(dirHandle) {
    const dirEntries = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'directory') {
        dirEntries.push({ name, handle });
      }
    }

    const repos = await Promise.all(
      dirEntries.map(async ({ name, handle }) => {
        const [stack, lastActivity] = await Promise.all([
          Scanner.detectStack(handle),
          Scanner.lastActivity(handle),
        ]);
        return {
          name,
          dirHandle: handle,
          stack,
          lastActivity,
          fileTree: null,
        };
      })
    );

    // Write a serializable subset (no live handles) to the cache.
    await Persist.saveCache({
      scannedAt: Date.now(),
      repos: repos.map((r) => ({
        name: r.name,
        stack: r.stack,
        lastActivity: r.lastActivity,
      })),
    });

    return repos;
  },

  /**
   * Probe the repo root for marker files and return stack badges.
   * A repo can carry multiple badges.
   */
  async detectStack(repoHandle) {
    const stacks = [];
    for (const marker of STACK_MARKERS) {
      for (const fileName of marker.files) {
        if (await Scanner._hasFile(repoHandle, fileName)) {
          stacks.push(marker.label);
          break;
        }
      }
    }
    return stacks;
  },

  async _hasFile(dirHandle, name) {
    try {
      await dirHandle.getFileHandle(name);
      return true;
    } catch (err) {
      return false;
    }
  },

  async _hasDir(dirHandle, name) {
    try {
      await dirHandle.getDirectoryHandle(name);
      return true;
    } catch (err) {
      return false;
    }
  },

  /**
   * Fallback chain:
   *  1. lastModified of .git/logs/HEAD
   *  2. else lastModified of .git/HEAD
   *  3. else shallow ignore-listed walk, newest file mtime (depth-capped)
   * Returns epoch ms, or null.
   */
  async lastActivity(repoHandle) {
    try {
      const gitDir = await repoHandle.getDirectoryHandle('.git');

      // 1. .git/logs/HEAD
      try {
        const logsDir = await gitDir.getDirectoryHandle('logs');
        const headFile = await logsDir.getFileHandle('HEAD');
        const file = await headFile.getFile();
        return file.lastModified;
      } catch (err) {
        // fall through
      }

      // 2. .git/HEAD
      try {
        const headFile = await gitDir.getFileHandle('HEAD');
        const file = await headFile.getFile();
        return file.lastModified;
      } catch (err) {
        // fall through
      }
    } catch (err) {
      // no .git directory at all — fall through to walk
    }

    // 3. shallow ignore-listed walk, newest file mtime, depth-capped
    try {
      return await Scanner._newestMtimeWalk(repoHandle, 0);
    } catch (err) {
      return null;
    }
  },

  async _newestMtimeWalk(dirHandle, depth) {
    let newest = null;
    if (depth > FALLBACK_WALK_MAX_DEPTH) return newest;

    for await (const [name, handle] of dirHandle.entries()) {
      if (IGNORE_LIST.has(name)) continue;

      if (handle.kind === 'file') {
        try {
          const file = await handle.getFile();
          if (newest === null || file.lastModified > newest) {
            newest = file.lastModified;
          }
        } catch (err) {
          // skip unreadable file
        }
      } else if (handle.kind === 'directory' && depth < FALLBACK_WALK_MAX_DEPTH) {
        const childNewest = await Scanner._newestMtimeWalk(handle, depth + 1);
        if (childNewest !== null && (newest === null || childNewest > newest)) {
          newest = childNewest;
        }
      }
    }

    return newest;
  },

  /**
   * Recursively enumerate a repo's directory handle into a TreeNode tree,
   * skipping any directory in the ignore-list during enumeration (not after).
   * TreeNode = { name, kind: 'file'|'dir', handle, children? }
   */
  async readTree(repo) {
    const root = await Scanner._readTreeNode(repo.dirHandle, repo.name, true);
    repo.fileTree = root;
    return root;
  },

  async _readTreeNode(dirHandle, name, isRoot) {
    const node = {
      name,
      kind: 'dir',
      handle: dirHandle,
      children: [],
    };

    const entries = [];
    for await (const [childName, childHandle] of dirHandle.entries()) {
      if (childHandle.kind === 'directory' && IGNORE_LIST.has(childName)) {
        continue;
      }
      entries.push({ name: childName, handle: childHandle });
    }

    // Directories first, then files, both alphabetical.
    entries.sort((a, b) => {
      const aIsDir = a.handle.kind === 'directory';
      const bIsDir = b.handle.kind === 'directory';
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (entry.handle.kind === 'directory') {
        node.children.push({
          name: entry.name,
          kind: 'dir',
          handle: entry.handle,
          children: null, // not yet read — lazy on expand
        });
      } else {
        node.children.push({
          name: entry.name,
          kind: 'file',
          handle: entry.handle,
        });
      }
    }

    return node;
  },

  /**
   * Lazily read the children of a directory TreeNode (for nested expand).
   */
  async readChildren(dirNode) {
    if (dirNode.children !== null) return dirNode.children;
    const populated = await Scanner._readTreeNode(dirNode.handle, dirNode.name, false);
    dirNode.children = populated.children;
    return dirNode.children;
  },
};

/* ===================================================================
   Compare — line-based LCS diff
   =================================================================== */

const Compare = {
  /**
   * Returns true if the text looks binary: contains a NUL byte in the
   * first ~8KB, or fails UTF-8 decode.
   */
  looksBinary(arrayBuffer) {
    const slice = arrayBuffer.slice(0, 8192);
    const bytes = new Uint8Array(slice);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) return true;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
    } catch (err) {
      return true;
    }
    return false;
  },

  /**
   * Hand-written line-based LCS diff.
   * Returns DiffLine[]: { type: 'equal'|'add'|'del', a?, b?, text }
   * `a`/`b` are 1-based line numbers in the respective file (only present
   * for lines that exist on that side).
   */
  diff(textA, textB) {
    const linesA = textA.length === 0 ? [] : textA.split('\n');
    const linesB = textB.length === 0 ? [] : textB.split('\n');

    const n = linesA.length;
    const m = linesB.length;

    // LCS length table, (n+1) x (m+1)
    const lcs = new Array(n + 1);
    for (let i = 0; i <= n; i++) {
      lcs[i] = new Int32Array(m + 1);
    }
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (linesA[i] === linesB[j]) {
          lcs[i][j] = lcs[i + 1][j + 1] + 1;
        } else {
          lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
      }
    }

    // Walk the table to produce the diff rows.
    const result = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (linesA[i] === linesB[j]) {
        result.push({ type: 'equal', a: i + 1, b: j + 1, text: linesA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        result.push({ type: 'del', a: i + 1, text: linesA[i] });
        i++;
      } else {
        result.push({ type: 'add', b: j + 1, text: linesB[j] });
        j++;
      }
    }
    while (i < n) {
      result.push({ type: 'del', a: i + 1, text: linesA[i] });
      i++;
    }
    while (j < m) {
      result.push({ type: 'add', b: j + 1, text: linesB[j] });
      j++;
    }

    return result;
  },
};

/* ===================================================================
   Copy — copy/overwrite a file from one repo onto the other
   =================================================================== */

const Copy = {
  /**
   * Resolve the destination directory handle by walking from the target
   * repo's root directory handle along `pathParts` (all but the last
   * segment, which is the file name).
   */
  async _resolveDestDir(repoDirHandle, pathParts) {
    let dir = repoDirHandle;
    for (let k = 0; k < pathParts.length - 1; k++) {
      dir = await dir.getDirectoryHandle(pathParts[k], { create: true });
    }
    return dir;
  },

  /**
   * Returns true if `name` already exists (as a file) in `dirHandle`.
   */
  async destExists(dirHandle, name) {
    try {
      await dirHandle.getFileHandle(name);
      return true;
    } catch (err) {
      return false;
    }
  },

  /**
   * Copy the contents of srcFileHandle into dstDirHandle/name, creating the
   * file if it doesn't exist and overwriting it if it does.
   */
  async copyFile(srcFileHandle, dstDirHandle, name) {
    const srcFile = await srcFileHandle.getFile();
    const contents = await srcFile.arrayBuffer();

    const dstFileHandle = await dstDirHandle.getFileHandle(name, { create: true });
    const writable = await dstFileHandle.createWritable();
    try {
      await writable.write(contents);
    } finally {
      await writable.close();
    }
    return dstFileHandle;
  },
};

/* ===================================================================
   App — top-level state, DOM wiring, rendering
   =================================================================== */

const App = {
  // ---- State ----
  rootHandle: null,
  repos: [], // Repo[]
  filterText: '',
  sortMode: 'last-activity', // 'last-activity' | 'alphabetical' | 'stack'
  selection: { sideA: null, sideB: null }, // {repoName, path, fileHandle} | null
  nextSide: 'A', // which side a plain "click = fill-next" assigns
  searchOverlayOpen: false,
  searchActiveIndex: 0,
  searchResults: [],
  lastFocusedBeforeOverlay: null,
  highlightedRepoName: null,

  // ---- DOM refs (filled in init) ----
  el: {},

  /* ----------------------------------------------------------- */
  /* Init                                                          */
  /* ----------------------------------------------------------- */

  async init() {
    this.cacheDom();
    this.bindEvents();
    await this.tryReopen();
  },

  cacheDom() {
    this.el.filterInput = document.getElementById('filter-input');
    this.el.sortSelect = document.getElementById('sort-select');
    this.el.searchHintBtn = document.getElementById('search-hint-btn');
    this.el.rescanBtn = document.getElementById('rescan-btn');
    this.el.chooseFolderBtn = document.getElementById('choose-folder-btn');
    this.el.reconnectBtn = document.getElementById('reconnect-btn');
    this.el.emptyChooseFolderBtn = document.getElementById('empty-choose-folder-btn');
    this.el.noticeBar = document.getElementById('notice-bar');

    this.el.emptyState = document.getElementById('empty-state');
    this.el.board = document.getElementById('board');

    this.el.comparePanel = document.getElementById('compare-panel');
    this.el.compareClearBtn = document.getElementById('compare-clear-btn');
    this.el.compareEmpty = document.getElementById('compare-empty');
    this.el.compareBody = document.getElementById('compare-body');
    this.el.diffMetaA = document.getElementById('diff-meta-a');
    this.el.diffMetaB = document.getElementById('diff-meta-b');
    this.el.diffStatus = document.getElementById('diff-status');
    this.el.diffView = document.getElementById('diff-view');
    this.el.copyBar = document.getElementById('copy-bar');
    this.el.copyAToB = document.getElementById('copy-a-to-b');
    this.el.copyBToA = document.getElementById('copy-b-to-a');

    this.el.selectionBar = document.getElementById('selection-bar');
    this.el.selectionValueA = document.getElementById('selection-value-a');
    this.el.selectionValueB = document.getElementById('selection-value-b');
    this.el.selectionSwapBtn = document.getElementById('selection-swap-btn');
    this.el.selectionClearBtn = document.getElementById('selection-clear-btn');
    this.el.selectionNextIndicator = document.getElementById('selection-next-indicator');

    this.el.searchOverlay = document.getElementById('search-overlay');
    this.el.searchInput = document.getElementById('search-input');
    this.el.searchResults = document.getElementById('search-results');

    this.el.confirmOverlay = document.getElementById('confirm-overlay');
    this.el.confirmTitle = document.getElementById('confirm-title');
    this.el.confirmMessage = document.getElementById('confirm-message');
    this.el.confirmCancelBtn = document.getElementById('confirm-cancel-btn');
    this.el.confirmOkBtn = document.getElementById('confirm-ok-btn');

    this.el.toast = document.getElementById('toast');
  },

  bindEvents() {
    this.el.chooseFolderBtn.addEventListener('click', () => this.handleChooseFolder());
    this.el.emptyChooseFolderBtn.addEventListener('click', () => this.handleChooseFolder());
    this.el.reconnectBtn.addEventListener('click', () => this.handleReconnect());
    this.el.rescanBtn.addEventListener('click', () => this.handleRescan());

    this.el.filterInput.addEventListener('input', () => {
      this.filterText = this.el.filterInput.value;
      this.renderBoard();
    });

    this.el.sortSelect.addEventListener('change', () => {
      this.sortMode = this.el.sortSelect.value;
      this.renderBoard();
    });

    // Ctrl+K / Cmd+K search overlay
    document.addEventListener('keydown', (e) => this.handleGlobalKeydown(e));

    this.el.searchHintBtn.addEventListener('click', () => this.openSearchOverlay());

    this.el.searchInput.addEventListener('input', () => this.handleSearchInput());
    this.el.searchInput.addEventListener('keydown', (e) => this.handleSearchKeydown(e));
    this.el.searchOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.searchOverlay) this.closeSearchOverlay();
    });

    this.el.selectionSwapBtn.addEventListener('click', () => this.swapSelection());
    this.el.selectionClearBtn.addEventListener('click', () => this.clearSelection());
    this.el.compareClearBtn.addEventListener('click', () => this.clearSelection());

    this.el.copyAToB.addEventListener('click', () => this.handleCopy('A', 'B'));
    this.el.copyBToA.addEventListener('click', () => this.handleCopy('B', 'A'));

    this.el.confirmCancelBtn.addEventListener('click', () => this.closeConfirmModal());
    this.el.confirmOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.confirmOverlay) this.closeConfirmModal();
    });
  },

  /* ----------------------------------------------------------- */
  /* Folder access / reopen flow                                  */
  /* ----------------------------------------------------------- */

  async tryReopen() {
    let handle;
    try {
      handle = await Persist.loadHandle();
    } catch (err) {
      handle = null;
    }

    if (!handle) {
      this.showEmptyState();
      return;
    }

    // Verify the handle is still valid by querying permission.
    let permission;
    try {
      permission = await handle.queryPermission({ mode: 'readwrite' });
    } catch (err) {
      // Stale handle (folder moved/deleted) — drop it.
      await Persist.saveHandle(null);
      this.showEmptyState();
      return;
    }

    if (permission === 'granted') {
      this.rootHandle = handle;
      await this.loadFromCacheThenScan();
    } else {
      // 'prompt' (or 'denied') — show Reconnect button; requestPermission
      // must happen inside a user gesture (click handler).
      this.rootHandle = handle;
      this.showReconnectPrompt();
      // Still render from cache if we have it, so the board isn't empty
      // while waiting for reconnect.
      await this.loadFromCacheOnly();
    }
  },

  async loadFromCacheOnly() {
    let cache;
    try {
      cache = await Persist.loadCache();
    } catch (err) {
      cache = null;
    }
    if (cache && Array.isArray(cache.repos) && cache.repos.length > 0) {
      this.repos = cache.repos.map((r) => ({
        name: r.name,
        dirHandle: null,
        stack: r.stack || [],
        lastActivity: r.lastActivity != null ? r.lastActivity : null,
        fileTree: null,
      }));
      this.showBoard();
      this.renderBoard();
    } else {
      this.showEmptyState();
    }
  },

  async loadFromCacheThenScan() {
    // Render from cache immediately for instant reopen, then rescan to get
    // live handles + fresh metadata.
    await this.loadFromCacheOnly();
    await this.handleRescan();
  },

  async handleChooseFolder() {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'vantage-root' });
    } catch (err) {
      // user cancelled
      return;
    }

    this.rootHandle = handle;
    try {
      await Persist.saveHandle(handle);
    } catch (err) {
      this.showNotice('Could not persist folder handle: ' + err.message);
    }

    this.el.reconnectBtn.hidden = true;
    await this.handleRescan();
  },

  async handleReconnect() {
    if (!this.rootHandle) return;
    let permission;
    try {
      permission = await this.rootHandle.requestPermission({ mode: 'readwrite' });
    } catch (err) {
      this.showNotice('Could not request permission: ' + err.message);
      return;
    }

    if (permission === 'granted') {
      this.el.reconnectBtn.hidden = true;
      await this.handleRescan();
    } else {
      this.showNotice('Permission was not granted. Folder access is read-only or unavailable.');
    }
  },

  async handleRescan() {
    if (!this.rootHandle) return;

    this.el.rescanBtn.disabled = true;
    try {
      const repos = await Scanner.scanRoot(this.rootHandle);
      this.repos = repos;
      this.showBoard();
      this.renderBoard();
      this.clearNotice();
    } catch (err) {
      // Stale handle: folder moved/deleted underneath.
      console.error('scanRoot failed:', err);
      await Persist.saveHandle(null);
      this.rootHandle = null;
      this.showNotice('Scan failed: ' + (err && err.message ? err.message : err));
      this.showEmptyState();
    } finally {
      this.el.rescanBtn.disabled = false;
    }
  },

  /* ----------------------------------------------------------- */
  /* View toggles                                                  */
  /* ----------------------------------------------------------- */

  showEmptyState() {
    this.el.emptyState.hidden = false;
    this.el.board.hidden = true;
    this.el.rescanBtn.hidden = true;
    this.el.selectionBar.hidden = true;
    this.el.comparePanel.hidden = true;
  },

  showBoard() {
    this.el.emptyState.hidden = true;
    this.el.board.hidden = false;
    this.el.rescanBtn.hidden = false;
    this.el.selectionBar.hidden = false;
    this.el.comparePanel.hidden = false;
  },

  showReconnectPrompt() {
    this.el.reconnectBtn.hidden = false;
  },

  /* ----------------------------------------------------------- */
  /* Notices / toasts                                              */
  /* ----------------------------------------------------------- */

  showNotice(message) {
    this.el.noticeBar.textContent = '';
    const span = document.createElement('span');
    span.textContent = message;
    const dismiss = document.createElement('button');
    dismiss.className = 'notice-dismiss';
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => this.clearNotice());
    this.el.noticeBar.appendChild(span);
    this.el.noticeBar.appendChild(dismiss);
    this.el.noticeBar.hidden = false;
  },

  clearNotice() {
    this.el.noticeBar.hidden = true;
    this.el.noticeBar.textContent = '';
  },

  showToast(message, isError) {
    this.el.toast.textContent = message;
    this.el.toast.classList.toggle('toast-error', !!isError);
    this.el.toast.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.el.toast.hidden = true;
    }, 2600);
  },

  /* ----------------------------------------------------------- */
  /* Formatting helpers                                            */
  /* ----------------------------------------------------------- */

  formatRelativeTime(epochMs) {
    if (epochMs == null) return '—'; // em dash
    const diffMs = Date.now() - epochMs;
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    const diffMonth = Math.floor(diffDay / 30);
    if (diffMonth < 12) return `${diffMonth}mo ago`;
    const diffYear = Math.floor(diffDay / 365);
    return `${diffYear}y ago`;
  },

  /* ----------------------------------------------------------- */
  /* Board rendering                                               */
  /* ----------------------------------------------------------- */

  getFilteredSortedRepos() {
    const filterLower = this.filterText.trim().toLowerCase();
    let list = this.repos.filter((r) =>
      filterLower === '' || r.name.toLowerCase().includes(filterLower)
    );

    if (this.sortMode === 'alphabetical') {
      list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    } else if (this.sortMode === 'last-activity') {
      list = list.slice().sort((a, b) => {
        const aTime = a.lastActivity == null ? -Infinity : a.lastActivity;
        const bTime = b.lastActivity == null ? -Infinity : b.lastActivity;
        return bTime - aTime; // most recent first; null sorts last
      });
    }
    // 'stack' sort mode is handled separately via grouping in renderBoard.

    return list;
  },

  renderBoard() {
    const board = this.el.board;
    board.textContent = '';
    board.classList.remove('empty');

    const list = this.getFilteredSortedRepos();

    if (list.length === 0) {
      board.classList.add('empty');
      return;
    }

    if (this.sortMode === 'stack') {
      this.renderBoardGroupedByStack(list);
    } else {
      board.classList.remove('board-grouped');
      for (const repo of list) {
        board.appendChild(this.buildRepoCard(repo));
      }
    }
  },

  renderBoardGroupedByStack(list) {
    const board = this.el.board;
    const groups = new Map(); // stack label -> Repo[]

    for (const repo of list) {
      const labels = repo.stack && repo.stack.length > 0 ? [repo.stack[0]] : ['Other'];
      for (const label of labels) {
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(repo);
      }
    }

    // Sort group names alphabetically, but keep "Other" last.
    const groupNames = Array.from(groups.keys()).sort((a, b) => {
      if (a === 'Other') return 1;
      if (b === 'Other') return -1;
      return a.localeCompare(b);
    });

    for (const groupName of groupNames) {
      const groupEl = document.createElement('div');
      groupEl.className = 'board-group';

      const title = document.createElement('div');
      title.className = 'board-group-title';
      title.textContent = `${groupName} (${groups.get(groupName).length})`;
      groupEl.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'board-group-grid';
      for (const repo of groups.get(groupName)) {
        grid.appendChild(this.buildRepoCard(repo));
      }
      groupEl.appendChild(grid);

      board.appendChild(groupEl);
    }
  },

  buildRepoCard(repo) {
    const card = document.createElement('div');
    card.className = 'repo-card';
    card.dataset.repoName = repo.name;

    if (repo.name === this.highlightedRepoName) {
      card.classList.add('highlight');
    }

    const isExpanded = !!repo._expanded;
    if (isExpanded) card.classList.add('expanded');

    // Header
    const header = document.createElement('div');
    header.className = 'repo-card-header';

    const name = document.createElement('div');
    name.className = 'repo-card-name';
    name.textContent = repo.name;
    header.appendChild(name);

    const toggle = document.createElement('div');
    toggle.className = 'repo-card-toggle';
    toggle.textContent = '▸'; // ▸
    header.appendChild(toggle);

    header.addEventListener('click', () => this.toggleCardExpanded(repo));
    card.appendChild(header);

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'repo-card-meta';

    const badges = document.createElement('div');
    badges.className = 'stack-badges';
    if (repo.stack && repo.stack.length > 0) {
      for (const label of repo.stack) {
        const badge = document.createElement('span');
        badge.className = 'stack-badge';
        badge.textContent = label;
        badges.appendChild(badge);
      }
    }
    meta.appendChild(badges);

    const activity = document.createElement('div');
    activity.className = 'last-activity';
    activity.textContent = this.formatRelativeTime(repo.lastActivity);
    meta.appendChild(activity);

    card.appendChild(meta);

    // File tree container (only shown when expanded)
    if (isExpanded) {
      const treeContainer = document.createElement('div');
      treeContainer.className = 'file-tree-container';
      card.appendChild(treeContainer);
      this.renderFileTreeInto(repo, treeContainer);
    }

    return card;
  },

  async toggleCardExpanded(repo) {
    repo._expanded = !repo._expanded;
    this.renderBoard();
  },

  /* ----------------------------------------------------------- */
  /* File tree rendering                                           */
  /* ----------------------------------------------------------- */

  async renderFileTreeInto(repo, container) {
    if (repo.fileTree) {
      this.renderTreeNode(repo, repo.fileTree, container, true);
      return;
    }

    if (!repo.dirHandle) {
      const err = document.createElement('div');
      err.className = 'file-tree-error';
      err.textContent = 'No folder handle available — rescan to enable file browsing.';
      container.appendChild(err);
      return;
    }

    const spinner = document.createElement('div');
    spinner.className = 'file-tree-spinner';
    spinner.textContent = 'Loading…';
    container.appendChild(spinner);

    try {
      const tree = await Scanner.readTree(repo);
      // Only re-render if the card is still expanded (container still attached).
      if (!container.isConnected) return;
      container.textContent = '';
      this.renderTreeNode(repo, tree, container, true);
    } catch (err) {
      container.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'file-tree-error';
      errEl.textContent =
        'Could not read this repo’s files (folder may have changed). Try Rescan.';
      container.appendChild(errEl);
    }
  },

  renderTreeNode(repo, node, container, isRoot) {
    const ul = document.createElement('ul');
    ul.className = isRoot ? 'tree-node tree-root' : 'tree-node';

    for (const child of node.children || []) {
      const li = document.createElement('li');

      if (child.kind === 'dir') {
        const row = document.createElement('div');
        row.className = 'tree-row tree-dir';

        const icon = document.createElement('span');
        icon.className = 'tree-row-icon';
        icon.textContent = child._open ? '▾' : '▸'; // ▾ / ▸

        const nameEl = document.createElement('span');
        nameEl.className = 'tree-row-name';
        nameEl.textContent = child.name;

        row.appendChild(icon);
        row.appendChild(nameEl);
        li.appendChild(row);

        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        if (!child._open) childrenContainer.classList.add('collapsed');
        li.appendChild(childrenContainer);

        row.addEventListener('click', async () => {
          child._open = !child._open;
          icon.textContent = child._open ? '▾' : '▸';

          if (child._open) {
            childrenContainer.classList.remove('collapsed');
            if (child.children === null) {
              const spinner = document.createElement('div');
              spinner.className = 'file-tree-spinner';
              spinner.textContent = 'Loading…';
              childrenContainer.appendChild(spinner);
              try {
                await Scanner.readChildren(child);
                childrenContainer.textContent = '';
                this.renderTreeNode(repo, child, childrenContainer, false);
              } catch (err) {
                childrenContainer.textContent = '';
                const errEl = document.createElement('div');
                errEl.className = 'file-tree-error';
                errEl.textContent = 'Could not read this folder.';
                childrenContainer.appendChild(errEl);
              }
            } else if (childrenContainer.children.length === 0) {
              this.renderTreeNode(repo, child, childrenContainer, false);
            }
          } else {
            childrenContainer.classList.add('collapsed');
          }
        });
      } else {
        // file
        const row = document.createElement('div');
        row.className = 'tree-row tree-file';

        const path = this.buildChildPath(node, child);

        const isA =
          this.selection.sideA &&
          this.selection.sideA.repoName === repo.name &&
          this.selection.sideA.path === path;
        const isB =
          this.selection.sideB &&
          this.selection.sideB.repoName === repo.name &&
          this.selection.sideB.path === path;
        if (isA || isB) row.classList.add('assigned');

        const icon = document.createElement('span');
        icon.className = 'tree-row-icon';
        icon.textContent = '•'; // •

        const nameEl = document.createElement('span');
        nameEl.className = 'tree-row-name';
        nameEl.textContent = child.name;

        const actions = document.createElement('span');
        actions.className = 'tree-row-actions';

        const btnA = document.createElement('button');
        btnA.className = 'btn';
        btnA.textContent = 'A';
        btnA.title = `Assign to Side A`;
        if (isA) btnA.classList.add('active-a');
        btnA.addEventListener('click', (e) => {
          e.stopPropagation();
          this.assignToSide('A', repo, path, child.handle);
        });

        const btnB = document.createElement('button');
        btnB.className = 'btn';
        btnB.textContent = 'B';
        btnB.title = `Assign to Side B`;
        if (isB) btnB.classList.add('active-b');
        btnB.addEventListener('click', (e) => {
          e.stopPropagation();
          this.assignToSide('B', repo, path, child.handle);
        });

        actions.appendChild(btnA);
        actions.appendChild(btnB);

        row.appendChild(icon);
        row.appendChild(nameEl);
        row.appendChild(actions);

        // Click anywhere on the row = fill-next.
        row.addEventListener('click', () => {
          this.assignToSide(this.nextSide, repo, path, child.handle);
        });

        li.appendChild(row);
      }

      ul.appendChild(li);
    }

    container.appendChild(ul);
  },

  /**
   * Build the path of `child` relative to the repo root, given its
   * immediate parent TreeNode `parent`.
   */
  buildChildPath(parent, child) {
    const parentPath = parent._path || '';
    const path = parentPath ? `${parentPath}/${child.name}` : child.name;
    child._path = path;
    return path;
  },

  /* ----------------------------------------------------------- */
  /* Selection                                                     */
  /* ----------------------------------------------------------- */

  assignToSide(side, repo, path, fileHandle) {
    const entry = { repoName: repo.name, path, fileHandle };
    if (side === 'A') {
      this.selection.sideA = entry;
      this.nextSide = 'B';
    } else {
      this.selection.sideB = entry;
      this.nextSide = 'A';
    }
    this.renderSelectionBar();
    this.renderBoard();
    this.renderComparePanel();
  },

  clearSelection() {
    this.selection.sideA = null;
    this.selection.sideB = null;
    this.nextSide = 'A';
    this.renderSelectionBar();
    this.renderBoard();
    this.renderComparePanel();
  },

  swapSelection() {
    const tmp = this.selection.sideA;
    this.selection.sideA = this.selection.sideB;
    this.selection.sideB = tmp;
    this.renderSelectionBar();
    this.renderBoard();
    this.renderComparePanel();
  },

  renderSelectionBar() {
    const a = this.selection.sideA;
    const b = this.selection.sideB;

    if (a) {
      this.el.selectionValueA.textContent = `${a.repoName}/${a.path}`;
      this.el.selectionValueA.classList.add('filled');
      this.el.selectionValueA.classList.remove('empty-value');
    } else {
      this.el.selectionValueA.textContent = 'empty';
      this.el.selectionValueA.classList.remove('filled');
      this.el.selectionValueA.classList.add('empty-value');
    }

    if (b) {
      this.el.selectionValueB.textContent = `${b.repoName}/${b.path}`;
      this.el.selectionValueB.classList.add('filled');
      this.el.selectionValueB.classList.remove('empty-value');
    } else {
      this.el.selectionValueB.textContent = 'empty';
      this.el.selectionValueB.classList.remove('filled');
      this.el.selectionValueB.classList.add('empty-value');
    }

    this.el.selectionNextIndicator.textContent = `Next click fills: ${this.nextSide}`;
  },

  /* ----------------------------------------------------------- */
  /* Compare panel / diff                                          */
  /* ----------------------------------------------------------- */

  async renderComparePanel() {
    const { sideA, sideB } = this.selection;

    if (!sideA || !sideB) {
      this.el.compareEmpty.hidden = false;
      this.el.compareBody.hidden = true;
      return;
    }

    this.el.compareEmpty.hidden = true;
    this.el.compareBody.hidden = false;

    this.el.diffMetaA.textContent = `A: ${sideA.repoName}/${sideA.path}`;
    this.el.diffMetaB.textContent = `B: ${sideB.repoName}/${sideB.path}`;

    await this.runDiffAndRender();
  },

  async runDiffAndRender() {
    const { sideA, sideB } = this.selection;
    if (!sideA || !sideB) return;

    this.el.diffStatus.hidden = true;
    this.el.diffStatus.className = 'diff-status';
    this.el.diffView.textContent = '';
    this.el.copyBar.hidden = true;

    let fileA, fileB, bufA, bufB;
    try {
      fileA = await sideA.fileHandle.getFile();
      fileB = await sideB.fileHandle.getFile();
      bufA = await fileA.arrayBuffer();
      bufB = await fileB.arrayBuffer();
    } catch (err) {
      this.el.diffStatus.hidden = false;
      this.el.diffStatus.classList.add('diff-error');
      this.el.diffStatus.textContent =
        'Could not read one or both files (folder may have changed). Try Rescan.';
      return;
    }

    if (Compare.looksBinary(bufA) || Compare.looksBinary(bufB)) {
      this.el.diffStatus.hidden = false;
      this.el.diffStatus.classList.add('diff-binary');
      this.el.diffStatus.textContent = "Binary file — can't compare.";
      // Copy is still allowed even if we can't render a diff.
      this.el.copyBar.hidden = false;
      this.updateCopyBarLabels();
      return;
    }

    const decoder = new TextDecoder('utf-8');
    const textA = decoder.decode(bufA);
    const textB = decoder.decode(bufB);

    if (textA === textB) {
      this.el.diffStatus.hidden = false;
      this.el.diffStatus.classList.add('diff-identical');
      this.el.diffStatus.textContent = 'Files are identical.';
      this.el.copyBar.hidden = false;
      this.updateCopyBarLabels();
      return;
    }

    const diffLines = Compare.diff(textA, textB);
    this.renderDiffView(diffLines);

    this.el.copyBar.hidden = false;
    this.updateCopyBarLabels();
  },

  updateCopyBarLabels() {
    const { sideA, sideB } = this.selection;
    if (!sideA || !sideB) return;
    this.el.copyAToB.textContent = `Copy A → B  (overwrite ${sideB.repoName}/${sideB.path})`;
    this.el.copyBToA.textContent = `Copy B → A  (overwrite ${sideA.repoName}/${sideA.path})`;
  },

  renderDiffView(diffLines) {
    const table = document.createElement('table');
    table.className = 'diff-table';

    for (const line of diffLines) {
      const tr = document.createElement('tr');
      tr.className = `diff-row diff-${line.type}`;

      const lineNoA = document.createElement('td');
      lineNoA.className = 'diff-lineno';
      lineNoA.textContent = line.a != null ? String(line.a) : '';

      const lineNoB = document.createElement('td');
      lineNoB.className = 'diff-lineno';
      lineNoB.textContent = line.b != null ? String(line.b) : '';

      const marker = document.createElement('td');
      marker.className = 'diff-marker';
      marker.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : '';

      const text = document.createElement('td');
      text.className = 'diff-text';
      text.textContent = line.text;

      tr.appendChild(lineNoA);
      tr.appendChild(lineNoB);
      tr.appendChild(marker);
      tr.appendChild(text);
      table.appendChild(tr);
    }

    this.el.diffView.appendChild(table);
  },

  /* ----------------------------------------------------------- */
  /* Copy / overwrite                                              */
  /* ----------------------------------------------------------- */

  async handleCopy(fromSide, toSide) {
    const src = fromSide === 'A' ? this.selection.sideA : this.selection.sideB;
    const dst = toSide === 'A' ? this.selection.sideA : this.selection.sideB;
    if (!src || !dst) return;

    const dstRepo = this.repos.find((r) => r.name === dst.repoName);
    if (!dstRepo || !dstRepo.dirHandle) {
      this.showToast('Destination repo handle unavailable. Try Rescan.', true);
      return;
    }

    // Ensure write permission on the root (re-request inside this click handler).
    if (this.rootHandle) {
      try {
        const perm = await this.rootHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          const req = await this.rootHandle.requestPermission({ mode: 'readwrite' });
          if (req !== 'granted') {
            this.showToast('Write permission denied.', true);
            return;
          }
        }
      } catch (err) {
        // queryPermission/requestPermission unsupported or failed — proceed
        // and let the write itself fail if truly unauthorized.
      }
    }

    const pathParts = dst.path.split('/');
    const fileName = pathParts[pathParts.length - 1];

    let destDir;
    try {
      destDir = await Copy._resolveDestDir(dstRepo.dirHandle, pathParts);
    } catch (err) {
      this.showToast('Could not resolve destination folder. Try Rescan.', true);
      return;
    }

    let exists;
    try {
      exists = await Copy.destExists(destDir, fileName);
    } catch (err) {
      exists = false;
    }

    const targetPath = `${dst.repoName}/${dst.path}`;

    if (exists) {
      const confirmed = await this.showConfirmModal(
        'Confirm overwrite',
        `This will overwrite "${targetPath}" with the contents of "${src.repoName}/${src.path}". This cannot be undone.`
      );
      if (!confirmed) return;
    }

    try {
      await Copy.copyFile(src.fileHandle, destDir, fileName);
    } catch (err) {
      this.showToast(`Write failed: ${err.message || err}. The folder may have changed — try Rescan.`, true);
      return;
    }

    // Re-resolve the destination file handle (in case it was just created)
    // and refresh the diff so the user sees the files now match.
    try {
      const newHandle = await destDir.getFileHandle(fileName);
      dst.fileHandle = newHandle;
    } catch (err) {
      // ignore — diff refresh below may fail gracefully
    }

    await this.runDiffAndRender();
    this.showToast(`Copied to ${targetPath}`);
  },

  /* ----------------------------------------------------------- */
  /* Confirm modal                                                 */
  /* ----------------------------------------------------------- */

  showConfirmModal(title, message) {
    this.el.confirmTitle.textContent = title;
    this.el.confirmMessage.textContent = message;
    this.el.confirmOverlay.hidden = false;

    return new Promise((resolve) => {
      const onOk = () => {
        cleanup();
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        this.el.confirmOkBtn.removeEventListener('click', onOk);
        this.el.confirmCancelBtn.removeEventListener('click', onCancel);
        this.el.confirmOverlay.hidden = true;
      };
      this.el.confirmOkBtn.addEventListener('click', onOk);
      this.el.confirmCancelBtn.addEventListener('click', onCancel);
      this._confirmResolveOnOverlayClose = onCancel;
    });
  },

  closeConfirmModal() {
    if (this._confirmResolveOnOverlayClose) {
      this._confirmResolveOnOverlayClose();
      this._confirmResolveOnOverlayClose = null;
    }
  },

  /* ----------------------------------------------------------- */
  /* Ctrl+K search overlay                                         */
  /* ----------------------------------------------------------- */

  handleGlobalKeydown(e) {
    const isMod = e.ctrlKey || e.metaKey;
    if (isMod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (this.searchOverlayOpen) {
        this.closeSearchOverlay();
      } else {
        this.openSearchOverlay();
      }
      return;
    }

    if (this.searchOverlayOpen && e.key === 'Escape') {
      e.preventDefault();
      this.closeSearchOverlay();
    }
  },

  openSearchOverlay() {
    if (this.repos.length === 0) return;
    this.searchOverlayOpen = true;
    this.lastFocusedBeforeOverlay = document.activeElement;
    this.el.searchOverlay.hidden = false;
    this.el.searchInput.value = '';
    this.searchActiveIndex = 0;
    this.updateSearchResults('');
    // Focus after the overlay is visible.
    setTimeout(() => this.el.searchInput.focus(), 0);
  },

  closeSearchOverlay() {
    this.searchOverlayOpen = false;
    this.el.searchOverlay.hidden = true;
    if (this.lastFocusedBeforeOverlay && this.lastFocusedBeforeOverlay.focus) {
      this.lastFocusedBeforeOverlay.focus();
    }
    this.lastFocusedBeforeOverlay = null;
  },

  handleSearchInput() {
    this.searchActiveIndex = 0;
    this.updateSearchResults(this.el.searchInput.value);
  },

  updateSearchResults(query) {
    const lower = query.trim().toLowerCase();
    const results =
      lower === ''
        ? this.repos.slice()
        : this.repos.filter((r) => r.name.toLowerCase().includes(lower));

    this.searchResults = results;
    this.renderSearchResults();
  },

  renderSearchResults() {
    const list = this.el.searchResults;
    list.textContent = '';

    if (this.searchResults.length === 0) {
      const li = document.createElement('li');
      li.className = 'search-no-results';
      li.textContent = 'No matching repos.';
      list.appendChild(li);
      return;
    }

    this.searchResults.forEach((repo, idx) => {
      const li = document.createElement('li');
      li.className = 'search-result';
      if (idx === this.searchActiveIndex) li.classList.add('active');

      const name = document.createElement('span');
      name.textContent = repo.name;

      const metaEl = document.createElement('span');
      metaEl.className = 'search-result-meta';
      metaEl.textContent = this.formatRelativeTime(repo.lastActivity);

      li.appendChild(name);
      li.appendChild(metaEl);

      li.addEventListener('click', () => this.jumpToRepo(repo));

      list.appendChild(li);
    });
  },

  handleSearchKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.searchResults.length === 0) return;
      this.searchActiveIndex = (this.searchActiveIndex + 1) % this.searchResults.length;
      this.renderSearchResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.searchResults.length === 0) return;
      this.searchActiveIndex =
        (this.searchActiveIndex - 1 + this.searchResults.length) % this.searchResults.length;
      this.renderSearchResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const repo = this.searchResults[this.searchActiveIndex];
      if (repo) this.jumpToRepo(repo);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.closeSearchOverlay();
    }
  },

  jumpToRepo(repo) {
    this.closeSearchOverlay();
    this.highlightedRepoName = repo.name;
    // Reset filter so the target repo is guaranteed to be visible.
    this.filterText = '';
    this.el.filterInput.value = '';
    this.renderBoard();

    requestAnimationFrame(() => {
      const card = this.el.board.querySelector(`[data-repo-name="${cssEscape(repo.name)}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    // Remove highlight after a short delay.
    clearTimeout(this._highlightTimer);
    this._highlightTimer = setTimeout(() => {
      this.highlightedRepoName = null;
      this.renderBoard();
    }, 2000);
  },
};

/**
 * Minimal CSS.escape fallback for attribute-selector safety (repo names
 * can contain characters like quotes in edge cases).
 */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/* ===================================================================
   Bootstrap
   =================================================================== */

window.addEventListener('DOMContentLoaded', () => {
  App.init();
});
