// Merges two copies of the data (this computer's and the one synced through Google Drive) item by item,
// so edits made on different computers are all kept. The merge gives the same result whichever copy
// is "local", and merging again changes nothing, so it's safe to repeat after any interruption.
//
// What tells which change is newer:
//   jobs, documents        their updatedAt
//   chat messages          kept from both copies (a "clear chat" removes messages older than chatClearedAt)
//   profile / settings     a time per field, in db.stamps.profile / db.stamps.settings
//   deletions              db.deleted[id] = when it was deleted; it wins over edits made before that

// Settings that describe this computer, not the job search: never synced.
export const LOCAL_SETTINGS = ['engine', 'builtinModel', 'builtinGpu', 'lmUrl', 'model', 'contextLength'];

const KEEP_DELETIONS_DAYS = 90;
const maxTime = (a, b) => (!a ? b || '' : !b ? a : a > b ? a : b);

// Deterministic choice between two versions with the same time, so both computers pick the same one.
function tieBreak(a, b) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return sa.length !== sb.length ? (sa.length > sb.length ? a : b) : sa >= sb ? a : b;
}

function newer(a, b, time) {
  if (!a) return b;
  if (!b) return a;
  const ta = time(a) || '';
  const tb = time(b) || '';
  return ta === tb ? tieBreak(a, b) : ta > tb ? a : b;
}

function mergeDeleted(a = {}, b = {}, now = new Date()) {
  const out = {};
  const cutoff = new Date(now.getTime() - KEEP_DELETIONS_DAYS * 86400000).toISOString();
  for (const [id, at] of [...Object.entries(a), ...Object.entries(b)]) {
    const t = maxTime(out[id], at);
    if (t >= cutoff) out[id] = t;
  }
  return out;
}

const isDeleted = (item, deleted) => Boolean(deleted[item.id] && deleted[item.id] >= (item.updatedAt || ''));

function mergeById(a = [], b = [], deleted, combine) {
  const byId = new Map();
  for (const item of a) byId.set(item.id, [item, null]);
  for (const item of b) byId.set(item.id, [byId.get(item.id)?.[0] || null, item]);
  const out = [];
  for (const [x, y] of byId.values()) {
    const merged = combine(x, y);
    if (!isDeleted(merged, deleted)) out.push(merged);
  }
  return out;
}

function mergeDocuments(a, b, deleted) {
  return mergeById(a, b, deleted, (x, y) => newer(x, y, (d) => d.updatedAt))
    .sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || '') || x.id.localeCompare(y.id));
}

// Chat messages have no ids: the same message is recognised by its time, role and text.
const messageKey = (m) => `${m.at}|${m.role}|${m.content}`;

function mergeChat(a = [], b = [], clearedAt = '') {
  const seen = new Map();
  for (const m of [...a, ...b]) if (!clearedAt || (m.at || '') > clearedAt) seen.set(messageKey(m), m);
  // Keep the order messages were written in; a user message and its reply share a time, user first.
  const order = { user: 0, assistant: 1 };
  return [...seen.values()].sort((x, y) => (x.at || '').localeCompare(y.at || '') || (order[x.role] ?? 2) - (order[y.role] ?? 2));
}

// A thread is a job or the general assistant: its own chat and documents.
function mergeThread(x, y, deleted) {
  const chatClearedAt = maxTime(x?.chatClearedAt, y?.chatClearedAt);
  return {
    chat: mergeChat(x?.chat, y?.chat, chatClearedAt),
    documents: mergeDocuments(x?.documents, y?.documents, deleted),
    ...(chatClearedAt ? { chatClearedAt } : {}),
  };
}

function mergeJobs(a, b, deleted) {
  return mergeById(a, b, deleted, (x, y) => ({ ...newer(x, y, (j) => j.updatedAt), ...mergeThread(x, y, deleted) }))
    .sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || '') || x.id.localeCompare(y.id));
}

// Fields with a change time each; a field never edited since stamps were added counts as oldest.
function mergeFields(a = {}, b = {}, stampsA = {}, stampsB = {}, skip = []) {
  const values = {};
  const stamps = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.includes(k)) continue;
    const ta = stampsA[k] || '';
    const tb = stampsB[k] || '';
    const fromA = !(k in b) || (k in a && (ta === tb ? tieBreak(a[k], b[k]) === a[k] : ta > tb));
    values[k] = fromA ? a[k] : b[k];
    const t = maxTime(ta, tb);
    if (t) stamps[k] = t;
  }
  return { values, stamps };
}

/*
 * local, remote: whole data objects. Returns the merged data, keeping this computer's own
 * settings (LOCAL_SETTINGS) and appVersion from `local`.
 */
export function mergeData(local, remote, { now = new Date() } = {}) {
  if (!remote) return local;
  const deleted = mergeDeleted(local.deleted, remote.deleted, now);
  const profile = mergeFields(local.profile, remote.profile, local.stamps?.profile, remote.stamps?.profile);
  const settings = mergeFields(local.settings, remote.settings, local.stamps?.settings, remote.stamps?.settings, LOCAL_SETTINGS);
  for (const k of LOCAL_SETTINGS) if (k in (local.settings || {})) settings.values[k] = local.settings[k];
  return {
    ...remote,
    ...local,
    jobs: mergeJobs(local.jobs, remote.jobs, deleted),
    profile: profile.values,
    settings: settings.values,
    general: { ...remote.general, ...local.general, ...mergeThread(local.general, remote.general, deleted) },
    stamps: { profile: profile.stamps, settings: settings.stamps },
    deleted,
  };
}

// The parts that are synced, in a stable form: equal for two copies that hold the same data.
export function syncedContent(db) {
  const settings = { ...db.settings };
  for (const k of LOCAL_SETTINGS) delete settings[k];
  return JSON.stringify({ jobs: db.jobs, profile: db.profile, settings, general: db.general, stamps: db.stamps, deleted: db.deleted });
}
