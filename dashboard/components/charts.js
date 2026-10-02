// Hand-rolled SVG charts (no library, no inline styles — colours come from CSS classes).
// Follows the dataviz method: thin marks, 2px surface gaps, 4px rounded data-ends,
// hairline grid, legend for >= 2 series, hover + keyboard tooltip, table-view twin.

import { escape, html, mount } from '../lib/html.js';

const PLOT_H = 220;
const X_BAND = 28;
const PAD_TOP = 18;
const PAD_RIGHT = 14;

const shortDate = (d) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const longDate = (d) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

/** Round tick steps (1, 2, 2.5, 5 × 10^n) covering [0, max]. */
function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
  return ticks;
}

function legend(series) {
  if (series.length < 2) return '';
  return html`<ul class="legend">${series.map((s) => html`<li><span class="swatch series-${s.slot}"></span>${s.label}</li>`)}</ul>`;
}

function tableView(categories, series, formatValue, { total = false } = {}) {
  return html`<details class="table-view"><summary>Show as table</summary>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th>${series.map((s) => html`<th class="right">${s.label}</th>`)}${total ? html`<th class="right">Total</th>` : ''}</tr></thead>
      <tbody>${categories.map(
        (c, i) => html`<tr><td>${shortDate(c)}</td>${series.map((s) => html`<td class="right num">${formatValue(s.values[i])}</td>`)}${
          total ? html`<td class="right num">${formatValue(series.reduce((a, s) => a + (s.values[i] ?? 0), 0))}</td>` : ''
        }</tr>`,
      )}</tbody>
    </table></div></details>`;
}

/**
 * Shared shell: legend, focusable plot, tooltip, table. `draw(width)` returns
 * { svg, x(i), tooltip(i) } for the current width.
 */
function chartShell(host, { ariaLabel, series, categories, formatValue, total, draw }) {
  mount(
    host,
    html`<div class="chart">
      ${legend(series)}
      <div class="plot" tabindex="0" role="group" aria-label="${ariaLabel}. Use the arrow keys to read each day.">
        <div class="svg-host"></div>
        <div class="chart-tooltip" role="status" aria-live="polite" hidden></div>
      </div>
      ${tableView(categories, series, formatValue, { total })}
    </div>`,
  );
  const plot = host.querySelector('.plot');
  const svgHost = host.querySelector('.svg-host');
  const tip = host.querySelector('.chart-tooltip');
  let active = -1;
  let current = null;

  const render = () => {
    const width = Math.max(300, Math.floor(svgHost.clientWidth || plot.clientWidth || 600));
    current = draw(width);
    svgHost.innerHTML = current.svg;
    if (active >= 0) show(active);
  };
  const show = (i) => {
    active = Math.max(0, Math.min(categories.length - 1, i));
    mount(tip, current.tooltip(active));
    tip.hidden = false;
    const x = current.x(active);
    const left = Math.min(Math.max(x - tip.offsetWidth / 2, 0), svgHost.clientWidth - tip.offsetWidth);
    tip.style.left = `${left}px`; // CSSOM, allowed by the CSP (unlike inline style attributes)
    svgHost.querySelectorAll('[data-i]').forEach((el) => el.classList.toggle('is-active', Number(el.dataset.i) === active));
    svgHost.querySelector('.crosshair')?.setAttribute('transform', `translate(${x},0)`);
    svgHost.querySelector('.crosshair')?.classList.add('is-visible');
  };
  const hide = () => {
    active = -1;
    tip.hidden = true;
    svgHost.querySelectorAll('.is-active').forEach((el) => el.classList.remove('is-active'));
    svgHost.querySelector('.crosshair')?.classList.remove('is-visible');
  };

  svgHost.addEventListener('pointermove', (e) => {
    const hit = e.target.closest('[data-hit]');
    if (hit) show(Number(hit.dataset.hit));
  });
  svgHost.addEventListener('pointerleave', hide);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      show(active < 0 ? (e.key === 'ArrowRight' ? 0 : categories.length - 1) : active + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (e.key === 'Escape') hide();
  });
  plot.addEventListener('blur', hide);

  render();
  const ro = new ResizeObserver(() => {
    if (!host.isConnected) return ro.disconnect();
    requestAnimationFrame(render);
  });
  ro.observe(svgHost);
}

