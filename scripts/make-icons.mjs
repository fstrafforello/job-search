// Renders assets/icon*.svg to PNGs and a multi-size assets/icon.ico, using headless Microsoft Edge.
// Run after changing the icon: npm run icons   (outputs are committed, so builds don't need Edge)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const big = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(ROOT, 'assets', 'icon-small.svg'), 'utf8');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const WEB = { 'public/icon-32.png': 32, 'public/icon-192.png': 192, 'public/icon-512.png': 512 };
const sizes = [...new Set([...ICO_SIZES, ...Object.values(WEB)])];

const edge = [
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((p) => fs.existsSync(p));
if (!edge) throw new Error('Microsoft Edge is needed to render the icons');

// The page draws each size onto a canvas and prints the PNGs as JSON for --dump-dom to capture.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-'));
const page = path.join(tmp, 'render.html');
fs.writeFileSync(page, `<!doctype html><pre id="out"></pre><script>
const svgs = { big: ${JSON.stringify(big)}, small: ${JSON.stringify(small)} };
const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s); });
(async () => {
  await document.fonts.ready;
  const imgs = { big: await load(svgs.big), small: await load(svgs.small) };
  const out = {};
  for (const size of ${JSON.stringify(sizes)}) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(size <= 32 ? imgs.small : imgs.big, 0, 0, size, size);
    out[size] = c.toDataURL('image/png').split(',')[1];
  }
  document.getElementById('out').textContent = JSON.stringify(out);
})();
</script>`);

const dom = execFileSync(edge, ['--headless=new', '--disable-gpu', `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--virtual-time-budget=5000', '--dump-dom', 'file:///' + page.replaceAll('\\', '/')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const json = dom.match(/<pre id="out">([^<]+)<\/pre>/)?.[1];
if (!json) throw new Error('Rendering failed');
const png = Object.fromEntries(Object.entries(JSON.parse(json)).map(([s, b64]) => [s, Buffer.from(b64, 'base64')]));
fs.rmSync(tmp, { recursive: true, force: true });

for (const [file, size] of Object.entries(WEB)) fs.writeFileSync(path.join(ROOT, file), png[size]);

// ICO = 6-byte header + 16-byte directory entry per image + PNG payloads.
const header = Buffer.alloc(6 + 16 * ICO_SIZES.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(ICO_SIZES.length, 4);
let offset = header.length;
ICO_SIZES.forEach((size, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(size >= 256 ? 0 : size, e);
  header.writeUInt8(size >= 256 ? 0 : size, e + 1);
  header.writeUInt16LE(1, e + 4); // planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(png[size].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png[size].length;
});
fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), Buffer.concat([header, ...ICO_SIZES.map((s) => png[s])]));
console.log(`Wrote assets/icon.ico (${ICO_SIZES.join(', ')} px) and ${Object.keys(WEB).join(', ')}`);
