// The built-in AI: status polling, the setup/download panel, and the first-start "how should the AI run?" choice.
import { $, esc, api, toast, confirmBox } from './util.js';

export const eng = { status: null };
const listeners = new Set();
let timer = null;
let active = false;
let lastDownload = null;

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export async function refreshEngine() {
  try {
    eng.status = await api('/engine/status');
  } catch { /* keep the last known state */ }
  const d = eng.status?.download;
  if (lastDownload === 'running' && d && d.state !== 'running') toast(d.message, d.state === 'error');
  lastDownload = d?.state || null;
  for (const fn of listeners) fn();
  clearTimeout(timer);
  const busy = d?.state === 'running' || eng.status?.server?.starting || eng.status?.server?.state === 'starting';
  if (active) timer = setTimeout(refreshEngine, busy ? 1000 : 10000);
  return eng.status;
}

// Polls only while the built-in AI is the chosen engine.
export function setEngineActive(on) {
  active = on;
  clearTimeout(timer);
  if (on) refreshEngine();
}

async function act(path, body) {
  try {
    await api(`/engine/${path}`, { method: 'POST', body: body || {} });
  } catch (e) {
    toast(e.message, true);
  }
  refreshEngine();
}

export const startSetup = (model) => act('install', model ? { model } : {});

// Bytes still to download for a model (engine included, minus what's already partly there).
function setupSize(s, model) {
  return (model.installed ? 0 : model.size) + (s.runtime ? 0 : 62 * 1024 * 1024);
}

function headline(s, model) {
  const d = s.download;
  const sv = s.server;
  if (d?.state === 'running') return ['', 'Setting up…'];
  if (!s.runtime || !model.installed) return ['down', 'Not set up yet'];
  if (sv.state === 'running' && sv.model === model.id) return ['ok', `Ready · ${model.name}`];
  if (sv.state === 'starting' || sv.starting) return ['', `Starting ${model.name}…`];
  if (sv.state === 'error') return ['down', 'Could not start'];
  return ['', 'Off · starts when you use the AI'];
}

/*
 * Renders the built-in AI's state into `el` and keeps it updated while `el` is on the page.
 *   getSettings(): current settings    compact: the small sidebar version
 *   onPickModel(id), onGpuChange(on): Settings page only, to save those choices
 */
