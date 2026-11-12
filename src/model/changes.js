import { APPROACH_FIELDS, FLEET, PROFILE_PRESETS } from './project.js';
import { TEMPLATES } from './network.js';

// What an alternative changes relative to a baseline, in planner's terms.
// Each change is classed as a design change (layout, signals), an assumption
// change (demand, turning, fleet) or a run-setting change, so a comparison can
// say whether it is an infrastructure-only test.

const ARM = { north: 'North', east: 'East', south: 'South', west: 'West' };
export function approachName(id) {
  if (ARM[id]) return `${ARM[id]} approach`;
  const side = id.match(/^([A-Z])-(north|east|south|west)$/);
  if (side) return `${side[1]} ${side[2]} approach`;
  const link = id.match(/^([A-Z])-([A-Z])$/);
  if (link) return `${link[1]} → ${link[2]} link`;
  return id;
}

const GROUP = { eastWest: 'east–west', northSouth: 'north–south' };
const units = { m: ' m', s: ' s', kmh: ' km/h', vph: ' veh/h', pct: '%', x: '×', none: '' };
const fmt = (value, unit = 'none') => value === undefined ? 'shared value' : `${typeof value === 'number' ? +value.toFixed(2) : value}${units[unit]}`;

function describe(path) {
  const [head, a, b, c] = path;
  if (head === 'template') return { kind: 'design', label: 'Layout template', unit: 'template' };
  if (head === 'layout') return { kind: 'design', label: `Junction ${a} ${{ position: 'grid position', arms: 'arms', offset: 'signal offset' }[b] ?? b}`, unit: b === 'offset' ? 'layoutSeconds' : 'layout' };
  if (head === 'geometry') return { kind: 'design', label: { length: 'Approach length (shared)', lanes: 'Lanes per direction (shared)', speed: 'Speed limit (shared)', spacing: 'Link length between junctions' }[a] ?? a, unit: { length: 'm', spacing: 'm', speed: 'kmh' }[a] };
  if (head === 'approaches') {
    const field = APPROACH_FIELDS[b];
    const unit = { length: 'm', pocket: 'm', speed: 'kmh', left: 'pct', right: 'pct', demand: 'vph' }[b];
    // Turning shares and demand are assumptions, not layout.
    return { kind: ['left', 'right', 'demand'].includes(b) ? 'assumption' : 'design', label: `${approachName(a)}: ${(field?.label ?? b).replace(/ \(.*\)$/, '').toLowerCase()}`, unit };
  }
  if (head === 'signals') {
    if (a === 'junctions') return { kind: 'design', label: `Junction ${b} ${GROUP[c] ?? c} green`, unit: 's' };
    if (a === 'phases') return { kind: 'design', label: 'Signal phase plan', unit: 'plan' };
    if (a === 'mode') return { kind: 'design', label: 'Signal plan type', unit: 'none' };
    return { kind: 'design', label: { eastWest: 'East–west green', northSouth: 'North–south green', yellow: 'Yellow interval', allRed: 'All-red interval', offset: 'Junction B offset' }[a] ?? a, unit: 's' };
  }
  if (head === 'turning') return { kind: 'assumption', label: `${a === 'left' ? 'Left' : 'Right'}-turn share (shared)`, unit: 'pct' };
  if (head === 'demand') {
    if (a === 'multiplier') return { kind: 'assumption', label: 'Demand multiplier', unit: 'x' };
    if (a === 'profile') return { kind: 'assumption', label: 'Demand over time', unit: 'profile' };
    return { kind: 'assumption', label: `${ARM[a] ?? a} demand`, unit: 'vph' };
  }
  if (head === 'fleet') return { kind: 'assumption', label: `${FLEET[a]?.label ?? a} share`, unit: 'pct' };
  if (head === 'run') return { kind: 'run', label: { duration: 'Run duration', warmup: 'Warm-up', seed: 'Random seed' }[a] ?? a, unit: a === 'seed' ? 'none' : 's' };
  return { kind: 'design', label: path.join('.'), unit: 'none' };
}

// Leaves are numbers/strings; arrays and the demand profile / phase plan are compared whole.
function flatten(value, path = [], out = new Map()) {
  const atomic = Array.isArray(value) || (path[0] === 'demand' && path[1] === 'profile') || (path[0] === 'signals' && path[1] === 'phases');
  if (value !== null && typeof value === 'object' && !atomic) {
    for (const [k, v] of Object.entries(value)) flatten(v, [...path, k], out);
  } else out.set(path.join('.'), value);
  return out;
}

function show(value, unit) {
  if (unit === 'template') return TEMPLATES[value] ?? value;
  if (unit === 'profile') {
    if (!value) return 'none';
    const preset = PROFILE_PRESETS[value.preset]?.label ?? 'Custom';
    return `${preset} (${value.factors.join(', ')} × every ${+(value.period / 60).toFixed(2)} min)`;
  }
  if (unit === 'plan') return Array.isArray(value) ? `${value.length} phases` : 'none';
  if (unit === 'layout' || unit === 'layoutSeconds') return value === undefined ? 'no junction' : unit === 'layout' ? value : fmt(value, 's');
  return fmt(value, unit);
}

// A grid layout is compared junction by junction, in words.
const layoutView = layout => layout ? Object.fromEntries(layout.nodes.map(n => [n.id, {
  position: `column ${n.col + 1}, row ${n.row + 1}`, arms: n.arms.length === 4 ? 'all four' : n.arms.join(', '), offset: n.offset }])) : undefined;

export function scenarioChanges(baseline, alternative) {
  const { id: _a, name: _b, ...base } = { ...baseline, layout: layoutView(baseline.layout) };
  const { id: _c, name: _d, ...alt } = { ...alternative, layout: layoutView(alternative.layout) };
  const before = flatten(base), after = flatten(alt);
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const changes = [];
  for (const key of keys) {
    const from = before.get(key), to = after.get(key);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    const { kind, label, unit } = describe(key.split('.'));
    changes.push({ key, kind, label, from: show(from, unit), to: show(to, unit) });
  }
  const order = { design: 0, assumption: 1, run: 2 };
  return changes.sort((x, y) => order[x.kind] - order[y.kind] || x.label.localeCompare(y.label));
}

export const changeText = c => `${c.label}: ${c.from} → ${c.to}`;

export function changeSummary(changes) {
  const design = changes.filter(c => c.kind === 'design').length;
  const other = changes.length - design;
  if (!changes.length) return 'Identical inputs to the baseline.';
  if (!other) return `${design} design change${design === 1 ? '' : 's'}; demand and run settings match the baseline.`;
  return `${design} design and ${other} demand or run change${other === 1 ? '' : 's'}: not an infrastructure-only comparison.`;
}
