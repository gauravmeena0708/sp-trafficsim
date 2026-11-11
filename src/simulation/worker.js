import { runReplications, timingCandidates } from './experiments.js';

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'compare') {
      const results = data.scenarios.map((s, i) => {
        const result = runReplications(s, data.count);
        self.postMessage({ type: 'progress', completed: i + 1, total: data.scenarios.length });
        return result;
      });
      self.postMessage({ type: 'complete', results });
    } else if (data.type === 'sweep') {
      const values = timingCandidates(data.start, data.end, data.increment);
      const results = values.map((green, i) => {
        const copy = structuredClone(data.scenario);
        copy.signals.eastWest = green;
        copy.name = `${green}s east–west green`;
        const result = runReplications(copy, data.count);
        self.postMessage({ type: 'progress', completed: i + 1, total: values.length });
        return { ...result, green };
      });
      self.postMessage({ type: 'complete', results });
    } else throw new Error('Unknown experiment type.');
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
