import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSea, getAsset } from 'node:sea';
import { createStore, STATUSES } from './lib/store.js';
import { buildSystemPrompt, extractJobFields, streamChat, stripThinking } from './lib/llm.js';
import * as lms from './lib/lms.js';
import { createUpdater } from './lib/updater.js';
import pkg from './package.json' with { type: 'json' };

// Packaged as an .exe, the web files are embedded assets and data lives in the user's profile.
const PACKAGED = isSea();
const ROOT = PACKAGED ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = PACKAGED
  ? path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Job Search Dashboard')
  : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 5177;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'db.json');
const store = createStore(DB_FILE, { appVersion: pkg.version });
const updater = createUpdater({
  version: pkg.version,
  repo: pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1],
  packaged: PACKAGED,
});

const JOB_FIELDS = ['title', 'company', 'location', 'workMode', 'url', 'salary', 'source', 'seniority', 'description',
  'notes', 'tags', 'appliedAt', 'matchScore', 'contact', 'nextAction', 'nextActionDate'];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

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

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
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
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/bootstrap', () => ({
  jobs: store.db.jobs.map(jobSummary),
  profile: store.db.profile,
  settings: store.db.settings,
  statuses: STATUSES,
  generalDocuments: store.db.general.documents.length,
  version: pkg.version,
  dataDir: path.dirname(DB_FILE),
}));

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
  const dir = path.dirname(DB_FILE);
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

route('PUT', '/api/profile', ({ body }) => {
  for (const k of Object.keys(store.db.profile)) if (k in body) store.db.profile[k] = String(body[k] ?? '');
  store.save();
  return store.db.profile;
});

route('PUT', '/api/settings', ({ body }) => {
  const s = store.db.settings;
  if ('lmUrl' in body) s.lmUrl = String(body.lmUrl).trim() || 'http://localhost:1234';
  if ('model' in body) s.model = String(body.model || '');
  if ('checkUpdates' in body) s.checkUpdates = body.checkUpdates === true || body.checkUpdates === 'on';
  for (const k of ['temperature', 'maxTokens', 'historyLimit', 'weeklyGoal', 'contextLength']) {
    if (k in body && body[k] !== '' && !Number.isNaN(Number(body[k]))) s[k] = Number(body[k]);
  }
  store.save();
  return s;
});

route('GET', '/api/export', () => store.db);

route('POST', '/api/import', ({ body }) => {
  if (!body || !Array.isArray(body.jobs)) throw new HttpError(400, 'Not a job search export file');
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
    const msg = error?.cause?.code === 'ECONNREFUSED' || error?.message === 'fetch failed'
      ? `Could not reach LM Studio at ${settings.lmUrl}. Click "Start LM Studio" in the sidebar.`
      : error?.message || 'The model returned an empty response';
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
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const result = await r.handler({ req, res, params, body });
    if (result !== undefined) send(res, 200, result);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

const APP_URL = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

const shouldOpen = PACKAGED ? process.env.OPEN_BROWSER !== '0' : process.env.OPEN_BROWSER === '1';
const AFTER_UPDATE = process.env.JSD_AFTER_UPDATE === '1';

// Called by the updater once the new exe is in place: free the port, start the new version, exit.
function restartInto(exe) {
  server.close();
  server.closeAllConnections();
  // `start` gives the new version its own console window, like a normal double-click.
  spawn('cmd', ['/c', 'start', '', exe], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
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
  // Most likely the dashboard is already running (e.g. the .exe was double-clicked twice).
  console.log(`Job Search Dashboard is already running at ${APP_URL}`);
  if (shouldOpen) openBrowser(APP_URL);
  setTimeout(() => process.exit(0), PACKAGED ? 3000 : 0);
});

server.listen(PORT, HOST, () => {
  if (PACKAGED) {
    process.title = 'Job Search Dashboard';
    console.log([
      '',
      '  Job Search Dashboard is running.',
      '',
      `  Open it in your browser:  ${APP_URL}`,
      `  Your data is saved in:    ${DATA_DIR}`,
      '',
      '  Keep this window open while you use the dashboard.',
      '  Close it to stop the dashboard.',
      '',
    ].join('\n'));
  } else {
    console.log(`Job search dashboard → ${APP_URL}`);
    console.log(`LM Studio endpoint     → ${store.db.settings.lmUrl}`);
  }
  if (shouldOpen && !AFTER_UPDATE) openBrowser(APP_URL);
  setTimeout(updater.cleanup, 3000);
});
