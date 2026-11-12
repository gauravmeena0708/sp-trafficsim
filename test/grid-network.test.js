import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenario, migrateScenario, validateScenario } from '../src/model/project.js';
import { chooseRoute, compileNetwork, defaultLayout, planMovements } from '../src/model/network.js';
import { modelChecks } from '../src/model/checks.js';
import { scenarioChanges, changeText } from '../src/model/changes.js';
import { Simulation } from '../src/simulation/engine.js';
import { movementGreen, phasePreset, signalState } from '../src/simulation/signals.js';
import { NetworkCanvas } from '../src/ui/canvas.js';

const ALL = ['north', 'east', 'south', 'west'];
const grid = (nodes = defaultLayout().nodes) => {
  const s = createScenario(); s.template = 'grid';
  s.layout = { nodes: structuredClone(nodes) };
  return s;
};
const node = (id, col, row, arms = ALL, offset = 0) => ({ id, col, row, arms: [...arms], offset });
// Two rows of three: A B E / C D F.
const sixGrid = () => grid([...defaultLayout().nodes, node('E', 2, 0), node('F', 2, 1)]);

test('the default grid compiles to four connected signalised junctions', () => {
  const s = grid();
  assert.deepEqual(validateScenario(s), []);
  const network = compileNetwork(s);
  const count = kind => network.links.filter(l => l.kind === kind).length;
  assert.equal(network.nodes.length, 4);
  assert.deepEqual([count('internal'), count('entry'), count('exit')], [8, 8, 8]);
  assert.ok(network.byId['A-B'] && network.byId['B-A'] && network.byId['A-C'] && network.byId['D-C']);
  assert.equal(network.byId['A-west'].label, 'A west approach');
  // Internal links span the block length between junction boxes.
  assert.equal(Math.round(network.byId['A-B'].length), s.geometry.spacing);
  assert.ok(Object.values(network.exitDistance).every(Number.isFinite));
});

test('a grid run conserves demand at every step and is deterministic', () => {
  const s = grid(); s.run.duration = 300; s.turning = { left: 20, right: 20 };
  const simulation = new Simulation(s);
  while (!simulation.done) {
    simulation.step();
    const r = simulation.result();
    assert.equal(r.requested, r.completed + r.inNetwork + r.waiting);
  }
  const strip = r => ({ ...r, inputs: null });
  assert.deepEqual(strip(new Simulation(s).runToEnd()), strip(simulation.result()));
  assert.ok(simulation.result().completed > 50);
});

