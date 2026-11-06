import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSea, getAsset } from 'node:sea';
import { createStore, STATUSES } from './lib/store.js';
import { buildSystemPrompt, extractJobFields, streamChat, stripThinking, usesBuiltin } from './lib/llm.js';
import * as lms from './lib/lms.js';
import * as engine from './lib/engine.js';
import { createUpdater } from './lib/updater.js';
import { logToFile, openAppWindow, openUrl, showErrorWindow } from './lib/desktop.js';
import { extractDocumentText } from './lib/extract.js';
import pkg from './package.json' with { type: 'json' };

// Packaged as an .exe, the web files are embedded assets and data lives in the user's profile.
const PACKAGED = isSea();
const ROOT = PACKAGED ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.JSD_DATA_DIR || (PACKAGED
  ? path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Job Search Dashboard')
  : path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT) || 5177;
const HOST = process.env.HOST || '127.0.0.1';
const LOG_FILE = path.join(DATA_DIR, 'app.log');
// The app window's browser profile: machine-local, separate from the user's own browser.
const WINDOW_PROFILE = path.join(process.env.LOCALAPPDATA || DATA_DIR, 'Job Search Dashboard', 'Window');

// The packaged app has no console: log to a file, and explain startup failures in the app window.
let listening = false;
if (PACKAGED) {
  logToFile(LOG_FILE);
  console.log(`Starting Job Search Dashboard ${pkg.version}`);
  process.on('uncaughtException', (e) => {
    console.error(e);
    if (!listening) showErrorWindow(e.message, { host: HOST, port: PORT, profileDir: WINDOW_PROFILE, logFile: LOG_FILE });
  });
}

// The data can live in another folder (e.g. one synced by OneDrive or Google Drive). That choice is kept
// in a small pointer file in the default folder, which always stays on this computer.
const LOCATION_FILE = path.join(DATA_DIR, 'location.json');
// Windows paths are case-insensitive and may use either slash.
const samePath = (a, b) => {
  const n = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
};
let locationProblem = null; // the chosen folder, when it couldn't be reached at startup

function chosenDataDir() {
  try {
    const { dataDir } = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8'));
    if (!dataDir) return null;
    if (fs.existsSync(dataDir)) return dataDir;
    locationProblem = dataDir;
    console.warn(`Data folder ${dataDir} is not available; using ${DATA_DIR} for now`);
  } catch { /* no custom folder */ }
  return null;
}

const DB_FILE = process.env.DB_FILE || path.join(chosenDataDir() || DATA_DIR, 'db.json');
const store = createStore(DB_FILE, { appVersion: pkg.version, onExternalChange: () => notifyPages('data-changed') });
const updater = createUpdater({
  version: pkg.version,
  repo: pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1],
  packaged: PACKAGED,
});

const JOB_FIELDS = ['title', 'company', 'location', 'workMode', 'url', 'salary', 'source', 'seniority', 'description',
  'notes', 'tags', 'appliedAt', 'matchScore', 'contact', 'nextAction', 'nextActionDate'];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- helpers ----------

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readRaw(req, limitMb = 20) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limitMb * 1024 * 1024) throw new HttpError(413, `File is too large (max ${limitMb} MB)`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function findJob(id) {
  const job = store.db.jobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, 'Job not found');
  return job;
}

// A "thread" is where chat + documents live: either a job or the general assistant.
function findThread(tid) {
  return tid === 'general' ? store.db.general : findJob(tid);
}

function jobSummary({ chat, ...job }) {
  return { ...job, chatCount: chat?.length || 0 };
}

function applyJobPatch(job, patch) {
  for (const k of JOB_FIELDS) if (k in patch) job[k] = patch[k];
  if (job.matchScore !== null && job.matchScore !== undefined && job.matchScore !== '') {
    job.matchScore = Math.max(0, Math.min(100, Math.round(Number(job.matchScore)))) || 0;
  } else {
    job.matchScore = null;
  }
  if (!Array.isArray(job.tags)) job.tags = String(job.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

  if (patch.status && patch.status !== job.status) {
    if (!STATUSES.includes(patch.status)) throw new HttpError(400, 'Unknown status');
    job.status = patch.status;
    job.history.push({ status: patch.status, at: now() });
    if (patch.status === 'applied' && !job.appliedAt) job.appliedAt = today();
  }
  job.updatedAt = now();
}

// ---------- routes ----------

const routes = [];
// { raw: true } leaves the request body unread so the handler can take it as bytes.
function route(method, pattern, handler, { raw = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, raw });
}

