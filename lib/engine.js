// The built-in AI: on first use, downloads llama.cpp's llama-server and a model, then runs it on this computer.
// llama-server speaks the same OpenAI-style API as LM Studio, so lib/llm.js talks to both the same way.
// Every download is pinned to an exact file, size and SHA-256 below.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';

const LLAMA_BUILD = 'b12110'; // llama.cpp v0.9.0 (2026-11-04)
const RUNTIMES = {
  // Vulkan uses NVIDIA, AMD and Intel graphics cards without extra drivers, and falls back to the CPU.
  vulkan: { file: `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`, size: 37661146, sha256: '9732a5e48887ca54d0bfe4af4324dc85fd56cd8cda19b52df3542fa6ebe6874f' },
  // CPU-only build, used if the Vulkan one can't start (e.g. a broken graphics driver).
  cpu: { file: `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`, size: 24708445, sha256: '98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2' },
};
const runtimeUrl = (r) => `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${r.file}`;

// Both Apache 2.0 (Qwen/Qwen3.5-4B and Qwen/Qwen3.5-2B), Q4_K_M quantizations by lmstudio-community.
export const MODELS = [
  {
    id: 'qwen3.5-4b', name: 'Qwen3.5 4B', tier: 'Standard', license: 'Apache 2.0',
    description: 'Best writing quality. Needs about 8 GB of memory (RAM).',
    repo: 'lmstudio-community/Qwen3.5-4B-GGUF', rev: 'f9f88ac3e234be915e23811a6d28ea287bdb927e',
    file: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2707513696, sha256: '25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c',
  },
  {
    id: 'qwen3.5-2b', name: 'Qwen3.5 2B', tier: 'Light', license: 'Apache 2.0',
    description: 'Faster on older or low-memory computers (4 GB RAM), but writes less well.',
    repo: 'lmstudio-community/Qwen3.5-2B-GGUF', rev: 'bb84e11355a036e28f080c7793fa6d22b7c4e344',
    file: 'Qwen3.5-2B-Q4_K_M.gguf', size: 1270808032, sha256: '0bfe35afc9f05b7fac3fa04925e051ac7939a42a8a17ea11afc99701bea826cc',
  },
];
export const DEFAULT_MODEL = MODELS[0].id;
const modelUrl = (m) => `https://huggingface.co/${m.repo}/resolve/${m.rev}/${m.file}`;
export const findModel = (id) => MODELS.find((m) => m.id === id) || MODELS[0];

// Machine-local and outside the data folder, so app updates and data sync never touch it.
const ROOT = process.env.JSD_ENGINE_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Job Search Dashboard', 'Built-in AI');
const BIN_DIR = path.join(ROOT, 'bin');
const MODEL_DIR = path.join(ROOT, 'models');
const STATE_FILE = path.join(ROOT, 'state.json');

export const SUPPORTED = process.platform === 'win32' && process.arch === 'x64';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runtimeDir = (backend) => path.join(BIN_DIR, `${LLAMA_BUILD}-${backend}`);
const serverExe = (backend) => path.join(runtimeDir(backend), 'llama-server.exe');
const modelPath = (m) => path.join(MODEL_DIR, m.file);
const runtimeInstalled = () => Object.keys(RUNTIMES).every((b) => fs.existsSync(serverExe(b)));
// A model file only gets its final name after its checksum matched, so existing means verified.
const modelInstalled = (m) => fs.existsSync(modelPath(m));
export const isReady = (id) => SUPPORTED && runtimeInstalled() && modelInstalled(findModel(id));

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch { /* only a hint for next time */ }
}

// ---------- downloads ----------

let download = null; // { state: running|done|error|cancelled, model, step, received, total, message }
let abort = null;

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch { return Infinity; }
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

