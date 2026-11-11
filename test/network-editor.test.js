import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenario, parseProject, createProject, validateScenario } from '../src/model/project.js';
import { modelChecks } from '../src/model/checks.js';
import { Simulation, GAP } from '../src/simulation/engine.js';
import { compileNetwork, pathsConflict, chooseRoute } from '../src/model/network.js';
import { groupGreen } from '../src/simulation/signals.js';

function assertInvariants(simulation) {
  const r = simulation.result();
  assert.equal(r.requested, r.completed + r.inNetwork + r.waiting);
  for (const link of Object.values(simulation.links)) for (const lane of link.lanes) {
    for (let i = 1; i < lane.length; i++) assert.ok(lane[i - 1].position - lane[i - 1].length - lane[i].position >= GAP - 1e-8, `spacing on ${link.id}`);
    if (link.to) assert.ok(lane.every(v => v.position <= link.length + 1e-8), `past stop line on ${link.id}`);
  }
  const crossing = simulation.crossing;
  for (let i = 0; i < crossing.length; i++) for (let j = i + 1; j < crossing.length; j++) {
    const [a, b] = [crossing[i], crossing[j]];
    if (pathsConflict(simulation.network, a.path, b.path)) {
      // Only converging roundabout movements may share a junction, one behind the other.
      assert.equal(simulation.network.nodeById[a.path.node].control, 'priority', `conflict ${a.path.key} / ${b.path.key}`);
      assert.equal(a.path.to, b.path.to);
    }
  }
}

const heavy = (s, perArm) => { for (const d of ['north', 'east', 'south', 'west']) s.demand[d] = perArm; return s; };

test('roundabout routes circulate clockwise and exit at the chosen arm', () => {
  const s = createScenario(); s.template = 'roundabout';
  const network = compileNetwork(s);
  // From the west, left = first exit (north), straight = east, right = south.
  s.turning = { left: 100, right: 0 };
  const left = chooseRoute(compileNetwork(s), 'west', s.turning, [0.5]);
  assert.deepEqual(left.route, ['west', 'RW-RN', 'north-out']);
  assert.deepEqual(left.moves, ['merge', 'diverge']);
  s.turning = { left: 0, right: 100 };
  const right = chooseRoute(compileNetwork(s), 'west', s.turning, [0.5]);
  assert.deepEqual(right.route, ['west', 'RW-RN', 'RN-RE', 'RE-RS', 'south-out']);
  assert.ok(network.nodes.every(n => n.control === 'priority'));
  assert.ok(network.links.every(l => l.lanes === 1));
});

test('roundabout keeps invariants under heavy demand and does not lock up', () => {
  const s = heavy(createScenario(), 900);
  s.template = 'roundabout'; s.turning = { left: 25, right: 25 }; s.run.duration = 1200;
  const simulation = new Simulation(s);
  let completedAtHalf = 0;
  while (!simulation.done) {
    simulation.step();
    assertInvariants(simulation);
    if (Math.abs(simulation.time - 600) < 1e-6) completedAtHalf = simulation.completed;
  }
  const r = simulation.result();
  assert.ok(r.completed - completedAtHalf > 100, 'traffic keeps moving in the second half');
  assert.ok(r.waiting > 0, 'overload is retained as waiting demand');
});

test('roundabout entries give way to circulating traffic within the critical gap', () => {
  const s = createScenario(); s.template = 'roundabout';
  heavy(s, 0);
  const simulation = new Simulation(s);
  const entry = simulation.links.west, ring = simulation.links['RS-RW'];
  const make = (linkId, moves, route) => ({ id: Math.random(), type: 'car', length: 4.5, desired: 8, speedFactor: 1, speed: 0, measured: false, occupancy: 1, route, moves, leg: 0 });
  const entering = make('west', ['merge', 'diverge'], ['west', 'RW-RN', 'north-out']);
  entering.position = entry.length;
  entry.lanes[0].push(entering);
  assert.equal(simulation.entryRefusal(entering, entry, 0, 10), null, 'free to enter with an empty ring');
  const circulating = make('RS-RW', ['circulate', 'diverge'], ['RS-RW', 'RW-RN', 'north-out']);
  circulating.position = ring.length - 8; circulating.speed = 6;
  ring.lanes[0].push(circulating);
  assert.equal(simulation.entryRefusal(entering, entry, 0, 10), 'yield');
});

