// Compiles scenario templates into an explicit network graph: nodes (junctions),
// directed links with lanes, and lane-level movement paths through each junction.
// World coordinates are metres with x east and y south (screen orientation).
// Traffic keeps left: lane 0 is the kerbside lane; through lanes come next and an
// optional right-turn pocket lane is the median-most lane.

export const LANE_WIDTH = 3.5;
export const TEMPLATES = {
  fourArm: 'Four-arm junction',
  tJunction: 'T-junction (no north arm)',
  corridor: 'Two-junction corridor',
  roundabout: 'Single-lane roundabout',
};
export const ARM_VECTORS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const ARM_LABELS = { north: 'North', east: 'East', south: 'South', west: 'West' };
const ARM_ORDER = ['north', 'east', 'south', 'west'];
const OPPOSITE = { north: 'south', east: 'west', south: 'north', west: 'east' };
export const ROUNDABOUT_RADIUS = 24;
export const armGroup = arm => (arm === 'east' || arm === 'west') ? 'eastWest' : 'northSouth';

export const boxHalf = lanes => lanes * LANE_WIDTH + 3;

// Lateral offset of a lane centre to the left of the link's travel direction.
export const laneOffset = (link, lane) => (link.lanes - 1 - lane + 0.5) * LANE_WIDTH;

export function lanePoint(link, lane, s) {
  const offset = laneOffset(link, lane);
  return [link.x0 + link.dx * s + link.dy * offset, link.y0 + link.dy * s - link.dx * offset];
}

// Movement relative to the arriving travel direction. In screen coordinates a
// negative cross product turns towards the left-hand side.
export function movementType(arrivalArm, departureArm) {
  const [tx, ty] = ARM_VECTORS[arrivalArm].map(v => -v);
  const [ox, oy] = ARM_VECTORS[departureArm];
  const cross = tx * oy - ty * ox;
  return cross < 0 ? 'left' : cross > 0 ? 'right' : 'straight';
}

// Effective per-approach settings: explicit overrides, else shared values.
export function approachSettings(scenario, linkId, kind = 'entry') {
  const o = scenario.approaches?.[linkId] ?? {};
  const shared = scenario.geometry;
  const roundabout = scenario.template === 'roundabout';
  return {
    lanes: roundabout ? 1 : o.lanes ?? shared.lanes,
    speed: o.speed ?? shared.speed,
    length: kind === 'entry' ? o.length ?? shared.length : null,
    left: o.left ?? scenario.turning.left,
    right: o.right ?? scenario.turning.right,
    pocket: roundabout ? 0 : o.pocket ?? 0,
  };
}

function makeLink(id, label, from, to, x0, y0, x1, y1, lanes, speedKmh, extra = {}) {
  const length = Math.hypot(x1 - x0, y1 - y0);
  return { id, label, from, to, x0, y0, x1, y1, dx: (x1 - x0) / length, dy: (y1 - y0) / length, length,
    lanes, throughLanes: lanes, pocket: null, speed: speedKmh / 3.6, ...extra };
}

function withPocket(link, pocketLength) {
  if (!pocketLength) return link;
  const length = Math.min(pocketLength, link.length - 10);
  return { ...link, lanes: link.throughLanes + 1, pocket: { lane: link.throughLanes, length, start: link.length - length } };
}

// Largest total lane count on any link, so every junction box can hold its paths.
function maxLanes(scenario) {
  if (scenario.template === 'roundabout') return 1;
  const values = Object.values(scenario.approaches ?? {}).map(o => (o.lanes ?? scenario.geometry.lanes) + (o.pocket ? 1 : 0));
  return Math.max(scenario.geometry.lanes, ...values);
}

function signalPlan(scenario, nodeId) {
  return { ...scenario.signals, ...(scenario.signals.junctions?.[nodeId] ?? {}) };
}

