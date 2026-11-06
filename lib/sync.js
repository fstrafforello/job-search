// Sync with Google Drive. The data is kept as one file in the app's hidden folder in the user's own Drive
// (the "appDataFolder": only this app can see it, and the app can't see anything else in the Drive).
// Each sync downloads that file, merges it with this computer's data item by item (lib/merge.js),
// saves the result here and uploads it. There is no server of ours in between.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mergeData, syncedContent, LOCAL_SETTINGS } from './merge.js';

// The Google Cloud "Desktop app" OAuth client. For installed apps Google doesn't treat the secret as secret
// (it ships inside every copy); it comes from the build (GitHub secrets) or the environment.
const CLIENT_ID = process.env.JSD_GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.JSD_GOOGLE_CLIENT_SECRET || '';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.JSD_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE = process.env.JSD_DRIVE_API || 'https://www.googleapis.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email';
const FILE_NAME = 'job-search-data.json';

const SYNC_AFTER_CHANGE_MS = 10 * 1000;
const SYNC_EVERY_MS = 5 * 60 * 1000;
const RETRY_OFFLINE_MS = 60 * 1000;

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- the sign-in token, kept safe on this computer ----------

function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `powershell exited ${code}`))));
    ps.stdin.end(input);
  });
}
const PROTECT = "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const UNPROTECT = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

// On a Mac the token goes in the user's Keychain (the `security` command), keyed by the token file's path.
const KEYCHAIN_SERVICE = 'Job Search Dashboard Google sync';
function security(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('security', args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `security exited ${code}`))));
  });
}

// Windows: DPAPI. Mac: Keychain. Elsewhere (or JSD_TOKEN_STORE=file, for tests): a file only this user can read.
function tokenStore() {
  if (process.env.JSD_TOKEN_STORE === 'file') return 'file';
  return process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'file';
}

