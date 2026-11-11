import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenario, parseProject, createProject, fingerprint, validateScenario } from '../src/model/project.js';
import { Simulation, STEP, GAP, queueExtent } from '../src/simulation/engine.js';
import { compileNetwork, pathsConflict, movementType, chooseRoute } from '../src/model/network.js';
import { cycleLength, isGreen, signalState } from '../src/simulation/signals.js';
import { timingCandidates, runReplications, summarize } from '../src/simulation/experiments.js';
import { csvReport, resultsAreStale, comparisonWarnings } from '../src/ui/reports.js';

test('signal phases include separate yellow/all-red intervals and wrap correctly', () => {
  const s = createScenario().signals;
  assert.equal(cycleLength(s), 75);
  assert.equal(signalState(s, 40).colour, 'yellow');
  assert.equal(signalState(s, 43).group, 'all');
  assert.equal(signalState(s, 45).group, 'northSouth');
  assert.equal(signalState(s, 75).group, 'eastWest');
  for (let t = 0; t < 750; t += STEP) {
    assert.ok(!(isGreen(s, t, 'north') && isGreen(s, t, 'west')));
  }
});

test('5 and 300 second greens remain valid without erasing clearances', () => {
  const s = createScenario();
  s.signals.eastWest = 5;
  s.signals.northSouth = 300;
  assert.deepEqual(validateScenario(s), []);
  assert.equal(cycleLength(s.signals), 315);
  s.signals.yellow = 0;
  assert.match(validateScenario(s).join(' '), /Yellow/);
});

test('repeat runs are deterministic and conserve all requested vehicles', () => {
  const s = createScenario();
  const first = new Simulation(s).runToEnd();
  const second = new Simulation(s).runToEnd();
  assert.deepEqual(first, second);
  assert.ok(first.completed > 0);
  assert.equal(first.requested, first.completed + first.inNetwork + first.waiting);
  assert.equal(first.admitted, first.completed + first.inNetwork);
  assert.equal(first.simulatedSeconds, s.run.duration);
});

// Shared invariants checked at every step: conservation, spacing on every lane,
// and no two vehicles using conflicting junction paths at the same time.
function assertInvariants(simulation) {
  const r = simulation.result();
  assert.equal(r.requested, r.completed + r.inNetwork + r.waiting);
  assert.equal(r.admitted, r.completed + r.inNetwork);
  for (const link of Object.values(simulation.links)) for (const lane of link.lanes) {
    for (let i = 1; i < lane.length; i++) {
      assert.ok(lane[i - 1].position - lane[i - 1].length - lane[i].position >= GAP - 1e-8, `spacing on ${link.id}`);
    }
    assert.ok(lane.every(v => v.position >= v.length - 1e-8), `vehicle behind start of ${link.id}`);
    if (link.to) assert.ok(lane.every(v => v.position <= link.length + 1e-8), `vehicle past stop line on ${link.id}`);
  }
  const crossing = simulation.crossing;
  for (let i = 0; i < crossing.length; i++) for (let j = i + 1; j < crossing.length; j++) {
    assert.ok(!pathsConflict(simulation.network, crossing[i].path, crossing[j].path), `conflicting paths ${crossing[i].path.key} / ${crossing[j].path.key}`);
  }
}

test('overloaded boundaries retain demand and preserve lane spacing at each step', () => {
  const s = createScenario();
  s.geometry.lanes = 1;
  s.geometry.length = 100;
  s.signals.eastWest = 5;
  s.signals.northSouth = 300;
  for (const d of ['north', 'east', 'south', 'west']) s.demand[d] = 3600;
  const simulation = new Simulation(s);
  while (!simulation.done) { simulation.step(); assertInvariants(simulation); }
  const r = simulation.result();
  assert.ok(r.waiting > 0);
  assert.ok(r.queues.west.entryBlockedSeconds > 0);
});

test('zero demand has no vehicles and no invented journey times', () => {
  const s = createScenario();
  for (const key of ['north', 'east', 'south', 'west']) s.demand[key] = 0;
  const r = new Simulation(s).runToEnd();
  assert.equal(r.requested, 0);
  assert.equal(r.meanJourney, null);
  assert.equal(r.accruedDelayPerRequest, null);
  assert.equal(r.maxQueue, 0);
});

test('timing alternatives use identical requested arrivals and fleet identities', () => {
  const first = createScenario();
  const second = structuredClone(first);
  second.signals.eastWest = 300;
  const a = new Simulation(first), b = new Simulation(second);
  const vehiclesA = [], vehiclesB = [];
  for (const [sim, collector] of [[a, vehiclesA], [b, vehiclesB]]) {
    const make = sim.makeVehicle.bind(sim);
    sim.makeVehicle = (...args) => {
      const v = make(...args);
      collector.push([v.direction, v.type, v.departure, v.desired]);
      return v;
    };
    sim.runToEnd();
  }
  assert.deepEqual(vehiclesA, vehiclesB);
});

