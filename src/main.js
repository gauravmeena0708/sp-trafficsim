import { createProject, validateScenario, parseProject, DIRECTIONS, FLEET, APPROACH_FIELDS } from './model/project.js';
import { modelChecks } from './model/checks.js';
import { Simulation, STEP } from './simulation/engine.js';
import { cycleLength } from './simulation/signals.js';
import { TEMPLATES, approachSettings, compileNetwork, configurableApproaches, inboundLinks } from './model/network.js';
import { DEMAND_LEVELS, SWEEP_GROUPS, sweepConfigurations } from './simulation/experiments.js';
import { explainApproach } from './diagnostics/explain.js';
import { NetworkCanvas } from './ui/canvas.js';
import { escapeHTML as esc, format, download, renderResults, comparisonWarnings, resultsAreStale, csvReport, printMetadata } from './ui/reports.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'junction.project.v2';
const LEGACY_STORAGE_KEY = 'junction.project.v1';
let project = createProject();
try {
  const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  if (stored) project = parseProject(stored);
} catch { /* A damaged or unavailable local store does not prevent a fresh study. */ }
let activeId = project.scenarios[0].id;
let simulation;
let playing = false;
let selectedLink = 'west';
let editingApproach = null;
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

// Per-approach overrides: a blank field inherits the shared value shown as placeholder.
function approachSection(network) {
  const s = active();
  const approaches = configurableApproaches(network);
  if (!approaches.some(l => l.id === editingApproach)) editingApproach = approaches[0].id;
  const link = network.byId[editingApproach];
  const own = s.approaches[link.id] ?? {};
  const shared = { lanes: s.geometry.lanes, speed: s.geometry.speed, length: s.geometry.length, left: s.turning.left, right: s.turning.right, pocket: 0 };
  const roundabout = s.template === 'roundabout';
  const signalised = network.nodeById[link.to].control === 'signal';
  const fields = Object.entries(APPROACH_FIELDS).filter(([key, f]) => !(f.entryOnly && link.kind !== 'entry') && !(roundabout && key === 'lanes') && !(key === 'pocket' && !signalised));
  const effective = approachSettings(s, link.id, link.kind);
  return `<section class="settings-section"><div class="section-title"><h3>Approach settings</h3><span class="section-number">02</span></div>
      <label class="field">Approach<select id="approach-edit">${approaches.map(l => `<option value="${esc(l.id)}" ${l.id === link.id ? 'selected' : ''}>${esc(l.label)}${s.approaches[l.id] ? ' · customised' : ''}</option>`).join('')}</select></label>
      <div class="input-grid">${fields.map(([key, f]) => `<label class="field"><span>${esc(f.label)}</span><input type="number" data-override="${key}" value="${own[key] ?? ''}" placeholder="${shared[key]} (shared)" min="${f.min}" max="${f.max}"></label>`).join('')}</div>
      <p class="field-hint">Leave a field blank to use the shared value. Effective here: ${effective.lanes} lane${effective.lanes > 1 ? 's' : ''}, ${effective.speed} km/h, ${effective.left}% left, ${effective.right}% right${effective.pocket ? `, ${effective.pocket} m right-turn pocket` : ''}. A pocket adds a median lane for right-turners at the stop line; when it is full they wait at its entrance and block the lane behind them.</p>
      ${s.approaches[link.id] ? '<button type="button" class="text-button" id="clear-approach">Use shared values for this approach</button>' : ''}
    </section>`;
}

function junctionSignalFields(network) {
  const s = active();
  const nodes = network.nodes.filter(n => n.control === 'signal');
  if (nodes.length < 2) return '';
  return nodes.map(n => {
    const own = s.signals.junctions[n.id];
    const fields = own ? `<div class="input-grid">${['eastWest', 'northSouth'].map(group => `<label class="field"><span>${group === 'eastWest' ? 'East–west' : 'North–south'} green (s)</span><input type="number" data-junction="${n.id}" data-group="${group}" value="${own[group] ?? ''}" placeholder="${s.signals[group]} (shared)" min="5" max="300"></label>`).join('')}</div>` : '';
    return `<label class="checkbox-line"><input type="checkbox" data-junction-toggle="${n.id}" ${own ? 'checked' : ''}> ${esc(n.label)} uses its own green times</label>${fields}`;
  }).join('');
}

