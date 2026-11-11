import { armGroup } from '../model/network.js';
import { groupGreen } from '../simulation/signals.js';

// Evidence-limited descriptions of the current state of one inbound link.
// They name likely contributors visible in the simulation, never a proven cause.
export function explainApproach(simulation, linkId) {
  const link = simulation.links[linkId];
  if (!link) return [];
  const node = simulation.network.nodeById[link.to];
  const descriptions = [];
  if (node.control === 'priority') {
    if (link.kind === 'entry' && link.queue > 20) descriptions.push({ title: 'Waiting for gaps in circulating traffic', detail: 'Entering vehicles give way to anyone on the roundabout arriving within 3.5 seconds. Heavy circulating flow from the previous entries leaves fewer gaps here; compare demand on the upstream arms before attributing this to the entry itself.' });
    if (link.kind === 'ring' && link.queue > 5) descriptions.push({ title: 'Circulating traffic held', detail: 'Vehicles on the roundabout are waiting for room on the next section. If this persists the roundabout may be locking up under this demand.' });
    if (link.waiting?.length) descriptions.push({ title: 'Entry storage exhausted', detail: `${link.waiting.length} vehicles are waiting outside the model. They remain included in demand accounting.` });
    if (!descriptions.length) descriptions.push({ title: 'No current queue evidence', detail: 'No substantial queue is detected here. This does not predict conditions outside the study area.' });
    return descriptions;
  }
  const green = groupGreen(node.plan, simulation.time, armGroup(link.toArm), node.offset);
  if (link.pocketBlocked) descriptions.push({ title: 'Right-turn pocket full', detail: `The ${Math.round(link.pocket.length)} m pocket is full, so the next right-turner waits at its entrance and holds through traffic in the lane behind it. A longer pocket, more right-turn green or fewer right-turners would reduce this.` });
  const heldDownstream = link.held.some(Boolean);
  if (!green && link.queue > 0) descriptions.push({ title: 'Signal hold', detail: 'This approach is not green. Queuing during a red phase is expected; this alone does not establish a design problem.' });
  if (green && heldDownstream) {
    const blockedLanes = link.held.map((held, lane) => held ? lane : null).filter(lane => lane !== null);
    const targets = new Set(blockedLanes.map(lane => link.lanes[lane][0]).filter(Boolean).map(v => simulation.links[v.route[v.leg + 1]]?.label).filter(Boolean));
    descriptions.push({ title: 'Blocked by downstream storage', detail: `The signal is green, but the receiving lane has no room${targets.size ? ` (${[...targets].join(', ')})` : ''}. Vehicles do not enter the junction until they can clear it. Look downstream before changing this approach's green time.` });
  }
  if (link.kind === 'internal' && link.queue >= link.length - 15) descriptions.push({ title: 'Queue reaches the upstream junction', detail: `This ${Math.round(link.length)} m link is full back to ${simulation.network.nodeById[link.from].label}. Traffic there feeding this link is held, so queues may now appear on approaches that are not themselves short of green time.` });
  if (link.waiting?.length) descriptions.push({ title: 'Entry storage exhausted', detail: `${link.waiting.length} vehicles are waiting outside the model. They remain included in demand accounting.` });
  if (link.kind === 'entry' && link.queue > link.length * 0.8) descriptions.push({ title: 'Queue near the study boundary', detail: 'The queue occupies most of this approach. Test timing, lane count, or lower demand, and check entry waiting.' });
  if (green && !heldDownstream && link.queue > 30) descriptions.push({ title: 'Queue discharging during green', detail: 'A queue remains while this approach has green. Turning vehicles yielding, conflicting movements and start-up headways all slow discharge; compare several cycles and repeated runs before attributing this to inadequate capacity.' });
  if (!descriptions.length) descriptions.push({ title: 'No current queue evidence', detail: 'No substantial queue is detected here. This does not predict conditions outside the study area.' });
  return descriptions;
}
