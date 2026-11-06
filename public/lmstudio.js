// LM Studio status polling, server/model controls and the model picker.
import { $, esc, api, toast } from './util.js';

export const lm = { running: null, models: [], disk: [], cli: false, app: false, job: null };
const listeners = new Set();
let timer = null;
let lastJobKey = null;
let active = false;

const JOB_LABEL = { start: 'Starting LM Studio', stop: 'Stopping server', load: 'Loading model', unload: 'Unloading models' };

export async function refreshLm() {
  try {
    Object.assign(lm, await api('/lms/status'));
  } catch {
    lm.running = false;
  }
  const j = lm.job;
  const key = j && `${j.startedAt}:${j.state}`;
  if (j && j.state !== 'running' && lastJobKey && key !== lastJobKey && lastJobKey.startsWith(j.startedAt)) {
    toast(j.message, j.state === 'error');
  }
  lastJobKey = key;
  for (const fn of listeners) fn();
  clearTimeout(timer);
  if (active) timer = setTimeout(refreshLm, j?.state === 'running' ? 1500 : 20000);
  return lm;
}

// Polls only while LM Studio is the chosen engine.
export function setLmActive(on) {
  active = on;
  clearTimeout(timer);
  if (on) refreshLm();
}

export async function lmAction(action, body) {
  try {
    lm.job = await api(`/lms/${action}`, { method: 'POST', body: body || {} });
    lastJobKey = `${lm.job.startedAt}:running`;
    for (const fn of listeners) fn();
  } catch (e) {
    toast(e.message, true);
  }
  refreshLm();
}

const busy = () => lm.job?.state === 'running';

function statusText() {
  if (busy()) return `${JOB_LABEL[lm.job.action]}…`;
  if (lm.running === null) return 'Checking…';
  if (!lm.running) return 'Server off';
  const loaded = lm.models.filter((m) => m.state === 'loaded').length;
  return loaded ? `Running · ${loaded} loaded` : 'Running · no model loaded';
}

/*
 * Renders a model dropdown (loaded / available / custom ID) with server controls into `el`,
 * and keeps it in sync with LM Studio's state while `el` is on the page.
 *   getModel(): the saved model id ('' = auto)    setModel(id): persist a new choice
 */