route('GET', '/api/bootstrap', () => ({
  jobs: store.db.jobs.map(jobSummary),
  profile: store.db.profile,
  settings: store.db.settings,
  statuses: STATUSES,
  generalDocuments: store.db.general.documents.length,
  version: pkg.version,
  dataDir: path.dirname(store.file),
  defaultDataDir: DATA_DIR,
  customDataDir: !process.env.DB_FILE && !samePath(path.dirname(store.file), DATA_DIR),
  locationProblem,
  openElsewhere: store.openElsewhere(),
  recovery: store.recovery,
}));

// ---------- data folder ----------

// Folders of the usual sync apps that exist on this computer, as one-click suggestions.
function syncFolderSuggestions() {
  const home = os.homedir();
  const candidates = [
    ['OneDrive', process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial],
    ['Google Drive', ...['G:\\My Drive', path.join(home, 'Google Drive'), path.join(home, 'My Drive')]],
    ['Dropbox', path.join(home, 'Dropbox')],
    ['iCloud Drive', path.join(home, 'iCloudDrive')],
  ];
  const out = [];
  for (const [label, ...dirs] of candidates) {
    const dir = dirs.find((d) => d && fs.existsSync(d));
    if (dir) out.push({ label, dir: path.join(dir, 'Job Search Dashboard') });
  }
  return out;
}

route('GET', '/api/data-folder', () => ({
  current: path.dirname(store.file),
  default: DATA_DIR,
  suggestions: syncFolderSuggestions(),
  locked: Boolean(process.env.DB_FILE),
}));

function resolveDataDir(dir) {
  const d = String(dir || '').trim().replace(/^"|"$/g, '');
  if (!d || !path.isAbsolute(d)) throw new HttpError(400, 'Enter a full folder path, e.g. C:\\Users\\you\\OneDrive\\Job Search Dashboard');
  return path.resolve(d);
}

// What's in a folder before switching to it.
route('POST', '/api/data-folder/check', ({ body }) => {
  const dir = resolveDataDir(body.dir);
  if (samePath(dir, path.dirname(store.file))) return { dir, same: true };
  const file = path.join(dir, 'db.json');
  if (!fs.existsSync(file)) return { dir, existing: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { dir, existing: { jobs: Array.isArray(data.jobs) ? data.jobs.length : 0, modified: fs.statSync(file).mtime.toISOString() } };
  } catch {
    return { dir, existing: { unreadable: true } };
  }
});

// mode: 'move' writes this computer's data there; 'use' switches to the data already in that folder.
route('POST', '/api/data-folder', ({ body }) => {
  if (process.env.DB_FILE) throw new HttpError(400, 'The data file is set by the DB_FILE environment variable');
  const dir = resolveDataDir(body.dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
  } catch (e) {
    throw new HttpError(400, `Can't save to that folder (${e.code || e.message}). Pick a folder you can write to.`);
  }
  store.switchTo(path.join(dir, 'db.json'), { keepCurrent: body.mode !== 'use' });
  if (samePath(dir, DATA_DIR)) fs.rmSync(LOCATION_FILE, { force: true });
  else fs.writeFileSync(LOCATION_FILE, JSON.stringify({ dataDir: dir }, null, 2));
  locationProblem = null;
  console.log(`Data folder is now ${dir}`);
  return { ok: true, dir };
});

// Windows' own folder picker (a browser page can't ask for a folder path).
route('POST', '/api/pick-folder', async () => {
  if (process.platform !== 'win32') throw new HttpError(400, 'Type the folder path instead');
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose where Job Search Dashboard keeps your data'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', '-'], { windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stdin.end(script);
  await new Promise((resolve) => { child.on('close', resolve); child.on('error', resolve); });
  return { dir: out.trim() || null };
});

// The packaged app quits when its window is closed: each open page holds this event stream,
// and the app exits once none has been connected for a little while.
const AUTO_QUIT = PACKAGED && process.env.JSD_AUTO_QUIT !== '0';
const openPages = new Set();

// Tells every open page about something (e.g. 'data-changed' after a sync client updated the data file).
function notifyPages(event) {
  for (const res of openPages) res.write(`event: ${event}
data: 1

`);
}
let quitTimer = null;

function scheduleQuit(ms) {
  if (!AUTO_QUIT) return;
  clearTimeout(quitTimer);
  quitTimer = setTimeout(() => {
    if (openPages.size || ['downloading', 'installing', 'restarting'].includes(updater.status().state)) return;
    console.log('No window open, quitting');
    process.exit(0);
  }, ms);
}

