export const DIRECTIONS = ['north', 'east', 'south', 'west'];
import { TEMPLATES } from './network.js';

export const ENGINE_VERSION = 'illustrative-network/0.2.0';
export const SCHEMA_VERSION = 2;
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
    demand: { north: 450, east: 800, south: 450, west: 800, multiplier: 1 },
    signals: { eastWest: 40, northSouth: 25, yellow: 3, allRed: 2, offset: 0 },
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
  return errors;
}

export function createProject() {
  return { schemaVersion: SCHEMA_VERSION, title: 'Junction study', scenarios: [createScenario()], results: [] };
}

// Schema 1 described a single straight-through four-arm junction.
export function migrateScenario(s, fromVersion) {
  if (fromVersion >= 2 || !s || typeof s !== 'object') return s;
  return { ...s, template: 'fourArm', geometry: { ...s.geometry, spacing: 200 }, turning: { left: 0, right: 0 } };
}

export function parseProject(text) {
  if (text.length > 5_000_000) throw new Error('Project is larger than the 5 MB import limit.');
  const project = JSON.parse(text);
  if (![1, SCHEMA_VERSION].includes(project?.schemaVersion)) throw new Error('Unsupported project version.');
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
