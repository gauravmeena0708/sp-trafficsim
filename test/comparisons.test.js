import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenario, profilePreset } from '../src/model/project.js';
import { scenarioChanges, changeSummary, approachName } from '../src/model/changes.js';
import { PRECISION, precisionVerdict, runAdaptiveComparison } from '../src/simulation/experiments.js';
import { csvReport, printMetadata } from '../src/ui/reports.js';

test('change summaries name design, assumption and run changes in planner terms', () => {
  const base = createScenario('Baseline');
  assert.deepEqual(scenarioChanges(base, structuredClone(base)), []);
  const alt = structuredClone(base);
  alt.id = 'other'; alt.name = 'Alternative';
  alt.template = 'corridor';
  alt.approaches = { west: { pocket: 40, right: 25 } };
  alt.signals.junctions = { B: { eastWest: 70 } };
  alt.demand.west = 900;
  alt.demand.profile = profilePreset('peak', 600);
  alt.run.seed = 7;
  const changes = scenarioChanges(base, alt);
  const byKey = Object.fromEntries(changes.map(c => [c.key, c]));
  assert.equal(byKey.template.to, 'Two-junction corridor');
  assert.equal(byKey['approaches.west.pocket'].kind, 'design');
  assert.equal(byKey['approaches.west.pocket'].label, 'West approach: right-turn pocket');
  assert.equal(byKey['approaches.west.pocket'].from, 'shared value');
  assert.equal(byKey['approaches.west.pocket'].to, '40 m');
  assert.equal(byKey['approaches.west.right'].kind, 'assumption', 'turning shares are demand assumptions');
  assert.equal(byKey['signals.junctions.B.eastWest'].label, 'Junction B east–west green');
  assert.equal(byKey['demand.west'].to, '900 veh/h');
  assert.match(byKey['demand.profile'].to, /^Peak in the middle/);
  assert.equal(byKey['run.seed'].kind, 'run');
  assert.ok(!changes.some(c => c.key === 'name' || c.key === 'id'));
  assert.deepEqual(changes.slice(0, 3).map(c => c.kind), ['design', 'design', 'design'], 'design changes are listed first');
  assert.match(changeSummary(changes), /not an infrastructure-only comparison/);
  const designOnly = structuredClone(base); designOnly.signals.eastWest = 60;
  assert.match(changeSummary(scenarioChanges(base, designOnly)), /demand and run settings match/);
  assert.equal(approachName('A-B'), 'A → B link');
  assert.equal(approachName('B-north'), 'B north approach');
});

test('precision verdicts follow the declared rule', () => {
  assert.equal(precisionVerdict({ mean: -5, low: -8, high: -2 }, 1, false), 'lower');
  assert.equal(precisionVerdict({ mean: 5, low: 2, high: 8 }, 1, false), 'higher');
  assert.equal(precisionVerdict({ mean: 0.1, low: -0.5, high: 0.7 }, 1, false), 'equivalent');
  assert.equal(precisionVerdict({ mean: 1, low: -3, high: 5 }, 1, false), null, 'keep adding seeds');
  assert.equal(precisionVerdict({ mean: 1, low: -3, high: 5 }, 1, true), 'inconclusive');
});

test('adaptive comparison stops early on clear differences and keeps seeds paired', () => {
  const base = createScenario('Baseline');
  base.run.duration = 300;
  const starved = structuredClone(base); starved.id = 'starved'; starved.name = 'Starved'; starved.signals.eastWest = 5;
  const same = structuredClone(base); same.id = 'same'; same.name = 'Same';
  const unpaired = structuredClone(base); unpaired.id = 'unpaired'; unpaired.name = 'Unpaired'; unpaired.demand.multiplier = 1.25;
  const progress = [];
  const results = runAdaptiveComparison([base, starved, same, unpaired], (seeds, open) => progress.push([seeds, open]));
  assert.equal(results[0].precision.verdict, 'baseline');
  assert.equal(results[1].precision.verdict, 'higher', 'a 5 s east–west green clearly raises delay');
  assert.equal(results[2].precision.verdict, 'equivalent', 'identical inputs show no difference');
  assert.equal(results[3].precision.verdict, 'unpaired');
  assert.equal(results[0].runs.length, PRECISION.initial, 'all clear after the initial seeds');
  assert.deepEqual(results.map(r => r.runs.map(x => x.seed)), results.map(() => [42, 43, 44, 45, 46]));
  assert.deepEqual(progress, [[5, 0]]);
});

test('adaptive comparison adds seeds in pairs up to the limit for a marginal change', () => {
  const base = createScenario('Baseline');
  base.run.duration = 240; base.run.warmup = 60;
  const marginal = structuredClone(base); marginal.id = 'm'; marginal.name = 'Marginal'; marginal.signals.eastWest = 41;
  const progress = [];
  const [, alt] = runAdaptiveComparison([base, marginal], (seeds) => progress.push(seeds));
  const seeds = alt.runs.length;
  assert.ok(seeds >= PRECISION.initial && seeds <= PRECISION.max);
  assert.ok(['lower', 'higher', 'equivalent', 'inconclusive'].includes(alt.precision.verdict));
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] - progress[i - 1] <= PRECISION.step);
  if (alt.precision.verdict === 'inconclusive') assert.equal(seeds, PRECISION.max);
});

test('reports carry change lists and verdicts', () => {
  const base = createScenario('Baseline'); base.run.duration = 300;
  const alt = structuredClone(base); alt.id = 'alt'; alt.name = 'Longer EW green'; alt.signals.eastWest = 60;
  const results = runAdaptiveComparison([base, alt]);
  const csv = csvReport(results);
  assert.match(csv, /East–west green: 40 s → 60 s/);
  const metadata = printMetadata(results);
  assert.match(metadata, /Changes in Longer EW green: East–west green: 40 s → 60 s/);
  assert.match(metadata, /Replications: added in pairs/);
});