function yAxis(ticks, y, width, padLeft, formatTick) {
  return ticks
    .map(
      (t) => `<line class="grid" x1="${padLeft}" x2="${width - PAD_RIGHT}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="tick" x="${padLeft - 8}" y="${y(t) + 4}" text-anchor="end">${escape(formatTick(t))}</text>`,
    )
    .join('');
}

function xAxis(categories, x, baseY) {
  const every = Math.max(1, Math.ceil(categories.length / 7));
  return categories
    .map((c, i) => (i % every === 0 || i === categories.length - 1 ? `<text class="tick" x="${x(i)}" y="${baseY + 18}" text-anchor="middle">${escape(shortDate(c))}</text>` : ''))
    .join('');
}

/** Rounded data-end on top (4px), square at the baseline. */
function columnPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Stacked columns per day. Series values must share one unit (one axis — never dual). */
export function columnChart(host, { categories, series, formatValue, formatTick, ariaLabel, emptyMessage }) {
  const totals = categories.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  if (totals.every((t) => t === 0)) {
    mount(host, html`<p class="muted chart-empty">${emptyMessage}</p>`);
    return;
  }
  const ticks = niceTicks(Math.max(...totals));
  const padLeft = 12 + Math.max(...ticks.map((t) => formatTick(t).length)) * 7;
  const peak = totals.indexOf(Math.max(...totals));

  chartShell(host, {
    ariaLabel,
    series,
    categories,
    formatValue,
    total: series.length > 1,
    draw: (width) => {
      const plotW = width - padLeft - PAD_RIGHT;
      const slot = plotW / categories.length;
      const barW = Math.max(3, Math.min(24, slot * 0.62));
      const baseY = PAD_TOP + PLOT_H;
      const top = ticks.at(-1);
      const y = (v) => baseY - (v / top) * PLOT_H;
      const x = (i) => padLeft + slot * i + slot / 2;

      const cols = categories
        .map((_, i) => {
          let acc = 0;
          const nonZero = series.map((s, si) => ({ s, si, v: s.values[i] ?? 0 })).filter((p) => p.v > 0);
          const segs = nonZero
            .map((p, k) => {
              const y0 = y(acc);
              acc += p.v;
              const y1 = y(acc);
              const isTop = k === nonZero.length - 1;
              // 2px surface gap between stacked segments (taken from the lower edge of upper segments).
              const gap = k > 0 ? 2 : 0;
              const h = Math.max(0, y0 - y1 - gap);
              if (h <= 0) return '';
              return isTop
                ? `<path class="mark series-${p.s.slot}" d="${columnPath(x(i) - barW / 2, y1, barW, h, 4)}"/>`
                : `<rect class="mark series-${p.s.slot}" x="${x(i) - barW / 2}" y="${y1}" width="${barW}" height="${h}"/>`;
            })
            .join('');
          return `<g class="col" data-i="${i}">${segs}</g>`;
        })
        .join('');
      const peakLabel = `<text class="direct-label" x="${x(peak)}" y="${y(totals[peak]) - 6}" text-anchor="middle">${escape(formatValue(totals[peak]))}</text>`;
      const hits = categories.map((_, i) => `<rect class="hit" data-hit="${i}" x="${padLeft + slot * i}" y="${PAD_TOP}" width="${slot}" height="${PLOT_H}"/>`).join('');

      return {
        svg: `<svg width="${width}" height="${baseY + X_BAND}" viewBox="0 0 ${width} ${baseY + X_BAND}" aria-hidden="true">
          ${yAxis(ticks, y, width, padLeft, formatTick)}
          <line class="axis" x1="${padLeft}" x2="${width - PAD_RIGHT}" y1="${baseY}" y2="${baseY}"/>
          ${cols}${peakLabel}${xAxis(categories, x, baseY)}${hits}
        </svg>`,
        x,
        tooltip: (i) => html`<strong>${longDate(categories[i])}</strong>
          ${series.map((s) => html`<div class="tt-row"><span class="swatch series-${s.slot}"></span>${s.label}<span class="num">${formatValue(s.values[i] ?? 0)}</span></div>`)}
          ${series.length > 1 ? html`<div class="tt-row tt-total">Total<span class="num">${formatValue(totals[i])}</span></div>` : ''}`,
      };
    },
  });
}

