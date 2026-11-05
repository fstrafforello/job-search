import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

export function createStore(file, { appVersion } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = structuredClone(DEFAULTS);
  let recovery = null;

  if (fs.existsSync(file)) {
    const result = loadOrRecover(file);
    recovery = result.recovery;
    if (result.loaded) {
      const { loaded } = result;
      db = merge(loaded);
      // Keep one rolling backup from the previous start.
      if (!recovery) fs.copyFileSync(file, file.replace(/\.json$/, '.backup.json'));
      // The first start of a new version also keeps a permanent copy of the data from before the update.
      if (appVersion && loaded.appVersion !== appVersion) {
        fs.copyFileSync(file, file.replace(/\.json$/, `.before-${appVersion}.json`));
        pruneUpgradeBackups(file);
      }
    }
  }
  if (appVersion && db.appVersion !== appVersion) {
    db.appVersion = appVersion;
    save();
  }

  function merge(loaded) {
    return {
      ...structuredClone(DEFAULTS),
      ...loaded,
      profile: { ...DEFAULTS.profile, ...loaded.profile },
      settings: { ...DEFAULTS.settings, ...loaded.settings },
      general: { ...structuredClone(DEFAULTS.general), ...loaded.general },
      jobs: Array.isArray(loaded.jobs) ? loaded.jobs : [],
    };
  }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows can refuse the rename if something holds the file open.
      fs.writeFileSync(file, JSON.stringify(db, null, 2));
      fs.rmSync(tmp, { force: true });
    }
  }

  return {
    get db() { return db; },
    recovery,
    replace(next) { db = { ...merge(next), appVersion: db.appVersion }; save(); },
    save,
    id: () => crypto.randomUUID(),
  };
}
