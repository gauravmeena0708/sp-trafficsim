import { createProject, validateScenario, parseProject, DIRECTIONS, FLEET } from './model/project.js';
import { Simulation, STEP } from './simulation/engine.js';
import { cycleLength } from './simulation/signals.js';
import { timingCandidates } from './simulation/experiments.js';
import { explainApproach } from './diagnostics/explain.js';
import { NetworkCanvas } from './ui/canvas.js';
import { escapeHTML as esc, format, download, renderResults, comparisonWarnings, resultsAreStale, csvReport, printMetadata } from './ui/reports.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'junction.project.v1';
let project = createProject();
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) project = parseProject(stored);
} catch { /* A damaged or unavailable local store does not prevent a fresh study. */ }
let activeId = project.scenarios[0].id;
let simulation;
let playing = false;
let selectedDirection = 'west';
let accumulator = 0;
let lastFrame = performance.now();
let lastMetrics = 0;
let worker;
let results = [];
let experimentLabel = '';
const active = () => project.scenarios.find(s => s.id === activeId);
const read = (object, path) => path.split('.').reduce((value, key) => value[key], object);
const write = (object, path, value) => {
  const parts = path.split('.');
  const key = parts.pop();
  const target = parts.reduce((value, part) => value[part], object);
  target[key] = value;
};

function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; }
function persist() {
  if (project.scenarios.some(s => validateScenario(s).length)) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...project, results: [] })); }
  catch { notice('Browser storage is unavailable or full. Use Save project to keep a file.', 'error'); }
}

function numberField(label, path, min, max, step = 1) {
  const value = read(active(), path);
  return `<label class="field"><span>${esc(label)}</span><input type="number" data-path="${path}" value="${value}" min="${min}" max="${max}" step="${step}"></label>`;
}
function rangeField(label, path, min, max, unit) {
  const value = read(active(), path);
  return `<div class="field"><div class="field-line"><label for="range-${path}">${esc(label)}</label><label><span class="sr-only">${esc(label)} in ${unit}</span><input type="number" data-path="${path}" value="${value}" min="${min}" max="${max}" step="1"></label></div><input id="range-${path}" type="range" data-path="${path}" value="${value}" min="${min}" max="${max}" step="1" aria-label="${esc(label)} slider (${unit})"></div>`;
}

function renderSettings() {
  $('scenario-select').innerHTML = project.scenarios.map((s, i) => `<option value="${esc(s.id)}" ${s.id === activeId ? 'selected' : ''}>${String(i + 1).padStart(2, '0')} / ${esc(s.name)}</option>`).join('');
  $('settings-form').innerHTML = `
    <label class="field">Scenario name<input type="text" data-path="name" value="${esc(active().name)}" maxlength="80"></label>
    <section class="settings-section"><div class="section-title"><h3>Road layout</h3><span class="section-number">01</span></div>
      ${rangeField('Approach length (m)', 'geometry.length', 100, 600, 'metres')}
      <div class="input-grid">${numberField('Lanes / direction', 'geometry.lanes', 1, 3)}${numberField('Speed limit (km/h)', 'geometry.speed', 20, 80)}</div>
      <p class="field-hint">Shared dimensions across all four arms. Straight-through routes only.</p>
    </section>
    <section class="settings-section"><div class="section-title"><h3>Signal timings</h3><span class="section-number">02</span></div>
      ${rangeField('East–west green (s)', 'signals.eastWest', 5, 300, 'seconds')}
      ${rangeField('North–south green (s)', 'signals.northSouth', 5, 300, 'seconds')}
      <div class="input-grid">${numberField('Yellow / phase (s)', 'signals.yellow', 3, 10)}${numberField('All-red / phase (s)', 'signals.allRed', 2, 10)}</div>
      <p class="field-hint">Fixed-time, two-phase signals. Transition intervals remain separate from green time.</p><div class="timing-summary"><span>Total cycle</span><strong id="settings-cycle">${cycleLength(active().signals)} seconds</strong></div>
    </section>
    <section class="settings-section"><div class="section-title"><h3>Traffic demand</h3><span class="section-number">03</span></div><div class="input-grid">${DIRECTIONS.map(d => numberField(`${d[0].toUpperCase() + d.slice(1)} (veh/h)`, `demand.${d}`, 0, 3600)).join('')}</div>
      <label class="field" style="margin-top:12px">Demand assumption<select data-path="demand.multiplier"><option value="0.75" ${active().demand.multiplier === .75 ? 'selected' : ''}>Low · 0.75×</option><option value="1" ${active().demand.multiplier === 1 ? 'selected' : ''}>Central · 1.00×</option><option value="1.25" ${active().demand.multiplier === 1.25 ? 'selected' : ''}>High · 1.25×</option>${![.75, 1, 1.25].includes(active().demand.multiplier) ? `<option selected value="${active().demand.multiplier}">Custom · ${active().demand.multiplier}×</option>` : ''}</select></label>
      <p class="field-hint">Growth sensitivity only. Population-to-trip estimation is planned.</p>
    </section>
    <section class="settings-section"><div class="section-title"><h3>Vehicle mix</h3><span class="section-number">04</span></div><div class="input-grid">${Object.entries(FLEET).map(([key, spec]) => numberField(`${spec.label} (%)`, `fleet.${key}`, 0, 100)).join('')}</div><p id="fleet-total" class="field-hint">Total: 100% · shares must add up to 100</p></section>
    <section class="settings-section"><div class="section-title"><h3>Run settings</h3><span class="section-number">05</span></div><div class="input-grid">${numberField('Duration (s)', 'run.duration', 120, 3600)}${numberField('Warm-up (s)', 'run.warmup', 0, 3540)}${numberField('Random seed', 'run.seed', 1, 2147483647)}</div><p class="field-hint">Batch runs increment this seed. Warm-up vehicles stay in the model.</p></section>`;
}

