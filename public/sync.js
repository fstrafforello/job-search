// Google Drive sync: the Settings card and the small status line in the sidebar.
import { $, esc, api, toast, relTime } from './util.js';

export const sync = { status: null };
const listeners = new Set();
let timer = null;
let waitingForBrowser = false; // sign-in started, not finished in the browser yet

export async function refreshSync() {
  try { sync.status = await api('/sync/status'); } catch { /* keep the last one */ }
  for (const fn of listeners) fn();
  clearTimeout(timer);
  const s = sync.status;
  if (s?.signedIn || waitingForBrowser) timer = setTimeout(refreshSync, s?.state === 'syncing' || waitingForBrowser ? 2000 : 30000);
  return s;
}

function describe(s) {
  if (s.state === 'syncing') return ['', 'Syncing…'];
  if (s.state === 'offline') return ['down', 'Offline · will sync later'];
  if (s.state === 'error') return ['down', s.signedIn ? 'Sync problem' : 'Signed out'];
  if (s.pending) return ['', 'Changes waiting to sync'];
  return ['ok', s.lastSync ? `Synced ${relTime(s.lastSync)}` : 'Synced'];
}

async function signIn() {
  try {
    const { url } = await api('/sync/signin', { method: 'POST' });
    waitingForBrowser = true;
    toast('Finish signing in in your browser');
    for (const fn of listeners) fn(url);
    refreshSync();
    setTimeout(() => { waitingForBrowser = false; }, 10 * 60 * 1000);
  } catch (e) { toast(e.message, true); }
}

async function signOut() {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog"><h2>Stop syncing on this computer?</h2>
    <p>Your data stays on this computer. Other computers keep their copy and keep syncing with each other.</p>
    <p class="small muted">"Sign out and delete" also removes the copy kept in your Google Drive. Do that on the last computer you stop syncing.</p>
    <div class="row"><button class="btn" value="">Cancel</button><button class="btn danger" value="delete">Sign out and delete</button><button class="btn primary" value="out">Sign out</button></div></form>`;
  dlg.onclose = null;
  dlg.returnValue = '';
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener('close', r, { once: true }));
  if (!dlg.returnValue) return;
  try {
    await api('/sync/signout', { method: 'POST', body: { deleteFromDrive: dlg.returnValue === 'delete' } });
    toast(dlg.returnValue === 'delete' ? 'Signed out and deleted the copy in Google Drive' : 'Signed out. Your data stays on this computer.');
  } catch (e) { toast(e.message, true); }
  refreshSync();
}

// The Settings card. Re-renders itself while it's on the page.
export function mountSyncCard(el) {
  let fallbackUrl = null;
  function render(url) {
    if (!el.isConnected) { listeners.delete(render); return; }
    if (typeof url === 'string') fallbackUrl = url;
    const s = sync.status;
    if (!s) { el.innerHTML = '<p class="small muted">Checking…</p>'; return; }
    if (!s.configured) {
      el.innerHTML = '<p class="small muted" style="margin-top:0">Google sync isn\'t available in this copy of the app (it was built without a Google sign-in key). Use the data folder option below instead.</p>';
      return;
    }
    if (!s.signedIn) {
      el.innerHTML = `
        ${s.state === 'error' && s.message ? `<div class="lm-job err" style="margin:0 0 10px">${esc(s.message)}</div>` : ''}
        <p class="small muted" style="margin-top:0">Sign in with your Google account to use the same jobs, documents and profile on all your computers.
          Your data is kept in a hidden app folder in <strong>your own</strong> Google Drive: the app can't see your other files, and nothing goes to any server of ours.
          The AI choice and other settings for this computer are not synced.</p>
        <div class="row"><button type="button" class="btn primary" id="sync-signin">Sign in with Google</button></div>
        ${waitingForBrowser ? `<div class="lm-job"><span class="spin"></span>Waiting for you to finish in the browser…
          ${fallbackUrl ? `<a href="${esc(fallbackUrl)}" target="_blank" rel="noopener">Open the sign-in page again</a>` : ''}</div>` : ''}`;
      $('#sync-signin', el).addEventListener('click', signIn);
      return;
    }
    waitingForBrowser = false;
    const [dot, text] = describe(s);
    el.innerHTML = `
      <div class="lm-head"><span class="dot ${dot}"></span><span>${esc(text)}</span></div>
      <p class="small muted" style="margin-top:0">Signed in as <strong>${esc(s.email || 'your Google account')}</strong>. Changes sync a few seconds after you make them,
        every few minutes, and when you close the app. On another computer, install the app and sign in with the same account.</p>
      ${s.message ? `<div class="lm-job ${s.state === 'error' ? 'err' : ''}" style="margin:0 0 10px">${esc(s.message)}</div>` : ''}
      <div class="row"><button type="button" class="btn" id="sync-now" ${s.state === 'syncing' ? 'disabled' : ''}>Sync now</button>
        <button type="button" class="btn ghost" id="sync-out">Sign out…</button></div>`;
    $('#sync-now', el).addEventListener('click', async () => {
      try {
        sync.status = await api('/sync/now', { method: 'POST' });
        if (sync.status.state === 'idle') toast('Synced');
      } catch (e) { toast(e.message, true); }
      refreshSync();
    });
    $('#sync-out', el).addEventListener('click', signOut);
  }
  listeners.add(render);
  render();
  refreshSync();
}

// The sidebar line: only shown while signed in, or when sync needs attention.
export function mountSyncBadge(el) {
  function render() {
    const s = sync.status;
    if (!s?.configured || (!s.signedIn && s.state !== 'error')) { el.innerHTML = ''; return; }
    const [dot, text] = s.signedIn ? describe(s) : ['down', 'Sync stopped: sign in again'];
    el.innerHTML = `<a class="sync-badge" href="#/settings" data-tip="Google Drive sync"><span class="dot ${dot}"></span>${esc(text)}</a>`;
  }
  listeners.add(render);
  render();
  refreshSync();
}
