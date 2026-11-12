import { DIRECTIONS, validateScenario } from './project.js';
import { analysePlanPhase, approachSettings, compileNetwork, configurableApproaches, movementLabel, movementsFrom } from './network.js';
import { cycleLength, movementGreenTime } from '../simulation/signals.js';

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
  if (network.template === 'grid') {
    // Directional demand applies in full to every boundary approach facing that way.
    const counts = DIRECTIONS.map(d => [d, network.links.filter(l => l.kind === 'entry' && l.demandKey === d).length]).filter(([, n]) => n > 1);
    if (counts.length) findings.push({ level: 'info', title: 'Demand applies to each boundary approach', detail: `Every boundary approach receives the full veh/h for the direction it faces: ${counts.map(([d, n]) => `${n} ${d} approaches × ${s.demand[d]}`).join(', ')} veh/h. Lower the directional values if they describe the whole network edge.` });
    const ring = network.links.some(l => l.kind === 'internal') && network.links.filter(l => l.kind === 'internal').length / 2 >= network.nodes.length;
    if (ring) findings.push({ level: 'info', title: 'The network has loops', detail: 'Routes are chosen junction by junction from turning shares and never revisit a junction; if every movement would, the vehicle takes the one closest to an exit. There is no route choice by travel time.' });
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
      // Green for the approach's straight-ahead movement (or its main movement if it has none).
      const main = available.has('straight') ? 'straight' : [...available][0];
      const green = movementGreenTime(plan, link.toArm, main);
      const indicative = INDICATIVE_LANE_FLOW * link.lanes * green / cycleLength(plan);
      const demand = s.demand[link.demandKey] * s.demand.multiplier;
      if (demand > indicative) findings.push({ level: 'warning', title: `${link.label}: demand may exceed discharge`, detail: `${Math.round(demand)} veh/h arrive, against an indicative ${Math.round(indicative)} veh/h (${INDICATIVE_LANE_FLOW} veh/h per lane × ${green} s green ÷ ${cycleLength(plan)} s cycle). This rule of thumb is not a model result; expect queues to grow through the run.`, target: link.id });
    }
  }
  if (s.signals.mode === 'custom' && !roundabout) {
    if (Object.keys(s.signals.junctions).length) findings.push({ level: 'warning', title: 'Per-junction green times are ignored', detail: 'With custom phases, every signalised junction runs the same phase plan. Remove the per-junction greens or return to the two-phase plan.' });
    s.signals.phases.forEach((p, i) => {
      const { permitted } = analysePlanPhase(network, p.movements);
      if (permitted.length) findings.push({ level: 'info', title: `Phase ${i + 1}: permitted right turns`, detail: `${permitted.map(movementLabel).join(', ')} cross${permitted.length === 1 ? 'es' : ''} opposing traffic that is also green, so ${permitted.length === 1 ? 'it gives' : 'they give'} way (4 s critical gap). Give right turns their own phase to protect them.` });
    });
  }
  const { period, factors } = s.demand.profile;
  if (factors.length > 1 || factors[0] !== 1) {
    // Average factor actually applied over the run (the last factor holds after the profile ends).
    let weighted = 0;
    for (let t = 0; t < s.run.duration; t += 10) weighted += factors[Math.min(factors.length - 1, Math.floor(t / period))];
    const mean = weighted / Math.ceil(s.run.duration / 10);
    if (Math.abs(mean - 1) > 0.02) findings.push({ level: 'info', title: `Demand profile adds ${mean > 1 ? 'more' : 'less'} demand overall`, detail: `Over this run the profile averages ${mean.toFixed(2)}× the entered veh/h, so total demand differs from a constant profile. Compare like with like, or rescale the factors to average 1.` });
    const span = period * factors.length;
    if (factors.length > 1 && span < s.run.duration) findings.push({ level: 'info', title: 'Profile ends before the run does', detail: `The profile covers ${span} s of a ${s.run.duration} s run; its last factor (${factors.at(-1)}×) holds for the rest.` });
  }
  if (s.run.warmup < 120) findings.push({ level: 'info', title: 'Short warm-up', detail: `A ${s.run.warmup} s warm-up measures traffic while the network is still filling. Consider at least one or two signal cycles.` });
  return findings;
}
