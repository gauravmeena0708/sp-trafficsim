import { Simulation } from './engine.js';

export const DEMAND_LEVELS = [
  { label: 'Low', multiplier: 0.75 },
  { label: 'Central', multiplier: 1 },
  { label: 'High', multiplier: 1.25 },
];
export const SWEEP_GROUPS = { eastWest: 'east–west', northSouth: 'north–south' };
const MAX_SWEEP_CONFIGURATIONS = 60;

export function timingCandidates(start, end, increment) {
  if (![start, end, increment].every(Number.isFinite) || start < 5 || end > 300 || start > end || increment < 1) throw new Error('Use a 5–300 second range, an end at or after the start, and an increment of at least 1 second.');
  const values = [];
  for (let n = start; n <= end; n += increment) values.push(n);
  if (values.at(-1) !== end) values.push(end);
  if (values.length > 30) throw new Error('Choose a larger increment: at most 30 candidates per sweep.');
  return values;
}

// Every candidate green for every requested demand multiplier, in a stable order.
export function sweepConfigurations({ group = 'eastWest', start, end, increment, multipliers }) {
  if (!SWEEP_GROUPS[group]) throw new Error('Unknown signal group for the sweep.');
  if (!Array.isArray(multipliers) || !multipliers.length || !multipliers.every(m => Number.isFinite(m) && m >= 0.25 && m <= 3)) throw new Error('Demand multipliers must be between 0.25 and 3.');
  const greens = timingCandidates(start, end, increment);
  const configurations = multipliers.flatMap(multiplier => greens.map(green => ({ group, green, multiplier })));
  if (configurations.length > MAX_SWEEP_CONFIGURATIONS) throw new Error(`At most ${MAX_SWEEP_CONFIGURATIONS} timing × demand combinations per sweep. Use a larger increment.`);
  return configurations;
}

export function summarize(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return { mean: null, sd: null, n: 0 };
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sd = valid.length > 1 ? Math.sqrt(valid.reduce((s, x) => s + (x - mean) ** 2, 0) / (valid.length - 1)) : null;
  return { mean, sd, n: valid.length };
}

// Two-sided 95% Student t critical values for 1–29 degrees of freedom.
const T95 = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145,
  2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045];
export const tCritical95 = df => df >= 1 && df < T95.length ? T95[df] : 1.96;

// Paired-seed difference (alternative − baseline) with a t-based 95% interval.
// Runs are matched by seed; unmatched or non-finite values are excluded and counted.
export function pairedDifference(baselineRuns, alternativeRuns, metric) {
  const bySeed = new Map(baselineRuns.map(r => [r.seed, r[metric]]));
  const diffs = [];
  let excluded = 0;
  for (const run of alternativeRuns) {
    const base = bySeed.get(run.seed);
    if (Number.isFinite(base) && Number.isFinite(run[metric])) diffs.push(run[metric] - base);
    else excluded++;
  }
  const { mean, sd, n } = summarize(diffs);
  if (n < 2 || sd === null) return { mean, low: null, high: null, n, excluded };
  const half = tCritical95(n - 1) * sd / Math.sqrt(n);
  return { mean, low: mean - half, high: mean + half, n, excluded };
}

export const DIFFERENCE_METRICS = {
  accruedDelayPerRequest: 'Accrued delay / request (s)',
  meanJourney: 'Completed-trip time (s)',
  maxQueue: 'Max queue (m)',
  waiting: 'Waiting outside',
  completed: 'Completed trips',
  persistentQueueSeconds: 'Persistent queue time (s)',
};

// Attach paired differences against the first result. Pairing is only claimed when
// demand, fleet and run settings match, so seeds generate identical arrivals.
export function attachBaselineDifferences(results) {
  if (results.length < 2) return results;
  const [baseline] = results;
  const controlled = r => ['demand', 'fleet', 'run'].every(k => JSON.stringify(r.inputs[k]) === JSON.stringify(baseline.inputs[k]));
  return results.map((r, i) => {
    if (i === 0) return { ...r, baseline: true };
    if (!controlled(r)) return { ...r, differences: null, differenceNote: 'Not paired: demand, fleet or run settings differ from the baseline.' };
    return { ...r, differences: Object.fromEntries(Object.keys(DIFFERENCE_METRICS).map(m => [m, pairedDifference(baseline.runs, r.runs, m)])) };
  });
}

// Report the lowest-delay candidate at each demand level and flag when it changes.
export function sweepFindings(results) {
  const levels = new Map();
  for (const r of results) {
    if (!r.sweep) continue;
    const list = levels.get(r.sweep.multiplier) ?? [];
    list.push(r);
    levels.set(r.sweep.multiplier, list);
  }
  const best = [...levels.entries()].map(([multiplier, list]) => {
    const ranked = list.filter(r => Number.isFinite(r.delay.mean)).sort((a, b) => a.delay.mean - b.delay.mean);
    return { multiplier, green: ranked[0]?.sweep.green ?? null, delay: ranked[0]?.delay.mean ?? null, waiting: ranked[0]?.waiting.mean ?? null };
  });
  const distinct = new Set(best.map(b => b.green));
  return { best, changesWithDemand: best.length > 1 && distinct.size > 1 };
}