// Downloads url to dest via dest.part, continuing a partial download if one is there, and only
// renames it to dest once the size and SHA-256 match.
async function fetchVerified(url, dest, { size, sha256 }, signal, onBytes, onCheck) {
  const part = `${dest}.part`;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have > size) { fs.rmSync(part); have = 0; }
  onBytes(have);

  if (have < size) {
    // Give up if no data arrives for a minute (e.g. Wi-Fi dropped without an error).
    const idle = new AbortController();
    let idleTimer;
    const stillAlive = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(), 60000); };
    stillAlive();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'JobSearchDashboard', ...(have ? { Range: `bytes=${have}-` } : {}) },
        signal: AbortSignal.any([signal, idle.signal]),
      });
      if (!res.ok) throw new Error(`Download failed (${res.status}) for ${path.basename(dest)}`);
      if (have && res.status !== 206) have = 0; // the server ignored the range: start over
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      await once(out, 'open');
      try {
        for await (const chunk of res.body) {
          stillAlive();
          have += chunk.length;
          onBytes(have);
          if (!out.write(chunk)) await once(out, 'drain');
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
    } catch (e) {
      if (signal.aborted) throw e;
      if (idle.signal.aborted || e.message === 'fetch failed' || e.message === 'terminated' || e.cause?.code) {
        throw new Error('The download was interrupted. Check your internet connection, then click Continue setup to pick up where it stopped.');
      }
      throw e;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  if (fs.statSync(part).size !== size) throw new Error('The download stopped early. Click Set up again to continue where it left off.');
  onCheck?.();
  if (await sha256Of(part) !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`${path.basename(dest)} was corrupted during download and was deleted. Please try again.`);
  }
  fs.renameSync(part, dest);
}

async function extractZip(zipFile, dir) {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipFile));
  const files = Object.values(zip.files).filter((f) => !f.dir);
  // Some builds put everything in one top-level folder; flatten it.
  const tops = new Set(files.map((f) => f.name.split('/')[0]));
  const strip = tops.size === 1 && files.every((f) => f.name.includes('/')) ? [...tops][0].length + 1 : 0;
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const rel = f.name.slice(strip);
    const target = path.resolve(tmp, rel);
    if (!target.startsWith(path.resolve(tmp) + path.sep)) continue; // ignore unsafe paths
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await f.async('nodebuffer'));
  }
  if (!fs.existsSync(path.join(tmp, 'llama-server.exe'))) throw new Error('The AI engine download did not contain llama-server.exe');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
}

