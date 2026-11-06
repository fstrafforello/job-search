// Desktop integration for the packaged app: its own window, a log file, and a startup error page.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import util from 'node:util';
import { spawn } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

export function openUrl(url) {
  // Not `cmd /c start`: cmd treats each & in a URL as a new command, cutting off its query string.
  const [cmd, args] = IS_WIN ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

// A Chromium browser that can open an app window. Edge ships with Windows 10/11; Chrome is the fallback.
// On a Mac, Chrome, Edge or Brave if installed; otherwise the default browser (e.g. Safari) opens a tab.
function findAppBrowser() {
  if (process.platform === 'darwin') {
    const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];
    for (const dir of ['/Applications', path.join(process.env.HOME || '', 'Applications')]) {
      for (const name of apps) {
        const p = path.join(dir, `${name}.app`, 'Contents', 'MacOS', name);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }
  if (!IS_WIN) return null;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const rel of [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']]) {
    for (const root of roots) {
      const p = path.join(root, ...rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Opens the dashboard as a standalone app window (no tabs or address bar). A dedicated profile keeps
// it separate from the user's normal browser windows. Falls back to the default browser.
export function openAppWindow(url, profileDir) {
  const browser = findAppBrowser();
  if (!browser) return openUrl(url);
  spawn(browser, [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1360,880',
  ], { detached: true, stdio: 'ignore' }).on('error', () => openUrl(url)).unref();
}

// With no console window, console output goes to a log file instead.
export function logToFile(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.rmSync(file);
  } catch { /* logging is best-effort */ }
  const write = (level) => (...args) => {
    try { fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`); } catch { /* ignore */ }
  };
  console.log = write('INFO');
  console.info = write('INFO');
  console.warn = write('WARN');
  console.error = write('ERROR');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// With no console, a startup failure is shown as a page in the app window instead.
export function showErrorWindow(message, { host, port, profileDir, logFile }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Job Search Dashboard</title>
    <style>body{font:15px/1.55 "Segoe UI",system-ui,sans-serif;max-width:620px;margin:60px auto;padding:0 24px;color:#1a1a1a;background:#f4f4f1}
    h1{font-size:20px}code,pre{background:#e9e8e3;border-radius:6px}pre{padding:12px;white-space:pre-wrap;word-break:break-word}code{padding:1px 5px}</style></head>
    <body><h1>Job Search Dashboard couldn't start</h1>
    <pre>${esc(message)}</pre>
    <p>Your data has not been changed. Try closing this window and opening the app again.
    If it keeps happening, the details are in <code>${esc(logFile)}</code>.</p></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  server.on('error', () => process.exit(1));
  server.listen(port, host, () => openAppWindow(`http://${host}:${port}/`, profileDir));
  setTimeout(() => process.exit(1), 3 * 60 * 1000);
}
