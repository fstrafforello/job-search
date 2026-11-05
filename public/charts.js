import { esc, $ } from './util.js';

function topRoundedBar(x, y, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / step) * step;
}

// Vertical single-series bar chart. data: [{label, value, tip, current}]
export function columnChart(data, { height = 200, unit = '' } = {}) {
  const W = 640;
  const H = height;
  const pad = { t: 10, r: 4, b: 24, l: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const slot = iw / data.length;
  const bw = Math.min(36, slot - 2); // 2px surface gap between neighbours at minimum
  const ticks = [0, max / 2, max];
  const labelEvery = data.length > 8 ? 2 : 1;

  const grid = ticks.map((t) => {
    const y = pad.t + ih - (t / max) * ih;
    return `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>
      <text class="axis-label" x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${Number.isInteger(t) ? t : t.toFixed(1)}</text>`;
  }).join('');

  const bars = data.map((d, i) => {
    const x = pad.l + i * slot + (slot - bw) / 2;
    const h = (d.value / max) * ih;
    const y = pad.t + ih - h;
    const tip = esc(d.tip || `${d.label}: ${d.value}${unit}`);
    const label = (data.length - 1 - i) % labelEvery === 0
      ? `<text class="axis-label" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>` : '';
    return `<g data-tip="${tip}">
      <rect class="hit" x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${ih}"/>
      ${d.value > 0 ? `<path class="bar${d.current ? ' current' : ''}" d="${topRoundedBar(x, y, bw, h)}"/>` : ''}
      ${label}</g>`;
  }).join('');

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">${grid}${bars}</svg></div>`;
}

// Horizontal bars as HTML; every bar carries a visible label and value.
export function barList(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar" data-tip="${esc(r.tip || `${r.label}: ${r.value}`)}">
      <span class="pill" style="--c:${r.color}">${esc(r.label)}</span>
      <div class="track"><div class="fill" style="width:${(r.value / max) * 100}%;background:${r.color}"></div></div>
      <span class="n">${r.value}</span>
    </div>`).join('')}</div>`;
}

// One shared tooltip for every [data-tip] element.
export function installTooltips() {
  const tip = $('#tooltip');
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = (el.querySelector('.bar') || el).getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top}px`;
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, true);
}
