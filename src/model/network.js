// Compiles scenario templates into an explicit network graph: nodes (junctions),
// directed links with lanes, and lane-level movement paths through each junction.
// World coordinates are metres with x east and y south (screen orientation).
// Traffic keeps left: lane 0 is the kerbside lane, lane (lanes − 1) the median lane.

export const LANE_WIDTH = 3.5;
export const TEMPLATES = {
  fourArm: 'Four-arm junction',
  tJunction: 'T-junction (no north arm)',
  corridor: 'Two-junction corridor',
};
export const ARM_VECTORS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const ARM_LABELS = { north: 'North', east: 'East', south: 'South', west: 'West' };
const ARM_ORDER = ['north', 'east', 'south', 'west'];
const OPPOSITE = { north: 'south', east: 'west', south: 'north', west: 'east' };
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

function makeLink(id, label, from, to, x0, y0, x1, y1, geometry, extra = {}) {
  const length = Math.hypot(x1 - x0, y1 - y0);
  return { id, label, from, to, x0, y0, x1, y1, dx: (x1 - x0) / length, dy: (y1 - y0) / length, length,
    lanes: geometry.lanes, speed: geometry.speed / 3.6, ...extra };
}

function templateNodes(scenario, half) {
  const template = scenario.template ?? 'fourArm';
  if (template === 'corridor') {
    return [
      { id: 'A', label: 'Junction A', x: 0, y: 0, arms: [...ARM_ORDER], offset: 0 },
      { id: 'B', label: 'Junction B', x: scenario.geometry.spacing + 2 * half, y: 0, arms: [...ARM_ORDER], offset: scenario.signals.offset },
    ];
  }
  const arms = template === 'tJunction' ? ['east', 'south', 'west'] : [...ARM_ORDER];
  return [{ id: 'J', label: 'Junction', x: 0, y: 0, arms, offset: 0 }];
}

export function compileNetwork(scenario) {
  const { geometry } = scenario;
  const half = boxHalf(geometry.lanes);
  const nodes = templateNodes(scenario, half).map(n => ({ ...n, half, inbound: {}, outbound: {} }));
  const single = nodes.length === 1;
  const links = [];
  const neighbour = (node, arm) => nodes.find(other => other !== node && Math.sign(other.x - node.x) === ARM_VECTORS[arm][0] && Math.sign(other.y - node.y) === ARM_VECTORS[arm][1] && other.arms.includes(OPPOSITE[arm]));
  for (const node of nodes) {
    for (const arm of node.arms) {
      const [vx, vy] = ARM_VECTORS[arm];
      const other = neighbour(node, arm);
      const name = single ? ARM_LABELS[arm] : (arm === 'east' || arm === 'west') && !other ? ARM_LABELS[arm] : `${node.id} ${ARM_LABELS[arm].toLowerCase()}`;
      const base = single || ((arm === 'east' || arm === 'west') && !other) ? arm : `${node.id}-${arm}`;
      if (other) {
        // One internal link per direction; create it from the upstream node only.
        const id = `${node.id}-${other.id}`;
        links.push(makeLink(id, `${node.id} → ${other.id}`, node.id, other.id,
          node.x + vx * half, node.y + vy * half, other.x - vx * half, other.y - vy * half, geometry,
          { kind: 'internal', fromArm: arm, toArm: OPPOSITE[arm] }));
        continue;
      }
      const far = half + geometry.length;
      links.push(makeLink(base, `${name} approach`, null, node.id,
        node.x + vx * far, node.y + vy * far, node.x + vx * half, node.y + vy * half, geometry,
        { kind: 'entry', toArm: arm, demandKey: arm }));
      links.push(makeLink(`${base}-out`, `${name} exit`, node.id, null,
        node.x + vx * half, node.y + vy * half, node.x + vx * far, node.y + vy * far, geometry,
        { kind: 'exit', fromArm: arm }));
    }
  }
  for (const link of links) {
    if (link.to) nodes.find(n => n.id === link.to).inbound[link.toArm] = link.id;
    if (link.from) nodes.find(n => n.id === link.from).outbound[link.fromArm] = link.id;
  }
  const byId = Object.fromEntries(links.map(l => [l.id, l]));
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
  return { template: scenario.template ?? 'fourArm', nodes, links, byId, nodeById, paths: new Map(), conflicts: new Map() };
}

// Available departures from an inbound link, with the movement each represents.
export function movementsFrom(network, linkId) {
  const link = network.byId[linkId];
  if (!link.to) return [];
  const node = network.nodeById[link.to];
  return node.arms.filter(arm => arm !== link.toArm).map(arm => ({ arm, link: node.outbound[arm], movement: movementType(link.toArm, arm) }));
}

// Choose a whole route at departure from declared turning shares. Unavailable
// movements are removed and the remaining shares renormalised; if none remain
// with a positive share, available movements are equally likely.
export function chooseRoute(network, entryId, turning, draws) {
  const route = [entryId];
  const moves = [];
  let current = entryId;
  for (let i = 0; network.byId[current].to; i++) {
    const options = movementsFrom(network, current);
    const share = { straight: Math.max(0, 100 - turning.left - turning.right), left: turning.left, right: turning.right };
    let weights = options.map(o => share[o.movement]);
    let total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) { weights = options.map(() => 1); total = options.length; }
    let draw = (draws[i] ?? 0.5) * total;
    let pick = options.at(-1);
    for (let k = 0; k < options.length; k++) { if (draw < weights[k]) { pick = options[k]; break; } draw -= weights[k]; }
    moves.push(pick.movement);
    route.push(pick.link);
    current = pick.link;
  }
  return { route, moves };
}

// Lane a vehicle uses on a link given the movement it will make at the link's end.
// Left turns use the kerbside lane, right turns the median lane; otherwise undefined.
export function laneForMovement(link, movement) {
  if (movement === 'left') return 0;
  if (movement === 'right') return link.lanes - 1;
  return undefined;
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
  if (Math.abs(det) < 1e-9) points = Array.from({ length: 13 }, (_, i) => [p0[0] + (p1[0] - p0[0]) * i / 12, p0[1] + (p1[1] - p0[1]) * i / 12]);
  else {
    // Control point where the arriving and departing lane centre lines intersect.
    const t = ((p1[0] - p0[0]) * -b.dy - (p1[1] - p0[1]) * -b.dx) / det;
    const control = [p0[0] + a.dx * t, p0[1] + a.dy * t];
    points = Array.from({ length: 13 }, (_, i) => quadratic(p0, control, p1, i / 12));
  }
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const movement = movementType(a.toArm, b.fromArm);
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
