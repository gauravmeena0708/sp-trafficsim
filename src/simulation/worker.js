import { attachBaselineDifferences, runReplications, runSweep } from './experiments.js';

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'compare') {
      const results = data.scenarios.map((s, i) => {
        const result = runReplications(s, data.count);
        self.postMessage({ type: 'progress', completed: i + 1, total: data.scenarios.length });
        return result;
      });
      self.postMessage({ type: 'complete', results: attachBaselineDifferences(results) });
    } else if (data.type === 'sweep') {
      const results = runSweep(data.scenario, data, (completed, total) => self.postMessage({ type: 'progress', completed, total }));
      self.postMessage({ type: 'complete', results });
    } else throw new Error('Unknown experiment type.');
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
