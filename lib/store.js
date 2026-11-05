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

export function createStore(file, { appVersion } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = structuredClone(DEFAULTS);

  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    db = merge(loaded);
    // Keep one rolling backup from the previous start.
    fs.copyFileSync(file, file.replace(/\.json$/, '.backup.json'));
    // The first start of a new version also keeps a permanent copy of the data from before the update.
    if (appVersion && loaded.appVersion !== appVersion) {
      fs.copyFileSync(file, file.replace(/\.json$/, `.before-${appVersion}.json`));
      pruneUpgradeBackups(file);
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
    replace(next) { db = { ...merge(next), appVersion: db.appVersion }; save(); },
    save,
    id: () => crypto.randomUUID(),
  };
}
