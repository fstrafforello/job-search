// Two "computers" syncing through a fake Google (token endpoint + Drive appDataFolder).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- fake Google ----------
const files = new Map(); // id -> { name, parents, content, version }
let nextId = 1;
let refreshAllowed = true;
const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };

  if (url.pathname === '/token') {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'authorization_code') {
      assert.ok(p.get('code_verifier'), 'PKCE verifier sent');
      const idToken = ['x', Buffer.from(JSON.stringify({ email: `${p.get('code')}@example.com` })).toString('base64url'), 'sig'].join('.');
      return json(200, { access_token: 'at', refresh_token: `rt-${p.get('code')}`, expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.appdata openid email', id_token: idToken });
    }
    return refreshAllowed ? json(200, { access_token: 'at2', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
  }
  if (req.headers.authorization?.startsWith('Bearer ') !== true) return json(401, { error: 'no token' });

  const m = url.pathname.match(/^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/);
  if (!m) return json(404, {});
  const id = m[2];
  if (req.method === 'GET' && !id) {
    assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
    return json(200, { files: [...files].map(([fid, f]) => ({ id: fid, version: String(f.version), modifiedTime: new Date().toISOString() })) });
  }
  if (req.method === 'GET' && url.searchParams.get('alt') === 'media') { res.writeHead(200); return res.end(files.get(id).content); }
  if (req.method === 'POST' && m[1]) { // multipart create
    const parts = body.split(/--jsd[0-9a-f]+/).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim()).filter(Boolean);
    const meta = JSON.parse(parts[0]);
    assert.deepEqual(meta.parents, ['appDataFolder']);
    const fid = `f${nextId++}`;
    files.set(fid, { ...meta, content: parts[1], version: 1 });
    return json(200, { id: fid, version: '1' });
  }
  if (req.method === 'PATCH' && m[1]) {
    const f = files.get(id);
    f.content = body;
    f.version++;
    return json(200, { id, version: String(f.version) });
  }
  if (req.method === 'DELETE') { files.delete(id); res.writeHead(204); return res.end(); }
  return json(400, {});
});

let createStore;
let createSync;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsd-sync-'));

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, { JSD_GOOGLE_CLIENT_ID: 'test-client', JSD_GOOGLE_CLIENT_SECRET: 'test-secret', JSD_GOOGLE_TOKEN_URL: `${base}/token`, JSD_DRIVE_API: base });
  ({ createStore } = await import('../lib/store.js'));
  ({ createSync } = await import('../lib/sync.js'));
});
after(() => { fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function computer(name) {
  const dir = path.join(tmp, name);
  let sync = null;
  const store = createStore(path.join(dir, 'db.json'), { appVersion: 'test', onSave: () => sync?.schedule() });
  sync = createSync({ store, tokenFile: path.join(dir, 'token.json'), redirectUri: 'http://127.0.0.1:1/api/sync/callback' });
  return { store, sync, dir };
}

async function signIn(pc, code) {
  const state = new URL(pc.sync.signInUrl()).searchParams.get('state');
  const r = await pc.sync.handleCallback(new URLSearchParams({ state, code }));
  assert.ok(r.ok, r.message);
  await pc.sync.syncNow();
}

const now = () => new Date().toISOString();
const job = (id, title) => ({ id, title, status: 'saved', history: [], chat: [], documents: [], createdAt: now(), updatedAt: now() });
const titles = (pc) => pc.store.db.jobs.map((j) => j.title).sort();
const remote = () => JSON.parse([...files.values()][0].content);

test('two computers end up with the same data, and deletions and edits travel both ways', async () => {
  const a = computer('a');
  a.store.db.jobs.push(job('ja', 'Job from A'));
  a.store.db.profile.name = 'Alex';
  a.store.db.settings.lmUrl = 'http://only-on-a:1234';
  a.store.save();
  await signIn(a, 'alex');
  assert.equal(a.sync.status().email, 'alex@example.com');
  assert.equal(files.size, 1, 'one file in the app folder');
  assert.equal(remote().settings.lmUrl, undefined, "this computer's own settings are not uploaded");

  const b = computer('b');
  b.store.db.jobs.push(job('jb', 'Job from B'));
  b.store.save();
  await signIn(b, 'alex');
  assert.deepEqual(titles(b), ['Job from A', 'Job from B']);
  assert.equal(b.store.db.profile.name, 'Alex');
  assert.equal(b.store.db.settings.lmUrl, 'http://localhost:1234');

  await a.sync.syncNow();
  assert.deepEqual(titles(a), ['Job from A', 'Job from B']);

  // A deletes its job while B renames its own; both sync.
  a.store.db.jobs = a.store.db.jobs.filter((j) => j.id !== 'ja');
  a.store.db.deleted.ja = now();
  a.store.save();
  const jb = b.store.db.jobs.find((j) => j.id === 'jb');
  Object.assign(jb, { title: 'Renamed on B', updatedAt: now() });
  b.store.save();
  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.deepEqual(titles(a), ['Renamed on B']);
  assert.deepEqual(titles(b), ['Renamed on B']);
  assert.equal(a.sync.status().state, 'idle');

  // Signing out with "delete from Google Drive" removes the copy there and keeps the data here.
  await a.sync.signOut({ deleteFromDrive: true });
  assert.equal(files.size, 0);
  assert.equal(a.sync.status().signedIn, false);
  assert.deepEqual(titles(a), ['Renamed on B']);
  assert.ok(!fs.existsSync(path.join(a.dir, 'token.json')));
});

test('the sign-in is saved encrypted and survives a restart', async () => {
  const c = computer('c');
  await signIn(c, 'casey');
  const saved = JSON.parse(fs.readFileSync(path.join(c.dir, 'token.json'), 'utf8'));
  assert.notEqual(saved.refreshToken, 'rt-casey', 'not stored in plain text');
  // A new app start on the same computer picks the sign-in up again.
  const again = createSync({ store: c.store, tokenFile: path.join(c.dir, 'token.json'), redirectUri: 'http://127.0.0.1:1/cb' });
  for (let i = 0; i < 50 && !again.status().signedIn; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(again.status().email, 'casey@example.com');
  await again.signOut();
});

test('an expired sign-in stops syncing and asks to sign in again', async () => {
  const d = computer('d');
  await signIn(d, 'dana');
  refreshAllowed = false;
  // Force a token refresh by pretending the access token expired.
  d.store.db.jobs.push(job('jd', 'x'));
  d.store.save();
  const fresh = createSync({ store: d.store, tokenFile: path.join(d.dir, 'token.json'), redirectUri: 'http://127.0.0.1:1/cb' });
  for (let i = 0; i < 50 && !fresh.status().signedIn; i++) await new Promise((r) => setTimeout(r, 100));
  const st = await fresh.syncNow();
  assert.equal(st.state, 'error');
  assert.match(fresh.status().message, /Sign in again/);
  assert.equal(fresh.status().signedIn, false);
  refreshAllowed = true;
  await d.sync.signOut();
});

test('a stale or forged sign-in link is refused', async () => {
  const e = computer('e');
  e.sync.signInUrl();
  const r = await e.sync.handleCallback(new URLSearchParams({ state: 'wrong', code: 'x' }));
  assert.equal(r.ok, false);
  assert.equal(e.sync.status().signedIn, false);
});
