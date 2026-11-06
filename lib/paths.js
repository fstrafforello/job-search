// Where the app keeps its files on each operating system.
//   dataDir:    the user's data (db.json, backups, log) unless they choose another folder in Settings
//   machineDir: things for this computer only: the app window's browser profile, the Google sign-in,
//               the built-in AI's engine and models
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'Job Search Dashboard';
const home = os.homedir();

export function dataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
}

export function machineDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_NAME);
  // macOS keeps both in Application Support, the usual place for an app's own files.
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_NAME);
}
