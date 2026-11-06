// Checks GitHub Releases for a newer JobSearchDashboard.exe and installs it in place of the running one.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { once } from 'node:events';

const API = process.env.UPDATE_API || 'https://api.github.com';
// The download for this system in each GitHub Release. On a Mac the update is offered as a download
// (installing in place is Windows-only for now).
export const ASSET_NAME = process.platform === 'darwin' ? `JobSearchDashboard-macOS-${process.arch}.zip` : 'JobSearchDashboard.exe';
const CACHE_MS = 60 * 60 * 1000; // GitHub allows 60 unauthenticated requests/hour per IP

function parse(v) {
  return String(v).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
}

export function isNewer(candidate, current) {
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function createUpdater({ version, repo, packaged }) {
  const canInstall = packaged && process.platform === 'win32';
  const headers = { 'User-Agent': `JobSearchDashboard/${version}`, Accept: 'application/vnd.github+json' };
  let cache = null; // { at, result, asset }
  let status = { state: 'idle' }; // idle | downloading | installing | restarting | error

  async function check(force = false) {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
    const res = await fetch(`${API}/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(10000) });
    let result;
    let asset = null;
    if (res.status === 404) {
      result = { current: version, latest: version, available: false, canInstall };
    } else if (!res.ok) {
      throw new Error(`Could not check for updates (GitHub responded ${res.status})`);
    } else {
      const rel = await res.json();
      asset = (rel.assets || []).find((a) => a.name === ASSET_NAME) || null;
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      result = {
        current: version,
        latest,
        available: Boolean(asset) && isNewer(latest, version),
        notes: rel.body || '',
        url: rel.html_url,
        size: asset?.size || null,
        canInstall,
      };
    }
    cache = { at: Date.now(), result, asset };
    return result;
  }

  async function download(asset, target) {
    const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const out = fs.createWriteStream(target);
    try {
      await once(out, 'open');
    } catch (e) {
      throw new Error(e.code === 'EPERM' || e.code === 'EACCES'
        ? 'The app is in a folder Windows won\'t let it change. Move JobSearchDashboard.exe to e.g. your Desktop or Documents and try again.'
        : e.message);
    }
    const hash = crypto.createHash('sha256');
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        status.received += chunk.length;
        if (!out.write(chunk)) await once(out, 'drain');
      }
    } finally {
      await new Promise((r) => out.end(r));
    }

    if (status.received !== asset.size) throw new Error('The download was incomplete. Please try again.');
    const expected = String(asset.digest || '').match(/^sha256:([0-9a-f]{64})$/i)?.[1];
    if (expected && expected.toLowerCase() !== hash.digest('hex')) throw new Error('The download was corrupted. Please try again.');
    const fd = fs.openSync(target, 'r');
    const magic = Buffer.alloc(2);
    fs.readSync(fd, magic, 0, 2, 0);
    fs.closeSync(fd);
    if (magic.toString() !== 'MZ') throw new Error('The downloaded file is not a Windows program.');
  }

  async function install(asset, latest, restart) {
    const exe = process.execPath;
    const fresh = `${exe}.new`;
    const old = `${exe}.old`;
    try {
      await download(asset, fresh);
      status.state = 'installing';
      // Windows lets a running .exe be renamed (not deleted), so swap the files and start the new one.
      fs.rmSync(old, { force: true });
      fs.renameSync(exe, old);
      try {
        fs.renameSync(fresh, exe);
      } catch (e) {
        fs.renameSync(old, exe);
        throw e;
      }
      status = { state: 'restarting', version: latest };
      setTimeout(() => restart(exe), 1500); // give the page a chance to see "restarting"
    } catch (e) {
      fs.rmSync(fresh, { force: true });
      status = { state: 'error', message: e.message };
    }
  }

  async function apply(restart) {
    if (!canInstall) throw Object.assign(new Error('Automatic updates only work in the Windows app (.exe).'), { status: 400 });
    if (['downloading', 'installing', 'restarting'].includes(status.state)) return status;
    const info = await check(true);
    if (!info.available) throw Object.assign(new Error('You already have the latest version.'), { status: 400 });
    status = { state: 'downloading', received: 0, total: cache.asset.size, version: info.latest };
    install(cache.asset, info.latest, restart);
    return status;
  }

  // Leftovers from a previous update: the old exe can only be removed once it has exited.
  function cleanup() {
    if (!canInstall) return;
    for (const f of [`${process.execPath}.old`, `${process.execPath}.new`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* still in use; try again next start */ }
    }
  }

  return { check, apply, cleanup, status: () => status };
}
