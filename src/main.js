import { createProject, validateScenario, parseProject, DIRECTIONS, FLEET, APPROACH_FIELDS, MAX_BOOKMARKS, PROFILE_PRESETS, profilePreset } from './model/project.js';
import { lineChart } from './ui/charts.js';
import { modelChecks } from './model/checks.js';
import { changeSummary, changeText, scenarioChanges } from './model/changes.js';
import { Simulation, STEP } from './simulation/engine.js';
import { PHASE_PRESETS, cycleLength, phasePreset } from './simulation/signals.js';
import { ARM_ORDER, GRID, TEMPLATES, analysePlanPhase, approachSettings, compileNetwork, configurableApproaches, defaultLayout, entryDemand, gridNeighbour, inboundLinks, layoutErrors, movementLabel, planMovements } from './model/network.js';
import { DEMAND_LEVELS, PRECISION, sweepConfigurations, sweepGroupLabel, sweepTargets } from './simulation/experiments.js';
import { explainApproach } from './diagnostics/explain.js';
import { NetworkCanvas } from './ui/canvas.js';
import { SPEED_LEGEND, SceneView, findVehicle } from './ui/scene3d.js';
import { escapeHTML as esc, format, download, renderResults, renderTimeCharts, comparisonWarnings, resultsAreStale, csvReport, printMetadata } from './ui/reports.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'junction.project.v2';
const LEGACY_STORAGE_KEY = 'junction.project.v1';
const MAP_VIEW_KEY = 'junction.mapView';
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
let selectedGridNode = null;
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
  const shared = { lanes: s.geometry.lanes, speed: s.geometry.speed, length: s.geometry.length, left: s.turning.left, right: s.turning.right, pocket: 0, demand: s.demand[link.demandKey] };
  const roundabout = s.template === 'roundabout';
  const signalised = network.nodeById[link.to].control === 'signal';
  const fields = Object.entries(APPROACH_FIELDS).filter(([key, f]) => !(f.entryOnly && link.kind !== 'entry') && !(roundabout && key === 'lanes') && !(key === 'pocket' && !signalised));
  const effective = approachSettings(s, link.id, link.kind);
  return `<section class="settings-section"><div class="section-title"><h3>Approach settings</h3><span class="section-number">02</span></div>
      <label class="field">Approach<select id="approach-edit">${approaches.map(l => `<option value="${esc(l.id)}" ${l.id === link.id ? 'selected' : ''}>${esc(l.label)}${s.approaches[l.id] ? ' · customised' : ''}</option>`).join('')}</select></label>
      <div class="input-grid">${fields.map(([key, f]) => `<label class="field"><span>${esc(f.label)}</span><input type="number" data-override="${key}" value="${own[key] ?? ''}" placeholder="${shared[key]} (shared)" min="${f.min}" max="${f.max}"></label>`).join('')}</div>
      <p class="field-hint">Leave a field blank to use the shared value. Effective here: ${link.kind === 'entry' ? `${entryDemand(s, link)} veh/h, ` : ''}${effective.lanes} lane${effective.lanes > 1 ? 's' : ''}, ${effective.speed} km/h, ${effective.left}% left, ${effective.right}% right${effective.pocket ? `, ${effective.pocket} m right-turn pocket` : ''}. A pocket adds a median lane for right-turners at the stop line; when it is full they wait at its entrance and block the lane behind them.</p>
      ${s.approaches[link.id] ? '<button type="button" class="text-button" id="clear-approach">Use shared values for this approach</button>' : ''}
    </section>`;
}

// Custom phase plan: each phase lists the movements that get green together.
// Arrays are replaced on every edit (the signal cache compares by reference).
const GLYPHS = { left: '↰', straight: '↑', right: '↱' };
function phaseEditor(network) {
  const s = active();
  const offered = planMovements(network);
  const arms = [...new Set(offered.map(m => m.arm))];
  const cards = s.signals.phases.map((p, i) => {
    const { permitted } = analysePlanPhase(network, p.movements);
    const rows = arms.map(arm => `<div class="movement-row"><span>${arm[0].toUpperCase() + arm.slice(1)}</span>${['left', 'straight', 'right'].map(movement => {
      const id = `${arm}:${movement}`;
      if (!offered.some(o => o.id === id)) return '<span class="movement none" aria-hidden="true">·</span>';
      return `<label class="movement${permitted.includes(id) ? ' permitted' : ''}"><input type="checkbox" data-phase="${i}" data-movement="${id}" ${p.movements.includes(id) ? 'checked' : ''}><span aria-hidden="true">${GLYPHS[movement]}</span><span class="sr-only">${esc(movementLabel(id))}</span>${permitted.includes(id) ? '<em>yields</em>' : ''}</label>`;
    }).join('')}</div>`).join('');
    return `<div class="phase-card"><div class="phase-head"><span class="phase-number">${i + 1}</span><input type="text" data-phase="${i}" data-phase-field="name" value="${esc(p.name)}" maxlength="40" aria-label="Phase ${i + 1} name"><label class="phase-green"><span>Green (s)</span><input type="number" data-phase="${i}" data-phase-field="green" value="${p.green}" min="5" max="300" aria-label="Phase ${i + 1} green, seconds"></label><button type="button" class="text-button" data-phase-action="remove" data-phase="${i}" ${s.signals.phases.length <= 2 ? 'disabled' : ''} aria-label="Remove phase ${i + 1}">Remove</button></div>
      <div class="movement-grid" role="group" aria-label="Movements green in phase ${i + 1}"><div class="movement-row movement-header" aria-hidden="true"><span></span><span>Left</span><span>Straight</span><span>Right</span></div>${rows}</div></div>`;
  }).join('');
  return `${cards}<div class="phase-actions"><button type="button" class="button secondary" data-phase-action="add" ${s.signals.phases.length >= 8 ? 'disabled' : ''}>Add phase</button><label class="field"><span>Start from a preset</span><select data-phase-action="preset"><option value="">Choose…</option>${Object.entries(PHASE_PRESETS).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('')}</select></label></div>
    <p class="field-hint">Tick the movements that get green together. A right turn crossing opposing traffic that is also green is <em>permitted</em> and gives way; give it its own phase to protect it. Crossing straight or left movements cannot share a phase.</p>`;
}

