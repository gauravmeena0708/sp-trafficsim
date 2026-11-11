import { performance } from 'node:perf_hooks';
import { cpus, platform } from 'node:os';
import { createScenario, ENGINE_VERSION } from '../src/model/project.js';
import { Simulation } from '../src/simulation/engine.js';

const scenario = createScenario();
new Simulation(scenario).runToEnd(); // Warm up the JS engine once.
const trials = [];
for (let i = 0; i < 5; i++) {
  const input = structuredClone(scenario);
  input.run.seed += i;
  const start = performance.now();
  const result = new Simulation(input).runToEnd();
  trials.push({ seed: input.run.seed, milliseconds: +(performance.now() - start).toFixed(1), requested: result.requested, completed: result.completed, waiting: result.waiting });
}
console.log(JSON.stringify({
  engine: ENGINE_VERSION, runtime: process.version, platform: platform(), cpu: cpus()[0]?.model,
  workload: { approaches: 4, lanesEach: scenario.geometry.lanes, lengthMetres: scenario.geometry.length,
    requestedVehiclesPerHour: 2500, simulatedSeconds: scenario.run.duration, timeStepSeconds: 0.2 },
  trials,
  note: 'Headless engine benchmark only; this does not measure browser rendering or establish model validity.',
}, null, 2));