function templateNodes(scenario, half) {
  const template = scenario.template ?? 'fourArm';
  if (template === 'corridor') {
    return [
      { id: 'A', label: 'Junction A', x: 0, y: 0, arms: [...ARM_ORDER], offset: 0, control: 'signal' },
      { id: 'B', label: 'Junction B', x: scenario.geometry.spacing + 2 * half, y: 0, arms: [...ARM_ORDER], offset: scenario.signals.offset, control: 'signal' },
    ];
  }
  if (template === 'roundabout') {
    return ARM_ORDER.map(arm => ({ id: `R${arm[0].toUpperCase()}`, label: `Roundabout ${arm} entry`, x: ARM_VECTORS[arm][0] * ROUNDABOUT_RADIUS,
      y: ARM_VECTORS[arm][1] * ROUNDABOUT_RADIUS, arms: [arm], offset: 0, control: 'priority' }));
  }
  const arms = template === 'tJunction' ? ['east', 'south', 'west'] : [...ARM_ORDER];
  return [{ id: 'J', label: 'Junction', x: 0, y: 0, arms, offset: 0, control: 'signal' }];
}

export function compileNetwork(scenario) {
  const { geometry } = scenario;
  const template = scenario.template ?? 'fourArm';
  const half = boxHalf(maxLanes(scenario));
  const nodes = templateNodes(scenario, half).map(n => ({ ...n, half, inbound: {}, outbound: {}, plan: signalPlan(scenario, n.id) }));
  const single = nodes.length === 1;
  const links = [];
  const neighbour = (node, arm) => nodes.find(other => other !== node && Math.sign(other.x - node.x) === ARM_VECTORS[arm][0] && Math.sign(other.y - node.y) === ARM_VECTORS[arm][1] && other.arms.includes(OPPOSITE[arm]));
  for (const node of nodes) {
    for (const arm of node.arms) {
      const [vx, vy] = ARM_VECTORS[arm];
      const other = template === 'roundabout' ? null : neighbour(node, arm);
      const sideRoad = !single && template !== 'roundabout' && (arm === 'north' || arm === 'south');
      const name = sideRoad ? `${node.id} ${arm}` : ARM_LABELS[arm];
      const base = sideRoad ? `${node.id}-${arm}` : arm;
      if (other) {
        // One internal link per direction; create it from the upstream node only.
        const id = `${node.id}-${other.id}`;
        const settings = approachSettings(scenario, id, 'internal');
        links.push(withPocket(makeLink(id, `${node.id} → ${other.id}`, node.id, other.id,
          node.x + vx * half, node.y + vy * half, other.x - vx * half, other.y - vy * half, settings.lanes, settings.speed,
          { kind: 'internal', fromArm: arm, toArm: OPPOSITE[arm] }), settings.pocket));
        continue;
      }
      const settings = approachSettings(scenario, base, 'entry');
      const far = half + settings.length;
      links.push(withPocket(makeLink(base, `${name} approach`, null, node.id,
        node.x + vx * far, node.y + vy * far, node.x + vx * half, node.y + vy * half, settings.lanes, settings.speed,
        { kind: 'entry', toArm: arm, demandKey: arm }), settings.pocket));
      const exitLanes = template === 'roundabout' ? 1 : geometry.lanes;
      links.push(makeLink(`${base}-out`, `${name} exit`, node.id, null,
        node.x + vx * half, node.y + vy * half, node.x + vx * (half + geometry.length), node.y + vy * (half + geometry.length), exitLanes, geometry.speed,
        { kind: 'exit', fromArm: arm }));
    }
  }
  if (template === 'roundabout') {
    // Clockwise circulation for left-hand traffic: west → north → east → south.
    const ordered = ['RW', 'RN', 'RE', 'RS'].map(id => nodes.find(n => n.id === id));
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i], b = ordered[(i + 1) % ordered.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
      links.push(makeLink(`${a.id}-${b.id}`, `Circulating ${a.id[1]}→${b.id[1]}`, a.id, b.id,
        a.x + dx * half, a.y + dy * half, b.x - dx * half, b.y - dy * half, 1, Math.min(geometry.speed, 30), { kind: 'ring', fromArm: 'ring', toArm: 'ring' }));
    }
  }
  for (const link of links) {
    if (link.to) nodes.find(n => n.id === link.to).inbound[link.kind === 'ring' ? 'ring' : link.toArm] = link.id;
    if (link.from) nodes.find(n => n.id === link.from).outbound[link.kind === 'ring' ? 'ring' : link.fromArm] = link.id;
  }
  const byId = Object.fromEntries(links.map(l => [l.id, l]));
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
  const centre = { x: nodes.reduce((s, n) => s + n.x, 0) / nodes.length, y: nodes.reduce((s, n) => s + n.y, 0) / nodes.length };
  return { template, nodes, links, byId, nodeById, centre, island: template === 'roundabout' ? { ...centre, radius: ROUNDABOUT_RADIUS - half - 1 } : null,
    paths: new Map(), conflicts: new Map(), turning: Object.fromEntries(links.filter(l => l.to).map(l => [l.id, approachSettings(scenario, l.id, l.kind)])) };
}