test('project import validates inputs and does not trust imported result claims', () => {
  const project = createProject();
  project.results = [{ status: 'Validated' }];
  const loaded = parseProject(JSON.stringify(project));
  assert.deepEqual(loaded.scenarios, project.scenarios);
  assert.deepEqual(loaded.results, []);
  project.scenarios[0].fleet.car = 0;
  assert.throws(() => parseProject(JSON.stringify(project)), /100%/);
  assert.throws(() => parseProject('{"schemaVersion":99}'), /version/);
});

test('timing sweep includes both endpoints and limits accidental excessive work', () => {
  const candidates = timingCandidates(5, 300, 30);
  assert.equal(candidates[0], 5);
  assert.equal(candidates.at(-1), 300);
  assert.deepEqual(timingCandidates(5, 5, 1), [5]);
  assert.throws(() => timingCandidates(5, 300, 1), /30 candidates/);
  assert.throws(() => timingCandidates(5, 300, 0), /increment/);
});

test('replication statistics use sample SD and retained seed metadata', () => {
  assert.deepEqual(summarize([1, 2, 3]), { mean: 2, sd: 1, n: 3 });
  assert.deepEqual(summarize([null]), { mean: null, sd: null, n: 0 });
  const s = createScenario();
  const result = runReplications(s, 3);
  assert.deepEqual(result.runs.map(r => r.seed), [42, 43, 44]);
  assert.ok(result.runs.every(r => r.inputs.run.seed === r.seed));
});

test('stale results are detected and CSV exports retain reproducible inputs safely', () => {
  const s = createScenario('=UNTRUSTED()');
  const result = runReplications(s, 1);
  assert.equal(resultsAreStale([result], [s]), false);
  assert.equal(comparisonWarnings([result]).length, 0);
  const csv = csvReport([result]);
  assert.match(csv, /"'=UNTRUSTED\(\)"/);
  assert.match(csv, /inputs_json/);
  const changed = structuredClone(s);
  changed.signals.eastWest = 50;
  assert.notEqual(fingerprint(s), fingerprint(changed));
  assert.equal(resultsAreStale([result], [changed]), true);
  const other = structuredClone(s);
  other.demand.multiplier = 1.25;
  assert.match(comparisonWarnings([result, runReplications(other, 1)]).join(' '), /Demand differ/);
});

test('paired differences match seeds and use t-based 95% intervals', async () => {
  const { pairedDifference, tCritical95, attachBaselineDifferences, sweepConfigurations } = await import('../src/simulation/experiments.js');
  const base = [{ seed: 1, x: 10 }, { seed: 2, x: 12 }, { seed: 3, x: 14 }];
  const alt = [{ seed: 3, x: 15 }, { seed: 1, x: 12 }, { seed: 2, x: 15 }];
  const d = pairedDifference(base, alt, 'x');
  // Differences 2, 3, 1: mean 2, sd 1, half-width t(2) / sqrt(3).
  assert.equal(d.mean, 2);
  assert.ok(Math.abs(d.high - d.mean - tCritical95(2) / Math.sqrt(3)) < 1e-9);
  assert.equal(pairedDifference(base, [{ seed: 9, x: 1 }], 'x').excluded, 1);
  assert.equal(pairedDifference(base.slice(0, 1), alt.slice(1, 2), 'x').low, null);

  const s = createScenario();
  const other = structuredClone(s); other.signals.eastWest = 60;
  const results = attachBaselineDifferences([runReplications(s, 2), runReplications(other, 2)]);
  assert.equal(results[0].baseline, true);
  assert.equal(results[1].differences.accruedDelayPerRequest.n, 2);
  const unpaired = structuredClone(s); unpaired.demand.multiplier = 1.25;
  assert.match(attachBaselineDifferences([runReplications(s, 1), runReplications(unpaired, 1)])[1].differenceNote, /Not paired/);

  const configs = sweepConfigurations({ group: 'northSouth', start: 5, end: 65, increment: 30, multipliers: [0.75, 1, 1.25] });
  assert.equal(configs.length, 9);
  assert.throws(() => sweepConfigurations({ group: 'northSouth', start: 5, end: 300, increment: 14, multipliers: [0.75, 1, 1.25] }), /At most 60/);
});

test('sweeps vary the chosen group and demand level without being reported stale', async () => {
  const { runSweep, sweepFindings } = await import('../src/simulation/experiments.js');
  const s = createScenario();
  s.run.duration = 300;
  const results = runSweep(s, { group: 'northSouth', start: 10, end: 70, increment: 60, multipliers: [0.75, 1.25], count: 1 });
  assert.deepEqual(results.map(r => [r.inputs.signals.northSouth, r.inputs.demand.multiplier]), [[10, 0.75], [70, 0.75], [10, 1.25], [70, 1.25]]);
  assert.ok(results.every(r => r.inputs.signals.eastWest === s.signals.eastWest));
  assert.equal(resultsAreStale(results, [s]), false);
  assert.ok(!comparisonWarnings(results).some(w => /Demand differ/.test(w)));
  assert.equal(sweepFindings(results).best.length, 2);
});

