import { fingerprint, ENGINE_VERSION } from '../model/project.js';

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

export function renderResults(results, table, chart) {
  table.innerHTML = `<table><caption class="sr-only">Mean and sample standard deviation across repeated seeds</caption><thead><tr><th scope="col">Alternative</th><th scope="col">Accrued delay / request (s)</th><th scope="col">Completed-trip time (s)</th><th scope="col">Max queue (m)</th><th scope="col">Waiting outside</th><th scope="col">Completed trips</th><th scope="col">Runs</th></tr></thead><tbody>${results.map(r => `<tr><td>${escapeHTML(r.name)}</td><td>${stat(r.delay)}</td><td>${stat(r.journey)}</td><td>${stat(r.queue)}</td><td>${stat(r.waiting)}</td><td>${stat(r.completed)}</td><td>${r.runs.length}</td></tr>`).join('')}</tbody></table>`;
  const max = Math.max(1, ...results.map(r => r.delay.mean ?? 0));
  chart.hidden = false;
  chart.innerHTML = `<h3>Accrued delay per requested vehicle <span class="subtle">/ seconds · unfinished demand included</span></h3>${results.map(r => `<div class="bar-row"><span>${escapeHTML(r.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, (r.delay.mean ?? 0) / max * 100)}%"></div></div><span>${format(r.delay.mean)} s</span></div>`).join('')}`;
}

export function comparisonWarnings(results) {
  if (results.length < 2) return [];
  const warnings = [];
  for (const key of ['demand', 'fleet', 'run']) {
    if (results.some(r => JSON.stringify(r.inputs[key]) !== JSON.stringify(results[0].inputs[key]))) warnings.push(`${key === 'run' ? 'Run settings' : key[0].toUpperCase() + key.slice(1)} differ between alternatives; this is not a controlled infrastructure-only comparison.`);
  }
  return warnings;
}

export function resultsAreStale(results, scenarios) {
  return results.some(r => {
    const current = scenarios.find(s => s.id === r.scenarioId);
    // Sweeps deliberately vary only the east–west green and display name.
    if (!current) return true;
    const expected = structuredClone(current);
    if (r.green !== undefined) expected.signals.eastWest = r.green;
    return fingerprint(expected) !== fingerprint(r.inputs);
  });
}

export function csvReport(results) {
  const rows = [['scenario', 'engine', 'seed', 'duration_s', 'warmup_s', 'ew_green_s', 'ns_green_s', 'accrued_delay_per_request_s', 'accrued_delay_per_person_s', 'completed_trip_mean_s', 'completed_trip_p95_s', 'max_queue_m', 'requested_total', 'admitted_total', 'completed_total', 'in_network', 'waiting_outside', 'measured_requested', 'measured_completed', 'inputs_json']];
  for (const result of results) for (const r of result.runs) rows.push([result.name, r.engineVersion, r.seed, r.inputs.run.duration, r.inputs.run.warmup, r.inputs.signals.eastWest, r.inputs.signals.northSouth, r.accruedDelayPerRequest, r.accruedDelayPerPerson, r.meanJourney, r.p95Journey, r.maxQueue, r.requested, r.admitted, r.completed, r.inNetwork, r.waiting, r.measuredRequested, r.measuredCompleted, JSON.stringify(r.inputs)]);
  // Prevent spreadsheet formula execution in user-supplied scenario names.
  return rows.map(row => row.map(value => {
    const text = String(value ?? '');
    return `"${(/^[=+@\-\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
}

export function printMetadata(results) {
  return `JUNCTION — ILLUSTRATIVE PLANNING REPORT\nEngine: ${ENGINE_VERSION}\nGenerated: ${new Date().toISOString()}\nUncalibrated straight-through junction model. No turns, lane changes, pedestrian service or bus dwell.\nStatistics: mean ± sample SD, not confidence intervals. Journey times describe completed measured trips only.\nAccrued delay includes unfinished measured demand and boundary waiting. Queue threshold: speed < 2 m/s.\n${comparisonWarnings(results).join('\n')}\n\n${results.map(r => `${r.name}\nSeeds: ${r.runs.map(x => x.seed).join(', ')}\nInputs: ${JSON.stringify(r.inputs)}\nAccounting per run: ${r.runs.map(x => `requested ${x.requested} = completed ${x.completed} + network ${x.inNetwork} + outside ${x.waiting}`).join('; ')}`).join('\n\n')}`;
}