// Available departures from an inbound link, with the movement each represents.
export function movementsFrom(network, linkId) {
  const link = network.byId[linkId];
  if (!link.to) return [];
  const node = network.nodeById[link.to];
  if (node.control === 'priority') {
    const ring = { arm: 'ring', link: node.outbound.ring };
    if (link.kind === 'entry') return [{ ...ring, movement: 'merge' }];
    return [{ ...ring, movement: 'circulate' }, { arm: node.arms[0], link: node.outbound[node.arms[0]], movement: 'diverge' }];
  }
  return node.arms.filter(arm => arm !== link.toArm).map(arm => ({ arm, link: node.outbound[arm], movement: movementType(link.toArm, arm) }));
}

const pickWeighted = (options, weights, draw) => {
  let total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) { weights = options.map(() => 1); total = options.length; }
  let value = (draw ?? 0.5) * total;
  for (let k = 0; k < options.length; k++) { if (value < weights[k]) return options[k]; value -= weights[k]; }
  return options.at(-1);
};

const shareOf = (shares, movement) => movement === 'left' ? shares.left : movement === 'right' ? shares.right : Math.max(0, 100 - shares.left - shares.right);

// Choose a whole route at departure from declared turning shares. Unavailable
// movements are removed and the remaining shares renormalised; if none remain
// with a positive share, available movements are equally likely.
export function chooseRoute(network, entryId, turning, draws) {
  const route = [entryId];
  const moves = [];
  if (network.template === 'roundabout') {
    // Exit chosen by the movement it represents relative to the entry arm:
    // first exit = left, second = straight on, third = right (no U-turns).
    const entry = network.byId[entryId];
    const shares = network.turning[entryId] ?? turning;
    const exits = ['north', 'east', 'south', 'west'].filter(arm => arm !== entry.toArm);
    const target = pickWeighted(exits, exits.map(arm => shareOf(shares, movementType(entry.toArm, arm))), draws[0]);
    let current = entryId;
    for (let guard = 0; guard < 8; guard++) {
      const node = network.nodeById[network.byId[current].to];
      const exitHere = node.arms[0] === target && network.byId[current].kind === 'ring';
      const options = movementsFrom(network, current);
      const pick = exitHere ? options.find(o => o.movement === 'diverge') : options.find(o => o.movement !== 'diverge');
      moves.push(pick.movement);
      route.push(pick.link);
      current = pick.link;
      if (exitHere) break;
    }
    return { route, moves };
  }
  let current = entryId;
  for (let i = 0; network.byId[current].to; i++) {
    const options = movementsFrom(network, current);
    const shares = network.turning[current] ?? turning;
    const pick = pickWeighted(options, options.map(o => shareOf(shares, o.movement)), draws[i]);
    moves.push(pick.movement);
    route.push(pick.link);
    current = pick.link;
  }
  return { route, moves };
}

