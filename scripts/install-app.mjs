// Installs the locally built exe for the current Windows user, with Start menu and Desktop shortcuts.
// Usage: npm run install-app            (builds first)
//        npm run install-app -- --uninstall   (removes the app and shortcuts; your data is kept)
// A locally built exe carries no "downloaded from the internet" mark, so Windows doesn't block it
// the way it can block the same file downloaded through a browser.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('install-app is for Windows');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'Job Search Dashboard';
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', APP);
const EXE = path.join(INSTALL_DIR, 'JobSearchDashboard.exe');
const uninstall = process.argv.includes('--uninstall');

const ps = (command) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
const q = (s) => `'${s.replace(/'/g, "''")}'`;

// The Desktop may be redirected (e.g. to OneDrive), so ask Windows where it is.
const desktop = ps('[Environment]::GetFolderPath("Desktop")');
const startMenu = ps('[Environment]::GetFolderPath("Programs")');
const shortcuts = [path.join(startMenu, `${APP}.lnk`), path.join(desktop, `${APP}.lnk`)];

function appIsRunning() {
  return ps(`@(Get-Process JobSearchDashboard -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(EXE)} }).Count`) !== '0';
}

if (appIsRunning()) {
  console.error(`${APP} is running. Close its window, wait a few seconds, then run this again.`);
  process.exit(1);
}

if (uninstall) {
  for (const f of shortcuts) fs.rmSync(f, { force: true });
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  console.log(`${APP} was removed. Your data is still in ${path.join(process.env.APPDATA, APP)}.`);
  process.exit(0);
}

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-exe.mjs')], { cwd: ROOT, stdio: 'inherit' });

fs.mkdirSync(INSTALL_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'dist', 'JobSearchDashboard.exe'), EXE);

for (const lnk of shortcuts) {
  ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)});
      $s.TargetPath = ${q(EXE)}; $s.WorkingDirectory = ${q(INSTALL_DIR)};
      $s.IconLocation = ${q(EXE + ',0')}; $s.Description = ${q('Track your job search with local AI')}; $s.Save()`);
}

console.log(`\nInstalled ${APP} to ${INSTALL_DIR}`);
console.log(`Shortcuts: Start menu and Desktop ("${APP}").`);
console.log('Updates install themselves from inside the app. To remove it: npm run install-app -- --uninstall');