async function saveToken(file, { email, refreshToken }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const store = tokenStore();
  let record;
  if (store === 'dpapi') record = { email, refreshToken: await powershell(PROTECT, refreshToken), protected: 'dpapi' };
  else if (store === 'keychain') {
    await security(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', file, '-w', refreshToken]);
    record = { email, protected: 'keychain' };
  } else record = { email, refreshToken, protected: false };
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
}

async function loadToken(file) {
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (record.protected === 'dpapi') record.refreshToken = await powershell(UNPROTECT, record.refreshToken);
  if (record.protected === 'keychain') record.refreshToken = await security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', file, '-w']);
  return record;
}

function deleteToken(file) {
  let record = null;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
  if (record?.protected === 'keychain') security(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', file]).catch(() => {});
  fs.rmSync(file, { force: true });
}

// ---------- sync ----------

/*
 * store: lib/store.js       tokenFile: where the sign-in is kept (on this computer, outside the data folder)
 * redirectUri: the app's own /api/sync/callback    onRemoteChange(): the data changed because of another computer
 */
export function createSync({ store, tokenFile, redirectUri, onRemoteChange }) {
  const configured = Boolean(CLIENT_ID);
  let account = null; // { email, refreshToken }
  let access = null; // { token, expires }
  let pendingSignIn = null; // { state, verifier, expires }
  let status = { state: 'off', lastSync: null, message: '' }; // off | idle | syncing | offline | error
  let applying = false; // true while saving a merge, so that save doesn't schedule another sync
  let dirty = false; // local changes not uploaded yet
  let timer = null;
  let periodic = null;
  let queue = Promise.resolve();

  async function init() {
    if (!configured) return;
    try {
      account = await loadToken(tokenFile);
    } catch (e) {
      console.warn('Google sync: could not read the saved sign-in:', e.message);
    }
    if (account) start();
  }

  function start() {
    status = { ...status, state: 'idle', message: '' };
    clearInterval(periodic);
    periodic = setInterval(() => syncNow().catch(() => {}), SYNC_EVERY_MS);
    periodic.unref();
    syncNow().catch(() => {});
  }

  // ----- Google sign-in (OAuth for installed apps: browser + loopback redirect + PKCE) -----

  function signInUrl() {
    if (!configured) throw Object.assign(new Error('Google sync is not available in this build of the app.'), { status: 400 });
    const verifier = base64url(crypto.randomBytes(48));
    const state = base64url(crypto.randomBytes(16));
    pendingSignIn = { state, verifier, expires: Date.now() + 10 * 60 * 1000 };
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: base64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline', // a refresh token, so it keeps working after the app restarts
      prompt: 'consent',
    });
    return `${AUTH_URL}?${params}`;
  }

  async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error_description || body.error || `Google responded ${res.status}`), { code: body.error });
    return body;
  }

  // Google redirects the browser here after the user agrees. Returns a message for that browser tab.
  async function handleCallback(query) {
    const p = pendingSignIn;
    if (query.get('error')) return { ok: false, message: query.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : `Google said: ${query.get('error')}` };
    if (!p || p.state !== query.get('state') || Date.now() > p.expires) return { ok: false, message: 'This sign-in link has expired. Start again from the app.' };
    pendingSignIn = null;
    const tokens = await tokenRequest({ grant_type: 'authorization_code', code: query.get('code'), code_verifier: p.verifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) return { ok: false, message: 'Google did not allow offline access. Please try again.' };
    if (!String(tokens.scope || '').includes('drive.appdata')) {
      return { ok: false, message: 'The app needs permission to keep its data in your Google Drive. Please sign in again and allow it.' };
    }
    let email = '';
    try { email = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url')).email || ''; } catch { /* optional */ }
    account = { email, refreshToken: tokens.refresh_token };
    access = { token: tokens.access_token, expires: Date.now() + (tokens.expires_in - 60) * 1000 };
    await saveToken(tokenFile, account);
    console.log(`Google sync: signed in${email ? ` as ${email}` : ''}`);
    start();
    return { ok: true, message: `Signed in${email ? ` as ${email}` : ''}. Your data is syncing.` };
  }

  async function accessToken() {
    if (access && Date.now() < access.expires) return access.token;
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken });
      access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
      return access.token;
    } catch (e) {
      if (e.code === 'invalid_grant') { // revoked, expired or password changed
        forget();
        throw Object.assign(new Error('Your Google sign-in has expired. Sign in again to keep syncing.'), { signedOut: true });
      }
      throw e;
    }
  }

  // ----- Google Drive (appDataFolder) -----

  async function drive(method, url, { body, headers = {}, raw = false } = {}) {
    const res = await fetch(`${DRIVE}${url}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...headers },
      body,
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 401) access = null; // retried with a fresh token on the next sync
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Google Drive responded ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    return raw ? res : res.status === 204 ? null : res.json();
  }

  async function findFile() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const { files = [] } = await drive('GET', `/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,version,modifiedTime)&orderBy=modifiedTime desc`);
    return files[0] || null;
  }

  async function download(id) {
    const res = await drive('GET', `/drive/v3/files/${id}?alt=media`, { raw: true });
    return JSON.parse(await res.text());
  }

  async function upload(file, data) {
    const json = JSON.stringify(data);
    if (file) {
      return drive('PATCH', `/upload/drive/v3/files/${file.id}?uploadType=media&fields=id,version`, {
        body: json, headers: { 'Content-Type': 'application/json' },
      });
    }
    const boundary = `jsd${crypto.randomBytes(8).toString('hex')}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
    return drive('POST', '/upload/drive/v3/files?uploadType=multipart&fields=id,version', {
      body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
  }

  // What goes to Drive: everything except this computer's own settings.
  function forUpload(db) {
    const settings = { ...db.settings };
    for (const k of LOCAL_SETTINGS) delete settings[k];
    return { ...db, settings };
  }

  // ----- the sync itself -----

  async function syncOnce() {
    // Drive can't refuse an upload when the file changed meanwhile, so check its version right before
    // uploading and merge again if another computer got in first. Merging is safe to repeat.
    for (let attempt = 0; attempt < 3; attempt++) {
      dirty = false;
      const file = await findFile();
      const remote = file ? await download(file.id) : null;
      const local = store.db;
      const merged = mergeData(local, remote);

      if (syncedContent(merged) !== syncedContent(local)) {
        applying = true;
        try { store.replace(merged); } finally { applying = false; }
        onRemoteChange?.();
      }
      if (remote && syncedContent(merged) === syncedContent(remote)) return; // Drive already has it all

      const latest = file ? await findFile() : null;
      if (file && latest && latest.version !== file.version) continue;
      await upload(file, forUpload(store.db));
      return;
    }
    throw new Error('Another computer kept changing the data; will try again shortly.');
  }

  function syncNow() {
    if (!account) return Promise.resolve(status);
    const run = queue.then(async () => {
      if (!account) return status;
      status = { ...status, state: 'syncing' };
      try {
        await syncOnce();
        status = { state: 'idle', lastSync: new Date().toISOString(), message: '' };
      } catch (e) {
        const offline = e.message === 'fetch failed' || e.name === 'TimeoutError' || e.cause?.code;
        status = {
          ...status,
          state: e.signedOut ? 'error' : offline ? 'offline' : 'error',
          message: offline ? 'Offline. Changes will sync when the connection is back.' : e.message,
        };
        if (!e.signedOut) console.warn('Google sync failed:', e.message);
        dirty = true;
        schedule(offline ? RETRY_OFFLINE_MS : SYNC_EVERY_MS);
      }
      return status;
    });
    queue = run.catch(() => {});
    return run;
  }

  // Called after every local save: sync a little later, so a burst of edits becomes one upload.
  function schedule(ms = SYNC_AFTER_CHANGE_MS) {
    if (!account || applying) return;
    if (ms === SYNC_AFTER_CHANGE_MS) dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow().catch(() => {}), ms);
    timer.unref();
  }

  // Before the app quits: upload pending changes, but don't hold the exit for long.
  async function flush(maxMs = 8000) {
    if (!account || !dirty) return;
    clearTimeout(timer);
    await Promise.race([syncNow(), new Promise((r) => setTimeout(r, maxMs))]);
  }

  function forget() {
    account = null;
    access = null;
    clearTimeout(timer);
    clearInterval(periodic);
    deleteToken(tokenFile);
    status = { state: 'off', lastSync: null, message: '' };
  }

  // Signs out on this computer. With deleteFromDrive, also removes the synced copy from Google Drive.
  async function signOut({ deleteFromDrive = false } = {}) {
    if (!account) return publicStatus();
    if (deleteFromDrive) {
      await queue;
      const file = await findFile();
      if (file) await drive('DELETE', `/drive/v3/files/${file.id}`);
    }
    const token = account.refreshToken;
    forget();
    fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => {});
    console.log(`Google sync: signed out${deleteFromDrive ? ' and deleted the copy in Google Drive' : ''}`);
    return publicStatus();
  }

  function publicStatus() {
    return { configured, signedIn: Boolean(account), email: account?.email || '', ...status, pending: dirty };
  }

  init();
  return { signInUrl, handleCallback, syncNow, schedule, flush, signOut, status: publicStatus };
}
