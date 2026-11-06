// Builds dist/JobSearchDashboard(.exe): one double-clickable file with the server and web UI inside.
// Usage: npm run build:exe   (needs Node >= 25.5 for --build-sea, and esbuild from devDependencies)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { setGuiSubsystem, stripSignature } from './pe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const IS_WIN = process.platform === 'win32';
const NAME = 'JobSearchDashboard' + (IS_WIN ? '.exe' : '');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. Bundle the server into one CommonJS file (SEA can only run a single script).
const bundle = path.join(DIST, 'server.cjs');
await build({
  entryPoints: [path.join(ROOT, 'server.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: {
    // Only read when not packaged; defined so the CJS bundle doesn't warn about import.meta.
    'import.meta.url': '"file:///packaged/server.js"',
    // Google sign-in for Drive sync (a "Desktop app" OAuth client). Set these when building, e.g. from
    // GitHub secrets in the release workflow; without them the exe has no Google sync.
    'process.env.JSD_GOOGLE_CLIENT_ID': JSON.stringify(process.env.JSD_GOOGLE_CLIENT_ID || ''),
    'process.env.JSD_GOOGLE_CLIENT_SECRET': JSON.stringify(process.env.JSD_GOOGLE_CLIENT_SECRET || ''),
  },
  logLevel: 'warning',
});

// 2. Refresh public/third-party-licenses.txt for the Node.js runtime and packages going into this exe,
//    then embed every file in public/ as an asset, keyed by its URL path.
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'licenses.mjs')], { cwd: ROOT, stdio: 'inherit' });
const assets = {};
for (const f of fs.readdirSync(path.join(ROOT, 'public'), { recursive: true })) {
  const full = path.join(ROOT, 'public', f);
  if (fs.statSync(full).isFile()) assets[f.replaceAll('\\', '/')] = rel(full);
}

// 3. On Windows, brand a copy of node.exe (icon, name, version) to build from.
let base = null;
if (IS_WIN) {
  const { rcedit } = await import('rcedit');
  base = path.join(DIST, 'base.exe');
  fs.copyFileSync(process.execPath, base);
  stripSignature(base);
  const version = `${pkg.version}.0`;
  await rcedit(base, {
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      FileDescription: 'Job Search Dashboard',
      ProductName: 'Job Search Dashboard',
      InternalName: 'JobSearchDashboard',
      OriginalFilename: NAME,
      CompanyName: '',
      LegalCopyright: 'Copyright 2026 Francesco Strafforello. Apache License 2.0.',
    },
  });
}

const configFile = path.join(DIST, 'sea-config.json');
fs.writeFileSync(configFile, JSON.stringify({
  main: rel(bundle),
  output: rel(path.join(DIST, NAME)),
  ...(base && { executable: rel(base) }),
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
  assets,
}, null, 2));

// 4. Produce the executable. On Windows it's marked as a GUI program so no console window opens.
execFileSync(process.execPath, ['--build-sea', rel(configFile)], { cwd: ROOT, stdio: 'inherit' });
if (IS_WIN) setGuiSubsystem(path.join(DIST, NAME));

for (const f of [bundle, configFile, base]) if (f) fs.rmSync(f);
const size = (fs.statSync(path.join(DIST, NAME)).size / 1024 / 1024).toFixed(0);
console.log(`\nBuilt dist/${NAME} (${size} MB, ${Object.keys(assets).length} embedded files)`);
