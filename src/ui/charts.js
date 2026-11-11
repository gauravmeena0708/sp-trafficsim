// Small SVG line charts for time series: one y-axis, thin 2px lines in fixed
// categorical order, a crosshair tooltip listing every series, a legend for two
// or more series (plus direct end labels up to four), and a table view.
// Labels are inserted with textContent: scenario names are user data.

const SVG = 'http://www.w3.org/2000/svg';
export const MAX_SERIES = 8;
const el = (tag, attrs = {}, parent) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};
const clock = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const niceMax = value => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map(m => m * power).find(m => m >= value);
};

/**
 * @param {HTMLElement} container
 * @param {{ title: string, unit: string, time: number[], series: { name: string, values: number[] }[],
 *           digits?: number, threshold?: { value: number, label: string }, bands?: { start: number, end: number }[],
 *           compact?: boolean, note?: string }} spec
 */
export function lineChart(container, spec) {
  const { time, unit, digits = 0, compact = false } = spec;
  const series = spec.series.slice(0, MAX_SERIES);
  container.replaceChildren();
  container.classList.add('line-chart');
  if (!compact) {
    const heading = document.createElement('h4');
    heading.textContent = spec.title;
    const units = document.createElement('span');
    units.className = 'subtle';
    units.textContent = ` / ${unit}`;
    heading.append(units);
    container.append(heading);
  }
  if (series.length > 1) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    series.forEach((s, i) => {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.background = `var(--series-${i + 1})`;
      item.append(swatch, document.createTextNode(s.name));
      legend.append(item);
    });
    container.append(legend);
  }
  const plot = document.createElement('div');
  plot.className = 'chart-plot';
  container.append(plot);
  const width = Math.max(240, Math.round(container.clientWidth || 600));
  const height = compact ? 92 : 190;
  const labelRoom = series.length > 1 && series.length <= 4 && !compact ? 96 : 8;
  const pad = { top: 10, right: labelRoom, bottom: compact ? 16 : 22, left: compact ? 30 : 40 };
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${spec.title}, ${unit}, over simulated time` }, plot);
  const tMax = time.at(-1) ?? 1;
  const yMax = niceMax(Math.max(spec.threshold?.value ?? 0, ...series.flatMap(s => s.values)) * 1.05);
  const x = t => pad.left + (t / tMax) * (width - pad.left - pad.right);
  const y = v => height - pad.bottom - (v / yMax) * (height - pad.top - pad.bottom);
  for (const band of spec.bands ?? []) {
    el('rect', { x: x(band.start), y: pad.top, width: Math.max(1, x(Math.min(band.end, tMax)) - x(band.start)), height: height - pad.top - pad.bottom, class: 'chart-band' }, svg);
  }
  for (const fraction of [0, 0.5, 1]) {
    const v = yMax * fraction;
    el('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: 'chart-grid' }, svg);
    const label = el('text', { x: pad.left - 5, y: y(v) + 3, 'text-anchor': 'end', class: 'chart-tick' }, svg);
    label.textContent = v.toLocaleString('en', { maximumFractionDigits: 1 });
  }
  for (const t of [0, tMax / 2, tMax]) {
    const label = el('text', { x: x(t), y: height - 5, 'text-anchor': t === 0 ? 'start' : t === tMax ? 'end' : 'middle', class: 'chart-tick' }, svg);
    label.textContent = clock(t);
  }
  if (spec.threshold) {
    el('line', { x1: pad.left, x2: width - pad.right, y1: y(spec.threshold.value), y2: y(spec.threshold.value), class: 'chart-threshold' }, svg);
    const label = el('text', { x: width - pad.right, y: y(spec.threshold.value) - 4, 'text-anchor': 'end', class: 'chart-tick' }, svg);
    label.textContent = spec.threshold.label;
  }
  series.forEach((s, i) => {
    const points = s.values.map((v, k) => `${x(time[k]).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    el('polyline', { points, fill: 'none', stroke: `var(--series-${i + 1})`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  });
  if (labelRoom > 8) {
    // Direct end labels, nudged apart so they never overlap.
    const ends = series.map((s, i) => ({ i, name: s.name, y: y(s.values.at(-1) ?? 0) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 12);
    for (const end of ends) {
      const label = el('text', { x: width - pad.right + 6, y: end.y + 3, class: 'chart-label' }, svg);
      label.textContent = end.name.length > 16 ? `${end.name.slice(0, 15)}…` : end.name;
    }
  }
  // Crosshair and tooltip: snap to the nearest sample.
  const cross = el('line', { y1: pad.top, y2: height - pad.bottom, class: 'chart-crosshair', visibility: 'hidden' }, svg);
  const dots = series.map((_, i) => el('circle', { r: 4, fill: `var(--series-${i + 1})`, stroke: 'var(--chart-surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.hidden = true;
  plot.append(tip);
  const hit = el('rect', { x: pad.left, y: 0, width: width - pad.left - pad.right, height, fill: 'transparent', tabindex: 0, 'aria-label': `${spec.title}: use arrow keys to read values` }, svg);
  let index = null;
  const show = k => {
    index = Math.max(0, Math.min(time.length - 1, k));
    const px = x(time[index]);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    dots.forEach((dot, i) => { dot.setAttribute('cx', px); dot.setAttribute('cy', y(series[i].values[index])); dot.setAttribute('visibility', 'visible'); });
    tip.replaceChildren();
    const when = document.createElement('div');
    when.className = 'chart-tooltip-time';
    when.textContent = clock(time[index]);
    tip.append(when);
    series.forEach((s, i) => {
      const row = document.createElement('div');
      const swatch = document.createElement('i');
      swatch.style.background = `var(--series-${i + 1})`;
      const value = document.createElement('strong');
      value.textContent = `${s.values[index].toLocaleString('en', { maximumFractionDigits: digits })} ${unit}`;
      const name = document.createElement('span');
      name.textContent = s.name;
      row.append(swatch, value, name);
      tip.append(row);
    });
    tip.hidden = false;
    tip.style.left = `${Math.min(px + 12, width - 200)}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); tip.hidden = true; };
  hit.addEventListener('pointermove', event => {
    const rect = svg.getBoundingClientRect();
    const t = ((event.clientX - rect.left) * (width / rect.width) - pad.left) / (width - pad.left - pad.right) * tMax;
    let best = 0;
    for (let k = 1; k < time.length; k++) if (Math.abs(time[k] - t) < Math.abs(time[best] - t)) best = k;
    show(best);
  });
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const last = time.length - 1;
    show(event.key === 'Home' ? 0 : event.key === 'End' ? last : (index ?? 0) + (event.key === 'ArrowRight' ? 1 : -1));
  });
  if (spec.note) {
    const note = document.createElement('p');
    note.className = 'chart-note';
    note.textContent = spec.note;
    container.append(note);
  }
  if (!compact) container.append(tableView(spec.title, unit, time, series, digits));
}

// Table alternative: one row per minute (or per sample if the run is short).
function tableView(title, unit, time, series, digits) {
  const details = document.createElement('details');
  details.className = 'chart-table';
  const summary = document.createElement('summary');
  summary.textContent = 'Show as table';
  const table = document.createElement('table');
  const caption = document.createElement('caption');
  caption.className = 'sr-only';
  caption.textContent = `${title} (${unit})`;
  const head = document.createElement('tr');
  for (const label of ['Time', ...series.map(s => s.name)]) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; head.append(th); }
  const thead = document.createElement('thead'); thead.append(head);
  const tbody = document.createElement('tbody');
  const step = Math.max(1, Math.round(60 / Math.max(1, (time[1] ?? 60) - (time[0] ?? 0))));
  for (let k = step - 1; k < time.length; k += step) {
    const row = document.createElement('tr');
    const cells = [clock(time[k]), ...series.map(s => s.values[k].toLocaleString('en', { maximumFractionDigits: digits }))];
    for (const text of cells) { const td = document.createElement('td'); td.textContent = text; row.append(td); }
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  details.append(summary, table);
  return details;
}
