// Builds the app with the server and web UI inside: dist/JobSearchDashboard.exe on Windows,
// dist/JobSearchDashboard-macOS.zip (holding a universal "Job Search Dashboard.app") on a Mac.
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
const IS_MAC = process.platform === 'darwin';
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

// 4. Produce the executable: the bundle and assets injected into a copy of a Node.js binary (`base`).
//    The code cache speeds up start-up but only works on the build machine's own kind of processor.
function buildSea(baseExe, output, useCodeCache = true) {
  const configFile = path.join(DIST, 'sea-config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    main: rel(bundle),
    output: rel(output),
    ...(baseExe && { executable: rel(baseExe) }),
    disableExperimentalSEAWarning: true,
    useCodeCache,
    assets,
  }, null, 2));
  execFileSync(process.execPath, ['--build-sea', rel(configFile)], { cwd: ROOT, stdio: 'inherit' });
  fs.rmSync(configFile);
}

let output = path.join(DIST, NAME);
if (IS_MAC) {
  // One "universal" program holding both an Apple Silicon and an Intel version; each Mac runs its own.
  // Node's binaries are signed: the signature comes off before the app is put inside, and the result is
  // signed again "ad hoc" (no developer identity), which Apple Silicon requires to run it.
  const slices = [];
  for (const arch of ['arm64', 'x64']) {
    const macBase = path.join(DIST, `base-${arch}`);
    if (arch === process.arch) fs.copyFileSync(process.execPath, macBase);
    else await downloadNode(arch, macBase);
    execFileSync('codesign', ['--remove-signature', macBase]);
    const slice = path.join(DIST, `${NAME}-${arch}`);
    buildSea(macBase, slice, arch === process.arch);
    fs.rmSync(macBase);
    slices.push(slice);
  }
  execFileSync('lipo', ['-create', ...slices, '-output', output]);
  for (const s of slices) fs.rmSync(s);
  output = makeMacApp(output);
} else {
  buildSea(base, output);
  // On Windows it's marked as a GUI program so no console window opens.
  if (IS_WIN) setGuiSubsystem(output);
}

for (const f of [bundle, base]) if (f) fs.rmSync(f, { force: true });
const size = (fs.statSync(output).size / 1024 / 1024).toFixed(0);
console.log(`\nBuilt ${rel(output)} (${size} MB, ${Object.keys(assets).length} embedded files)`);

// The official Node.js binary of the same version for another processor (e.g. Intel on an Apple Silicon
// build machine), checked against nodejs.org's published SHA-256.
async function downloadNode(arch, dest) {
  const v = process.version;
  const name = `node-${v}-darwin-${arch}`;
  const url = `https://nodejs.org/dist/${v}/`;
  console.log(`Downloading ${name}…`);
  const sums = await (await fetch(`${url}SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(`  ${name}.tar.gz`))?.split(' ')[0];
  if (!expected) throw new Error(`nodejs.org has no ${name}.tar.gz`);
  const res = await fetch(`${url}${name}.tar.gz`);
  if (!res.ok) throw new Error(`Download of ${name} failed (${res.status})`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const { createHash } = await import('node:crypto');
  if (createHash('sha256').update(tgz).digest('hex') !== expected) throw new Error(`${name}.tar.gz failed its checksum`);
  const tgzFile = path.join(DIST, `${name}.tar.gz`);
  fs.writeFileSync(tgzFile, tgz);
  execFileSync('tar', ['-xzf', tgzFile, '-C', DIST, `${name}/bin/node`]);
  fs.renameSync(path.join(DIST, name, 'bin', 'node'), dest);
  fs.rmSync(path.join(DIST, name), { recursive: true });
  fs.rmSync(tgzFile);
}

// 5. Mac: wrap the program in "Job Search Dashboard.app" (icon, name, version) and zip it for download.
// The app isn't signed with an Apple Developer ID, so the first time macOS asks the user to allow it.
function makeMacApp(binary) {
  const app = path.join(DIST, 'Job Search Dashboard.app');
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  execFileSync('codesign', ['--force', '--sign', '-', binary]);
  fs.renameSync(binary, path.join(contents, 'MacOS', NAME));

  const iconset = path.join(DIST, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = Math.min(size * scale, 512); // the largest source image is 512 px
      const out = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
      execFileSync('sips', ['-z', String(px), String(px), path.join(ROOT, 'public', 'icon-512.png'), '--out', out], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources', 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true });

  const xml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const entries = {
    CFBundleName: 'Job Search Dashboard',
    CFBundleDisplayName: 'Job Search Dashboard',
    CFBundleIdentifier: 'io.github.fstrafforello.job-search',
    CFBundleExecutable: NAME,
    CFBundleIconFile: 'icon',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: pkg.version,
    CFBundleVersion: pkg.version,
    LSMinimumSystemVersion: '13.5', // what the Node.js runtime inside needs
    NSHumanReadableCopyright: 'Copyright 2026 Francesco Strafforello. Apache License 2.0.',
  };
  const lines = Object.entries(entries).map(([k, v]) => `  <key>${k}</key><string>${xml(v)}</string>`);
  fs.writeFileSync(path.join(contents, 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    ...lines,
    // No Dock icon or menu bar: the app's window is a browser window, and the app quits when it closes.
    '  <key>LSUIElement</key><true/>',
    '</dict></plist>',
    '',
  ].join('\n'));

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  const zip = path.join(DIST, 'JobSearchDashboard-macOS.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip]);
  // Version 1.4.0 (Apple Silicon only) looks for this name when checking for updates.
  fs.copyFileSync(zip, path.join(DIST, 'JobSearchDashboard-macOS-arm64.zip'));
  return zip;
}
