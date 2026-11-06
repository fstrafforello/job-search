import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LOCAL_SETTINGS } from './merge.js';

export const STATUSES = ['saved', 'applied', 'screening', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'];

function pruneUpgradeBackups(file) {
  const dir = path.dirname(file);
  const prefix = path.basename(file, '.json') + '.before-';
  fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(KEEP_UPGRADE_BACKUPS)
    .forEach(({ f }) => fs.rmSync(path.join(dir, f)));
}

const DEFAULTS = {
  version: 1,
  jobs: [],
  profile: { name: '', headline: '', resume: '', about: '', style: '' },
  settings: {
    engine: '', // 'builtin' | 'lmstudio'; '' until the user picks one on first start
    builtinModel: 'qwen3.5-4b',
    builtinGpu: true,
    lmUrl: 'http://localhost:1234',
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
    contextLength: 8192,
    historyLimit: 10,
    weeklyGoal: 5,
    checkUpdates: true,
  },
  general: { chat: [], documents: [] },
  // For sync (lib/merge.js): when each profile/settings field last changed, and what was deleted when.
  stamps: { profile: {}, settings: {} },
  deleted: {},
};

const KEEP_UPGRADE_BACKUPS = 5;

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// A damaged data file (e.g. the PC lost power mid-save) is set aside and the last backup restored.
function loadOrRecover(file) {
  try {
    return { loaded: readJson(file), recovery: null };
  } catch (e) {
    const damaged = file.replace(/\.json$/, `.damaged-${Date.now()}.json`);
    fs.renameSync(file, damaged);
    const backup = file.replace(/\.json$/, '.backup.json');
    try {
      const loaded = readJson(backup);
      fs.copyFileSync(backup, file);
      return { loaded, recovery: { restored: true, backupDate: fs.statSync(backup).mtime.toISOString(), damaged, error: e.message } };
    } catch {
      return { loaded: null, recovery: { restored: false, damaged, error: e.message } };
    }
  }
}

// How long another computer's "I have this data open" note counts as current.
const OPEN_ELSEWHERE_MS = 3 * 60 * 1000;
const HOST = os.hostname();

export function createStore(initialFile, { appVersion, onExternalChange, onSave } = {}) {
  let file = initialFile;
  let db = structuredClone(DEFAULTS);
  let recovery = null;
  let written = null; // { mtimeMs, size } of our last write, to tell our saves from a sync client's

  function open(target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) return null;
    const result = loadOrRecover(target);
    if (result.loaded) {
      // Keep one rolling backup from the previous start.
      if (!result.recovery) fs.copyFileSync(target, target.replace(/\.json$/, '.backup.json'));
      // The first start of a new version also keeps a permanent copy of the data from before the update.
      if (appVersion && result.loaded.appVersion !== appVersion) {
        fs.copyFileSync(target, target.replace(/\.json$/, `.before-${appVersion}.json`));
        pruneUpgradeBackups(target);
      }
    }
    return result;
  }

  function keepLocalSettings(next) {
    for (const k of LOCAL_SETTINGS) next.settings[k] = db.settings[k];
    return next;
  }

  function stat(f) {
    try { const s = fs.statSync(f); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; }
  }
  const changedOnDisk = () => {
    const s = stat(file);
    return Boolean(s && written && (s.mtimeMs !== written.mtimeMs || s.size !== written.size));
  };

  // A sync client (OneDrive, Google Drive, Dropbox…) replaced the file: load the new version.
  // Everything here is saved as soon as it changes, so nothing in memory is lost by reloading.
  function checkForExternalChange() {
    if (!changedOnDisk()) return;
    let loaded;
    try { loaded = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; } // mid-write; try next time
    db = keepLocalSettings({ ...merge(loaded), appVersion: db.appVersion });
    written = stat(file);
    console.log('Data file changed on disk (synced from another computer?); reloaded it');
    onExternalChange?.();
  }
  const watcher = setInterval(checkForExternalChange, 4000);
  watcher.unref();

  function merge(loaded) {
    return {
      ...structuredClone(DEFAULTS),
      ...loaded,
      profile: { ...DEFAULTS.profile, ...loaded.profile },
      settings: { ...DEFAULTS.settings, ...loaded.settings },
      general: { ...structuredClone(DEFAULTS.general), ...loaded.general },
      stamps: { profile: { ...loaded.stamps?.profile }, settings: { ...loaded.stamps?.settings } },
      deleted: { ...loaded.deleted },
      jobs: Array.isArray(loaded.jobs) ? loaded.jobs : [],
    };
  }

  function save() {
    // Changed by a sync client since we last wrote it, and not reloaded yet: keep that version too.
    if (changedOnDisk()) {
      const copy = file.replace(/\.json$/, `.conflict-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      try { fs.copyFileSync(file, copy); console.warn(`Data file changed on disk before a save; kept it as ${copy}`); } catch { /* best effort */ }
    }
    const json = JSON.stringify(db, null, 2);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, json);
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows can refuse the rename if something holds the file open.
      fs.writeFileSync(file, json);
      fs.rmSync(tmp, { force: true });
    }
    written = stat(file);
    onSave?.();
  }

  // Use the data file in another folder. With keepCurrent, this computer's data is written there
  // (replacing any file there); otherwise the data already in that folder is loaded.
  function switchTo(newFile, { keepCurrent }) {
    const previous = { file, db, written };
    try {
      if (keepCurrent) {
        fs.mkdirSync(path.dirname(newFile), { recursive: true });
        if (fs.existsSync(newFile)) fs.copyFileSync(newFile, newFile.replace(/\.json$/, `.replaced-${Date.now()}.json`));
        file = newFile;
        written = null;
        save();
      } else {
        const result = open(newFile);
        if (!result?.loaded) throw new Error('The data file in that folder could not be read.');
        file = newFile;
        db = keepLocalSettings({ ...merge(result.loaded), appVersion: db.appVersion });
        written = null;
        save();
      }
    } catch (e) {
      ({ file, db, written } = previous);
      throw e;
    }
  }

  // Load the data at startup.
  const first = open(file);
  if (first) {
    recovery = first.recovery;
    if (first.loaded) db = merge(first.loaded);
  }
  if (appVersion && db.appVersion !== appVersion) db.appVersion = appVersion;
  save();

  // ---------- "is this data open on another computer?" (for data folders shared by a sync client) ----------
  const lockFile = () => path.join(path.dirname(file), 'open-on.json');
  function touchLock() {
    try { fs.writeFileSync(lockFile(), JSON.stringify({ host: HOST, at: new Date().toISOString() })); } catch { /* read-only folder */ }
  }
  function openElsewhere() {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
      return lock.host !== HOST && Date.now() - Date.parse(lock.at) < OPEN_ELSEWHERE_MS ? lock.host : null;
    } catch { return null; }
  }
  let elsewhereAtStart = openElsewhere();
  touchLock();
  setInterval(touchLock, 60 * 1000).unref();
  process.on('exit', () => {
    try { if (JSON.parse(fs.readFileSync(lockFile(), 'utf8')).host === HOST) fs.rmSync(lockFile()); } catch { /* gone */ }
  });

  return {
    get db() { return db; },
    get file() { return file; },
    recovery,
    replace(next) { db = { ...merge(next), appVersion: db.appVersion }; save(); },
    save,
    switchTo(newFile, opts) {
      try { if (JSON.parse(fs.readFileSync(lockFile(), 'utf8')).host === HOST) fs.rmSync(lockFile()); } catch { /* none */ }
      switchTo(newFile, opts);
      elsewhereAtStart = openElsewhere();
      touchLock();
    },
    // Another computer that had this data open when the app started (or switched folder), if any.
    openElsewhere: () => elsewhereAtStart,
    id: () => crypto.randomUUID(),
  };
}
