import { DIRECTIONS, validateScenario } from './project.js';
import { approachSettings, compileNetwork, configurableApproaches, movementsFrom } from './network.js';
import { cycleLength } from '../simulation/signals.js';

// Indicative discharge used only for a pre-run warning. It is a common planning
// rule of thumb, not a calibrated saturation flow and not a model output.
export const INDICATIVE_LANE_FLOW = 1800;

const name = d => d[0].toUpperCase() + d.slice(1);

// Pre-run checks: blocking errors, then assumptions the planner should review.
// Each finding says what is wrong, where, and what would change it.
export function modelChecks(s) {
  const errors = validateScenario(s);
  if (errors.length) return errors.map(detail => ({ level: 'error', title: 'Invalid input', detail }));
  const findings = [];
  const network = compileNetwork(s);
  const roundabout = network.template === 'roundabout';
  const linkIds = new Set(configurableApproaches(network).map(l => l.id));
  const entryArms = new Set(network.links.filter(l => l.kind === 'entry').map(l => l.demandKey));

  for (const d of DIRECTIONS) {
    if (!entryArms.has(d) && s.demand[d] > 0) findings.push({ level: 'warning', title: `${name(d)} demand is not used`, detail: `This layout has no ${d} approach, so its ${s.demand[d]} veh/h are ignored. Set it to 0 or choose another template.` });
  }
  for (const link of network.links.filter(l => l.kind === 'entry')) {
    if (!s.demand[link.demandKey]) findings.push({ level: 'info', title: `No demand on ${link.label}`, detail: 'No vehicles enter here. Check that this is intended.', target: link.id });
  }
  for (const id of Object.keys(s.approaches)) {
    if (!linkIds.has(id)) findings.push({ level: 'warning', title: `Unused approach settings: ${id}`, detail: 'This layout has no such approach, so these settings have no effect. Remove them or switch template.', target: id });
  }
  const nodeIds = new Set(network.nodes.filter(n => n.control === 'signal').map(n => n.id));
  for (const id of Object.keys(s.signals.junctions)) {
    if (!nodeIds.has(id)) findings.push({ level: 'warning', title: `Unused signal settings for junction ${id}`, detail: 'This layout has no signalised junction with that name, so the timings have no effect.' });
  }

  if (roundabout) {
    findings.push({ level: 'info', title: 'Priority control', detail: 'Roundabout entries give way to circulating traffic. Signal timings and timing sweeps do not apply to this layout.' });
    const multiLane = s.geometry.lanes > 1 || Object.values(s.approaches).some(o => (o.lanes ?? 1) > 1);
    if (multiLane) findings.push({ level: 'warning', title: 'Lane counts are ignored', detail: 'The roundabout template is single-lane throughout: every approach, exit and circulating link has one lane. Compare it with a one-lane signalised junction for a like-for-like test.' });
    if (Object.values(s.approaches).some(o => o.pocket)) findings.push({ level: 'warning', title: 'Turning pockets are ignored', detail: 'Right-turn pockets apply only at signalised junctions.' });
  }

  for (const link of network.links.filter(l => l.to)) {
    const node = network.nodeById[link.to];
    if (node.control !== 'signal') continue;
    const shares = approachSettings(s, link.id, link.kind);
    const available = new Set(movementsFrom(network, link.id).map(m => m.movement));
    for (const movement of ['left', 'right']) {
      if (shares[movement] > 0 && !available.has(movement)) findings.push({ level: 'info', title: `${link.label}: no ${movement} turn`, detail: `The ${shares[movement]}% ${movement}-turn share is redistributed across the movements that exist here.`, target: link.id });
    }
    if (shares.right > 0 && available.has('right') && !link.pocket && link.throughLanes === 1) {
      findings.push({ level: 'warning', title: `${link.label}: right-turners share the only lane`, detail: 'Each right-turner waits for a gap in opposing traffic and holds everything behind it. A right-turn pocket or an extra lane would separate them.', target: link.id });
    }
    if (link.kind === 'entry' && s.demand[link.demandKey] > 0) {
      const plan = node.plan;
      const group = link.toArm === 'east' || link.toArm === 'west' ? 'eastWest' : 'northSouth';
      const indicative = INDICATIVE_LANE_FLOW * link.lanes * plan[group] / cycleLength(plan);
      const demand = s.demand[link.demandKey] * s.demand.multiplier;
      if (demand > indicative) findings.push({ level: 'warning', title: `${link.label}: demand may exceed discharge`, detail: `${Math.round(demand)} veh/h arrive, against an indicative ${Math.round(indicative)} veh/h (${INDICATIVE_LANE_FLOW} veh/h per lane × ${plan[group]} s green ÷ ${cycleLength(plan)} s cycle). This rule of thumb is not a model result; expect queues to grow through the run.`, target: link.id });
    }
  }
  if (s.run.warmup < 120) findings.push({ level: 'info', title: 'Short warm-up', detail: `A ${s.run.warmup} s warm-up measures traffic while the network is still filling. Consider at least one or two signal cycles.` });
  return findings;
}