route('GET', '/api/alive', ({ res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  res.write('retry: 1000\n\n');
  openPages.add(res);
  clearTimeout(quitTimer);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => {
    clearInterval(ping);
    openPages.delete(res);
    if (!openPages.size) scheduleQuit(15000);
  });
  return undefined;
});

route('GET', '/api/update/check', async ({ req }) => {
  const force = new URL(req.url, 'http://x').searchParams.has('force');
  try {
    return await updater.check(force);
  } catch (e) {
    return { current: pkg.version, available: false, error: e.name === 'TimeoutError' ? 'Could not reach GitHub to check for updates' : e.message };
  }
});
route('POST', '/api/update/apply', () => updater.apply(restartInto));
route('GET', '/api/update/status', () => updater.status());

route('POST', '/api/open-data-folder', () => {
  const dir = path.dirname(store.file);
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [dir]]
    : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  return { ok: true };
});

route('GET', '/api/jobs', () => store.db.jobs.map(jobSummary));

route('POST', '/api/jobs', ({ body }) => {
  const status = STATUSES.includes(body.status) ? body.status : 'saved';
  const job = {
    id: store.id(), status, history: [{ status, at: now() }], tags: [], matchScore: null,
    chat: [], documents: [], createdAt: now(), updatedAt: now(),
  };
  applyJobPatch(job, { ...body, status: undefined });
  if (status === 'applied' && !job.appliedAt) job.appliedAt = today();
  store.db.jobs.unshift(job);
  store.save();
  return job;
});

route('GET', '/api/jobs/:id', ({ params }) => findJob(params.id));

route('PUT', '/api/jobs/:id', ({ params, body }) => {
  const job = findJob(params.id);
  applyJobPatch(job, body);
  store.save();
  return job;
});

route('DELETE', '/api/jobs/:id', ({ params }) => {
  findJob(params.id);
  store.db.jobs = store.db.jobs.filter((j) => j.id !== params.id);
  store.save();
  return { ok: true };
});

route('GET', '/api/threads/:tid', ({ params }) => {
  const t = findThread(params.tid);
  return { chat: t.chat, documents: t.documents };
});

route('DELETE', '/api/threads/:tid/chat', ({ params }) => {
  findThread(params.tid).chat = [];
  store.save();
  return { ok: true };
});

route('POST', '/api/threads/:tid/documents', ({ params, body }) => {
  const t = findThread(params.tid);
  const doc = {
    id: store.id(), type: body.type || 'other', title: body.title || 'Untitled document',
    content: body.content || '', createdAt: now(), updatedAt: now(),
  };
  t.documents.unshift(doc);
  store.save();
  return doc;
});

route('PUT', '/api/threads/:tid/documents/:docId', ({ params, body }) => {
  const doc = findThread(params.tid).documents.find((d) => d.id === params.docId);
  if (!doc) throw new HttpError(404, 'Document not found');
  for (const k of ['type', 'title', 'content']) if (k in body) doc[k] = body[k];
  doc.updatedAt = now();
  store.save();
  return doc;
});

route('DELETE', '/api/threads/:tid/documents/:docId', ({ params }) => {
  const t = findThread(params.tid);
  t.documents = t.documents.filter((d) => d.id !== params.docId);
  store.save();
  return { ok: true };
});

// Reads a PDF / Word / text file sent as the raw request body; the name comes in X-Filename.
route('POST', '/api/extract-text', async ({ req }) => {
  const buffer = await readRaw(req);
  if (!buffer.length) throw new HttpError(400, 'The file is empty');
  const filename = decodeURIComponent(req.headers['x-filename'] || '');
  return extractDocumentText(buffer, filename);
}, { raw: true });

route('PUT', '/api/profile', ({ body }) => {
  for (const k of Object.keys(store.db.profile)) if (k in body) store.db.profile[k] = String(body[k] ?? '');
  store.save();
  return store.db.profile;
});