test('layout checks report arms facing nothing, crossings, gaps and bad cells', () => {
  const errors = s => validateScenario(s).join(' ');
  const facing = sixGrid(); facing.layout.nodes[5].arms = ['north', 'east', 'south'];
  assert.match(errors(facing), /Junction D's east arm runs into junction F, which has no west arm/);
  const crossing = grid([...defaultLayout().nodes, node('E', 2, 0)]);
  assert.match(errors(crossing), /D's east boundary road crosses E's south boundary road without a junction/);
  // Shorter approaches clear the crossing.
  crossing.geometry.length = 100;
  assert.deepEqual(validateScenario(crossing), []);
  const apart = grid([node('A', 0, 0, ['east', 'south', 'west']), node('B', 2, 2)]);
  apart.geometry.length = 100;
  assert.match(errors(apart), /Junction B is not connected to junction A/);
  assert.match(errors(grid([node('A', 0, 0), node('B', 0, 0)])), /shares its grid cell/);
  assert.match(errors(grid([node('A', 0, 0, ['east', 'west'])])), /at least three arms/);
  assert.match(errors(grid([node('A', 4, 0)])), /within the 4 × 4 grid/);
  assert.match(errors(grid(Array.from({ length: 9 }, (_, i) => node('ABCDEFGHI'[i], i % 4, Math.floor(i / 4))))), /1–8 junctions/);
  const other = createScenario(); other.layout = defaultLayout();
  assert.match(errors(other), /Only the custom grid network uses a junction layout/);
});

test('grid routes end at an exit without revisiting a junction', () => {
  const s = sixGrid(); s.turning = { left: 35, right: 35 };
  const network = compileNetwork(s);
  for (const entry of network.links.filter(l => l.kind === 'entry')) {
    for (let k = 0; k < 200; k++) {
      const draws = Array.from({ length: network.routeDraws }, (_, i) => ((k * 7919 + i * 104729) % 1000) / 1000);
      const { route, moves } = chooseRoute(network, entry.id, s.turning, draws);
      assert.equal(network.byId[route.at(-1)].kind, 'exit', `route from ${entry.id} ends on ${route.at(-1)}`);
      const nodes = route.slice(0, -1).map(id => network.byId[id].to);
      assert.equal(new Set(nodes).size, nodes.length, `route ${route.join(' > ')} revisits a junction`);
      assert.equal(moves.length, route.length - 1);
      assert.ok(moves.length <= network.routeDraws);
    }
  }
});

test('a shared custom plan fits junctions with different arms', () => {
  // A T-junction (no north arm) beside four-arm junctions.
  const s = grid([node('A', 0, 0, ['east', 'south', 'west']), node('B', 1, 0), node('C', 0, 1), node('D', 1, 1)]);
  s.geometry.length = 150;
  s.signals.mode = 'custom';
  const offered = planMovements(compileNetwork(s)).map(m => m.id);
  assert.ok(offered.includes('north:straight'), 'movements offered anywhere can be listed');
  s.signals.phases = phasePreset('protectedRights', offered);
  assert.deepEqual(validateScenario(s), []);
  s.turning = { left: 15, right: 25 }; s.run.duration = 240;
  const simulation = new Simulation(s);
  while (!simulation.done) {
    const now = simulation.time;
    simulation.step();
    for (const v of simulation.crossing.filter(c => c.progress === 0)) {
      const link = simulation.network.byId[v.path.from];
      const at = simulation.network.nodeById[link.to];
      assert.ok(movementGreen(at.plan, now, at.offset, link.toArm, v.path.movement), `${v.path.movement} from ${link.id} entered on red`);
    }
  }
  assert.ok(simulation.result().completed > 0);
});

test('per-junction offsets shift that junction’s plan and keep arrivals paired', () => {
  const base = grid(); base.run.duration = 300;
  const shifted = structuredClone(base); shifted.layout.nodes[1].offset = 20;
  const network = compileNetwork(shifted);
  assert.equal(network.nodeById.B.offset, 20);
  assert.equal(signalState(network.nodeById.B.plan, 20 - network.nodeById.B.offset).group, signalState(network.nodeById.A.plan, 0).group);
  const a = new Simulation(base).runToEnd(), b = new Simulation(shifted).runToEnd();
  assert.equal(a.requested, b.requested, 'same seeds give the same arrivals');
  assert.notDeepEqual(a.accruedDelayPerRequest, b.accruedDelayPerRequest);
});

test('changes, checks, migration and drawing understand grid layouts', () => {
  const base = grid(); const alt = sixGrid();
  alt.layout.nodes[1].offset = 15;
  const text = scenarioChanges(base, alt).map(changeText);
  assert.ok(text.includes('Junction E grid position: no junction → column 3, row 1'), text.join(' | '));
  assert.ok(text.includes('Junction B signal offset: 0 s → 15 s'), text.join(' | '));
  const findings = modelChecks(base).map(f => f.title);
  assert.ok(findings.includes('Demand applies to each boundary approach'));
  assert.ok(findings.includes('The network has loops'));
  assert.deepEqual(modelChecks(grid([node('A', 0, 0), node('B', 1, 0)])).filter(f => /loops/.test(f.title)), []);
  const old = createScenario(); delete old.layout;
  assert.equal(migrateScenario(old, 5).layout, null);
  const placed = NetworkCanvas.place(compileNetwork(alt), 1, 1);
  assert.deepEqual(Object.keys(placed.centres).sort(), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.ok(Math.abs(placed.centres.A.x - placed.centres.C.x) < 1e-6 && placed.centres.E.x > placed.centres.B.x);
});

test('a boundary approach can have its own demand without disturbing the others', () => {
  const departures = scenario => {
    const simulation = new Simulation(scenario);
    const seen = [];
    const make = simulation.makeVehicle.bind(simulation);
    simulation.makeVehicle = (id, at) => { const v = make(id, at); seen.push(`${id}@${at.toFixed(3)}`); return v; };
    const result = simulation.runToEnd();
    return { seen, result, from: id => seen.filter(x => x.startsWith(`${id}@`)) };
  };
  const base = grid(); base.run.duration = 300;
  const quiet = structuredClone(base); quiet.approaches['A-north'] = { demand: 0 };
  const busy = structuredClone(base); busy.approaches['A-north'] = { demand: 900 };
  const same = structuredClone(base); same.approaches['A-north'] = { demand: base.demand.north };
  const b = departures(base), q = departures(quiet), h = departures(busy);
  assert.equal(q.from('A-north').length, 0, 'zero demand generates no traffic');
  assert.ok(h.from('A-north').length > 1.6 * b.from('A-north').length, 'doubling demand roughly doubles arrivals');
  for (const id of ['A-west', 'B-north', 'D-east']) assert.deepEqual(q.from(id), b.from(id), `${id} arrivals stay paired`);
  const strip = r => ({ ...r, inputs: null, fingerprint: null });
  assert.deepEqual(strip(departures(same).result), strip(b.result), 'an override equal to the shared value changes nothing');

  assert.match(validateScenario(Object.assign(structuredClone(base), { approaches: { 'A-north': { demand: 4000 } } })).join(' '), /demand/i);
  const text = scenarioChanges(base, quiet);
  assert.deepEqual(text.map(c => [c.kind, changeText(c)]), [['assumption', 'A north approach: demand: shared value → 0 veh/h']]);

  const allNorth = structuredClone(base);
  allNorth.approaches = { 'A-north': { demand: 300 }, 'B-north': { demand: 200 }, 'C-A': { demand: 100 } };
  const findings = modelChecks(allNorth);
  assert.ok(findings.some(f => f.title === 'North demand is not used' && f.level === 'info'));
  assert.ok(findings.some(f => /Demand on C → A is ignored/.test(f.title)));
  assert.ok(!/2 north approaches/.test(findings.find(f => f.title === 'Demand applies to each boundary approach').detail));
});