// Lane at the stop line for a movement: kerbside for left, pocket (or median
// through lane) for right; undefined when any through lane will do.
export function laneForMovement(link, movement) {
  if (movement === 'left') return 0;
  if (movement === 'right') return link.pocket ? link.pocket.lane : link.throughLanes - 1;
  return undefined;
}

// Lane used from the start of a link. Right-turners travel in the median
// through lane until they can enter the pocket.
export function approachLane(link, movement) {
  if (movement === 'right' && link.pocket) return link.throughLanes - 1;
  return laneForMovement(link, movement);
}

function quadratic(p0, c, p1, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
}

// Lane-to-lane path through a junction, sampled as a polyline with cumulative length.
export function junctionPath(network, fromId, fromLane, toId, toLane) {
  const key = `${fromId}:${fromLane}>${toId}:${toLane}`;
  const cached = network.paths.get(key);
  if (cached) return cached;
  const a = network.byId[fromId], b = network.byId[toId];
  const p0 = lanePoint(a, fromLane, a.length), p1 = lanePoint(b, toLane, 0);
  const det = a.dx * -b.dy - a.dy * -b.dx;
  let points;
  const t = Math.abs(det) < 1e-9 ? null : ((p1[0] - p0[0]) * -b.dy - (p1[1] - p0[1]) * -b.dx) / det;
  if (t === null || t <= 0) points = Array.from({ length: 13 }, (_, i) => [p0[0] + (p1[0] - p0[0]) * i / 12, p0[1] + (p1[1] - p0[1]) * i / 12]);
  else {
    // Control point where the arriving and departing lane centre lines intersect.
    const control = [p0[0] + a.dx * t, p0[1] + a.dy * t];
    points = Array.from({ length: 13 }, (_, i) => quadratic(p0, control, p1, i / 12));
  }
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const movement = movementsFrom(network, fromId).find(m => m.link === toId)?.movement ?? 'straight';
  const path = { key, from: fromId, fromLane, to: toId, toLane, node: a.to, movement, points, cumulative, length: cumulative.at(-1) };
  network.paths.set(key, path);
  return path;
}

export function pointOnPath(path, distance) {
  const d = Math.max(0, Math.min(path.length, distance));
  let i = 1;
  while (i < path.cumulative.length - 1 && path.cumulative[i] < d) i++;
  const span = path.cumulative[i] - path.cumulative[i - 1] || 1;
  const t = (d - path.cumulative[i - 1]) / span;
  const [x0, y0] = path.points[i - 1], [x1, y1] = path.points[i];
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, angle: Math.atan2(y1 - y0, x1 - x0) };
}

// Two distinct paths conflict when any sampled points come closer than a vehicle
// width plus margin: crossing, merging into one lane, or diverging from one lane.
export const CONFLICT_DISTANCE = 2.6;
export function pathsConflict(network, p, q) {
  if (p.key === q.key) return false;
  const key = p.key < q.key ? `${p.key}|${q.key}` : `${q.key}|${p.key}`;
  if (network.conflicts.has(key)) return network.conflicts.get(key);
  let conflict = false;
  outer: for (const [ax, ay] of p.points) for (const [bx, by] of q.points) {
    if (Math.hypot(ax - bx, ay - by) < CONFLICT_DISTANCE) { conflict = true; break outer; }
  }
  network.conflicts.set(key, conflict);
  return conflict;
}

// Approach links a planner can inspect: everything that ends at a junction.
export const inboundLinks = network => network.links.filter(l => l.to);

// Links a planner may configure individually (boundary and internal approaches).
export const configurableApproaches = network => network.links.filter(l => l.kind === 'entry' || l.kind === 'internal');
