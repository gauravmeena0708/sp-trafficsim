import { Simulation } from './engine.js';

export function timingCandidates(start, end, increment) {
  if (![start, end, increment].every(Number.isFinite) || start < 5 || end > 300 || start > end || increment < 1) throw new Error('Use a 5–300 second range, an end at or after the start, and an increment of at least 1 second.');
  const values = [];
  for (let n = start; n <= end; n += increment) values.push(n);
  if (values.at(-1) !== end) values.push(end);
  if (values.length > 30) throw new Error('Choose a larger increment: at most 30 candidates per sweep.');
  return values;
}

export function summarize(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return { mean: null, sd: null, n: 0 };
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sd = valid.length > 1 ? Math.sqrt(valid.reduce((s, x) => s + (x - mean) ** 2, 0) / (valid.length - 1)) : null;
  return { mean, sd, n: valid.length };
}

export function runReplications(scenario, count = 3) {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Use 1–10 replications.');
  const runs = Array.from({ length: count }, (_, i) => {
    const copy = structuredClone(scenario);
    copy.run.seed += i;
    return new Simulation(copy).runToEnd();
  });
  return { name: scenario.name, scenarioId: scenario.id, inputs: structuredClone(scenario), runs,
    delay: summarize(runs.map(r => r.accruedDelayPerRequest)),
    journey: summarize(runs.map(r => r.meanJourney)),
    queue: summarize(runs.map(r => r.maxQueue)),
    waiting: summarize(runs.map(r => r.waiting)),
    completed: summarize(runs.map(r => r.completed)),
  };
}