function renderSettings() {
  const corridor = active().template === 'corridor';
  const roundabout = active().template === 'roundabout';
  const network = compileNetwork(active());
  $('scenario-select').innerHTML = project.scenarios.map((s, i) => `<option value="${esc(s.id)}" ${s.id === activeId ? 'selected' : ''}>${String(i + 1).padStart(2, '0')} / ${esc(s.name)}</option>`).join('');
  $('settings-form').innerHTML = `
    <label class="field">Scenario name<input type="text" data-path="name" value="${esc(active().name)}" maxlength="80"></label>
    <section class="settings-section"><div class="section-title"><h3>Road layout</h3><span class="section-number">01</span></div>
      <label class="field">Layout template<select data-path="template">${Object.entries(TEMPLATES).map(([key, label]) => `<option value="${key}" ${active().template === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
      ${rangeField('Approach length (m)', 'geometry.length', 100, 600, 'metres')}
      <div class="input-grid">${numberField('Lanes / direction', 'geometry.lanes', 1, 3)}${numberField('Speed limit (km/h)', 'geometry.speed', 20, 80)}${corridor ? numberField('Link A–B length (m)', 'geometry.spacing', 60, 600) : ''}</div>
      <p class="field-hint">Shared dimensions on every road.${corridor ? ' The link between junctions has finite storage: when it fills, junction A cannot release traffic into it.' : ''} Left turns use the kerbside lane and right turns the median lane; there are no mid-block lane changes.</p>
    </section>
    ${approachSection(network)}
    <section class="settings-section"><div class="section-title"><h3>Signal timings</h3><span class="section-number">03</span></div>
      ${roundabout ? '<p class="field-hint">The roundabout uses priority control: entering traffic gives way to circulating traffic. Signal timings are kept for other layouts but have no effect here.</p></section><section hidden>' : ''}
      ${rangeField('East–west green (s)', 'signals.eastWest', 5, 300, 'seconds')}
      ${rangeField('North–south green (s)', 'signals.northSouth', 5, 300, 'seconds')}
      <div class="input-grid">${numberField('Yellow / phase (s)', 'signals.yellow', 3, 10)}${numberField('All-red / phase (s)', 'signals.allRed', 2, 10)}${corridor ? numberField('Junction B offset (s)', 'signals.offset', 0, 600) : ''}</div>
      <p class="field-hint">Fixed-time, two-phase signals${corridor ? ' shared by both junctions; the offset delays the start of junction B’s plan for coordination' : ''}. Transition intervals remain separate from green time. Right turns are permissive and yield to opposing traffic arriving within 4 seconds.</p><div class="timing-summary"><span>Total cycle</span><strong id="settings-cycle">${cycleLength(active().signals)} seconds</strong></div>
      ${junctionSignalFields(network)}
    </section>
    <section class="settings-section"><div class="section-title"><h3>Traffic demand</h3><span class="section-number">04</span></div><div class="input-grid">${DIRECTIONS.filter(d => !(d === 'north' && active().template === 'tJunction')).map(d => numberField(`${d[0].toUpperCase() + d.slice(1)} (veh/h)`, `demand.${d}`, 0, 3600)).join('')}</div>
      ${corridor ? '<p class="field-hint">North and south values apply to each junction’s side road.</p>' : ''}
      <div class="input-grid">${numberField('Left turn (%)', 'turning.left', 0, 100)}${numberField('Right turn (%)', 'turning.right', 0, 100)}</div>
      <p class="field-hint">Shared turning shares apply wherever an approach has none of its own; the remainder goes straight. At the roundabout, left, straight and right mean the first, second and third exit. Unavailable movements are dropped and the remaining shares rescaled.</p>
      <label class="field" style="margin-top:12px">Demand assumption<select data-path="demand.multiplier"><option value="0.75" ${active().demand.multiplier === .75 ? 'selected' : ''}>Low · 0.75×</option><option value="1" ${active().demand.multiplier === 1 ? 'selected' : ''}>Central · 1.00×</option><option value="1.25" ${active().demand.multiplier === 1.25 ? 'selected' : ''}>High · 1.25×</option>${![.75, 1, 1.25].includes(active().demand.multiplier) ? `<option selected value="${active().demand.multiplier}">Custom · ${active().demand.multiplier}×</option>` : ''}</select></label>
      <p class="field-hint">Growth sensitivity only. Population-to-trip estimation is planned.</p>
    </section>
    <section class="settings-section"><div class="section-title"><h3>Vehicle mix</h3><span class="section-number">05</span></div><div class="input-grid">${Object.entries(FLEET).map(([key, spec]) => numberField(`${spec.label} (%)`, `fleet.${key}`, 0, 100)).join('')}</div><p id="fleet-total" class="field-hint">Total: 100% · shares must add up to 100</p></section>
    <section class="settings-section"><div class="section-title"><h3>Run settings</h3><span class="section-number">06</span></div><div class="input-grid">${numberField('Duration (s)', 'run.duration', 120, 3600)}${numberField('Warm-up (s)', 'run.warmup', 0, 3540)}${numberField('Random seed', 'run.seed', 1, 2147483647)}</div><p class="field-hint">Batch runs increment this seed. Warm-up vehicles stay in the model.</p></section>`;
}

function validate() {
  const errors = validateScenario(active());
  $('validation').hidden = !errors.length;
  $('validation').textContent = errors.join(' ');
  const findings = errors.length ? [] : modelChecks(active());
  $('model-checks').hidden = !findings.length;
  $('model-checks').innerHTML = findings.length ? `<h4>Model checks</h4><ul>${findings.map(f => `<li class="check-${f.level}"><strong>${f.level === 'warning' ? 'Review' : 'Note'}: ${esc(f.title)}</strong><span>${esc(f.detail)}</span></li>`).join('')}</ul>` : '';
  $('play-button').disabled = !!errors.length;
  $('duplicate-button').disabled = !!errors.length || project.scenarios.length >= 30;
  return !errors.length;
}

function resetSimulation() {
  playing = false;
  accumulator = 0;
  if (validate()) { simulation = new Simulation(active()); renderApproachButtons(); }
  refreshMetrics();
}

function renderApproachButtons() {
  if (!simulation) return;
  const links = inboundLinks(simulation.network);
  if (!links.some(l => l.id === selectedLink)) selectedLink = links[0].id;
  $('approach-buttons').innerHTML = links.map(l => `<button data-link="${esc(l.id)}" aria-pressed="${l.id === selectedLink}">${esc(l.label.replace(' approach', ''))}</button>`).join('');
  renderer.selected = selectedLink;
}

function selectApproach(linkId) {
  selectedLink = linkId;
  renderer.selected = linkId;
  document.querySelectorAll('[data-link]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.link === linkId)));
  refreshMetrics();
}

const renderer = new NetworkCanvas($('network-canvas'), selectApproach);

function refreshMetrics() {
  if (!simulation) return;
  const r = simulation.result();
  const phases = simulation.phases();
  const phaseText = phase => phase.group === 'all' ? 'all-red' : `${phase.group === 'eastWest' ? 'east–west' : 'north–south'} ${phase.colour}`;
  const nodes = simulation.network.nodes.filter(n => n.control === 'signal');
  $('metric-completed').textContent = r.completed;
  $('metric-queue').innerHTML = `${format(r.maxQueue, 0)} <small>m</small>`;
  $('metric-requested').textContent = r.requested;
  $('metric-network').textContent = r.inNetwork;
  $('metric-waiting').textContent = r.waiting;
  // Pausing must be visible even during warm-up.
  $('run-state').textContent = validateScenario(active()).length ? 'Invalid inputs' : simulation.done ? 'Complete' : !playing ? (simulation.time > 0 ? 'Paused' : 'Ready') : simulation.time < active().run.warmup ? 'Warm-up' : 'Running';
  $('play-button').textContent = simulation.done ? '↺ Run again' : playing ? 'Ⅱ Pause' : '▶ Run simulation';
  const clock = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  $('simulation-time').textContent = `${clock(simulation.time)} / ${clock(simulation.scenario.run.duration)}`;
  const percent = simulation.time / simulation.scenario.run.duration * 100;
  $('timeline-fill').style.width = `${percent}%`;
  document.querySelector('.timeline').setAttribute('aria-valuenow', String(Math.round(percent)));
  if (nodes.length) {
    const label = nodes.map(n => `${nodes.length > 1 ? `${n.id}: ` : ''}${phaseText(phases[n.id])}`).join(' · ');
    $('phase-label').textContent = label[0].toUpperCase() + label.slice(1);
    $('phase-countdown').textContent = nodes.map(n => `${Math.ceil(phases[n.id].remaining)}s`).join(' / ') + ' remaining';
    $('cycle-label').textContent = `Cycle: ${[...new Set(nodes.map(n => cycleLength(n.plan)))].join(' / ')}s`;
  } else {
    $('phase-label').textContent = 'Priority control';
    $('phase-countdown').textContent = 'Entries give way to circulating traffic';
    $('cycle-label').textContent = 'No signals';
  }
  const link = simulation.links[selectedLink];
  $('approach-title').textContent = link ? link.label : '';
  $('diagnostic-list').innerHTML = explainApproach(simulation, selectedLink).map(d => `<div class="diagnostic"><h4>${esc(d.title)}</h4><p>${esc(d.detail)}</p></div>`).join('');
}

function refreshWarnings() {
  const warnings = comparisonWarnings(results);
  const stale = resultsAreStale(results, project.scenarios);
  if (stale) warnings.unshift('Inputs have changed since this experiment. These results describe the recorded inputs; run again to compare the current scenarios.');
  $('comparison-warning').hidden = !warnings.length;
  $('comparison-warning').textContent = warnings.join(' ');
}

$('settings-form').addEventListener('submit', event => event.preventDefault());
function inputsChanged() {
  resetSimulation();
  validate();
  refreshWarnings();
  persist();
  notice('Inputs changed. Run the simulation to evaluate this version.');
}

// Drop per-approach and per-junction settings the new layout cannot use.
function pruneForTemplate() {
  const s = active();
  const network = compileNetwork(s);
  const links = new Set(configurableApproaches(network).map(l => l.id));
  const nodes = new Set(network.nodes.filter(n => n.control === 'signal').map(n => n.id));
  const dropped = [...Object.keys(s.approaches).filter(id => !links.has(id)), ...Object.keys(s.signals.junctions).filter(id => !nodes.has(id))];
  for (const id of Object.keys(s.approaches)) if (!links.has(id)) delete s.approaches[id];
  for (const id of Object.keys(s.signals.junctions)) if (!nodes.has(id)) delete s.signals.junctions[id];
  return dropped;
}

$('settings-form').addEventListener('change', event => {
  if (event.target.id === 'approach-edit') { editingApproach = event.target.value; renderSettings(); }
});
$('settings-form').addEventListener('click', event => {
  if (event.target.id !== 'clear-approach') return;
  delete active().approaches[editingApproach];
  renderSettings(); inputsChanged();
});
$('settings-form').addEventListener('input', event => {
  const { override, junction, group, junctionToggle } = event.target.dataset;
  if (override) {
    const s = active();
    const own = { ...(s.approaches[editingApproach] ?? {}) };
    if (event.target.value === '') delete own[override];
    else own[override] = Number(event.target.value);
    if (Object.keys(own).length) s.approaches[editingApproach] = own; else delete s.approaches[editingApproach];
    inputsChanged();
    return;
  }
  if (junctionToggle) {
    const plans = active().signals.junctions;
    if (event.target.checked) plans[junctionToggle] = {}; else delete plans[junctionToggle];
    renderSettings(); inputsChanged();
    return;
  }
  if (junction) {
    const plan = active().signals.junctions[junction];
    if (event.target.value === '') delete plan[group]; else plan[group] = Number(event.target.value);
    inputsChanged();
    return;
  }
  const { path } = event.target.dataset;
  if (!path) return;
  const value = ['name', 'template'].includes(path) ? event.target.value : event.target.value === '' ? NaN : Number(event.target.value);
  write(active(), path, value);
  document.querySelectorAll('[data-path]').forEach(control => { if (control !== event.target && control.dataset.path === path) control.value = value; });
  if (path === 'name') {
    $('scenario-select').selectedOptions[0].textContent = active().name;
  } else if (path === 'template') {
    const dropped = pruneForTemplate();
    renderSettings(); resetSimulation();
    if (dropped.length) { validate(); persist(); notice(`Layout changed. Settings for ${dropped.join(', ')} do not apply to this layout and were removed.`); return; }
  } else resetSimulation();
  const total = Object.keys(FLEET).reduce((sum, key) => sum + active().fleet[key], 0);
  $('fleet-total').textContent = `Total: ${format(total, 0)}% · shares must add up to 100`;
  if ($('settings-cycle')) $('settings-cycle').textContent = `${format(cycleLength(active().signals), 0)} seconds`;
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
$('approach-buttons').addEventListener('click', event => { const button = event.target.closest('[data-link]'); if (button) selectApproach(button.dataset.link); });

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
  if (active().template === 'roundabout') { notice('The roundabout has no signals to sweep. Choose a signalised layout, or compare scenarios instead.', 'error'); return; }
  const group = $('sweep-group').value;
  const multipliers = $('sweep-demand-levels').checked ? DEMAND_LEVELS.map(l => l.multiplier) : [active().demand.multiplier];
  try { sweepConfigurations({ group, start, end, increment, multipliers }); }
  catch (error) { notice(error.message, 'error'); return; }
  startExperiment({ type: 'sweep', scenario: structuredClone(active()), group, start, end, increment, multipliers, count: Number($('replications').value) }, `${SWEEP_GROUPS[group][0].toUpperCase() + SWEEP_GROUPS[group].slice(1)} timing sweep`);
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
selectApproach(selectedLink);
requestAnimationFrame(frame);