route('PUT', '/api/settings', ({ body }) => {
  const s = store.db.settings;
  const before = { engine: s.engine, builtinModel: s.builtinModel, builtinGpu: s.builtinGpu, contextLength: s.contextLength };
  if ('engine' in body) {
    if (!['builtin', 'lmstudio'].includes(body.engine)) throw new HttpError(400, 'Unknown AI engine');
    s.engine = body.engine;
  }
  if ('builtinModel' in body) s.builtinModel = engine.findModel(body.builtinModel).id;
  if ('builtinGpu' in body) s.builtinGpu = body.builtinGpu === true || body.builtinGpu === 'on';
  if ('lmUrl' in body) s.lmUrl = String(body.lmUrl).trim() || 'http://localhost:1234';
  if ('model' in body) s.model = String(body.model || '');
  if ('checkUpdates' in body) s.checkUpdates = body.checkUpdates === true || body.checkUpdates === 'on';
  for (const k of ['temperature', 'maxTokens', 'historyLimit', 'weeklyGoal', 'contextLength']) {
    if (k in body && body[k] !== '' && !Number.isNaN(Number(body[k]))) s[k] = Number(body[k]);
  }
  store.save();
  // Free the memory when switching to LM Studio; restart with the new options otherwise.
  if (before.engine === 'builtin' && s.engine !== 'builtin') engine.stop();
  else if (s.engine === 'builtin' && ['engine', 'builtinModel', 'builtinGpu', 'contextLength'].some((k) => before[k] !== s[k])) warmUpEngine(true);
  return s;
});

// Starts the built-in AI in the background so the first request doesn't wait for the model to load.
function warmUpEngine(restart = false) {
  const s = store.db.settings;
  if (!usesBuiltin(s) || !engine.isReady(s.builtinModel)) return;
  (restart ? engine.stop() : Promise.resolve()).then(() => engine.ensureRunning(s)).catch((e) => console.warn('Built-in AI:', e.message));
}

route('GET', '/api/engine/status', () => engine.status());
route('POST', '/api/engine/install', ({ body }) => {
  const s = store.db.settings;
  const model = engine.findModel(body.model || s.builtinModel).id;
  const d = engine.install(model);
  // Once it's downloaded, use it and start it.
  const wait = setInterval(() => {
    if (d.state === 'running') return;
    clearInterval(wait);
    if (d.state === 'done' && s.builtinModel === model) warmUpEngine();
  }, 1000);
  return d;
});
route('POST', '/api/engine/cancel', () => engine.cancelInstall() || {});
route('POST', '/api/engine/remove', ({ body }) => engine.removeModel(body.model));
route('POST', '/api/engine/restart', ({ body }) => {
  if (body.retryGpu) engine.resetGpuHint();
  warmUpEngine(true);
  return { ok: true };
});

route('GET', '/api/export', () => store.db);

route('POST', '/api/import', ({ body }) => {
  if (!body || !Array.isArray(body.jobs)) throw new HttpError(400, 'Not a job search export file');
  // How the AI runs belongs to this computer: keep it unless the backup has its own choice.
  const { engine: eng, builtinModel, builtinGpu } = store.db.settings;
  if (!body.settings?.engine) body.settings = { ...body.settings, engine: eng, builtinModel, builtinGpu };
  store.replace(body);
  return { ok: true, jobs: store.db.jobs.length };
});

route('GET', '/api/lms/status', async () => {
  const models = await lms.serverModels(store.db.settings);
  return {
    running: models !== null,
    models: (models || []).filter((m) => m.type !== 'embeddings'),
    disk: models === null ? lms.diskModels() : [],
    cli: Boolean(lms.cliPath()),
    app: Boolean(lms.appPath()),
    job: lms.currentJob(),
  };
});

route('POST', '/api/lms/start', () => lms.startServer(store.db.settings));
route('POST', '/api/lms/stop', () => lms.stopServer());
route('POST', '/api/lms/unload', () => lms.unloadAll());
route('POST', '/api/lms/load', ({ body }) => {
  const model = String(body.model || '').trim();
  if (!model) throw new HttpError(400, 'Choose a model to load');
  return lms.loadModel(store.db.settings, model, { unloadOthers: body.unloadOthers !== false });
});

route('POST', '/api/llm/extract', async ({ body }) => {
  if (!body.description?.trim()) throw new HttpError(400, 'Paste a job description first');
  try {
    return await extractJobFields(store.db.settings, body.description);
  } catch (e) {
    throw new HttpError(502, e.message);
  }
});