/** One line per series over days; null values break the line (no traffic that day). */
export function lineChart(host, { categories, series, formatValue, formatTick, ariaLabel, emptyMessage, yMin = 0, yMax = 1 }) {
  const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  if (all.length === 0) {
    mount(host, html`<p class="muted chart-empty">${emptyMessage}</p>`);
    return;
  }
  const lo = Math.min(yMin, Math.floor(Math.min(...all) * 10) / 10);
  const ticks = [];
  const step = (yMax - lo) / 4;
  for (let k = 0; k <= 4; k++) ticks.push(lo + step * k);
  const padLeft = 12 + Math.max(...ticks.map((t) => formatTick(t).length)) * 7;
  const lastIdx = (s) => s.values.findLastIndex((v) => v !== null && v !== undefined);

  chartShell(host, {
    ariaLabel,
    series,
    categories,
    formatValue,
    draw: (width) => {
      const labelW = series.length <= 4 ? 64 : 0;
      const plotW = width - padLeft - PAD_RIGHT - labelW;
      const baseY = PAD_TOP + PLOT_H;
      const x = (i) => padLeft + (categories.length === 1 ? plotW / 2 : (plotW * i) / (categories.length - 1));
      const y = (v) => baseY - ((v - lo) / (yMax - lo)) * PLOT_H;

      const lines = series
        .map((s) => {
          let d = '';
          let pen = false;
          s.values.forEach((v, i) => {
            if (v === null || v === undefined) return void (pen = false);
            d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
            pen = true;
          });
          const li = lastIdx(s);
          const end = li >= 0 ? `<circle class="end-dot series-${s.slot}" cx="${x(li)}" cy="${y(s.values[li])}" r="4"/>` : '';
          return `<path class="line series-${s.slot}" d="${d}"/>${end}`;
        })
        .join('');

      // Direct end labels only when they don't collide; otherwise the legend carries identity.
      const ends = series.map((s) => ({ s, li: lastIdx(s) })).filter((e) => e.li >= 0).map((e) => ({ ...e, yy: y(e.s.values[e.li]) }));
      const sorted = [...ends].sort((a, b) => a.yy - b.yy);
      const collide = sorted.some((e, k) => k > 0 && e.yy - sorted[k - 1].yy < 14);
      const endLabels = labelW && !collide
        ? ends.map((e) => `<text class="direct-label" x="${x(e.li) + 8}" y="${e.yy + 4}">${escape(e.s.label)}</text>`).join('')
        : '';

      const crossDots = series
        .map((s) => s.values.map((v, i) => (v === null || v === undefined ? '' : `<circle class="hover-dot series-${s.slot}" data-i="${i}" cx="${x(i)}" cy="${y(v)}" r="4"/>`)).join(''))
        .join('');
      const half = categories.length > 1 ? plotW / (categories.length - 1) / 2 : plotW / 2;
      const hits = categories.map((_, i) => `<rect class="hit" data-hit="${i}" x="${x(i) - half}" y="${PAD_TOP}" width="${half * 2}" height="${PLOT_H}"/>`).join('');

      return {
        svg: `<svg width="${width}" height="${baseY + X_BAND}" viewBox="0 0 ${width} ${baseY + X_BAND}" aria-hidden="true">
          ${yAxis(ticks, y, width - labelW, padLeft, formatTick)}
          <line class="axis" x1="${padLeft}" x2="${width - PAD_RIGHT - labelW}" y1="${baseY}" y2="${baseY}"/>
          <line class="crosshair" x1="0" x2="0" y1="${PAD_TOP}" y2="${baseY}"/>
          ${lines}${crossDots}${endLabels}${xAxis(categories, x, baseY)}${hits}
        </svg>`,
        x,
        tooltip: (i) => html`<strong>${longDate(categories[i])}</strong>
          ${series.map((s) => html`<div class="tt-row"><span class="swatch series-${s.slot}"></span>${s.label}<span class="num">${s.values[i] === null || s.values[i] === undefined ? 'No traffic' : formatValue(s.values[i])}</span></div>`)}`,
      };
    },
  });
}
