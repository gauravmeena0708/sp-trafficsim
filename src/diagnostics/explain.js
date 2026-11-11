import { isGreen } from '../simulation/signals.js';

export function explainApproach(simulation, direction) {
  const a = simulation.approaches[direction];
  const s = simulation.scenario;
  const green = isGreen(s.signals, simulation.time, direction);
  const descriptions = [];
  if (!green && a.queue > 0) descriptions.push({ title: 'Signal hold', detail: 'This approach is not green. Queuing during a red phase is expected; this alone does not establish a design problem.' });
  if (a.waiting.length) descriptions.push({ title: 'Entry storage exhausted', detail: `${a.waiting.length} vehicles are waiting outside the model. They remain included in demand accounting.` });
  if (a.queue > s.geometry.length * 0.8) descriptions.push({ title: 'Queue near the study boundary', detail: 'The slow-vehicle tail occupies most of this approach. Test timing, lane count, or lower demand, and check entry waiting.' });
  if (green && a.queue > 30) descriptions.push({ title: 'Queue discharging during green', detail: 'Slow vehicles remain while this approach has green. Compare several cycles and repeated runs before attributing this to inadequate capacity.' });
  if (!descriptions.length) descriptions.push({ title: 'No current queue evidence', detail: 'No substantial slow-vehicle queue is detected here. This does not predict conditions outside the study area.' });
  return descriptions;
}
