// Fixed-time signal plans. A plan is either the built-in two-phase plan
// (east–west, then north–south, each serving every movement from its arms) or
// a custom list of phases, each naming the movements it serves, written as
// "<arrival arm>:<left|straight|right>". Every phase is followed by the shared
// yellow and all-red intervals, even when a movement continues into the next
// phase (a conservative simplification).

const ARM_GROUP = { east: 'eastWest', west: 'eastWest', north: 'northSouth', south: 'northSouth' };
const cache = new WeakMap();

// Cached per plan object. The cache is checked by reference and value of the
// fields that define phases, so editors must replace (not mutate) phase arrays.
export function planPhases(plan) {
  const hit = cache.get(plan);
  if (hit && hit.mode === plan.mode && hit.list === plan.phases && hit.ew === plan.eastWest && hit.ns === plan.northSouth) return hit.phases;
  const phases = plan.mode === 'custom'
    ? plan.phases.map((p, i) => ({ name: p.name || `Phase ${i + 1}`, green: p.green, movements: new Set(p.movements), group: `phase${i}` }))
    : [{ name: 'East–west', green: plan.eastWest, movements: null, group: 'eastWest' }, { name: 'North–south', green: plan.northSouth, movements: null, group: 'northSouth' }];
  cache.set(plan, { mode: plan.mode, list: plan.phases, ew: plan.eastWest, ns: plan.northSouth, phases });
  return phases;
}

export function cycleLength(plan) {
  const phases = planPhases(plan);
  return phases.reduce((sum, p) => sum + p.green, 0) + phases.length * (plan.yellow + plan.allRed);
}

// Current state: phase index and name, colour (green, yellow, or red during all-red) and time remaining.
// `offset` shifts the plan start for coordination.
export function signalState(plan, time, offset = plan.offset ?? 0) {
  const phases = planPhases(plan);
  const cycle = cycleLength(plan);
  let t = ((time + offset) % cycle + cycle) % cycle;
  for (let index = 0; index < phases.length; index++) {
    const p = phases[index];
    if (t < p.green) return { group: p.group, index, name: p.name, colour: 'green', remaining: p.green - t };
    t -= p.green;
    if (t < plan.yellow) return { group: p.group, index, name: p.name, colour: 'yellow', remaining: plan.yellow - t };
    t -= plan.yellow;
    if (t < plan.allRed) return { group: 'all', index, name: 'All-red', colour: 'red', remaining: plan.allRed - t };
    t -= plan.allRed;
  }
  return { group: 'all', index: phases.length - 1, name: 'All-red', colour: 'red', remaining: 0 };
}

const serves = (phase, arm, movement) => phase.movements ? phase.movements.has(`${arm}:${movement}`) : phase.group === ARM_GROUP[arm];

// Only green admits new entries to the junction; yellow is treated as closed.
export function movementGreen(plan, time, offset, arm, movement) {
  const state = signalState(plan, time, offset);
  return state.colour === 'green' && serves(planPhases(plan)[state.index], arm, movement);
}

// Signal head for an arm: green when every movement it offers is green,
// "partial" when only some are (e.g. a right-turn-only phase), yellow when the
// phase serving it is ending, otherwise red.
export function armSignal(plan, time, offset, arm, movements) {
  const state = signalState(plan, time, offset);
  if (state.group === 'all') return 'red';
  const phase = planPhases(plan)[state.index];
  const served = movements.filter(m => serves(phase, arm, m));
  if (!served.length) return 'red';
  if (state.colour === 'yellow') return 'yellow';
  return served.length === movements.length ? 'green' : 'partial';
}

// Total green per cycle in which a movement may proceed.
export function movementGreenTime(plan, arm, movement) {
  return planPhases(plan).filter(p => serves(p, arm, movement)).reduce((sum, p) => sum + p.green, 0);
}

// Two-phase helpers kept for the built-in plan and its tests.
export function groupColour(plan, time, group, offset) {
  const phase = signalState(plan, time, offset);
  return phase.group === group ? phase.colour : 'red';
}
export const groupGreen = (plan, time, group, offset) => groupColour(plan, time, group, offset) === 'green';
export function isGreen(plan, time, direction, offset) {
  return groupGreen(plan, time, ARM_GROUP[direction], offset);
}

// Preset custom plans for the arms a junction has. Movements a layout lacks
// are dropped, and phases left empty are removed.
export const PHASE_PRESETS = {
  protectedRights: 'Protected right turns (4 phases)',
  split: 'One arm at a time',
  twoPhase: 'Two phases, permitted right turns',
};
export function phasePreset(name, available) {
  const has = id => available.includes(id);
  const pick = (arms, movements) => arms.flatMap(a => movements.map(m => `${a}:${m}`)).filter(has);
  const build = list => list.map(([phaseName, green, movements]) => ({ name: phaseName, green, movements })).filter(p => p.movements.length);
  if (name === 'split') return build(['north', 'east', 'south', 'west'].map(arm => [`${arm[0].toUpperCase() + arm.slice(1)} arm`, 15, pick([arm], ['left', 'straight', 'right'])]));
  if (name === 'twoPhase') return build([['East–west', 40, pick(['east', 'west'], ['left', 'straight', 'right'])], ['North–south', 25, pick(['north', 'south'], ['left', 'straight', 'right'])]]);
  return build([
    ['East–west through', 30, pick(['east', 'west'], ['left', 'straight'])],
    ['East–west right turns', 10, pick(['east', 'west'], ['right'])],
    ['North–south through', 20, pick(['north', 'south'], ['left', 'straight'])],
    ['North–south right turns', 8, pick(['north', 'south'], ['right'])],
  ]);
}