export function mountModelPicker(el, { getModel, setModel, compact = false }) {
  let customMode = false;

  function render() {
    if (!el.isConnected) { listeners.delete(render); return; }
    if (el.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return; // don't yank an open dropdown

    const current = getModel();
    const loaded = lm.models.filter((m) => m.state === 'loaded');
    const available = lm.models.filter((m) => m.state !== 'loaded');
    const known = lm.models.some((m) => m.id === current);
    if (lm.running && current && !known) customMode = true;
    const selected = lm.models.find((m) => m.id === current);
    const ctx = (m) => (m.ctx ? ` · ${Math.round(m.ctx / 1024)}k ctx` : '');
    const opt = (m) => `<option value="${esc(m.id)}" ${m.id === current && !customMode ? 'selected' : ''}>${esc(m.id)}${compact ? '' : ctx(m)}</option>`;

    const options = [
      `<option value="" ${!current && !customMode ? 'selected' : ''}>Auto — first loaded model</option>`,
      loaded.length ? `<optgroup label="Loaded">${loaded.map(opt).join('')}</optgroup>` : '',
      available.length ? `<optgroup label="${lm.models.some((m) => m.state === 'unknown') ? 'Models' : 'Downloaded (not loaded)'}">${available.map(opt).join('')}</optgroup>` : '',
      !lm.running && current && !customMode ? `<option value="${esc(current)}" selected>${esc(current)}</option>` : '',
      !lm.running && lm.disk.length ? `<optgroup label="On disk — start the server to use">${lm.disk.map((d) => `<option disabled>${esc(d)}</option>`).join('')}</optgroup>` : '',
      `<option value="__custom" ${customMode ? 'selected' : ''}>Custom model ID…</option>`,
    ].join('');

    // Which model a "Load" click would load.
    const target = customMode ? current : current || '';
    const targetLoaded = loaded.some((m) => m.id === target);
    const canLoad = lm.running && lm.cli && target && !targetLoaded && (selected?.state === 'not-loaded' || customMode);

    const buttons = [
      !lm.running && (lm.cli || lm.app) ? `<button class="btn sm primary" data-act="start" ${busy() ? 'disabled' : ''}>Start LM Studio</button>` : '',
      canLoad ? `<button class="btn sm primary" data-act="load" ${busy() ? 'disabled' : ''}>Load model</button>` : '',
      !compact && lm.running && loaded.length && lm.cli ? `<button class="btn sm" data-act="unload" ${busy() ? 'disabled' : ''}>Unload all</button>` : '',
      !compact && lm.running && lm.cli ? `<button class="btn sm ghost danger" data-act="stop" ${busy() ? 'disabled' : ''}>Stop server</button>` : '',
      !compact ? '<button class="btn sm ghost" data-act="refresh">Refresh</button>' : '',
    ].join('');

    const j = lm.job;
    const jobLine = busy()
      ? `<div class="lm-job"><span class="spin"></span>${esc(j.log[j.log.length - 1] || JOB_LABEL[j.action] + '…')}</div>`
      : j?.state === 'error' ? `<div class="lm-job err">${esc(j.message)}</div>` : '';
    const hint = busy() ? ''
      : lm.running === false && !lm.cli && !lm.app
        ? '<div class="lm-job">The AI features need LM Studio (free). <a href="https://lmstudio.ai" target="_blank" rel="noopener">Download it here</a>, install it, then come back. This panel updates by itself.</div>'
      : lm.running === false && !lm.disk.length
        ? '<div class="lm-job">Click Start LM Studio. If you haven\'t yet, download a model in LM Studio first (search for e.g. "Qwen3 8B" or "Gemma 3 12B").</div>'
      : lm.running && !lm.models.length
        ? '<div class="lm-job">No AI models downloaded yet. In LM Studio, search for a model (e.g. "Qwen3 8B" or "Gemma 3 12B") and download it. It will appear here.</div>'
      : lm.running && !loaded.length && !current
        ? '<div class="lm-job">Pick a model above, then click Load model.</div>' : '';

    el.innerHTML = `
      <div class="lm-head"><span class="dot ${lm.running ? 'ok' : lm.running === false ? 'down' : ''}"></span><span>${esc(statusText())}</span></div>
      <select class="lm-select" aria-label="Model">${options}</select>
      <div class="lm-custom" ${customMode ? '' : 'hidden'}>
        <input type="text" placeholder="e.g. qwen/qwen3-8b" value="${esc(customMode ? current : '')}" spellcheck="false">
        <button class="btn sm" data-act="use">Use</button>
      </div>
      ${buttons ? `<div class="lm-actions">${buttons}</div>` : ''}
      ${jobLine}${hint}`;

    const sel = $('.lm-select', el);
    const input = $('.lm-custom input', el);
    sel.addEventListener('change', async () => {
      if (sel.value === '__custom') {
        customMode = true;
        $('.lm-custom', el).hidden = false;
        input.focus();
        return;
      }
      customMode = false;
      await setModel(sel.value);
      sel.blur();
      render();
    });
    const useCustom = async () => {
      const v = input.value.trim();
      if (!v) return toast('Type a model ID', true);
      await setModel(v);
      toast(`Model set to ${v}`);
      input.blur();
      render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useCustom(); } });
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      const act = b.dataset.act;
      if (act === 'use') useCustom();
      else if (act === 'refresh') refreshLm();
      else if (act === 'load') lmAction('load', { model: target });
      else lmAction(act);
    }));
  }

  listeners.add(render);
  render();
}