export function install(modelId) {
  if (!SUPPORTED) throw Object.assign(new Error('The built-in AI is only available on 64-bit Windows. Use LM Studio instead.'), { status: 400 });
  if (download?.state === 'running') return download;
  const model = findModel(modelId);
  const steps = [
    ...Object.entries(RUNTIMES).filter(([b]) => !fs.existsSync(serverExe(b)))
      .map(([backend, r]) => ({ label: `AI engine (${backend === 'cpu' ? 'CPU' : 'graphics card'} version)`, size: r.size, run: (bytes) => installRuntime(backend, r, bytes) })),
    ...(modelInstalled(model) ? [] : [{
      label: `${model.name} model`, size: model.size,
      run: (bytes) => fetchVerified(modelUrl(model), modelPath(model), model, abort.signal, bytes,
        () => { current.step = `Checking the ${model.name} download`; }),
    }]),
  ];
  const total = steps.reduce((n, s) => n + s.size, 0);
  download = { state: 'running', model: model.id, step: '', received: 0, total, message: '' };
  abort = new AbortController();
  const current = download;

  (async () => {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const partial = (f) => (fs.existsSync(`${f}.part`) ? fs.statSync(`${f}.part`).size : 0);
    const need = total - partial(modelPath(model)) + 300 * 1024 * 1024;
    if (freeBytes(ROOT) < need) {
      throw new Error(`Not enough free disk space: the built-in AI needs about ${(need / 1024 ** 3).toFixed(1)} GB on drive ${path.parse(ROOT).root}`);
    }
    let done = 0;
    for (const step of steps) {
      current.step = step.label;
      await step.run((bytes) => { current.received = done + bytes; });
      done += step.size;
      current.received = done;
    }
    return `${model.name} is ready`;
  })().then(
    (message) => { Object.assign(current, { state: 'done', message, step: '' }); },
    (e) => {
      const cancelled = abort?.signal.aborted;
      Object.assign(current, { state: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Download paused. Click Set up to continue.' : e.message });
      if (!cancelled) console.error('Built-in AI download failed:', e);
    },
  );
  return download;
}

async function installRuntime(backend, r, bytes) {
  const zip = path.join(BIN_DIR, r.file);
  if (!fs.existsSync(zip)) await fetchVerified(runtimeUrl(r), zip, r, abort.signal, bytes);
  await extractZip(zip, runtimeDir(backend));
  fs.rmSync(zip, { force: true });
}

export function cancelInstall() {
  if (download?.state === 'running') abort?.abort();
  return download;
}

export async function removeModel(id) {
  const model = findModel(id);
  if (download?.state === 'running' && download.model === model.id) throw Object.assign(new Error('Wait for the download to finish or cancel it first'), { status: 409 });
  if (server.model === model.id || server.state === 'starting') await stop();
  fs.rmSync(modelPath(model), { force: true });
  fs.rmSync(`${modelPath(model)}.part`, { force: true });
  return { ok: true };
}

// ---------- the llama-server process ----------

let child = null;
let server = { state: 'off' }; // off | starting | running | error, plus model, backend, ctx, port, message
let starting = false;
const outputTail = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

function launch(backend, model, ctx, port) {
  const args = [
    '--model', modelPath(model),
    '--host', '127.0.0.1', '--port', String(port),
    '--ctx-size', String(ctx),
    '--parallel', '1', // one conversation at a time gets the whole context
    '--gpu-layers', backend === 'cpu' ? '0' : '999',
    '--jinja',
    '--reasoning', 'off', // answer directly; Qwen3.5's "thinking" mostly costs time here
    '--no-webui',
  ];
  outputTail.length = 0;
  const proc = spawn(serverExe(backend), args, { cwd: runtimeDir(backend), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.trim()) outputTail.push(line);
    if (outputTail.length > 60) outputTail.splice(0, outputTail.length - 60);
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  return proc;
}

// If the app was killed (crash, Task Manager), its llama-server keeps running and holding memory.
// Before the first start, stop any llama-server that runs from our own folder.
let straysChecked = false;
function stopStrays() {
  if (straysChecked || process.platform !== 'win32') return Promise.resolve();
  straysChecked = true;
  const dir = BIN_DIR.replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.ExecutablePath -like '${dir}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => resolve());
    ps.on('close', () => {
      if (out.trim()) console.log(`Built-in AI: stopped leftover llama-server (pid ${out.trim().split(/\s+/).join(', ')})`);
      resolve();
    });
  });
}

// Starts llama-server and waits until the model is loaded. Tries the graphics card first, then the CPU.
async function start(settings) {
  await stopStrays();
  const model = findModel(settings.builtinModel);
  if (!isReady(model.id)) throw new Error(`The built-in AI isn't set up yet. Click "Set up" in the sidebar to download ${model.name}.`);
  const ctx = Number(settings.contextLength) > 0 ? Number(settings.contextLength) : 8192;
  const hint = readState();
  const gpuBroken = hint.vulkanFailed === LLAMA_BUILD;
  const backends = settings.builtinGpu === false || gpuBroken ? ['cpu'] : ['vulkan', 'cpu'];

  let lastError = null;
  for (const backend of backends) {
    const port = await freePort();
    server = { state: 'starting', model: model.id, backend, ctx, port };
    console.log(`Built-in AI: starting ${model.name} (${backend}, ${ctx} ctx) on port ${port}`);
    const proc = launch(backend, model, ctx, port);
    child = proc;
    let exited = null;
    proc.on('exit', (code) => {
      exited = code ?? 'killed';
      if (child === proc) {
        child = null;
        if (server.state === 'running') {
          console.error(`Built-in AI stopped unexpectedly (exit ${code}):\n${outputTail.slice(-15).join('\n')}`);
          server = { state: 'error', message: 'The built-in AI stopped unexpectedly. It restarts the next time you use it.' };
        }
      }
    });
    proc.on('error', (e) => { exited = e.message; });

    const deadline = Date.now() + 4 * 60 * 1000; // loading from a slow disk can take a while
    while (Date.now() < deadline && exited === null && !(await healthy(port))) await sleep(500);
    if (exited === null && await healthy(port)) {
      // The very first run on a computer, the graphics driver compiles its shaders on the first request
      // (about a minute). Do that now, while the panel says "Starting", instead of on the user's first request.
      try {
        await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(3 * 60 * 1000),
        });
      } catch { /* not essential */ }
      server = { state: 'running', model: model.id, backend, ctx, port };
      console.log(`Built-in AI ready (${backend})`);
      if (backend === 'cpu' && backends[0] === 'vulkan') writeState({ vulkanFailed: LLAMA_BUILD });
      return server;
    }
    proc.kill();
    lastError = exited === null ? 'took too long to start' : `exited (${exited})`;
    console.error(`Built-in AI (${backend}) ${lastError}:\n${outputTail.slice(-15).join('\n')}`);
  }
  const memory = outputTail.some((l) => /out of memory|failed to allocate|alloc/i.test(l));
  throw new Error(memory
    ? `Not enough memory to run ${model.name}. Close other programs, or switch to the Light model in Settings.`
    : `The built-in AI could not start (${lastError}). Details are in the app log.`);
}