export function mountEnginePanel(el, { getSettings, compact = false, onPickModel, onGpuChange }) {
  function render() {
    if (!el.isConnected) { listeners.delete(render); return; }
    const s = eng.status;
    if (!s) { el.innerHTML = '<div class="lm-head"><span class="dot"></span><span>Checking…</span></div>'; return; }
    if (!s.supported) {
      el.innerHTML = '<div class="lm-job">The built-in AI needs 64-bit Windows. Switch to LM Studio in Settings → AI.</div>';
      return;
    }
    const settings = getSettings();
    const model = s.models.find((m) => m.id === settings.builtinModel) || s.models[0];
    const d = s.download;
    const sv = s.server;
    const [dot, text] = headline(s, model);
    const downloading = d?.state === 'running';
    const ready = s.runtime && model.installed;

    let body = '';
    if (downloading) {
      const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 0;
      body = `<div class="lm-job"><span class="spin"></span>${esc(d.step || 'Preparing')}…</div>
        <div class="meter" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct.toFixed(1)}%"></span></div>
        <div class="small muted" style="margin-top:4px">${gb(d.received)} of ${gb(d.total)}</div>
        <div class="lm-actions"><button class="btn sm ghost" data-act="cancel">Pause</button></div>`;
    } else if (!ready) {
      const again = d?.model === model.id && ['error', 'cancelled'].includes(d.state);
      body = `${again ? `<div class="lm-job ${d.state === 'error' ? 'err' : ''}">${esc(d.message)}</div>` : ''}
        ${compact ? '' : `<p class="small muted">Downloads ${esc(model.name)} and the AI engine once (${gb(setupSize(s, model))}). After that it works offline.</p>`}
        <div class="lm-actions"><button class="btn sm primary" data-act="install">${again || model.partial ? 'Continue setup' : `Set up (${gb(setupSize(s, model))})`}</button></div>`;
    } else if (sv.state === 'error') {
      body = `<div class="lm-job err">${esc(sv.message || 'The built-in AI could not start.')}</div>
        <div class="lm-actions"><button class="btn sm" data-act="restart">Try again</button></div>`;
    } else if (sv.state === 'starting' || sv.starting) {
      body = '<div class="lm-job"><span class="spin"></span>Loading the model into memory. This takes a few seconds (up to a minute the very first time).</div>';
    } else if (!compact && sv.state === 'running') {
      body = `<div class="small muted">Running on the ${sv.backend === 'cpu' ? 'CPU' : 'graphics card (falls back to the CPU if needed)'} · context ${Math.round(sv.ctx / 1024)}k tokens</div>`;
    }

    el.innerHTML = `<div class="lm-head"><span class="dot ${dot}"></span><span>${esc(text)}</span></div>${body}${compact ? '' : details(s, settings, model)}`;
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      const a = b.dataset.act;
      if (a === 'install') startSetup(b.dataset.model || model.id);
      else if (a === 'cancel') act('cancel');
      else if (a === 'restart') act('restart');
      else if (a === 'retry-gpu') act('restart', { retryGpu: true });
      else if (a === 'remove') removeModel(s.models.find((m) => m.id === b.dataset.model));
    }));
    el.querySelectorAll('input[name="builtinModel"]').forEach((r) => r.addEventListener('change', () => onPickModel?.(r.value)));
    $('input[name="builtinGpu"]', el)?.addEventListener('change', (e) => onGpuChange?.(e.target.checked));
  }

  // Settings page only: model list, graphics card option, where the files are.
  function details(s, settings, current) {
    const rows = s.models.map((m) => `
      <label class="choice ${m.id === current.id ? 'on' : ''}">
        <input type="radio" name="builtinModel" value="${esc(m.id)}" ${m.id === current.id ? 'checked' : ''}>
        <div class="grow"><strong>${esc(m.tier)}: ${esc(m.name)}</strong> <span class="small muted">· ${gb(m.size)} · ${esc(m.license)}</span>
          <div class="small muted">${esc(m.description)}</div></div>
        ${m.installed
          ? `<button class="btn sm ghost danger" data-act="remove" data-model="${esc(m.id)}">Remove</button>`
          : `<span class="small muted">${m.partial ? 'Partly downloaded' : 'Not downloaded'}</span>`}
      </label>`).join('');
    return `
      <div class="choices" style="margin-top:12px">${rows}</div>
      <label class="row small" style="gap:6px;margin-top:10px"><input type="checkbox" name="builtinGpu" ${settings.builtinGpu !== false ? 'checked' : ''}> Use the graphics card when possible (faster)</label>
      ${s.gpuFallback && settings.builtinGpu !== false ? `<div class="lm-job">The graphics card didn't work last time, so the AI runs on the CPU.
        <button class="btn sm ghost" data-act="retry-gpu">Try the graphics card again</button></div>` : ''}
      <p class="small muted">Files are kept in <code>${esc(s.dir)}</code>, separate from your data. They stay when the app updates.
        Uses <a href="https://github.com/ggml-org/llama.cpp" target="_blank" rel="noopener">llama.cpp</a> (MIT) and Qwen3.5 by Alibaba Cloud (Apache 2.0).</p>`;
  }

  async function removeModel(m) {
    if (!(await confirmBox(`Remove ${m.name} from this computer? It frees ${gb(m.size)}. You can download it again later.`, { ok: 'Remove' }))) return;
    act('remove', { model: m.id });
  }

  listeners.add(render);
  render();
}

/*
 * First start: asks whether to use the built-in AI or LM Studio. Resolves with the choice,
 * or null if the dialog was dismissed (the sidebar then offers it again).
 */
export async function chooseEngine({ current = '' } = {}) {
  const s = eng.status || await refreshEngine().catch(() => null);
  const model = s?.models?.[0];
  const remaining = s && model ? setupSize(s, model) : null;
  const download = remaining === 0
    ? `${esc(model.name)} is already on this computer, so it's ready right away.`
    : `Downloads ${esc(model?.name || 'the model')} once (${remaining ? gb(remaining) : 'about 2.6 GB'}).`;
  const supported = s?.supported !== false;
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="engine-choice"><h2>How should the AI run?</h2>
    <p class="small muted" style="margin-top:0">Both are free and run on this computer. Nothing you write is sent to the internet. You can switch at any time in Settings.</p>
    <div class="choices">
      <label class="choice"><input type="radio" name="engine" value="builtin" ${supported ? '' : 'disabled'} ${current !== 'lmstudio' && supported ? 'checked' : ''}>
        <div><strong>Built-in AI${supported ? ' (recommended)' : ''}</strong>
        <div class="small muted">${supported ? `Nothing else to install. ${download} Works best with 8 GB of memory or more.` : 'Needs 64-bit Windows.'}</div></div></label>
      <label class="choice"><input type="radio" name="engine" value="lmstudio" ${current === 'lmstudio' || !supported ? 'checked' : ''}>
        <div><strong>LM Studio</strong>
        <div class="small muted">Use your own LM Studio app and pick any model you like. Good if you already use it or want bigger models.</div></div></label>
    </div>
    <div class="row"><button class="btn primary" value="ok">Continue</button></div></form>`;
  const choices = () => dlg.querySelectorAll('.choice').forEach((c) => c.classList.toggle('on', $('input', c).checked));
  dlg.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', choices));
  choices();
  dlg.onclose = null;
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener('close', r, { once: true }));
  if (dlg.returnValue !== 'ok') return null;
  return dlg.querySelector('input[name="engine"]:checked')?.value || null;
}