// Streams the assistant reply as plain text, then stores the exchange in the thread.
route('POST', '/api/llm/chat', async ({ body, res }) => {
  const tid = body.threadId || 'general';
  const thread = findThread(tid);
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw new HttpError(400, 'Empty prompt');

  const { settings, profile, jobs } = store.db;
  const system = buildSystemPrompt({ profile, job: tid === 'general' ? null : thread, jobs });
  const history = thread.chat.slice(-Math.max(0, settings.historyLimit || 0))
    .map(({ role, content }) => ({ role, content }));
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }];

  const upstream = new AbortController();
  res.on('close', () => { if (!res.writableFinished) upstream.abort(); });

  let started = false;
  let full = '';
  let error = null;
  try {
    full = await streamChat(settings, messages, {
      signal: upstream.signal,
      onDelta: (d) => {
        if (!started) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          started = true;
        }
        full += d;
        if (!res.destroyed) res.write(d);
      },
    });
  } catch (e) {
    error = e;
  }

  const reply = stripThinking(full);
  if (reply) {
    thread.chat.push(
      { role: 'user', content: prompt, label: body.label || null, at: now() },
      { role: 'assistant', content: reply + (error && upstream.signal.aborted ? '\n\n_(stopped)_' : ''), action: body.action || null, at: now() },
    );
    store.save();
  }

  if (!started) {
    const unreachable = error?.cause?.code === 'ECONNREFUSED' || error?.message === 'fetch failed';
    const msg = !unreachable ? error?.message || 'The model returned an empty response'
      : usesBuiltin(settings) ? 'The built-in AI stopped responding. Try again; it restarts by itself.'
        : `Could not reach LM Studio at ${settings.lmUrl}. Click "Start LM Studio" in the sidebar.`;
    throw new HttpError(502, msg);
  }
  if (error && !upstream.signal.aborted && !res.destroyed) res.write(`\n\n**Error:** ${error.message}`);
  res.end();
  return undefined;
});

// ---------- server ----------

function serveAsset(req, res) {
  const name = new URL(req.url, 'http://x').pathname.slice(1) || 'index.html';
  let data;
  try { data = Buffer.from(getAsset(name)); } catch { data = null; }
  const type = data ? MIME[path.extname(name)] || 'application/octet-stream' : MIME['.html'];
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(data || Buffer.from(getAsset('index.html'))); // SPA fallback
}

function serveStatic(req, res) {
  if (PACKAGED) return serveAsset(req, res);
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/api/')) return serveStatic(req, res);

  const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
  if (!r) return send(res, 404, { error: 'Not found' });
  const m = pathname.match(r.re);
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  try {
    const body = !r.raw && ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const result = await r.handler({ req, res, params, body });
    if (result !== undefined) send(res, 200, result);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

const APP_URL = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;

const shouldOpen = PACKAGED ? process.env.OPEN_BROWSER !== '0' : process.env.OPEN_BROWSER === '1';
const AFTER_UPDATE = process.env.JSD_AFTER_UPDATE === '1';

// The .exe opens its own app window; from source, the default browser.
function openWindow() {
  if (PACKAGED) openAppWindow(APP_URL, WINDOW_PROFILE);
  else openUrl(APP_URL);
}

// Called by the updater once the new exe is in place: free the port, start the new version, exit.
// The open window reconnects to the new version by itself.
function restartInto(exe) {
  server.close();
  server.closeAllConnections();
  spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, JSD_AFTER_UPDATE: '1', OPEN_BROWSER: '0' },
  }).unref();
  setTimeout(() => process.exit(0), 300);
}

let listenRetries = 0;
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Right after an update the previous version may still be releasing the port.
  if (AFTER_UPDATE && listenRetries++ < 20) {
    setTimeout(() => server.listen(PORT, HOST), 500);
    return;
  }
  // Most likely the app is already running (e.g. its icon was double-clicked again): show another window.
  console.log(`Job Search Dashboard is already running at ${APP_URL}`);
  if (shouldOpen) openWindow();
  setTimeout(() => process.exit(0), PACKAGED ? 3000 : 0);
});

server.listen(PORT, HOST, () => {
  listening = true;
  console.log(`Job Search Dashboard ${pkg.version} running at ${APP_URL}`);
  console.log(`Data: ${path.dirname(store.file)} | AI: ${store.db.settings.engine || 'not chosen yet'}${store.db.settings.engine === 'lmstudio' ? ` at ${store.db.settings.lmUrl}` : ''}`);
  if (store.recovery) console.warn('Data file was damaged:', store.recovery);
  if (shouldOpen && !AFTER_UPDATE) openWindow();
  // If no window ever connects (e.g. it failed to open), don't linger in the background.
  scheduleQuit(AFTER_UPDATE ? 60000 : 120000);
  setTimeout(updater.cleanup, 3000);
  warmUpEngine();
});