function validate() {
  const errors = validateScenario(active());
  $('validation').hidden = !errors.length;
  $('validation').textContent = errors.join(' ');
  $('play-button').disabled = !!errors.length;
  $('duplicate-button').disabled = !!errors.length || project.scenarios.length >= 30;
  return !errors.length;
}

function resetSimulation() {
  playing = false;
  accumulator = 0;
  if (validate()) simulation = new Simulation(active());
  refreshMetrics();
}

function selectApproach(direction) {
  selectedDirection = direction;
  renderer.selected = direction;
  document.querySelectorAll('[data-direction]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.direction === direction)));
  refreshMetrics();
}

const renderer = new NetworkCanvas($('network-canvas'), selectApproach);

function refreshMetrics() {
  if (!simulation) return;
  const r = simulation.result();
  const phase = simulation.snapshot().phase;
  $('metric-completed').textContent = r.completed;
  $('metric-queue').innerHTML = `${format(r.maxQueue, 0)} <small>m</small>`;
  $('metric-requested').textContent = r.requested;
  $('metric-network').textContent = r.inNetwork;
  $('metric-waiting').textContent = r.waiting;
  $('run-state').textContent = !validateScenario(active()).length ? (simulation.done ? 'Complete' : simulation.time < active().run.warmup ? 'Warm-up' : playing ? 'Running' : 'Paused') : 'Invalid inputs';
  $('play-button').textContent = simulation.done ? '↺ Run again' : playing ? 'Ⅱ Pause' : '▶ Run simulation';
  const clock = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  $('simulation-time').textContent = `${clock(simulation.time)} / ${clock(simulation.scenario.run.duration)}`;
  const percent = simulation.time / simulation.scenario.run.duration * 100;
  $('timeline-fill').style.width = `${percent}%`;
  document.querySelector('.timeline').setAttribute('aria-valuenow', String(Math.round(percent)));
  $('phase-label').textContent = phase.group === 'all' ? 'All-red clearance' : `${phase.group === 'eastWest' ? 'East–west' : 'North–south'} ${phase.colour}`;
  $('phase-countdown').textContent = `${Math.ceil(phase.remaining)}s remaining`;
  $('cycle-label').textContent = `Cycle: ${cycleLength(simulation.scenario.signals)}s`;
  $('approach-title').textContent = `${selectedDirection[0].toUpperCase() + selectedDirection.slice(1)} approach`;
  $('diagnostic-list').innerHTML = explainApproach(simulation, selectedDirection).map(d => `<div class="diagnostic"><h4>${esc(d.title)}</h4><p>${esc(d.detail)}</p></div>`).join('');
}

function refreshWarnings() {
  const warnings = comparisonWarnings(results);
  const stale = resultsAreStale(results, project.scenarios);
  if (stale) warnings.unshift('Inputs have changed since this experiment. These results describe the recorded inputs; run again to compare the current scenarios.');
  $('comparison-warning').hidden = !warnings.length;
  $('comparison-warning').textContent = warnings.join(' ');
}

$('settings-form').addEventListener('submit', event => event.preventDefault());
$('settings-form').addEventListener('input', event => {
  const { path } = event.target.dataset;
  if (!path) return;
  const value = path === 'name' ? event.target.value : event.target.value === '' ? NaN : Number(event.target.value);
  write(active(), path, value);
  document.querySelectorAll('[data-path]').forEach(control => { if (control !== event.target && control.dataset.path === path) control.value = value; });
  if (path === 'name') {
    $('scenario-select').selectedOptions[0].textContent = active().name;
  } else resetSimulation();
  const total = Object.keys(FLEET).reduce((sum, key) => sum + active().fleet[key], 0);
  $('fleet-total').textContent = `Total: ${format(total, 0)}% · shares must add up to 100`;
  $('settings-cycle').textContent = `${format(cycleLength(active().signals), 0)} seconds`;
  validate();
  refreshWarnings();
  persist();
  notice('Inputs changed. Run the simulation to evaluate this version.');
});

$('scenario-select').addEventListener('change', event => {
  activeId = event.target.value;
  renderSettings(); resetSimulation();
  notice(`Opened ${active().name}.`);
});
$('duplicate-button').addEventListener('click', () => {
  if (!validate() || project.scenarios.length >= 30) return;
  const copy = structuredClone(active());
  copy.id = crypto.randomUUID();
  copy.name = `${copy.name.slice(0, 58)} · alternative`;
  project.scenarios.push(copy); activeId = copy.id;
  renderSettings(); resetSimulation(); persist();
  notice('Alternative created. Change its settings, then compare it with the baseline.', 'success');
});
$('play-button').addEventListener('click', () => {
  if (!validate()) return;
  if (simulation.done) resetSimulation();
  playing = !playing;
  lastFrame = performance.now();
  refreshMetrics();
  notice(playing ? 'Simulation running. Metrics update live; completed trips exclude vehicles still travelling.' : 'Simulation paused.');
});
$('reset-button').addEventListener('click', () => { resetSimulation(); notice('Run reset with the same seed and inputs.'); });
document.querySelectorAll('[data-direction]').forEach(button => button.addEventListener('click', () => selectApproach(button.dataset.direction)));

function changeView(view) {
  if (view === 'compare') { playing = false; refreshMetrics(); }
  for (const name of ['design', 'compare']) {
    $(`${name}-panel`).hidden = name !== view;
    $(`tab-${name}`).setAttribute('aria-selected', String(name === view));
    $(`tab-${name}`).tabIndex = name === view ? 0 : -1;
  }
}
document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => changeView(button.dataset.view));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const view = event.key === 'Home' ? 'design' : event.key === 'End' ? 'compare' : button.dataset.view === 'design' ? 'compare' : 'design';
    changeView(view); $(`tab-${view}`).focus();
  });
});