test('every template keeps invariants with turning traffic and routes follow connected links', () => {
  for (const template of ['fourArm', 'tJunction', 'corridor']) {
    const s = createScenario();
    s.template = template;
    s.turning = { left: 25, right: 25 };
    s.run.duration = 400;
    s.geometry.spacing = 80;
    for (const d of ['north', 'east', 'south', 'west']) s.demand[d] = 900;
    const simulation = new Simulation(s);
    const routes = [];
    const make = simulation.makeVehicle.bind(simulation);
    simulation.makeVehicle = (...args) => { const v = make(...args); routes.push(v.route); return v; };
    while (!simulation.done) { simulation.step(); assertInvariants(simulation); }
    assert.ok(simulation.result().completed > 0, template);
    for (const route of routes) {
      for (let i = 1; i < route.length; i++) assert.equal(simulation.network.byId[route[i - 1]].to, simulation.network.byId[route[i]].from);
      assert.equal(simulation.network.byId[route.at(-1)].kind, 'exit');
      assert.notEqual(route.at(-1), `${route[0]}-out`, 'no U-turns');
    }
  }
});

test('turn movements follow left-hand traffic and declared shares', () => {
  assert.equal(movementType('west', 'north'), 'left');
  assert.equal(movementType('west', 'south'), 'right');
  assert.equal(movementType('south', 'west'), 'left');
  assert.equal(movementType('east', 'west'), 'straight');
  const s = createScenario();
  s.turning = { left: 100, right: 0 };
  for (const d of ['north', 'east', 'south']) s.demand[d] = 0;
  const r = new Simulation(s).runToEnd();
  assert.ok(r.completed > 0);
  assert.deepEqual(Object.keys(r.exitCounts), ['north-out']);
  // The T-junction stem has no straight movement; shares renormalise to left/right.
  const t = createScenario(); t.template = 'tJunction'; t.turning = { left: 0, right: 0 };
  const network = compileNetwork(t);
  const exits = new Set([0.1, 0.9].map(d => chooseRoute(network, 'south', t.turning, [d]).route.at(-1)));
  assert.deepEqual([...exits].sort(), ['east-out', 'west-out']);
  assert.equal(network.nodes[0].inbound.north, undefined);
});

test('a restricted downstream junction spills back along the corridor link', () => {
  const s = createScenario();
  s.template = 'corridor';
  s.geometry.spacing = 80;
  s.geometry.lanes = 1;
  s.demand.west = 1200; s.demand.east = 0; s.demand.north = 0; s.demand.south = 0;
  // A releases a platoon longer than the 80 m link stores while B, offset by
  // half a cycle, is red: the queue must reach back into junction A.
  s.signals.eastWest = 30; s.signals.northSouth = 120; s.signals.offset = 80;
  s.run.duration = 900;
  const simulation = new Simulation(s);
  while (!simulation.done) { simulation.step(); assertInvariants(simulation); }
  const r = simulation.result();
  assert.ok(r.queues['A-B'].spillbackSeconds > 0, 'queue reaches junction A');
  assert.ok(r.queues.west.downstreamBlockedSeconds > 0, 'west approach blocked by the full link');
  assert.ok(r.waiting > 0);
});

test('queue extent counts only a slow chain from the stop line', () => {
  const link = { length: 200, lanes: [[
    { position: 199, length: 4.5, speed: 0 },
    { position: 190, length: 4.5, speed: 0.5 },
    { position: 120, length: 4.5, speed: 0 },
  ]] };
  assert.equal(queueExtent(link), 200 - (190 - 4.5));
  link.lanes[0][0].speed = 5;
  assert.equal(queueExtent(link), 0);
});

test('schema 1 projects migrate to the straight-through four-arm template', () => {
  const project = createProject();
  const v1 = structuredClone(project.scenarios[0]);
  delete v1.template; delete v1.turning; delete v1.geometry.spacing;
  const loaded = parseProject(JSON.stringify({ schemaVersion: 1, scenarios: [v1] }));
  assert.equal(loaded.scenarios[0].template, 'fourArm');
  assert.deepEqual(loaded.scenarios[0].turning, { left: 0, right: 0 });
  assert.deepEqual(validateScenario(loaded.scenarios[0]), []);
  const bad = structuredClone(project.scenarios[0]); bad.turning = { left: 70, right: 40 };
  assert.match(validateScenario(bad).join(' '), /exceed 100/);
});
