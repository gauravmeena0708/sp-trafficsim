import { fingerprint, ENGINE_VERSION } from '../model/project.js';
import { sweepFindings } from '../simulation/experiments.js';
import { lineChart, MAX_SERIES } from './charts.js';

export const format = (value, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: digits });
export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
}
export function download(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stat = (s, unit = '') => `${format(s.mean)}${s.sd === null ? '' : ` ± ${format(s.sd)}`}${unit}`;
const signed = value => (Number.isFinite(value) && value > 0 ? '+' : '') + format(value);

export function differenceText(d) {
  if (!d || d.mean === null) return '—';
  return d.low === null ? `${signed(d.mean)} (n=${d.n}, no interval)` : `${signed(d.mean)} [${signed(d.low)}, ${signed(d.high)}]`;
}

function differenceCell(r) {
  if (r.baseline) return 'Baseline';
  if (r.differenceNote) return escapeHTML(r.differenceNote);
  if (!r.differences) return '—';
  const d = r.differences;
  return `Delay ${differenceText(d.accruedDelayPerRequest)} s<br>Waiting ${differenceText(d.waiting)}<br>Completed ${differenceText(d.completed)}<br>Persistent queue ${differenceText(d.persistentQueueSeconds)} s`;
}

function findingsHTML(results) {
  const { best, changesWithDemand } = sweepFindings(results);
  if (!best.length) return '';
  const items = best.map(b => `<li>${format(b.multiplier, 2)}× demand: lowest mean accrued delay at ${b.green ?? '—'} s (${format(b.delay)} s/request, ${format(b.waiting)} waiting outside)</li>`).join('');
  return `<div class="sweep-findings"><h4>Lowest-delay candidate by demand level</h4><ul>${items}</ul>${changesWithDemand ? '<p><strong>The preferred green changes with demand.</strong> Do not generalise a timing choice from one demand level.</p>' : ''}<p class="subtle">Lowest mean delay is one indicator only; compare queues, waiting demand and completed trips before preferring a candidate.</p></div>`;
}

export function renderResults(results, table, chart) {
  const hasDiffs = results.some(r => r.baseline);
  table.innerHTML = `<table><caption class="sr-only">Mean and sample standard deviation across repeated seeds</caption><thead><tr><th scope="col">Alternative</th><th scope="col">Accrued delay / request (s)</th><th scope="col">Completed-trip time (s)</th><th scope="col">Max queue (m)</th><th scope="col">Waiting outside</th><th scope="col">Completed trips</th><th scope="col">Persistent queue (link-min)</th><th scope="col">Unresolved at end</th><th scope="col">Runs</th>${hasDiffs ? '<th scope="col">Paired change vs baseline, mean [95% CI]</th>' : ''}</tr></thead><tbody>${results.map(r => `<tr><td>${escapeHTML(r.name)}</td><td>${stat(r.delay)}</td><td>${stat(r.journey)}</td><td>${stat(r.queue)}</td><td>${stat(r.waiting)}</td><td>${stat(r.completed)}</td><td>${r.persistent ? stat({ mean: r.persistent.mean === null ? null : r.persistent.mean / 60, sd: r.persistent.sd === null ? null : r.persistent.sd / 60 }) : '—'}</td><td>${r.unresolved ? stat(r.unresolved) : '—'}</td><td>${r.runs.length}</td>${hasDiffs ? `<td>${differenceCell(r)}</td>` : ''}</tr>`).join('')}</tbody></table>${findingsHTML(results)}`;
  const max = Math.max(1, ...results.map(r => r.delay.mean ?? 0));
  chart.hidden = false;
  chart.innerHTML = `<h3>Accrued delay per requested vehicle <span class="subtle">/ seconds · unfinished demand included</span></h3>${results.map(r => `<div class="bar-row"><span>${escapeHTML(r.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, (r.delay.mean ?? 0) / max * 100)}%"></div></div><span>${format(r.delay.mean)} s</span></div>`).join('')}`;
}

// Time-series charts for scenario comparisons (not sweeps, whose dozens of
// candidates would exceed the categorical palette). Mean across seeds.
export function renderTimeCharts(results, container) {
  const usable = results.filter(r => r.series && !r.sweep);
  container.replaceChildren();
  container.hidden = !usable.length;
  if (!usable.length) return;
  const shown = usable.slice(0, MAX_SERIES);
  const sameClock = shown.every(r => r.series.time.length === shown[0].series.time.length);
  if (!sameClock) { container.textContent = 'Time charts need alternatives with the same run duration.'; return; }
  const note = `Mean across ${shown[0].series.seeds} seed${shown[0].series.seeds > 1 ? 's' : ''} at each ${shown[0].series.interval} s sample.${usable.length > shown.length ? ` Showing the first ${shown.length} of ${usable.length} alternatives; the table lists all.` : ''}`;
  const queue = document.createElement('div');
  const waiting = document.createElement('div');
  container.append(queue, waiting);
  lineChart(queue, { title: 'Longest approach queue over time', unit: 'm', time: shown[0].series.time, series: shown.map(r => ({ name: r.name, values: r.series.maxQueue })), note });
  lineChart(waiting, { title: 'Vehicles waiting to enter over time', unit: 'vehicles', digits: 1, time: shown[0].series.time, series: shown.map(r => ({ name: r.name, values: r.series.waiting })),
    note: 'Demand that could not yet enter the study area. A rising line means the design is not keeping up.' });
}

export function comparisonWarnings(results) {
  if (results.length < 2) return [];
  const warnings = [];
  const isSweep = results.every(r => r.sweep);
  // Sweeps vary the demand multiplier on purpose; compare the rest of the demand.
  const comparable = (r, key) => key === 'demand' && isSweep ? { ...r.inputs.demand, multiplier: 0 } : r.inputs[key];
  for (const key of ['demand', 'fleet', 'run']) {
    if (results.some(r => JSON.stringify(comparable(r, key)) !== JSON.stringify(comparable(results[0], key)))) warnings.push(`${key === 'run' ? 'Run settings' : key[0].toUpperCase() + key.slice(1)} differ between alternatives; this is not a controlled infrastructure-only comparison.`);
  }
  if (isSweep && sweepFindings(results).changesWithDemand) warnings.push('The lowest-delay green time differs between demand levels.');
  return warnings;
}

export function resultsAreStale(results, scenarios) {
  return results.some(r => {
    const current = scenarios.find(s => s.id === r.scenarioId);
    // Sweeps deliberately vary one green time, the demand multiplier and the display name.
    if (!current) return true;
    const expected = structuredClone(current);
    if (r.sweep) { expected.signals[r.sweep.group] = r.sweep.green; expected.demand.multiplier = r.sweep.multiplier; }
    return fingerprint(expected) !== fingerprint(r.inputs);
  });
}

export function csvReport(results) {
  const rows = [['scenario', 'engine', 'seed', 'duration_s', 'warmup_s', 'ew_green_s', 'ns_green_s', 'demand_multiplier', 'accrued_delay_per_request_s', 'accrued_delay_per_person_s', 'completed_trip_mean_s', 'completed_trip_p95_s', 'max_queue_m', 'requested_total', 'admitted_total', 'completed_total', 'in_network', 'waiting_outside', 'measured_requested', 'measured_completed', 'persistent_queue_s', 'unresolved_queues', 'queue_events', 'inputs_json']];
  for (const result of results) for (const r of result.runs) rows.push([result.name, r.engineVersion, r.seed, r.inputs.run.duration, r.inputs.run.warmup, r.inputs.signals.eastWest, r.inputs.signals.northSouth, r.inputs.demand.multiplier, r.accruedDelayPerRequest, r.accruedDelayPerPerson, r.meanJourney, r.p95Journey, r.maxQueue, r.requested, r.admitted, r.completed, r.inNetwork, r.waiting, r.measuredRequested, r.measuredCompleted, r.persistentQueueSeconds, r.unresolvedQueues, (r.queueEvents ?? []).map(e => `${e.link}@${e.start}-${e.end ?? 'end'}`).join(' '), JSON.stringify(r.inputs)]);
  // Prevent spreadsheet formula execution in user-supplied scenario names.
  return rows.map(row => row.map(value => {
    const text = String(value ?? '');
    return `"${(/^[=+@\-\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
}

export function printMetadata(results) {
  const differences = results.filter(r => r.differences).map(r => `${r.name} vs ${results[0].name}: delay ${differenceText(r.differences.accruedDelayPerRequest)} s; waiting ${differenceText(r.differences.waiting)}; completed ${differenceText(r.differences.completed)}`);
  return `JUNCTION — ILLUSTRATIVE PLANNING REPORT\nEngine: ${ENGINE_VERSION}\nGenerated: ${new Date().toISOString()}\nUncalibrated lane model. See model assumptions for omitted behaviour.\nStatistics: mean ± sample SD across seeds. Paired changes vs the baseline use matched seeds with t-based 95% intervals; they describe run-to-run variation only, not uncertainty in demand or behaviour inputs.\nPersistent queues: an approach whose queued vehicles at the start of green are not all cleared by its end, for 2+ consecutive cycles (60 s windows at roundabouts).\nJourney times describe completed measured trips only. Accrued delay includes unfinished measured demand and boundary waiting. Queue threshold: speed < 2 m/s.\n${comparisonWarnings(results).join('\n')}\n${differences.join('\n')}\n\n${results.map(r => `${r.name}\nSeeds: ${r.runs.map(x => x.seed).join(', ')}\nInputs: ${JSON.stringify(r.inputs)}\nAccounting per run: ${r.runs.map(x => `requested ${x.requested} = completed ${x.completed} + network ${x.inNetwork} + outside ${x.waiting}`).join('; ')}`).join('\n\n')}`;
}