// Run seeds base+from … base+from+count−1. Returns the runs without their time
// series and, separately, the series (kept only to form the mean across seeds).
function runSeeds(scenario, from, count) {
  const runs = [], series = [];
  for (let i = from; i < from + count; i++) {
    const copy = structuredClone(scenario);
    copy.run.seed += i;
    const { series: s, ...rest } = new Simulation(copy).runToEnd();
    runs.push(rest);
    series.push(s);
  }
  return { runs, series };
}

export function runReplications(scenario, count = 3) {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Use 1–10 replications.');
  const { runs, series } = runSeeds(scenario, 0, count);
  return summarizeRuns(scenario, runs, series);
}

// Keep the per-seed time series out of stored runs; the mean across seeds is
// kept once per alternative so results and project files stay small.
function summarizeRuns(scenario, runs, seriesList) {
  const series = meanSeries(seriesList);
  return { name: scenario.name, scenarioId: scenario.id, inputs: structuredClone(scenario), runs, series,
    delay: summarize(runs.map(r => r.accruedDelayPerRequest)),
    journey: summarize(runs.map(r => r.meanJourney)),
    queue: summarize(runs.map(r => r.maxQueue)),
    waiting: summarize(runs.map(r => r.waiting)),
    completed: summarize(runs.map(r => r.completed)),
    persistent: summarize(runs.map(r => r.persistentQueueSeconds)),
    unresolved: summarize(runs.map(r => r.unresolvedQueues)),
  };
}

// Declared rule for adding replications until the comparison is precise enough.
// The primary indicator is accrued delay per request; the target half-width is
// the larger of PRECISION.absolute seconds and PRECISION.relative × baseline delay.
export const PRECISION = { initial: 5, step: 2, max: 20, relative: 0.05, absolute: 1 };
export const VERDICTS = {
  lower: 'Lower delay than baseline',
  higher: 'Higher delay than baseline',
  equivalent: 'No difference beyond the precision target',
  inconclusive: 'Inconclusive at the seed limit',
  unpaired: 'Not paired with the baseline',
};

// Classify one alternative's paired delay difference against the baseline.
export function precisionVerdict(difference, target, atLimit) {
  if (!difference || difference.low === null) return atLimit ? 'inconclusive' : null;
  if (difference.high < 0) return 'lower';
  if (difference.low > 0) return 'higher';
  if ((difference.high - difference.low) / 2 <= target) return 'equivalent';
  return atLimit ? 'inconclusive' : null;
}

// Paired comparison that adds PRECISION.step seeds to every scenario (keeping
// seeds paired) until each alternative's delay difference is clear: its 95%
// interval excludes zero, or is narrower than the target, or the seed limit
// is reached.
export function runAdaptiveComparison(scenarios, onProgress = () => {}) {
  const state = scenarios.map(scenario => ({ scenario, runs: [], series: [] }));
  const add = count => state.forEach(s => {
    const next = runSeeds(s.scenario, s.runs.length, count);
    s.runs.push(...next.runs);
    s.series.push(...next.series);
  });
  add(PRECISION.initial);
  for (;;) {
    const seeds = state[0].runs.length;
    const results = attachBaselineDifferences(state.map(s => summarizeRuns(s.scenario, s.runs, s.series)));
    const baselineDelay = Math.abs(results[0].delay.mean ?? 0);
    const target = Math.max(PRECISION.absolute, PRECISION.relative * baselineDelay);
    const atLimit = seeds >= PRECISION.max;
    const verdicts = results.map((r, i) => i === 0 ? 'baseline' : r.differenceNote ? 'unpaired' : precisionVerdict(r.differences.accruedDelayPerRequest, target, atLimit));
    onProgress(seeds, verdicts.filter(v => v === null).length);
    if (atLimit || verdicts.every(v => v !== null)) {
      return results.map((r, i) => ({ ...r, precision: { verdict: verdicts[i], seeds, target, rule: PRECISION } }));
    }
    add(Math.min(PRECISION.step, PRECISION.max - seeds));
  }
}

// Mean across seeds at each sample time (all runs share the same sample times).
export function meanSeries(list) {
  if (!list.length) return null;
  const mean = key => list[0][key].map((_, i) => list.reduce((s, x) => s + x[key][i], 0) / list.length);
  return { interval: list[0].interval, time: [...list[0].time], seeds: list.length,
    maxQueue: mean('maxQueue'), waiting: mean('waiting'), inNetwork: mean('inNetwork') };
}

export function runSweep(scenario, request, onProgress = () => {}) {
  const configurations = sweepConfigurations(request);
  const levelLabel = m => DEMAND_LEVELS.find(l => l.multiplier === m)?.label ?? `${m}×`;
  return configurations.map((sweep, i) => {
    const copy = structuredClone(scenario);
    copy.signals[sweep.group] = sweep.green;
    copy.demand.multiplier = sweep.multiplier;
    copy.name = `${sweep.green}s ${SWEEP_GROUPS[sweep.group]} green${request.multipliers.length > 1 ? ` · ${levelLabel(sweep.multiplier)} demand` : ''}`;
    const result = runReplications(copy, request.count);
    onProgress(i + 1, configurations.length);
    return { ...result, sweep };
  });
}
