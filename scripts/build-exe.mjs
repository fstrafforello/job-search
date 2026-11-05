// Builds dist/JobSearchDashboard(.exe): one double-clickable file with the server and web UI inside.
// Usage: npm run build:exe   (needs Node >= 25.5 for --build-sea, and esbuild from devDependencies)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'JobSearchDashboard' + (process.platform === 'win32' ? '.exe' : '');
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
  // Only read when not packaged; defined so the CJS bundle doesn't warn about import.meta.
  define: { 'import.meta.url': '"file:///packaged/server.js"' },
  logLevel: 'warning',
});

// 2. Embed every file in public/ as an asset, keyed by its URL path.
const assets = {};
for (const f of fs.readdirSync(path.join(ROOT, 'public'), { recursive: true })) {
  const full = path.join(ROOT, 'public', f);
  if (fs.statSync(full).isFile()) assets[f.replaceAll('\\', '/')] = rel(full);
}

const configFile = path.join(DIST, 'sea-config.json');
fs.writeFileSync(configFile, JSON.stringify({
  main: rel(bundle),
  output: rel(path.join(DIST, NAME)),
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
  assets,
}, null, 2));

// 3. Produce the executable.
execFileSync(process.execPath, ['--build-sea', rel(configFile)], { cwd: ROOT, stdio: 'inherit' });

fs.rmSync(bundle);
fs.rmSync(configFile);
const size = (fs.statSync(path.join(DIST, NAME)).size / 1024 / 1024).toFixed(0);
console.log(`\nBuilt dist/${NAME} (${size} MB, ${Object.keys(assets).length} embedded files)`);
