import { performance } from 'node:perf_hooks';
import { cpus, platform } from 'node:os';
import { createScenario, ENGINE_VERSION } from '../src/model/project.js';
import { Simulation } from '../src/simulation/engine.js';
import { defaultLayout } from '../src/model/network.js';

// Declared reference workloads. Keep these fixed so results stay comparable.
const workloads = {
  fourArmStraight: createScenario(),
  corridorTurning: Object.assign(createScenario(), { template: 'corridor', turning: { left: 20, right: 15 } }),
  roundaboutTurning: Object.assign(createScenario(), { template: 'roundabout', turning: { left: 25, right: 25 } }),
  gridTurning: Object.assign(createScenario(), { template: 'grid', layout: defaultLayout(), turning: { left: 20, right: 15 } }),
};

const report = {};
for (const [name, scenario] of Object.entries(workloads)) {
  new Simulation(scenario).runToEnd(); // Warm up the JS engine once.
  const trials = [];
  for (let i = 0; i < 5; i++) {
    const input = structuredClone(scenario);
    input.run.seed += i;
    const start = performance.now();
    const result = new Simulation(input).runToEnd();
    trials.push({ seed: input.run.seed, milliseconds: +(performance.now() - start).toFixed(1), requested: result.requested, completed: result.completed, waiting: result.waiting });
  }
  const sorted = trials.map(t => t.milliseconds).sort((a, b) => a - b);
  report[name] = {
    workload: { template: scenario.template, lanesEach: scenario.geometry.lanes, approachMetres: scenario.geometry.length,
      linkMetres: ['corridor', 'grid'].includes(scenario.template) ? scenario.geometry.spacing : null, junctions: scenario.layout?.nodes.length ?? null, demand: scenario.demand, turning: scenario.turning,
      simulatedSeconds: scenario.run.duration, timeStepSeconds: 0.2 },
    medianMilliseconds: sorted[2], trials,
  };
}
console.log(JSON.stringify({
  engine: ENGINE_VERSION, runtime: process.version, platform: platform(), cpu: cpus()[0]?.model, report,
  note: 'Headless engine benchmark only; this does not measure browser rendering or establish model validity.',
}, null, 2));
