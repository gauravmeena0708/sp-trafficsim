import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenario, validateScenario } from '../src/model/project.js';
import { compileNetwork, nodeMovements } from '../src/model/network.js';
import { modelChecks } from '../src/model/checks.js';
import { Simulation, STEP } from '../src/simulation/engine.js';
import { armSignal, cycleLength, movementGreen, phasePreset, signalState } from '../src/simulation/signals.js';
import { resultsAreStale } from '../src/ui/reports.js';
import { runSweep, sweepTargets } from '../src/simulation/experiments.js';

const offered = template => {
  const s = createScenario(); s.template = template;
  const network = compileNetwork(s);
  return nodeMovements(network, network.nodes.find(n => n.control === 'signal')).map(m => m.id);
};
const custom = (preset, template = 'fourArm') => {
  const s = createScenario(); s.template = template;
  s.signals.mode = 'custom';
  s.signals.phases = phasePreset(preset, offered(template));
  return s;
};

test('custom plans cycle through named phases with clearance after each', () => {
  const s = custom('protectedRights');
  const plan = s.signals;
  // 30 + 10 + 20 + 8 green, plus 4 × (3 yellow + 2 all-red).
  assert.equal(cycleLength(plan), 88);
  assert.equal(signalState(plan, 0).name, 'East–west through');
  assert.equal(signalState(plan, 31).colour, 'yellow');
  assert.equal(signalState(plan, 34).group, 'all');
  assert.equal(signalState(plan, 35).name, 'East–west right turns');
  assert.ok(movementGreen(plan, 10, 0, 'west', 'straight'));
  assert.ok(!movementGreen(plan, 10, 0, 'west', 'right'), 'right turns wait for their own phase');
  assert.ok(movementGreen(plan, 40, 0, 'west', 'right'));
  assert.equal(armSignal(plan, 40, 0, 'west', ['left', 'straight', 'right']), 'partial');
  assert.equal(armSignal(plan, 10, 0, 'north', ['left', 'straight', 'right']), 'red');
});

test('validation rejects conflicting, missing and unserved movements', () => {
  const crossing = createScenario();
  crossing.signals.mode = 'custom';
  crossing.signals.phases = [
    { name: 'Bad', green: 20, movements: ['west:straight', 'north:straight'] },
    { name: 'Rest', green: 20, movements: offered('fourArm').filter(m => m !== 'west:straight' && m !== 'north:straight') },
  ];
  assert.match(validateScenario(crossing).join(' '), /Phase 1 runs north straight ahead and west straight ahead together/);
  const unserved = custom('protectedRights');
  unserved.signals.phases = unserved.signals.phases.slice(0, 3);
  assert.match(validateScenario(unserved).join(' '), /North right turn never gets green/);
  const missing = custom('twoPhase', 'tJunction');
  missing.signals.phases[1].movements.push('north:straight');
  assert.match(validateScenario(missing).join(' '), /does not have/);
  const one = custom('twoPhase'); one.signals.phases = one.signals.phases.slice(0, 1);
  assert.match(validateScenario(one).join(' '), /2–8 phases/);
  for (const preset of ['protectedRights', 'split', 'twoPhase']) for (const template of ['fourArm', 'tJunction', 'corridor']) {
    assert.deepEqual(validateScenario(custom(preset, template)), [], `${preset} on ${template}`);
  }
});

test('a custom plan equal to the two-phase plan gives identical results', () => {
  const builtIn = createScenario(); builtIn.turning = { left: 15, right: 25 };
  const same = custom('twoPhase'); same.turning = { left: 15, right: 25 };
  const strip = r => ({ ...r, inputs: null, fingerprint: null, scenarioId: null });
  assert.deepEqual(strip(new Simulation(same).runToEnd()), strip(new Simulation(builtIn).runToEnd()));
});

test('vehicles only enter on their own movement’s green, and protected rights never yield', () => {
  const s = custom('protectedRights');
  s.turning = { left: 15, right: 30 };
  const simulation = new Simulation(s);
  const node = simulation.network.nodes[0];
  let yields = 0;
  const original = simulation.opposingWithinGap.bind(simulation);
  simulation.opposingWithinGap = (...args) => { const r = original(...args); if (r) yields++; return r; };
  while (!simulation.done) {
    const now = simulation.time;
    simulation.step();
    for (const v of simulation.crossing.filter(c => c.progress === 0)) {
      const link = simulation.network.byId[v.path.from];
      assert.ok(movementGreen(node.plan, now, node.offset, link.toArm, v.path.movement), `${v.path.movement} from ${link.toArm} entered on red at ${now}`);
    }
  }
  assert.equal(yields, 0, 'with protected right-turn phases, no right turn ever has to give way');
  assert.ok(simulation.result().completed > 0);
  assert.ok(Math.abs(simulation.time - s.run.duration) < STEP);
});

test('right-turners waiting for a later phase do not count as cycle failures', () => {
  // With pockets, through traffic is not held behind waiting right-turners, so
  // any failure here would be a right-turner miscounted against the through phase.
  const s = custom('protectedRights');
  for (const d of ['north', 'east', 'south', 'west']) { s.demand[d] = 250; s.approaches[d] = { pocket: 60 }; }
  s.turning = { left: 10, right: 30 };
  const r = new Simulation(s).runToEnd();
  assert.equal(r.queueEvents.length, 0, JSON.stringify(r.queueEvents));
});

test('protected-only right turns in a shared lane block through traffic and are flagged', () => {
  const s = custom('protectedRights');
  for (const d of ['north', 'east', 'south', 'west']) s.demand[d] = 250;
  s.geometry.lanes = 1;
  s.turning = { left: 10, right: 30 };
  const r = new Simulation(s).runToEnd();
  assert.ok(r.queueEvents.length > 0, 'a right-turner waiting at the head of a single lane holds the through phase');
});

test('sweeps can target one phase of a custom plan', () => {
  const s = custom('protectedRights'); s.run.duration = 240;
  assert.deepEqual(sweepTargets(s.signals), ['phase:0', 'phase:1', 'phase:2', 'phase:3']);
  const results = runSweep(s, { group: 'phase:1', start: 6, end: 20, increment: 14, multipliers: [1], count: 1 });
  assert.deepEqual(results.map(r => r.inputs.signals.phases.map(p => p.green)), [[30, 6, 20, 8], [30, 20, 20, 8]]);
  assert.match(results[0].name, /phase 2 \(East–west right turns\)/);
  assert.equal(resultsAreStale(results, [s]), false);
  assert.equal(s.signals.phases[1].green, 10, 'the source scenario is not modified');
});

test('model checks name permitted right turns and ignored per-junction greens', () => {
  const s = custom('twoPhase', 'corridor');
  s.signals.junctions = { B: { eastWest: 60 } };
  const findings = modelChecks(s);
  assert.ok(findings.some(f => /Phase 1: permitted right turns/.test(f.title) && /East right turn/.test(f.detail)));
  assert.ok(findings.some(f => /Per-junction green times are ignored/.test(f.title)));
  assert.ok(!modelChecks(custom('protectedRights')).some(f => /permitted right turns/.test(f.title)));
});