$('save-button').addEventListener('click', () => {
  const errors = project.scenarios.flatMap(s => validateScenario(s));
  if (errors.length) { notice(`Fix inputs before saving: ${errors[0]}`, 'error'); return; }
  persist();
  download('junction-study.json', JSON.stringify({ ...project, results }, null, 2));
  notice('Project downloaded. Recorded experiment inputs are included; imported results must be regenerated.', 'success');
});
$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('Project is larger than the 5 MB import limit.');
    const imported = parseProject(await file.text());
    stopExperiment();
    project = imported; activeId = project.scenarios[0].id; results = [];
    $('results-table').textContent = 'Project opened. Re-run comparisons to generate verified local results.';
    $('results-chart').hidden = true;
    $('csv-button').disabled = true; $('report-button').disabled = true;
    renderSettings(); resetSimulation(); refreshWarnings(); persist();
    notice('Project opened. Imported results are not trusted; run scenarios again.', 'success');
  } catch (error) { notice(`Could not open project: ${error.message}`, 'error'); }
  event.target.value = '';
});

function setBusy(busy) {
  $('compare-button').disabled = busy;
  $('sweep-button').disabled = busy;
  $('cancel-button').hidden = !busy;
}
function stopExperiment() { worker?.terminate(); worker = null; setBusy(false); }
function startExperiment(request, label) {
  const invalid = project.scenarios.flatMap(s => validateScenario(s));
  if (invalid.length) { notice(`Fix scenario inputs: ${invalid[0]}`, 'error'); return; }
  stopExperiment(); playing = false;
  try { worker = new Worker(new URL('./simulation/worker.js', import.meta.url), { type: 'module' }); }
  catch (error) { notice(`Could not start the simulation worker: ${error.message}`, 'error'); return; }
  experimentLabel = label;
  setBusy(true);
  $('experiment-status').textContent = `${label} · running in a background worker…`;
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') $('experiment-status').textContent = `${label} · ${data.completed} / ${data.total} alternatives complete`;
    if (data.type === 'error') { stopExperiment(); $('experiment-status').textContent = `Experiment failed: ${data.message}`; notice(data.message, 'error'); }
    if (data.type === 'complete') {
      results = data.results;
      stopExperiment();
      renderResults(results, $('results-table'), $('results-chart'));
      refreshWarnings();
      $('experiment-status').textContent = `${label} · ${results.length} alternatives · ${request.count} seeds each · illustrative`;
      $('csv-button').disabled = false; $('report-button').disabled = false;
      notice('Experiment complete. Read waiting demand and completion counts alongside delay.', 'success');
    }
  };
  worker.onerror = event => { stopExperiment(); $('experiment-status').textContent = 'Experiment failed to load.'; notice(`Worker error: ${event.message}. Serve the app over HTTP rather than opening the HTML file directly.`, 'error'); };
  worker.postMessage({ ...request, count: Number($('replications').value) });
}
$('compare-button').addEventListener('click', () => {
  if (project.scenarios.length < 2) { notice('Create an alternative with Duplicate in the design view before comparing.', 'error'); return; }
  startExperiment({ type: 'compare', scenarios: structuredClone(project.scenarios), count: Number($('replications').value) }, 'Scenario comparison');
});
$('sweep-button').addEventListener('click', () => {
  const start = Number($('sweep-start').value), end = Number($('sweep-end').value), increment = Number($('sweep-step').value);
  try { timingCandidates(start, end, increment); }
  catch (error) { notice(error.message, 'error'); return; }
  startExperiment({ type: 'sweep', scenario: structuredClone(active()), start, end, increment, count: Number($('replications').value) }, 'East–west timing sweep');
});
$('cancel-button').addEventListener('click', () => { stopExperiment(); $('experiment-status').textContent = `${experimentLabel} cancelled. Any displayed results are from the previous completed experiment.`; notice('Experiment cancelled.'); });
$('csv-button').addEventListener('click', () => download('junction-results.csv', csvReport(results), 'text/csv;charset=utf-8'));
$('report-button').addEventListener('click', () => {
  let metadata = $('report-metadata');
  if (!metadata) { metadata = document.createElement('pre'); metadata.id = 'report-metadata'; metadata.hidden = true; $('compare-panel').prepend(metadata); }
  metadata.textContent = printMetadata(results) + (resultsAreStale(results, project.scenarios) ? '\nCAUTION: current scenario inputs have changed since these results were generated.' : '');
  window.print();
});
$('help-button').addEventListener('click', () => $('about-dialog').showModal());
$('close-help').addEventListener('click', () => $('about-dialog').close());
$('close-help-primary').addEventListener('click', () => $('about-dialog').close());

function frame(now) {
  const elapsed = Math.min(.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing && simulation && !simulation.done) {
    accumulator += elapsed * Number($('speed-select').value);
    while (accumulator >= STEP && !simulation.done) { simulation.step(); accumulator -= STEP; }
    if (simulation.done) { playing = false; notice('Run complete. Duplicate this scenario or compare its signal timings.', 'success'); }
  }
  if (!$('design-panel').hidden && simulation) renderer.draw(simulation);
  if (now - lastMetrics > 200) { refreshMetrics(); lastMetrics = now; }
  requestAnimationFrame(frame);
}

renderSettings();
resetSimulation();
selectApproach(selectedDirection);
requestAnimationFrame(frame);
