export const DIRECTIONS = ['north', 'east', 'south', 'west'];
import { TEMPLATES, analysePhase, approachSettings, compileNetwork, configurableApproaches, movementLabel, nodeMovements } from './network.js';
const MOVEMENT_ID = /^(north|east|south|west):(left|straight|right)$/;

export const ENGINE_VERSION = 'illustrative-network/0.5.0';
export const SCHEMA_VERSION = 5;

// Demand over time: each entry's base veh/h is multiplied by the factor for the
// current period. Presets are written out as explicit factors so a saved
// scenario reproduces exactly; they span the run duration in six periods.
export const PROFILE_PRESETS = {
  flat: { label: 'Constant', shape: [1] },
  peak: { label: 'Peak in the middle', shape: [0.6, 0.9, 1.3, 1.5, 1.1, 0.6] },
  surge: { label: 'Short surge', shape: [0.8, 0.8, 2, 0.8, 0.8, 0.8] },
  rising: { label: 'Steadily rising', shape: [0.6, 0.8, 1, 1.2, 1.4, 1.6] },
};
export function profilePreset(preset, duration) {
  const shape = PROFILE_PRESETS[preset]?.shape ?? [1];
  return { preset, period: shape.length === 1 ? 900 : Math.max(60, Math.round(duration / shape.length)), factors: [...shape] };
}
export const APPROACH_FIELDS = {
  lanes: { label: 'Lanes', min: 1, max: 3, integer: true },
  speed: { label: 'Speed limit (km/h)', min: 20, max: 80 },
  length: { label: 'Approach length (m)', min: 100, max: 600, entryOnly: true },
  left: { label: 'Left turn (%)', min: 0, max: 100 },
  right: { label: 'Right turn (%)', min: 0, max: 100 },
  pocket: { label: 'Right-turn pocket (m)', min: 0, max: 200 },
};
export const FLEET = {
  twoWheeler: { label: 'Two-wheelers', length: 2, speedFactor: 1, acceleration: 2.2, occupancy: 1.2, colour: '#d48b37' },
  auto: { label: 'Auto-rickshaws', length: 3, speedFactor: 0.85, acceleration: 1.6, occupancy: 2, colour: '#9c78cc' },
  car: { label: 'Cars', length: 4.5, speedFactor: 1, acceleration: 1.8, occupancy: 1.5, colour: '#54b8bd' },
  bus: { label: 'Buses', length: 11, speedFactor: 0.8, acceleration: 0.9, occupancy: 25, colour: '#456cba' },
  truck: { label: 'Trucks', length: 10, speedFactor: 0.75, acceleration: 0.7, occupancy: 1.2, colour: '#8a929e' },
};

export function createScenario(name = 'Existing junction') {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `scenario-${Date.now()}`,
    name,
    template: 'fourArm',
    geometry: { length: 250, lanes: 2, speed: 40, spacing: 200 },
    turning: { left: 0, right: 0 },
    approaches: {},
    demand: { north: 450, east: 800, south: 450, west: 800, multiplier: 1, profile: profilePreset('flat', 600) },
    signals: { mode: 'twoPhase', eastWest: 40, northSouth: 25, phases: [], yellow: 3, allRed: 2, offset: 0, junctions: {} },
    fleet: { twoWheeler: 30, auto: 10, car: 50, bus: 5, truck: 5 },
    run: { duration: 600, warmup: 60, seed: 42 },
  };
}

export function fingerprint(scenario) {
  const { name, id, ...inputs } = scenario;
  return JSON.stringify(inputs);
}

