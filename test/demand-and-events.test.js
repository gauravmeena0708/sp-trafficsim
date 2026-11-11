import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenario, profilePreset, validateScenario } from '../src/model/project.js';
import { Simulation, SAMPLE_SECONDS } from '../src/simulation/engine.js';
import { runReplications } from '../src/simulation/experiments.js';
import { modelChecks } from '../src/model/checks.js';

const arrivals = scenario => {
  const simulation = new Simulation(scenario);
  const times = [];
  const make = simulation.makeVehicle.bind(simulation);
  simulation.makeVehicle = (linkId, departure) => { times.push([linkId, +departure.toFixed(9)]); return make(linkId, departure); };
  return { result: simulation.runToEnd(), times };
};

test('a profile of equal factors reproduces constant demand exactly', () => {
  const flat = createScenario();
  const split = createScenario();
  split.demand.profile = { preset: 'custom', period: 200, factors: [1, 1, 1] };
  assert.deepEqual(arrivals(flat).times, arrivals(split).times);
});

test('a profile with mean factor 1 over the run keeps the same number of requests', () => {
  const flat = createScenario();
  const peak = createScenario();
  peak.demand.profile = profilePreset('peak', peak.run.duration);
  const mean = peak.demand.profile.factors.reduce((a, b) => a + b, 0) / peak.demand.profile.factors.length;
  assert.ok(Math.abs(mean - 1) < 1e-9);
  // The cumulative-intensity transform maps the same unit draws onto the run.
  assert.equal(arrivals(peak).result.requested, arrivals(flat).result.requested);
});

test('period factors control when vehicles arrive', () => {
  const s = createScenario();
  for (const d of ['north', 'east', 'south']) s.demand[d] = 0;
  s.demand.west = 800;
  s.demand.profile = { preset: 'custom', period: 300, factors: [0, 2] };
  const { times } = arrivals(s);
  assert.ok(times.every(([, t]) => t >= 300), 'no arrivals during a zero-factor period');
  // 1,600 veh/h for 300 s: expect 133.3; allow four Poisson standard deviations.
  assert.ok(Math.abs(times.length - 133.3) < 4 * Math.sqrt(133.3), `got ${times.length}`);
  const stop = createScenario();
  stop.demand.profile = { preset: 'custom', period: 120, factors: [1, 0] };
  assert.ok(arrivals(stop).times.every(([, t]) => t < 120), 'the last factor holds after the profile ends');
});

test('time series are sampled at a fixed interval and stay consistent with totals', () => {
  const r = new Simulation(createScenario()).runToEnd();
  assert.equal(r.series.time.length, 600 / SAMPLE_SECONDS);
  assert.equal(r.series.time[0], SAMPLE_SECONDS);
  assert.equal(r.series.completed.at(-1), r.completed);
  assert.equal(r.series.requested.at(-1), r.requested);
  for (let i = 1; i < r.series.completed.length; i++) assert.ok(r.series.completed[i] >= r.series.completed[i - 1]);
  assert.ok(r.series.maxQueue.every(q => q >= 0 && q <= 250));
  const replicated = runReplications(createScenario(), 2);
  assert.equal(replicated.series.seeds, 2);
  assert.equal(replicated.series.maxQueue.length, 60);
  assert.ok(replicated.runs.every(run => !('series' in run)), 'per-seed series are not stored');
});

test('light demand has no persistent queues; overload produces dated cycle-failure events', () => {
  const light = createScenario();
  for (const d of ['north', 'east', 'south', 'west']) light.demand[d] = 300;
  const calm = new Simulation(light).runToEnd();
  assert.equal(calm.queueEvents.length, 0);
  assert.equal(calm.persistentQueueSeconds, 0);

  const heavy = createScenario();
  heavy.demand.west = 1500; heavy.demand.east = 1500;
  heavy.run.duration = 900;
  const r = new Simulation(heavy).runToEnd();
  assert.ok(r.queueEvents.length > 0);
  for (const e of r.queueEvents) {
    assert.ok(['east', 'west'].includes(e.link), `unexpected event on ${e.link}`);
    assert.ok(e.cycles >= 2);
    assert.ok(e.end === null || e.end > e.start);
  }
  assert.equal(r.unresolvedQueues, r.queueEvents.filter(e => e.end === null).length);
  assert.ok(r.persistentQueueSeconds > 0);
});

test('roundabout entries over capacity raise persistent queue events', () => {
  const s = createScenario();
  s.template = 'roundabout';
  for (const d of ['north', 'east', 'south', 'west']) s.demand[d] = 700;
  const r = new Simulation(s).runToEnd();
  assert.ok(r.queueEvents.some(e => e.link === 'west'));
  const calm = createScenario(); calm.template = 'roundabout';
  for (const d of ['north', 'east', 'south', 'west']) calm.demand[d] = 250;
  assert.equal(new Simulation(calm).runToEnd().queueEvents.length, 0);
});

test('profile validation and checks', () => {
  const s = createScenario();
  s.demand.profile = { preset: 'custom', period: 300, factors: [1, 4] };
  assert.match(validateScenario(s).join(' '), /between 0 and 3/);
  s.demand.profile = { preset: 'custom', period: 30, factors: [1] };
  assert.match(validateScenario(s).join(' '), /period/);
  s.demand.profile = { preset: 'custom', period: 300, factors: [] };
  assert.match(validateScenario(s).join(' '), /1–48/);
  const uneven = createScenario();
  uneven.demand.profile = { preset: 'custom', period: 300, factors: [2, 2] };
  assert.ok(modelChecks(uneven).some(f => /more demand overall/.test(f.title)));
});
