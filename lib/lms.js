// Controls the LM Studio app/server through its `lms` CLI, and reports server + model state.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cliPath() {
  const exe = IS_WIN ? 'lms.exe' : 'lms';
  const candidates = [
    process.env.LMS_CLI,
    path.join(HOME, '.lmstudio', 'bin', exe),
    path.join(HOME, '.cache', 'lm-studio', 'bin', exe),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function appPath() {
  const candidates = IS_WIN
    ? [process.env.LMSTUDIO_APP, path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio', 'LM Studio.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LM Studio', 'LM Studio.exe')]
    : process.platform === 'darwin'
      ? [process.env.LMSTUDIO_APP, '/Applications/LM Studio.app', path.join(HOME, 'Applications', 'LM Studio.app')]
      : [process.env.LMSTUDIO_APP];
  return candidates.filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

function root(settings) {
  return settings.lmUrl.replace(/\/+$/, '').replace(/\/(v1|api\/v0)$/, '');
}

function port(settings) {
  try { return new URL(root(settings)).port || '1234'; } catch { return '1234'; }
}

// Runs the CLI and resolves with its exit code and combined output (never rejects).
function run(args, timeoutMs) {
  const cli = cliPath();
  if (!cli) return Promise.resolve({ code: -1, out: 'LM Studio CLI (lms) not found' });
  return new Promise((resolve) => {
    const child = spawn(cli, args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); out += '\nTimed out'; }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }); });
  });
}

const lastLine = (out) => out.trim().split(/\r?\n/).filter(Boolean).pop() || '';

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(1500);
  }
  return false;
}

// Returns [{ id, type, state, ctx }] from the running server, or null when it is unreachable.
export async function serverModels(settings) {
  const base = root(settings);
  try {
    const res = await fetch(`${base}/api/v0/models`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const { data = [] } = await res.json();
      return data.map((m) => ({ id: m.id, type: m.type, state: m.state, ctx: m.max_context_length || null }));
    }
  } catch { /* fall through to the OpenAI endpoint */ }
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const { data = [] } = await res.json();
    return data.map((m) => ({ id: m.id, type: /embed/i.test(m.id) ? 'embeddings' : 'llm', state: 'unknown', ctx: null }));
  } catch {
    return null;
  }
}

// Models downloaded to disk, for display while the server is off.
export function diskModels() {
  const dir = process.env.LMSTUDIO_MODELS_DIR || path.join(HOME, '.lmstudio', 'models');
  const found = [];
  const ls = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
  for (const pub of ls(dir).filter((d) => d.isDirectory())) {
    for (const repo of ls(path.join(dir, pub.name)).filter((d) => d.isDirectory())) {
      const files = ls(path.join(dir, pub.name, repo.name)).map((f) => f.name);
      const isModel = files.some((f) => (f.endsWith('.gguf') && !f.startsWith('mmproj')) || f.endsWith('.safetensors'));
      if (isModel && !/embed/i.test(repo.name)) found.push(`${pub.name}/${repo.name}`);
    }
  }
  return found;
}

// ---------- long-running actions, one at a time ----------

let job = null;

export function currentJob() {
  return job;
}

function startJob(action, fn) {
  if (job?.state === 'running') {
    const err = new Error(`Busy: ${job.action} is still running`);
    err.status = 409;
    throw err;
  }
  job = { action, state: 'running', log: [], message: '', startedAt: new Date().toISOString() };
  const current = job;
  const log = (m) => { if (m) current.log.push(m); };
  fn(log).then(
    (message) => { current.state = 'done'; current.message = message || 'Done'; },
    (e) => { current.state = 'error'; current.message = e.message; },
  );
  return job;
}

function launchApp(app) {
  const child = process.platform === 'darwin'
    ? spawn('open', ['-a', app], { detached: true, stdio: 'ignore' })
    : spawn(app, [], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function startServer(settings) {
  return startJob('start', async (log) => {
    const up = async () => (await serverModels(settings)) !== null;
    if (await up()) return 'LM Studio server is already running';

    const cli = cliPath();
    const app = appPath();
    if (!cli && !app) throw new Error('LM Studio is not installed (neither the app nor the lms CLI was found).');

    if (cli) {
      log('Starting the LM Studio server…');
      const r = await run(['server', 'start', '--port', port(settings)], 75000);
      if (r.code === 0 && await waitFor(up, 10000)) return `Server running on port ${port(settings)}`;
      log(lastLine(r.out));
    }
    if (!app) throw new Error('The lms CLI could not start the server and the LM Studio app was not found.');

    log('Opening the LM Studio app…');
    launchApp(app);
    if (cli) {
      await sleep(6000);
      log('Starting the server…');
      await run(['server', 'start', '--port', port(settings)], 90000);
    }
    if (await waitFor(up, 45000)) return `Server running on port ${port(settings)}`;
    throw new Error('LM Studio opened but its server did not start. In LM Studio, open the Developer tab and turn the server on.');
  });
}

export function stopServer() {
  return startJob('stop', async () => {
    const r = await run(['server', 'stop'], 30000);
    if (r.code !== 0) throw new Error(lastLine(r.out) || 'Could not stop the server');
    return 'Server stopped';
  });
}

export function loadModel(settings, model, { unloadOthers = true } = {}) {
  return startJob('load', async (log) => {
    if (!cliPath()) throw new Error('The lms CLI is needed to load models. Load it in the LM Studio app instead.');
    if (unloadOthers) {
      log('Unloading other models…');
      await run(['unload', '--all'], 60000);
    }
    log(`Loading ${model}… (large models can take a minute)`);
    const args = ['load', model, '-y'];
    if (Number(settings.contextLength) > 0) args.push('--context-length', String(settings.contextLength));
    const r = await run(args, 10 * 60000);
    if (r.code !== 0) throw new Error(lastLine(r.out) || `Could not load ${model}`);
    return `${model} loaded`;
  });
}

export function unloadAll() {
  return startJob('unload', async () => {
    const r = await run(['unload', '--all'], 60000);
    if (r.code !== 0) throw new Error(lastLine(r.out) || 'Could not unload models');
    return 'All models unloaded';
  });
}