// Grid layout editor. Each cell is a button: a junction cell selects it, an
// empty cell adds a junction there. Arm stubs and roads through empty cells are
// drawn for orientation; the model checks report what does not connect.
const armName = arm => arm[0].toUpperCase() + arm.slice(1);
function gridEditor() {
  const s = active();
  const nodes = s.layout.nodes;
  if (!nodes.some(n => n.id === selectedGridNode)) selectedGridNode = nodes[0]?.id ?? null;
  const full = nodes.length >= GRID.maxNodes;
  const through = new Map();
  for (const n of nodes) for (const [arm, facing] of [['east', 'west'], ['south', 'north']]) {
    const other = n.arms.includes(arm) ? gridNeighbour(nodes, n, arm) : null;
    if (!other?.arms.includes(facing)) continue;
    for (let c = n.col + 1; c < other.col; c++) through.set(`${c},${n.row}`, [...(through.get(`${c},${n.row}`) ?? []), 'road-ew']);
    for (let r = n.row + 1; r < other.row; r++) through.set(`${n.col},${r}`, [...(through.get(`${n.col},${r}`) ?? []), 'road-ns']);
  }
  const cells = [];
  for (let row = 0; row < GRID.rows; row++) for (let col = 0; col < GRID.cols; col++) {
    const n = nodes.find(x => x.col === col && x.row === row);
    if (n) {
      const arms = n.arms.length === 4 ? 'all four arms' : `arms ${ARM_ORDER.filter(a => n.arms.includes(a)).join(', ')}`;
      cells.push(`<button type="button" class="grid-cell junction" data-grid-select="${n.id}" aria-pressed="${n.id === selectedGridNode}" aria-label="Junction ${n.id}: ${arms}">${ARM_ORDER.filter(a => n.arms.includes(a)).map(a => `<span class="stub stub-${a}" aria-hidden="true"></span>`).join('')}<strong>${n.id}</strong></button>`);
    } else {
      cells.push(`<button type="button" class="grid-cell empty ${(through.get(`${col},${row}`) ?? []).join(' ')}" data-grid-add="${col},${row}" aria-label="Add a junction at column ${col + 1}, row ${row + 1}" ${full ? 'disabled' : ''}><span aria-hidden="true">+</span></button>`);
    }
  }
  const node = nodes.find(n => n.id === selectedGridNode);
  const panel = node ? `<fieldset class="grid-node"><legend>Junction ${node.id} · column ${node.col + 1}, row ${node.row + 1}</legend>
      <div class="arm-toggles">${ARM_ORDER.map(arm => `<label class="checkbox-line"><input type="checkbox" data-grid-arm="${arm}" ${node.arms.includes(arm) ? 'checked' : ''}> ${armName(arm)}</label>`).join('')}</div>
      <div class="grid-node-actions"><label class="field"><span>Signal offset (s)</span><input type="number" data-grid-offset value="${node.offset}" min="0" max="600"></label>
      <button type="button" class="text-button" data-grid-remove ${nodes.length <= 1 ? 'disabled' : ''}>Remove junction ${node.id}</button></div></fieldset>` : '';
  return `<div class="grid-editor" role="group" aria-label="Junction grid, ${GRID.cols} columns by ${GRID.rows} rows" style="--grid-cols:${GRID.cols}">${cells.join('')}</div>${panel}
    <p class="field-hint">Select a junction to change its arms, or an empty cell to add one (up to ${GRID.maxNodes}). An arm joins the nearest junction in its row or column, which needs the facing arm; otherwise it becomes a boundary road. Roads may only meet at junctions. The offset delays the start of that junction's signal plan.</p>`;
}

