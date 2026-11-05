export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch('/api' + path, {
    method,
    signal,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 't' + (isError ? ' err' : '');
  el.textContent = message;
  $('#toast').append(el);
  setTimeout(() => el.remove(), isError ? 6000 : 2600);
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso.length === 10 ? iso + 'T12:00:00' : iso)) / 86400000);
}

export function relTime(iso) {
  const d = daysSince(iso);
  if (d === null) return '';
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  return fmtDate(iso);
}

export function download(filename, text, type = 'text/markdown') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function copy(text) {
  await navigator.clipboard.writeText(text);
  toast('Copied to clipboard');
}

export function slug(s) {
  return String(s || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
}

// Shows a modal with the given fields; resolves with the values or null when cancelled.
export function form(title, fields, { submit = 'Save' } = {}) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    <div class="grid">${fields.map((f) => f.type === 'select'
      ? `<label class="field">${esc(f.label)}<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`
      : `<label class="field">${esc(f.label)}<input type="text" name="${f.name}" value="${esc(f.value || '')}" ${f.required ? 'required' : ''}></label>`).join('')}</div>
    <div class="row"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(submit)}</button></div>
  </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(new FormData($('form', dlg))));
    };
    dlg.showModal();
    $('input, select', dlg)?.focus();
  });
}

export function confirmBox(message, { ok = 'Delete', danger = true } = {}) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog"><h2>${esc(message)}</h2>
    <div class="row"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok" ${danger ? 'style="background:var(--danger);border-color:var(--danger)"' : ''}>${esc(ok)}</button></div></form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.showModal();
  });
}

// ---------- minimal, escape-first Markdown renderer ----------

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function md(src) {
  const lines = esc(src).split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null;
  let code = null;
  let table = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
  const flushList = () => {
    if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; }
  };
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
      rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    table = null;
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (const raw of lines) {
    if (code) {
      if (/^\s*```/.test(raw)) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) { flushAll(); code = []; continue; }
    const line = raw.trimEnd();
    let m;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue; // separator row
      (table ||= []).push(cells(line));
      continue;
    }
    if (table) flushTable();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
      flushAll();
      const level = Math.min(m[1].length + 2, 6);
      out.push(`<h${level}>${inline(m[2].replace(/\s*#+$/, ''))}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*([-*+•]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const type = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    flushList();
    para.push(line);
  }
  if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  flushAll();
  return out.join('');
}

// Hides <think>…</think> reasoning blocks some local models emit.
export function visibleText(text) {
  const open = text.lastIndexOf('<think>');
  const close = text.lastIndexOf('</think>');
  const thinking = open > close;
  const cleaned = text.replace(/<think>[\s\S]*?(<\/think>|$)\s*/g, '');
  return { text: cleaned, thinking };
}