export function validateScenario(s) {
  const errors = [];
  const range = (value, min, max, label, integer = false) => {
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) errors.push(`${label} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  };
  if (!s || typeof s !== 'object') return ['Missing scenario.'];
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 80) errors.push('Scenario name must contain 1–80 characters.');
  if (typeof s.id !== 'string' || !s.id) errors.push('Scenario ID is missing.');
  range(s.geometry?.length, 100, 600, 'Approach length');
  range(s.geometry?.lanes, 1, 3, 'Lanes per approach', true);
  range(s.geometry?.speed, 20, 80, 'Speed limit');
  range(s.geometry?.spacing, 60, 600, 'Junction spacing');
  if (!Object.hasOwn(TEMPLATES, s.template)) errors.push('Choose a supported layout template.');
  range(s.turning?.left, 0, 100, 'Left-turn share');
  range(s.turning?.right, 0, 100, 'Right-turn share');
  if ((s.turning?.left ?? 0) + (s.turning?.right ?? 0) > 100) errors.push('Left- and right-turn shares cannot exceed 100% together.');
  for (const d of DIRECTIONS) range(s.demand?.[d], 0, 3600, `${d} demand`);
  range(s.demand?.multiplier, 0.25, 3, 'Demand multiplier');
  const profile = s.demand?.profile;
  if (!profile || typeof profile !== 'object') errors.push('Demand profile is missing.');
  else {
    if (![...Object.keys(PROFILE_PRESETS), 'custom'].includes(profile.preset)) errors.push('Choose a supported demand profile.');
    range(profile.period, 60, 3600, 'Demand profile period', true);
    if (!Array.isArray(profile.factors) || profile.factors.length < 1 || profile.factors.length > 48) errors.push('A demand profile needs 1–48 period factors.');
    else if (profile.factors.some(f => !Number.isFinite(f) || f < 0 || f > 3)) errors.push('Demand profile factors must each be between 0 and 3.');
  }
  range(s.signals?.eastWest, 5, 300, 'East–west green');
  range(s.signals?.northSouth, 5, 300, 'North–south green');
  range(s.signals?.yellow, 3, 10, 'Yellow interval');
  range(s.signals?.allRed, 2, 10, 'All-red clearance');
  range(s.signals?.offset, 0, 600, 'Signal offset');
  for (const k of Object.keys(FLEET)) range(s.fleet?.[k], 0, 100, `${FLEET[k].label} share`);
  if (Math.abs(Object.keys(FLEET).reduce((sum, k) => sum + (s.fleet?.[k] ?? 0), 0) - 100) > 0.01) errors.push('Vehicle shares must total 100%.');
  range(s.run?.duration, 120, 3600, 'Run duration', true);
  range(s.run?.warmup, 0, (s.run?.duration ?? 0) - 60, 'Warm-up duration', true);
  range(s.run?.seed, 1, 2147483647, 'Random seed', true);
  if (!s.approaches || typeof s.approaches !== 'object' || Array.isArray(s.approaches)) errors.push('Approach settings are missing.');
  else for (const [id, overrides] of Object.entries(s.approaches)) {
    if (!overrides || typeof overrides !== 'object') { errors.push(`Approach ${id} settings are invalid.`); continue; }
    for (const [key, value] of Object.entries(overrides)) {
      const field = APPROACH_FIELDS[key];
      if (!field) errors.push(`Approach ${id} has an unknown setting “${key}”.`);
      else range(value, field.min, field.max, `${id} ${field.label.toLowerCase()}`, field.integer);
    }
    const left = overrides.left ?? s.turning?.left ?? 0, right = overrides.right ?? s.turning?.right ?? 0;
    if (left + right > 100) errors.push(`${id}: left- and right-turn shares cannot exceed 100% together.`);
  }
  const junctions = s.signals?.junctions;
  if (!junctions || typeof junctions !== 'object' || Array.isArray(junctions)) errors.push('Junction signal settings are missing.');
  else for (const [id, plan] of Object.entries(junctions)) {
    for (const key of Object.keys(plan ?? {})) {
      if (!['eastWest', 'northSouth'].includes(key)) errors.push(`Junction ${id} has an unknown signal setting “${key}”.`);
      else range(plan[key], 5, 300, `Junction ${id} ${key === 'eastWest' ? 'east–west' : 'north–south'} green`);
    }
  }
  if (!['twoPhase', 'custom'].includes(s.signals?.mode)) errors.push('Choose a signal plan type.');
  if (!Array.isArray(s.signals?.phases)) errors.push('Signal phases are missing.');
  else if (s.signals.mode === 'custom') {
    if (s.signals.phases.length < 2 || s.signals.phases.length > 8) errors.push('A custom signal plan needs 2–8 phases.');
    s.signals.phases.forEach((p, i) => {
      range(p?.green, 5, 300, `Phase ${i + 1} green`);
      if (typeof p?.name !== 'string' || p.name.length > 40) errors.push(`Phase ${i + 1} name must be up to 40 characters.`);
      if (!Array.isArray(p?.movements) || !p.movements.length) errors.push(`Phase ${i + 1} must serve at least one movement.`);
      else if (p.movements.some(m => !MOVEMENT_ID.test(m)) || new Set(p.movements).size !== p.movements.length) errors.push(`Phase ${i + 1} lists an invalid or repeated movement.`);
    });
  }
  if (!errors.length) {
    // Pockets must leave a through section before them on the approach.
    const network = compileNetwork(s);
    if (s.signals.mode === 'custom') errors.push(...phasePlanErrors(network, s.signals.phases));
    for (const link of configurableApproaches(network)) {
      const pocket = approachSettings(s, link.id, link.kind).pocket;
      if (pocket && pocket > link.length - 10) errors.push(`${link.label}: the right-turn pocket must be at least 10 m shorter than the ${Math.round(link.length)} m approach.`);
    }
  }
  return errors;
}

// A custom plan must fit every signalised junction: phases may only list
// movements the junction offers, every offered movement must get green, and
// two conflicting straight/left movements may not share a phase.
function phasePlanErrors(network, phases) {
  const errors = [];
  for (const node of network.nodes.filter(n => n.control === 'signal')) {
    const offered = nodeMovements(network, node).map(m => m.id);
    const where = network.nodes.length > 1 ? ` at ${node.label}` : '';
    phases.forEach((p, i) => {
      for (const id of p.movements) if (!offered.includes(id)) errors.push(`Phase ${i + 1} lists ${movementLabel(id).toLowerCase()}, which this layout does not have${where}.`);
      for (const [a, b] of analysePhase(network, node, p.movements).errors) errors.push(`Phase ${i + 1} runs ${movementLabel(a).toLowerCase()} and ${movementLabel(b).toLowerCase()} together, but their paths cross${where}.`);
    });
    for (const id of offered) if (!phases.some(p => p.movements.includes(id))) errors.push(`${movementLabel(id)} never gets green${where}: vehicles making it would wait forever.`);
  }
  return [...new Set(errors)];
}

export function createProject() {
  return { schemaVersion: SCHEMA_VERSION, title: 'Junction study', scenarios: [createScenario()], results: [] };
}

// Schema 1 described a single straight-through four-arm junction; schema 2 added
// templates and shared turning shares; schema 3 adds per-approach and per-junction settings.
export function migrateScenario(s, fromVersion) {
  if (fromVersion >= SCHEMA_VERSION || !s || typeof s !== 'object') return s;
  let next = s;
  if (fromVersion < 2) next = { ...next, template: 'fourArm', geometry: { ...next.geometry, spacing: 200 }, turning: { left: 0, right: 0 } };
  if (fromVersion < 3) next = { ...next, approaches: {}, signals: { ...next.signals, junctions: {} } };
  if (fromVersion < 4) next = { ...next, demand: { ...next.demand, profile: profilePreset('flat', next.run?.duration ?? 600) } };
  if (fromVersion < 5) next = { ...next, signals: { ...next.signals, mode: 'twoPhase', phases: [] } };
  return next;
}

export function parseProject(text) {
  if (text.length > 5_000_000) throw new Error('Project is larger than the 5 MB import limit.');
  const project = JSON.parse(text);
  if (![1, 2, 3, 4, SCHEMA_VERSION].includes(project?.schemaVersion)) throw new Error('Unsupported project version.');
  if (Array.isArray(project.scenarios)) project.scenarios = project.scenarios.map(s => migrateScenario(s, project.schemaVersion));
  if (!Array.isArray(project.scenarios) || project.scenarios.length < 1 || project.scenarios.length > 30) throw new Error('A project must contain 1–30 scenarios.');
  const ids = new Set();
  for (const s of project.scenarios) {
    const errors = validateScenario(s);
    if (errors.length) throw new Error(errors.join(' '));
    if (ids.has(s.id)) throw new Error('Duplicate scenario IDs.');
    ids.add(s.id);
  }
  // Imported reports are not trusted as engine outputs. Re-run scenarios to compare.
  return { schemaVersion: SCHEMA_VERSION, title: 'Junction study', scenarios: project.scenarios, results: [] };
}