// Replace the layout (never mutate it in place), drop settings for roads that
// no longer exist once the layout is valid, and keep focus on the edited control.
function layoutChanged(nodes, focus) {
  active().layout = { nodes };
  const dropped = layoutErrors(active()).length ? [] : pruneForTemplate();
  renderSettings();
  if (focus) document.querySelector(focus)?.focus();
  inputsChanged();
  if (dropped.length) notice(`Layout changed. Settings for ${dropped.join(', ')} no longer apply and were removed.`);
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
  const grid = active().template === 'grid';
  const network = compileNetwork(active());
  $('scenario-select').innerHTML = project.scenarios.map((s, i) => `<option value="${esc(s.id)}" ${s.id === activeId ? 'selected' : ''}>${String(i + 1).padStart(2, '0')} / ${esc(s.name)}</option>`).join('');
  $('settings-form').innerHTML = `
    <label class="field">Scenario name<input type="text" data-path="name" value="${esc(active().name)}" maxlength="80"></label>
    <section class="settings-section"><div class="section-title"><h3>Road layout</h3><span class="section-number">01</span></div>
      <label class="field">Layout template<select data-path="template">${Object.entries(TEMPLATES).map(([key, label]) => `<option value="${key}" ${active().template === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
      ${rangeField('Approach length (m)', 'geometry.length', 100, 600, 'metres')}
      <div class="input-grid">${numberField('Lanes / direction', 'geometry.lanes', 1, 3)}${numberField('Speed limit (km/h)', 'geometry.speed', 20, 80)}${corridor ? numberField('Link A–B length (m)', 'geometry.spacing', 60, 600) : ''}${grid ? numberField('Block length (m)', 'geometry.spacing', 60, 600) : ''}</div>
      <p class="field-hint">Shared dimensions on every road.${corridor || grid ? ' Links between junctions have finite storage: when one fills, the junction upstream cannot release traffic into it.' : ''}${grid ? ' The block length is the road between neighbouring grid cells; boundary roads use the approach length.' : ''} Left turns use the kerbside lane and right turns the median lane; there are no mid-block lane changes.</p>
      ${grid && active().layout ? gridEditor() : ''}
    </section>
    ${approachSection(network)}
    <section class="settings-section"><div class="section-title"><h3>Signal timings</h3><span class="section-number">03</span></div>
      ${roundabout ? '<p class="field-hint">The roundabout uses priority control: entering traffic gives way to circulating traffic. Signal timings are kept for other layouts but have no effect here.</p></section><section hidden>' : ''}
      <label class="field">Signal plan<select data-plan-mode><option value="twoPhase" ${active().signals.mode === 'twoPhase' ? 'selected' : ''}>Two phases: east–west, then north–south</option><option value="custom" ${active().signals.mode === 'custom' ? 'selected' : ''}>Custom phases</option></select></label>
      ${active().signals.mode === 'custom' ? phaseEditor(network) : `${rangeField('East–west green (s)', 'signals.eastWest', 5, 300, 'seconds')}${rangeField('North–south green (s)', 'signals.northSouth', 5, 300, 'seconds')}`}
      <div class="input-grid">${numberField('Yellow / phase (s)', 'signals.yellow', 3, 10)}${numberField('All-red / phase (s)', 'signals.allRed', 2, 10)}${corridor ? numberField('Junction B offset (s)', 'signals.offset', 0, 600) : ''}</div>
      <p class="field-hint">Fixed-time signals${corridor ? ' shared by both junctions; the offset delays the start of junction B’s plan for coordination' : ''}. Every phase is followed by the yellow and all-red intervals.${active().signals.mode === 'twoPhase' ? ' Right turns are permitted in their arm’s phase and give way to opposing traffic arriving within 4 seconds.' : ''}</p><div class="timing-summary"><span>Total cycle</span><strong id="settings-cycle">${cycleLength(active().signals)} seconds</strong></div>
      ${active().signals.mode === 'twoPhase' ? junctionSignalFields(network) : ''}
    </section>
    <section class="settings-section"><div class="section-title"><h3>Traffic demand</h3><span class="section-number">04</span></div><div class="input-grid">${DIRECTIONS.filter(d => !(d === 'north' && active().template === 'tJunction')).map(d => numberField(`${d[0].toUpperCase() + d.slice(1)} (veh/h)`, `demand.${d}`, 0, 3600)).join('')}</div>
      ${corridor ? '<p class="field-hint">North and south values apply to each junction’s side road.</p>' : ''}${grid ? '<p class="field-hint">Each value applies in full to every boundary approach facing that way (for example, every north boundary road receives the north veh/h), unless the approach has its own demand under Approach settings.</p>' : ''}
      <div class="input-grid">${numberField('Left turn (%)', 'turning.left', 0, 100)}${numberField('Right turn (%)', 'turning.right', 0, 100)}</div>
      <p class="field-hint">Shared turning shares apply wherever an approach has none of its own; the remainder goes straight. At the roundabout, left, straight and right mean the first, second and third exit. Unavailable movements are dropped and the remaining shares rescaled.</p>
      <label class="field" style="margin-top:12px">Demand assumption<select data-path="demand.multiplier"><option value="0.75" ${active().demand.multiplier === .75 ? 'selected' : ''}>Low · 0.75×</option><option value="1" ${active().demand.multiplier === 1 ? 'selected' : ''}>Central · 1.00×</option><option value="1.25" ${active().demand.multiplier === 1.25 ? 'selected' : ''}>High · 1.25×</option>${![.75, 1, 1.25].includes(active().demand.multiplier) ? `<option selected value="${active().demand.multiplier}">Custom · ${active().demand.multiplier}×</option>` : ''}</select></label>
      <p class="field-hint">Growth sensitivity only. Population-to-trip estimation is planned.</p>
      ${profileFields()}
    </section>
    <section class="settings-section"><div class="section-title"><h3>Vehicle mix</h3><span class="section-number">05</span></div><div class="input-grid">${Object.entries(FLEET).map(([key, spec]) => numberField(`${spec.label} (%)`, `fleet.${key}`, 0, 100)).join('')}</div><p id="fleet-total" class="field-hint">Total: 100% · shares must add up to 100</p></section>
    <section class="settings-section"><div class="section-title"><h3>Run settings</h3><span class="section-number">06</span></div><div class="input-grid">${numberField('Duration (s)', 'run.duration', 120, 3600)}${numberField('Warm-up (s)', 'run.warmup', 0, 3540)}${numberField('Random seed', 'run.seed', 1, 2147483647)}</div><p class="field-hint">Batch runs increment this seed. Warm-up vehicles stay in the model.</p></section>`;
}

// Demand over time: a preset written out as explicit period factors, or custom.
function profileFields() {
  const { preset, period, factors } = active().demand.profile;
  const max = Math.max(1, ...factors.filter(Number.isFinite));
  const bars = factors.map((f, i) => `<span style="height:${Math.max(2, (Number.isFinite(f) ? f : 0) / max * 100)}%" title="Period ${i + 1}: ${f}×"></span>`).join('');
  return `<label class="field" style="margin-top:12px">Demand over time<select data-profile="preset">${Object.entries(PROFILE_PRESETS).map(([key, p]) => `<option value="${key}" ${preset === key ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}<option value="custom" ${preset === 'custom' ? 'selected' : ''}>Custom factors</option></select></label>
      <div class="profile-preview" role="img" aria-label="Demand factor by period: ${factors.join(', ')}">${bars}</div>
      <div class="input-grid"><label class="field"><span>Period (min)</span><input type="number" data-profile="period" value="${+(period / 60).toFixed(2)}" min="1" max="60" step="any"></label><label class="field"><span>Factors per period</span><input type="text" data-profile="factors" value="${esc(factors.join(', '))}" inputmode="decimal"></label></div>
      <p class="field-hint">Each approach's veh/h is multiplied by the factor for the current period; the last factor holds after the profile ends. Presets span the run in six periods.</p>`;
}

// What the active scenario changes relative to the first (baseline) scenario.
function renderChangeSummary() {
  const box = $('change-summary');
  const baseline = project.scenarios[0];
  if (active() === baseline) { box.hidden = true; return; }
  const changes = scenarioChanges(baseline, active());
  box.hidden = false;
  box.innerHTML = `<h4>Changes from baseline · ${esc(baseline.name)}</h4>${changes.length ? `<ul>${changes.map(c => `<li class="change-${c.kind}">${esc(changeText(c))}</li>`).join('')}</ul>` : ''}<p>${esc(changeSummary(changes))}</p>`;
}

function validate() {
  const errors = validateScenario(active());
  $('validation').hidden = !errors.length;
  $('validation').textContent = errors.join(' ');
  const findings = errors.length ? [] : modelChecks(active());
  $('model-checks').hidden = !findings.length;
  renderChangeSummary();
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
  scene.renderer.selected = selectedLink;
}

function selectApproach(linkId) {
  selectedLink = linkId;
  renderer.selected = linkId;
  scene.renderer.selected = linkId;
  document.querySelectorAll('[data-link]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.link === linkId)));
  refreshMetrics();
}

const renderer = new NetworkCanvas($('network-canvas'), selectApproach);

// ---------------------------------------------------------------- 3D view
// Both views draw the same Simulation object; neither view nor camera changes it.
let mapView = '2d';
const VEHICLE_NAMES = { twoWheeler: 'two-wheeler', auto: 'auto-rickshaw', car: 'car', bus: 'bus', truck: 'truck' };
const scene = new SceneView($('scene-canvas'), {
  select: id => selectApproach(id),
  onCamera: () => refreshCompass(),
  onVehicle: () => refreshVehicleStatus(),
  onFollowEnd: message => { refreshVehicleStatus(); if (message) notice(message); },
  onFailure: error => {
    setMapView('2d');
    $('view-3d').disabled = true;
    notice(`The 3D view is unavailable (${error.message}). Showing the 2D plan; the run continues unchanged.`, 'error');
  },
});
if (!scene.supported) { $('view-3d').disabled = true; $('view-3d').title = 'This browser cannot draw the 3D view.'; }

function setMapView(view) {
  mapView = view === '3d' && scene.supported && !scene.failed ? '3d' : '2d';
  const three = mapView === '3d';
  $('network-canvas').hidden = three;
  $('scene-canvas').hidden = !three;
  $('scene-controls').hidden = !three;
  document.querySelector('.map-wrap').classList.toggle('three', three);
  refreshSpeedLegend();
  $('view-2d').setAttribute('aria-pressed', String(!three));
  $('view-3d').setAttribute('aria-pressed', String(three));
  $('map-note-title').textContent = three ? '3D view · true scale' : 'Schematic layout';
  $('map-note-detail').textContent = three ? 'Same run as the 2D plan · 3.5 m lanes · not geographic' : 'Concept geometry · lane widths exaggerated for legibility';
  if (three) scene.resize(); else scene.stopFollowing(false);
  refreshCompass();
  refreshVehicleStatus();
  try { localStorage.setItem(MAP_VIEW_KEY, mapView); } catch { /* a remembered view is only a convenience */ }
}

function refreshCompass() {
  $('compass-needle').style.transform = mapView === '3d' && scene.camera ? `rotate(${-scene.camera.yaw}rad)` : '';
}

function refreshVehicleStatus() {
  const id = scene.renderer.selectedVehicle;
  const found = id !== null && simulation ? findVehicle(simulation, id) : null;
  if (id !== null && !found && !scene.following) scene.renderer.selectedVehicle = null;
  $('vehicle-status').textContent = found
    ? `Vehicle ${id}: ${VEHICLE_NAMES[found.v.type] ?? found.v.type} · ${Math.round(found.v.speed * 3.6)} km/h · ${found.where}`
    : 'Select a vehicle on the 3D view to inspect or follow it.';
  $('follow-button').disabled = !found && !scene.following;
  $('follow-button').textContent = scene.following ? 'Stop following' : 'Follow vehicle';
  $('follow-button').setAttribute('aria-pressed', String(Boolean(scene.following)));
}

function renderBookmarks(selected = '') {
  const list = project.views.bookmarks;
  $('bookmark-select').innerHTML = `<option value="">${list.length ? 'Go to a saved view…' : 'No saved views yet'}</option>` + list.map((b, i) => `<option value="${i}">${esc(b.name)}</option>`).join('');
  $('bookmark-select').value = selected;
  $('bookmark-delete').disabled = selected === '';
}

function refreshSpeedLegend() {
  const on = scene.renderer.overlays.speed;
  $('speed-legend').hidden = !on;
  // Speed colours replace vehicle-type colours, so the type legend would mislead.
  document.querySelector('.map-legend').hidden = on && mapView === '3d';
  $('speed-legend').innerHTML = on ? `<span class="legend-title">Vehicle speed</span>${SPEED_LEGEND.map(b => `<span><i style="background:${b.colour}"></i> ${esc(b.label)}</span>`).join('')}` : '';
}

$('view-2d').addEventListener('click', () => setMapView('2d'));
$('view-3d').addEventListener('click', () => setMapView('3d'));
$('scene-controls').addEventListener('click', event => {
  const preset = event.target.closest('[data-preset]')?.dataset.preset;
  if (preset) { scene.preset(preset); return; }
  const action = event.target.closest('[data-camera]')?.dataset.camera;
  const turn = Math.PI / 24;
  const actions = {
    'orbit-left': () => scene.orbit(turn, 0), 'orbit-right': () => scene.orbit(-turn, 0),
    'tilt-up': () => scene.orbit(0, -turn), 'tilt-down': () => scene.orbit(0, turn),
    'zoom-in': () => scene.zoom(0.8), 'zoom-out': () => scene.zoom(1.25),
    'pan-left': () => scene.pan(60, 0), 'pan-right': () => scene.pan(-60, 0), 'pan-up': () => scene.pan(0, 60), 'pan-down': () => scene.pan(0, -60),
  };
  actions[action]?.();
});
$('scene-controls').addEventListener('change', event => {
  const overlay = event.target.dataset.overlay;
  if (overlay) { scene.renderer.overlays[overlay] = event.target.checked; refreshSpeedLegend(); }
});
$('scene-detail').addEventListener('change', event => { scene.renderer.detail = event.target.value; });
$('follow-button').addEventListener('click', () => {
  if (scene.following) scene.stopFollowing(true, 'Stopped following. The camera has returned to the previous view.');
  else if (scene.renderer.selectedVehicle !== null) {
    scene.follow(scene.renderer.selectedVehicle);
    notice(`Following vehicle ${scene.renderer.selectedVehicle}. Press Esc on the 3D view or Stop following to return.`);
  }
  refreshVehicleStatus();
});
$('bookmark-save').addEventListener('click', () => {
  if (!scene.camera) return;
  const list = project.views.bookmarks;
  const name = $('bookmark-name').value.trim().slice(0, 40) || `View ${list.length + 1}`;
  const existing = list.findIndex(b => b.name === name);
  if (existing < 0 && list.length >= MAX_BOOKMARKS) { notice(`A project can hold ${MAX_BOOKMARKS} saved views. Delete one first.`, 'error'); return; }
  const camera = { ...scene.camera, target: { ...scene.camera.target } };
  if (existing >= 0) list[existing].camera = camera; else list.push({ name, camera });
  persist();
  renderBookmarks(String(existing >= 0 ? existing : list.length - 1));
  $('bookmark-name').value = '';
  notice(`Saved view "${name}". Views are saved with the project and do not affect inputs or results.`, 'success');
});
$('bookmark-select').addEventListener('change', event => {
  const bookmark = project.views.bookmarks[Number(event.target.value)];
  $('bookmark-delete').disabled = !bookmark;
  if (bookmark && event.target.value !== '') scene.setCamera(bookmark.camera);
});
$('bookmark-delete').addEventListener('click', () => {
  const index = Number($('bookmark-select').value);
  const [removed] = project.views.bookmarks.splice(index, 1);
  persist();
  renderBookmarks();
  if (removed) notice(`Deleted saved view "${removed.name}".`);
});

const clockText = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
let liveChartKey = '';
let eventsKey = '';

// Queue on the selected approach over the run so far, with persistent-queue spans shaded.
function refreshLiveChart() {
  const values = simulation.series.queues[selectedLink];
  const key = `${selectedLink}:${values?.length}:${simulation.events.length}`;
  if (!values || key === liveChartKey) return;
  liveChartKey = key;
  const container = $('live-chart');
  if (values.length < 2) { container.replaceChildren(); container.textContent = 'The chart starts after the first 20 simulated seconds.'; return; }
  const bands = simulation.events.filter(e => e.link === selectedLink).map(e => ({ start: e.start, end: e.end ?? simulation.time }));
  lineChart(container, { title: `${simulation.links[selectedLink].label} queue`, unit: 'm', time: simulation.series.time, compact: true,
    series: [{ name: simulation.links[selectedLink].label, values }], bands });
}

function refreshQueueEvents() {
  const events = simulation.events;
  const key = events.map(e => `${e.link}${e.start}${e.end}${e.cycles}`).join('|');
  if (key === eventsKey) return;
  eventsKey = key;
  const list = $('queue-events');
  if (!events.length) { list.innerHTML = '<p class="subtle">None yet. A queue becomes persistent when vehicles waiting at the start of green are still there at its end, two cycles running.</p>'; return; }
  const ordered = [...events].sort((a, b) => (a.end === null) - (b.end === null) || b.start - a.start).reverse();
  list.innerHTML = `<ul>${ordered.map(e => `<li><button type="button" data-event-link="${esc(e.link)}"><strong>${esc(e.label.replace(' approach', ''))}</strong><span>${e.end === null ? `since ${clockText(e.start)} · ongoing` : `${clockText(e.start)}–${clockText(e.end)}`}${e.cycles ? ` · ${e.cycles} ${simulation.network.nodeById[simulation.links[e.link].to].control === 'priority' ? 'minutes' : 'cycles'} not cleared` : ''} · up to ${format(e.maxQueue, 0)} m</span></button></li>`).join('')}</ul>`;
}

function refreshTimeline() {
  const duration = simulation.scenario.run.duration;
  $('timeline-markers').innerHTML = simulation.events.map(e => `<span style="left:${e.start / duration * 100}%;width:${Math.max(0.5, ((e.end ?? simulation.time) - e.start) / duration * 100)}%" title="${esc(e.label)}: persistent queue"></span>`).join('');
}

function refreshMetrics() {
  if (!simulation) return;
  const r = simulation.result();
  const phases = simulation.phases();
  const phaseText = phase => phase.group === 'all' ? 'all-red' : phase.group === 'eastWest' || phase.group === 'northSouth' ? `${phase.group === 'eastWest' ? 'east–west' : 'north–south'} ${phase.colour}` : `${phase.name} ${phase.colour}`;
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
  refreshTimeline();
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
  refreshLiveChart();
  refreshQueueEvents();
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
  const dropped = [];
  if (s.template !== 'grid' && s.layout) { s.layout = null; dropped.push('the grid layout'); }
  const network = compileNetwork(s);
  const links = new Set(configurableApproaches(network).map(l => l.id));
  const nodes = new Set(network.nodes.filter(n => n.control === 'signal').map(n => n.id));
  dropped.push(...Object.keys(s.approaches).filter(id => !links.has(id)), ...Object.keys(s.signals.junctions).filter(id => !nodes.has(id)));
  for (const id of Object.keys(s.approaches)) if (!links.has(id)) delete s.approaches[id];
  for (const id of Object.keys(s.signals.junctions)) if (!nodes.has(id)) delete s.signals.junctions[id];
  // Custom phases keep only movements the new layout offers; too few phases left reverts to two-phase.
  if (s.signals.mode === 'custom' && network.nodes.some(n => n.control === 'signal')) {
    const offered = new Set(planMovements(network).map(m => m.id));
    const removed = s.signals.phases.flatMap(p => p.movements.filter(m => !offered.has(m)));
    s.signals.phases = s.signals.phases.map(p => ({ ...p, movements: p.movements.filter(m => offered.has(m)) })).filter(p => p.movements.length);
    if (removed.length) dropped.push(`phase movements (${removed.map(movementLabel).join(', ')})`);
    if (s.signals.phases.length < 2) { s.signals.mode = 'twoPhase'; s.signals.phases = []; dropped.push('the custom phase plan'); }
  }
  return dropped;
}

$('settings-form').addEventListener('change', event => {
  if (event.target.id === 'approach-edit') { editingApproach = event.target.value; renderSettings(); }
});
$('settings-form').addEventListener('change', event => {
  if (event.target.dataset.phaseAction !== 'preset' || !event.target.value) return;
  const offered = planMovements(compileNetwork(active())).map(m => m.id);
  active().signals.phases = phasePreset(event.target.value, offered);
  renderSettings(); inputsChanged();
});
$('settings-form').addEventListener('click', event => {
  const action = event.target.closest('button[data-phase-action]')?.dataset.phaseAction;
  if (action === 'add') {
    const phases = active().signals.phases;
    active().signals.phases = [...phases, { name: `Phase ${phases.length + 1}`, green: 15, movements: [] }];
    renderSettings(); inputsChanged();
    return;
  }
  if (action === 'remove') {
    const i = Number(event.target.closest('button').dataset.phase);
    active().signals.phases = active().signals.phases.filter((_, k) => k !== i);
    renderSettings(); inputsChanged();
    return;
  }
  const cell = event.target.closest('button[data-grid-add], button[data-grid-select], button[data-grid-remove]');
  if (cell) {
    const nodes = active().layout.nodes;
    if (cell.dataset.gridSelect) {
      selectedGridNode = cell.dataset.gridSelect;
      renderSettings();
      document.querySelector(`[data-grid-select="${selectedGridNode}"]`)?.focus();
    } else if (cell.dataset.gridAdd) {
      const [col, row] = cell.dataset.gridAdd.split(',').map(Number);
      const id = [...GRID.ids].find(letter => !nodes.some(n => n.id === letter));
      selectedGridNode = id;
      layoutChanged([...nodes, { id, col, row, arms: [...ARM_ORDER], offset: 0 }], `[data-grid-select="${id}"]`);
    } else {
      const removed = selectedGridNode;
      selectedGridNode = null;
      layoutChanged(nodes.filter(n => n.id !== removed), '.grid-cell.junction');
      notice(`Removed junction ${removed}.`);
    }
    return;
  }
  if (event.target.id !== 'clear-approach') return;
  delete active().approaches[editingApproach];
  renderSettings(); inputsChanged();
});
$('queue-events').addEventListener('click', event => {
  const button = event.target.closest('[data-event-link]');
  if (button) selectApproach(button.dataset.eventLink);
});
$('settings-form').addEventListener('input', event => {
  const { override, junction, group, junctionToggle, profile: profileField } = event.target.dataset;
  if (profileField) {
    const demand = active().demand;
    if (profileField === 'preset') {
      demand.profile = event.target.value === 'custom' ? { ...demand.profile, preset: 'custom' } : profilePreset(event.target.value, active().run.duration);
      renderSettings();
    } else if (profileField === 'period') {
      demand.profile = { ...demand.profile, preset: 'custom', period: event.target.value === '' ? NaN : Math.round(Number(event.target.value) * 60) };
    } else {
      const factors = event.target.value.split(/[,\s]+/).filter(Boolean).map(Number);
      demand.profile = { ...demand.profile, preset: 'custom', factors };
    }
    if (profileField !== 'preset') {
      const select = document.querySelector('[data-profile="preset"]');
      if (select) select.value = 'custom';
    }
    inputsChanged();
    return;
  }
  if (override) {
    const s = active();
    const own = { ...(s.approaches[editingApproach] ?? {}) };
    if (event.target.value === '') delete own[override];
    else own[override] = Number(event.target.value);
    if (Object.keys(own).length) s.approaches[editingApproach] = own; else delete s.approaches[editingApproach];
    inputsChanged();
    return;
  }
  const { gridArm, gridOffset } = event.target.dataset;
  if (gridArm !== undefined) {
    const nodes = active().layout.nodes.map(n => n.id !== selectedGridNode ? n : { ...n, arms: ARM_ORDER.filter(a => a === gridArm ? event.target.checked : n.arms.includes(a)) });
    layoutChanged(nodes, `[data-grid-arm="${gridArm}"]`);
    return;
  }
  if (gridOffset !== undefined) {
    const offset = event.target.value === '' ? NaN : Number(event.target.value);
    active().layout = { nodes: active().layout.nodes.map(n => n.id !== selectedGridNode ? n : { ...n, offset }) };
    inputsChanged();
    return;
  }
  const { planMode, phase, phaseField, movement } = event.target.dataset;
  if (planMode !== undefined) {
    const signals = active().signals;
    signals.mode = event.target.value;
    if (signals.mode === 'custom' && !signals.phases.length) {
      // Start from the equivalent of the two-phase plan so nothing changes until edited.
      const offered = planMovements(compileNetwork(active())).map(m => m.id);
      signals.phases = phasePreset('twoPhase', offered).map((p, i) => ({ ...p, green: i === 0 ? signals.eastWest : signals.northSouth }));
    }
    renderSettings(); inputsChanged();
    return;
  }
  if (movement !== undefined) {
    const i = Number(phase);
    active().signals.phases = active().signals.phases.map((p, k) => k !== i ? p : { ...p, movements: event.target.checked ? [...p.movements, movement] : p.movements.filter(m => m !== movement) });
    renderSettings();
    document.querySelector(`[data-phase="${i}"][data-movement="${movement}"]`)?.focus();
    inputsChanged();
    return;
  }
  if (phaseField !== undefined) {
    const i = Number(phase);
    const value = phaseField === 'green' ? (event.target.value === '' ? NaN : Number(event.target.value)) : event.target.value;
    active().signals.phases = active().signals.phases.map((p, k) => k !== i ? p : { ...p, [phaseField]: value });
    if ($('settings-cycle')) $('settings-cycle').textContent = `${format(cycleLength(active().signals), 0)} seconds`;
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
    if (value === 'grid' && !active().layout) active().layout = defaultLayout();
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

function renderSweepTargets() {
  const signals = active().signals;
  const current = $('sweep-group').value;
  const targets = sweepTargets(signals);
  $('sweep-group').innerHTML = targets.map(t => { const label = sweepGroupLabel(t, signals); return `<option value="${esc(t)}">${esc(label[0].toUpperCase() + label.slice(1))} green</option>`; }).join('');
  if (targets.includes(current)) $('sweep-group').value = current;
}

function changeView(view) {
  if (view === 'compare') { playing = false; refreshMetrics(); renderSweepTargets(); }
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
    $('time-charts').hidden = true;
    $('csv-button').disabled = true; $('report-button').disabled = true;
    renderSettings(); resetSimulation(); refreshWarnings(); renderBookmarks(); persist();
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
    if (data.type === 'progress') $('experiment-status').textContent = data.text ? `${label} · ${data.text}` : `${label} · ${data.completed} / ${data.total} alternatives complete`;
    if (data.type === 'error') { stopExperiment(); $('experiment-status').textContent = `Experiment failed: ${data.message}`; notice(data.message, 'error'); }
    if (data.type === 'complete') {
      results = data.results;
      stopExperiment();
      renderResults(results, $('results-table'), $('results-chart'));
      renderTimeCharts(results, $('time-charts'));
      refreshWarnings();
      $('experiment-status').textContent = request.adaptive
        ? `${label} · ${results.length} alternatives · ${results[0].runs.length} seeds each (added until precise, limit ${PRECISION.max}) · illustrative`
        : `${label} · ${results.length} alternatives · ${request.count} seeds each · illustrative`;
      $('csv-button').disabled = false; $('report-button').disabled = false;
      notice('Experiment complete. Read waiting demand and completion counts alongside delay.', 'success');
    }
  };
  worker.onerror = event => { stopExperiment(); $('experiment-status').textContent = 'Experiment failed to load.'; notice(`Worker error: ${event.message}. Serve the app over HTTP rather than opening the HTML file directly.`, 'error'); };
  worker.postMessage(request);
}
$('compare-button').addEventListener('click', () => {
  if (project.scenarios.length < 2) { notice('Create an alternative with Duplicate in the design view before comparing.', 'error'); return; }
  const adaptive = $('replications').value === 'adaptive';
  startExperiment({ type: 'compare', scenarios: structuredClone(project.scenarios), adaptive, count: adaptive ? PRECISION.initial : Number($('replications').value) }, 'Scenario comparison');
});
$('sweep-button').addEventListener('click', () => {
  const start = Number($('sweep-start').value), end = Number($('sweep-end').value), increment = Number($('sweep-step').value);
  if (active().template === 'roundabout') { notice('The roundabout has no signals to sweep. Choose a signalised layout, or compare scenarios instead.', 'error'); return; }
  const group = $('sweep-group').value;
  const multipliers = $('sweep-demand-levels').checked ? DEMAND_LEVELS.map(l => l.multiplier) : [active().demand.multiplier];
  try { sweepConfigurations({ group, start, end, increment, multipliers }); }
  catch (error) { notice(error.message, 'error'); return; }
  const groupLabel = sweepGroupLabel(group, active().signals);
  startExperiment({ type: 'sweep', scenario: structuredClone(active()), group, start, end, increment, multipliers, count: $('replications').value === 'adaptive' ? PRECISION.initial : Number($('replications').value) }, `${groupLabel[0].toUpperCase() + groupLabel.slice(1)} timing sweep`);
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
  if (!$('design-panel').hidden && simulation) (mapView === '3d' ? scene : renderer).draw(simulation);
  if (now - lastMetrics > 200) { refreshMetrics(); if (mapView === '3d') refreshVehicleStatus(); lastMetrics = now; }
  requestAnimationFrame(frame);
}

renderSettings();
resetSimulation();
selectApproach(selectedLink);
renderBookmarks();
try { if (localStorage.getItem(MAP_VIEW_KEY) === '3d') setMapView('3d'); } catch { /* default to the 2D plan */ }
requestAnimationFrame(frame);