test('a short right-turn pocket overflows and blocks through traffic; a longer one helps', () => {
  const run = pocket => {
    const s = heavy(createScenario(), 0);
    s.demand.west = 900; s.demand.east = 700;
    s.approaches = { west: { right: 50, pocket } };
    s.signals.eastWest = 25; s.signals.northSouth = 40;
    s.run.duration = 900;
    const simulation = new Simulation(s);
    while (!simulation.done) { simulation.step(); assertInvariants(simulation); }
    return simulation.result();
  };
  const short = run(15), long = run(150);
  assert.ok(short.queues.west.pocketOverflowSeconds > 0, 'short pocket overflows');
  assert.ok(long.queues.west.pocketOverflowSeconds < short.queues.west.pocketOverflowSeconds);
  const network = compileNetwork(Object.assign(createScenario(), { approaches: { west: { pocket: 40 } } }));
  assert.equal(network.byId.west.lanes, 3);
  assert.equal(network.byId.west.throughLanes, 2);
  assert.equal(network.byId.west.pocket.start, network.byId.west.length - 40);
});

test('per-approach overrides change only that approach', () => {
  const s = createScenario();
  s.approaches = { west: { lanes: 3, speed: 60, length: 400, left: 100 } };
  const network = compileNetwork(s);
  assert.equal(network.byId.west.lanes, 3);
  assert.equal(network.byId.west.length, 400);
  assert.equal(network.byId.east.lanes, 2);
  assert.equal(network.byId.east.length, 250);
  const simulation = new Simulation(s);
  const vehicles = [];
  const make = simulation.makeVehicle.bind(simulation);
  simulation.makeVehicle = (...args) => { const v = make(...args); vehicles.push(v); return v; };
  simulation.runToEnd();
  const west = vehicles.filter(v => v.entry === 'west'), east = vehicles.filter(v => v.entry === 'east');
  assert.ok(west.every(v => v.route.at(-1) === 'north-out'), 'west traffic all turns left');
  assert.ok(west.some(v => v.desired > 50 / 3.6), 'west uses its own speed limit');
  assert.ok(east.every(v => v.desired <= 40 / 3.6 * 1.1 + 1e-9));
});

test('corridor junctions can run their own green times', () => {
  const s = createScenario(); s.template = 'corridor';
  s.signals.junctions = { B: { eastWest: 90 } };
  const network = compileNetwork(s);
  assert.equal(network.nodeById.A.plan.eastWest, 40);
  assert.equal(network.nodeById.B.plan.eastWest, 90);
  assert.equal(network.nodeById.B.plan.northSouth, 25);
  // At t = 60 s, A (40 s green) has left east–west green; B (90 s green) has not.
  assert.equal(groupGreen(network.nodeById.A.plan, 60, 'eastWest', 0), false);
  assert.equal(groupGreen(network.nodeById.B.plan, 60, 'eastWest', s.signals.offset), true);
  const simulation = new Simulation(s);
  while (!simulation.done) { simulation.step(); assertInvariants(simulation); }
});

test('validation rejects malformed overrides and over-long pockets', () => {
  const s = createScenario();
  s.approaches = { west: { width: 3 } };
  assert.match(validateScenario(s).join(' '), /unknown setting/);
  s.approaches = { west: { pocket: 200, length: 150 } };
  assert.match(validateScenario(s).join(' '), /10 m shorter/);
  s.approaches = { west: { left: 60, right: 50 } };
  assert.match(validateScenario(s).join(' '), /exceed 100/);
  s.approaches = {};
  s.signals.junctions = { B: { eastWest: 2 } };
  assert.match(validateScenario(s).join(' '), /between 5 and 300/);
});

test('model checks flag ignored demand, unused settings and shared-lane right turns', () => {
  const t = createScenario(); t.template = 'tJunction';
  assert.ok(modelChecks(t).some(f => f.level === 'warning' && /North demand is not used/.test(f.title)));
  const single = createScenario(); single.geometry.lanes = 1; single.turning = { left: 0, right: 20 };
  assert.ok(modelChecks(single).some(f => /share the only lane/.test(f.title)));
  single.approaches = { west: { pocket: 30 } };
  assert.ok(!modelChecks(single).some(f => /West approach: right-turners share/.test(f.title)), 'a pocket removes the warning');
  const unused = createScenario(); unused.approaches = { 'A-B': { lanes: 1 } };
  assert.ok(modelChecks(unused).some(f => /Unused approach settings/.test(f.title)));
  const roundabout = createScenario(); roundabout.template = 'roundabout';
  assert.ok(modelChecks(roundabout).some(f => /Lane counts are ignored/.test(f.title)));
  const over = createScenario(); over.demand.west = 3000;
  assert.ok(modelChecks(over).some(f => /may exceed discharge/.test(f.title)));
  const bad = createScenario(); bad.fleet.car = 0;
  assert.equal(modelChecks(bad)[0].level, 'error');
});

test('schema 2 projects migrate to schema 3 with empty overrides', () => {
  const v2 = structuredClone(createProject().scenarios[0]);
  delete v2.approaches; delete v2.signals.junctions;
  const loaded = parseProject(JSON.stringify({ schemaVersion: 2, scenarios: [v2] }));
  assert.deepEqual(loaded.scenarios[0].approaches, {});
  assert.deepEqual(loaded.scenarios[0].signals.junctions, {});
  assert.equal(loaded.schemaVersion, 3);
});
