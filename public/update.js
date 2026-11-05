// "Update available" card: checks GitHub Releases through the server and installs with one click.
import { $, esc, api, toast, md, confirmBox } from './util.js';

let info = null;
let installing = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function checkForUpdate({ force = false, quiet = true } = {}) {
  try {
    info = await api('/update/check' + (force ? '?force=1' : ''));
  } catch (e) {
    if (!quiet) toast(e.message, true);
    return null;
  }
  if (!quiet) {
    if (info.error) toast(info.error, true);
    else if (!info.available) toast(`You have the latest version (v${info.current})`);
  }
  render();
  return info;
}

function showNotes() {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog"><h2>What's new in v${esc(info.latest)}</h2>
    <div class="md" style="max-height:50vh;overflow:auto">${md(info.notes || 'No release notes.')}</div>
    <div class="row"><button class="btn" value="close">Close</button></div></form>`;
  dlg.onclose = null;
  dlg.showModal();
}

function render() {
  const el = $('#update-slot');
  if (!info?.available || installing) { if (!installing) el.innerHTML = ''; return; }
  const mb = info.size ? Math.round(info.size / 1024 / 1024) : null;
  el.innerHTML = `
    <div class="update-card">
      <div><strong>Update available</strong></div>
      <div class="small muted">Version ${esc(info.latest)} · you have ${esc(info.current)}</div>
      <div class="lm-actions">
        ${info.canInstall
          ? '<button class="btn sm primary" id="upd-go">Update now</button>'
          : `<a class="btn sm primary" href="${esc(info.url)}" target="_blank" rel="noopener">Download</a>`}
        <button class="btn sm ghost" id="upd-notes">What's new</button>
      </div>
      <div id="upd-progress"></div>
    </div>`;
  $('#upd-notes', el).addEventListener('click', showNotes);
  $('#upd-go', el)?.addEventListener('click', () => install(mb));
}

async function install(mb) {
  const ok = await confirmBox(
    `Update to version ${info.latest}? The app downloads the update${mb ? ` (about ${mb} MB)` : ''} and restarts. Your jobs, documents and settings are kept.`,
    { ok: 'Update now', danger: false },
  );
  if (!ok) return;
  try {
    await api('/update/apply', { method: 'POST' });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  installing = true;
  $$buttons(true);
  const progress = $('#upd-progress');
  const target = info.latest;

  for (;;) {
    await sleep(500);
    let s;
    try { s = await api('/update/status'); } catch { break; } // server already restarting
    if (s.state === 'downloading') {
      const pct = s.total ? Math.floor((s.received / s.total) * 100) : 0;
      progress.innerHTML = `<div class="lm-job">Downloading… ${pct}%</div><div class="meter"><span style="width:${pct}%"></span></div>`;
    } else if (s.state === 'installing') {
      progress.innerHTML = '<div class="lm-job"><span class="spin"></span>Installing…</div>';
    } else if (s.state === 'error') {
      installing = false;
      toast(s.message, true);
      render();
      return;
    } else {
      break; // restarting (or the new version is already answering)
    }
  }

  progress.innerHTML = '<div class="lm-job"><span class="spin"></span>Restarting…</div>';
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const b = await api('/bootstrap');
      if (b.version === target) { location.reload(); return; }
    } catch { /* not back yet */ }
  }
  progress.innerHTML = '<div class="lm-job">The update was installed. Please open Job Search Dashboard again.</div>';
}

function $$buttons(disabled) {
  document.querySelectorAll('#update-slot button').forEach((b) => { b.disabled = disabled; });
}