// Returns the running server, starting it (or restarting it with new settings) if needed.
// Calls are queued so a background warm-up and a request never start two servers.
export function ensureRunning(settings) {
  const run = queue.then(() => ensureRunningNow(settings));
  queue = run.catch(() => {});
  return run;
}
let queue = Promise.resolve();

async function ensureRunningNow(settings) {
  const model = findModel(settings.builtinModel);
  const ctx = Number(settings.contextLength) > 0 ? Number(settings.contextLength) : 8192;
  const gpuOk = settings.builtinGpu !== false || server.backend === 'cpu';
  if (server.state === 'running' && child && server.model === model.id && server.ctx === ctx && gpuOk) return server;
  await stopNow();
  starting = true;
  try {
    return await start(settings);
  } catch (e) {
    server = { state: 'error', model: model.id, message: e.message };
    throw e;
  } finally {
    starting = false;
  }
}

export function stop() {
  const run = queue.then(stopNow);
  queue = run.catch(() => {});
  return run;
}

async function stopNow() {
  const proc = child;
  child = null;
  server = { state: 'off' };
  if (!proc) return;
  proc.kill();
  await Promise.race([once(proc, 'exit'), sleep(5000)]);
}

// The model server must not outlive the app.
process.on('exit', () => { try { child?.kill(); } catch { /* already gone */ } });

// Lets the user retry the graphics card after a fallback to the CPU.
export function resetGpuHint() {
  writeState({ vulkanFailed: null });
}

export function status() {
  return {
    supported: SUPPORTED,
    dir: ROOT,
    runtime: runtimeInstalled(),
    models: MODELS.map(({ id, name, tier, description, license, size, repo }) => ({
      id, name, tier, description, license, size, repo,
      installed: SUPPORTED && modelInstalled(findModel(id)),
      partial: fs.existsSync(`${modelPath(findModel(id))}.part`),
    })),
    download,
    server: { ...server, starting },
    gpuFallback: readState().vulkanFailed === LLAMA_BUILD,
  };
}
