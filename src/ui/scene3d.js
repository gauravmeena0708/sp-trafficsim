import { FLEET } from '../model/project.js';
import { LANE_WIDTH, inboundLinks, lanePoint, pointOnPath } from '../model/network.js';
import { armSignal } from '../simulation/signals.js';

// Navigable 3D view drawn with a perspective projection onto a Canvas 2D context.
// It reads the same compiled network and engine state as the 2D plan and never
// writes to either, so switching views or moving the camera cannot change results.
//
// World coordinates are the network's own: metres, x east, y south (as on the 2D
// plan), plus z up from the road surface. Unlike the 2D plan, lanes and roads are
// drawn at one true scale.

const DEG = Math.PI / 180;
export const CAMERA_LIMITS = { fov: 50 * DEG, minPitch: 3 * DEG, maxPitch: 89.5 * DEG, minDistance: 8, minEyeHeight: 1.6, near: 0.5 };
export const GRID_SPACING = 50;
const SIGNAL_LAMPS = { red: '#e0533d', yellow: '#f2b632', green: '#58c46a' };
const SPEED_BINS = [
  { label: 'Stopped (under 2 m/s)', colour: '#c4513a', test: v => v.speed < 2 },
  { label: 'Slow (under half desired speed)', colour: '#e0a23a', test: v => v.speed < v.desired / 2 },
  { label: 'Moving', colour: '#3f8f63', test: () => true },
];
export const SPEED_LEGEND = SPEED_BINS.map(({ label, colour }) => ({ label, colour }));
// Recognisable vehicle bodies: breadth and height in metres (length comes from the fleet).
const BODY = { twoWheeler: [0.8, 1.4], auto: [1.4, 1.7], car: [1.8, 1.5], bus: [2.5, 3.1], truck: [2.5, 3.3] };
const PALETTE = {
  sky: '#dfe9ec', horizon: '#eef2ea', ground: '#e8eddf', grid: '#d6ddcb', road: '#5e6965', box: '#66716b',
  marking: '#e4e8da', median: '#d9cf8a', island: '#cfdcc0', islandEdge: '#b9c8a7', stop: '#f2f3ea',
  queue: '#d2a052', selected: '#6f9a55', pole: '#4a514e', housing: '#2f3532',
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

// Extent of everything drawn, in world metres.
export function networkBounds(network) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const link of network.links) {
    const margin = link.lanes * LANE_WIDTH + 3;
    for (const [x, y] of [[link.x0, link.y0], [link.x1, link.y1]]) {
      box.minX = Math.min(box.minX, x - margin); box.maxX = Math.max(box.maxX, x + margin);
      box.minY = Math.min(box.minY, y - margin); box.maxY = Math.max(box.maxY, y + margin);
    }
  }
  // Road ends (and junction centres) are what a fitted view must keep on screen.
  const points = [...network.links.flatMap(l => [[l.x0, l.y0], [l.x1, l.y1]]), ...network.nodes.map(n => [n.x, n.y])];
  return { ...box, points, cx: (box.minX + box.maxX) / 2, cy: (box.minY + box.maxY) / 2, radius: Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2 };
}

// Keep the camera usable: above the ground, not inside geometry, not lost far away.
export function clampCamera(camera, bounds) {
  const { minPitch, maxPitch, minDistance, minEyeHeight } = CAMERA_LIMITS;
  const maxDistance = Math.max(300, bounds.radius * 4);
  const margin = Math.max(100, bounds.radius);
  const distance = clamp(Number.isFinite(camera.distance) ? camera.distance : maxDistance / 2, minDistance, maxDistance);
  let pitch = clamp(Number.isFinite(camera.pitch) ? camera.pitch : 45 * DEG, minPitch, maxPitch);
  if (distance * Math.sin(pitch) < minEyeHeight) pitch = Math.min(maxPitch, Math.asin(minEyeHeight / distance));
  const tx = Number.isFinite(camera.target?.x) ? camera.target.x : bounds.cx;
  const ty = Number.isFinite(camera.target?.y) ? camera.target.y : bounds.cy;
  return {
    target: { x: clamp(tx, bounds.minX - margin, bounds.maxX + margin), y: clamp(ty, bounds.minY - margin, bounds.maxY + margin) },
    yaw: wrapAngle(Number.isFinite(camera.yaw) ? camera.yaw : 0), pitch, distance,
  };
}

// Centre the whole study area in view, keeping the camera's direction and tilt.
export function fitCamera(bounds, yaw, pitch, aspect = 1.6) {
  const half = CAMERA_LIMITS.fov / 2;
  const horizontal = Math.atan(Math.tan(half) * aspect);
  const target = { x: bounds.cx, y: bounds.cy };
  // A bounding sphere always fits; then close in until a road end touches the screen margin.
  let far = bounds.radius / Math.sin(Math.min(half, horizontal)) * 1.04;
  const H = 1000, W = H * aspect, margin = 0.05;
  const corners = bounds.points ?? [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY]];
  const fits = distance => {
    const b = viewBasis({ target, yaw, pitch, distance }, W, H);
    return corners.every(([x, y]) => {
      const p = projectPoint(b, x, y, 0);
      return p && p.x >= W * margin && p.x <= W * (1 - margin) && p.y >= H * margin && p.y <= H * (1 - margin);
    });
  };
  if (fits(far)) {
    let near = CAMERA_LIMITS.minDistance;
    for (let i = 0; i < 32; i++) { const mid = (near + far) / 2; if (fits(mid)) far = mid; else near = mid; }
  }
  return clampCamera({ target, yaw, pitch, distance: far }, bounds);
}

// Yaw that looks along a travel direction (dx, dy).
const headingYaw = (dx, dy) => Math.atan2(dx, -dy);

export const CAMERA_PRESETS = {
  overview: { label: 'Angled overview' },
  overhead: { label: 'Overhead' },
  street: { label: 'Street level' },
  fit: { label: 'Fit study area' },
  reset: { label: 'Reset view' },
};

export function presetCamera(name, network, bounds, current, aspect, focusLink) {
  if (name === 'overhead') return fitCamera(bounds, 0, CAMERA_LIMITS.maxPitch, aspect);
  if (name === 'fit') return fitCamera(bounds, current?.yaw ?? 0, current?.pitch ?? 45 * DEG, aspect);
  if (name === 'street') {
    // A driver's-eye view on an approach, looking along it towards the stop line.
    const link = network.byId[focusLink]?.to ? network.byId[focusLink] : inboundLinks(network)[0];
    const [x, y] = lanePoint(link, Math.floor(link.lanes / 2), link.length);
    return clampCamera({ target: { x, y }, yaw: headingYaw(link.dx, link.dy), pitch: CAMERA_LIMITS.minPitch, distance: Math.min(45, link.length * 0.8) }, bounds);
  }
  return fitCamera(bounds, -20 * DEG, 42 * DEG, aspect);
}

// Camera basis: forward F, right R and screen-up C, the eye position and focal length (px).
export function viewBasis(camera, width, height) {
  const { yaw, pitch, distance, target } = camera;
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  return {
    F: [sy * cp, -cy * cp, -sp], R: [cy, sy, 0], C: [sp * sy, -sp * cy, cp],
    eye: [target.x - sy * cp * distance, target.y + cy * cp * distance, sp * distance],
    focal: (height / 2) / Math.tan(CAMERA_LIMITS.fov / 2), cx: width / 2, cy: height / 2,
  };
}

export function toCamera(basis, x, y, z) {
  const v = [x - basis.eye[0], y - basis.eye[1], z - basis.eye[2]];
  return [dot(v, basis.R), dot(v, basis.C), dot(v, basis.F)];
}

export function projectPoint(basis, x, y, z = 0) {
  const [u, v, w] = toCamera(basis, x, y, z);
  if (w < CAMERA_LIMITS.near) return null;
  return { x: basis.cx + u * basis.focal / w, y: basis.cy - v * basis.focal / w, depth: w };
}

// Where a screen point's sight line meets the ground, or null above the horizon.
export function groundPoint(basis, sx, sy) {
  const a = (sx - basis.cx) / basis.focal, b = (basis.cy - sy) / basis.focal;
  const d = [0, 1, 2].map(i => basis.F[i] + basis.R[i] * a + basis.C[i] * b);
  if (d[2] >= -1e-6) return null;
  const t = -basis.eye[2] / d[2];
  return { x: basis.eye[0] + d[0] * t, y: basis.eye[1] + d[1] * t };
}

// Clip a camera-space polygon to the near plane (Sutherland–Hodgman, one plane).
function clipNear(points) {
  const near = CAMERA_LIMITS.near;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const ain = a[2] >= near, bin = b[2] >= near;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (near - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]);
    }
  }
  return out;
}

const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const shadeCache = new Map();
function shade(hex, factor) {
  const key = `${hex}:${factor}`;
  if (!shadeCache.has(key)) shadeCache.set(key, `rgb(${hexRgb(hex).map(c => Math.round(clamp(c * factor, 0, 255))).join(',')})`);
  return shadeCache.get(key);
}
// Fixed light from the north-west, above.
const LIGHT = (() => { const l = [-0.45, -0.6, 0.66]; const n = Math.hypot(...l); return l.map(c => c / n); })();
const faceShade = normal => 0.62 + 0.38 * Math.max(0, dot(normal, LIGHT));

// Locate a vehicle by id anywhere in the network (on a lane or crossing a junction).
export function findVehicle(simulation, id) {
  for (const link of simulation.network.links) {
    const lanes = simulation.links[link.id].lanes;
    for (let lane = 0; lane < lanes.length; lane++) {
      const v = lanes[lane].find(x => x.id === id);
      if (v) {
        const [x, y] = lanePoint(link, lane, Math.min(link.length, v.position));
        return { v, x, y, angle: Math.atan2(link.dy, link.dx), where: link.label };
      }
    }
  }
  const v = simulation.crossing.find(x => x.id === id);
  if (!v) return null;
  const p = pointOnPath(v.path, v.progress);
  return { v, x: p.x, y: p.y, angle: p.angle, where: simulation.network.nodeById[v.path.node]?.label ?? 'a junction' };
}

export class SceneRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.width = 0; this.height = 0;
    this.camera = null;
    this.network = null;
    this.bounds = null;
    this.selected = null;           // selected link id (shared with the 2D plan)
    this.selectedVehicle = null;    // vehicle id
    this.overlays = { labels: true, queues: true, signals: true, speed: false };
    this.detail = 'full';
    this.drawnVehicles = [];
    this.stats = { faces: 0, vehicles: 0 };
  }

  setSize(width, height) { this.width = width; this.height = height; }
  get aspect() { return this.width / Math.max(1, this.height); }
  basis() { return viewBasis(this.camera, this.width, this.height); }

  // Adopt a network; keep the current camera unless the study area changed shape.
  useNetwork(network) {
    if (network === this.network) return;
    const previous = this.network;
    this.network = network;
    this.bounds = networkBounds(network);
    const sameShape = previous && previous.template === network.template && previous.nodes.length === network.nodes.length;
    this.camera = this.camera && sameShape ? clampCamera(this.camera, this.bounds) : presetCamera('overview', network, this.bounds, null, this.aspect || 1.6);
  }

  setCamera(camera) { this.camera = clampCamera(camera, this.bounds); return this.camera; }
  applyPreset(name) {
    if (!this.network) return this.camera;
    return this.setCamera(presetCamera(name, this.network, this.bounds, this.camera, this.aspect, this.selected));
  }

  orbit(dYaw, dPitch) { return this.setCamera({ ...this.camera, yaw: this.camera.yaw + dYaw, pitch: this.camera.pitch + dPitch }); }
  zoom(factor) { return this.setCamera({ ...this.camera, distance: this.camera.distance * factor }); }
  // Pan by a screen-space offset in pixels (drag direction moves the ground with the pointer).
  pan(dx, dy) {
    const { yaw, distance, target } = this.camera;
    const k = distance / ((this.height / 2) / Math.tan(CAMERA_LIMITS.fov / 2));
    const r = [Math.cos(yaw), Math.sin(yaw)], f = [Math.sin(yaw), -Math.cos(yaw)];
    return this.setCamera({ ...this.camera, target: { x: target.x - r[0] * dx * k + f[0] * dy * k, y: target.y - r[1] * dx * k + f[1] * dy * k } });
  }

  // ------------------------------------------------------------ primitives
  polygon(b, points, fill, stroke) {
    const clipped = clipNear(points.map(([x, y, z]) => toCamera(b, x, y, z)));
    if (clipped.length < 3) return false;
    const c = this.ctx;
    c.beginPath();
    clipped.forEach(([u, v, w], i) => {
      const sx = b.cx + u * b.focal / w, sy = b.cy - v * b.focal / w;
      if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy);
    });
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1; c.stroke(); }
    this.stats.faces++;
    return true;
  }

  // Adds a 3D segment to the current path (clipped to the near plane).
  segment(b, p, q) {
    let a = toCamera(b, ...p), d = toCamera(b, ...q);
    const near = CAMERA_LIMITS.near;
    if (a[2] < near && d[2] < near) return;
    if (a[2] < near || d[2] < near) {
      const t = (near - a[2]) / (d[2] - a[2]);
      const m = [a[0] + (d[0] - a[0]) * t, a[1] + (d[1] - a[1]) * t, near];
      if (a[2] < near) a = m; else d = m;
    }
    this.ctx.moveTo(b.cx + a[0] * b.focal / a[2], b.cy - a[1] * b.focal / a[2]);
    this.ctx.lineTo(b.cx + d[0] * b.focal / d[2], b.cy - d[1] * b.focal / d[2]);
  }

  // World point at distance s along a link, `metres` to the left of its centre line.
  static along(link, metres, s, z = 0) {
    return [link.x0 + link.dx * s + link.dy * metres, link.y0 + link.dy * s - link.dx * metres, z];
  }

  band(b, link, from, to, start, end, fill, z = 0) {
    const at = SceneRenderer.along;
    return this.polygon(b, [at(link, from, start, z), at(link, from, end, z), at(link, to, end, z), at(link, to, start, z)], fill);
  }

  // A box resting on the ground: front-centre (x, y), heading angle, size, colour.
  box(b, x, y, angle, length, breadth, height, colour, z0 = 0) {
    const ux = Math.cos(angle), uy = Math.sin(angle), nx = -uy, ny = ux, hb = breadth / 2;
    const corner = (a, s, z) => [x + ux * a + nx * s, y + uy * a + ny * s, z];
    const z1 = z0 + height;
    const faces = [
      { n: [0, 0, 1], p: [corner(0, -hb, z1), corner(0, hb, z1), corner(-length, hb, z1), corner(-length, -hb, z1)] },
      { n: [ux, uy, 0], p: [corner(0, -hb, z0), corner(0, hb, z0), corner(0, hb, z1), corner(0, -hb, z1)] },
      { n: [-ux, -uy, 0], p: [corner(-length, -hb, z0), corner(-length, hb, z0), corner(-length, hb, z1), corner(-length, -hb, z1)] },
      { n: [nx, ny, 0], p: [corner(0, hb, z0), corner(-length, hb, z0), corner(-length, hb, z1), corner(0, hb, z1)] },
      { n: [-nx, -ny, 0], p: [corner(0, -hb, z0), corner(-length, -hb, z0), corner(-length, -hb, z1), corner(0, -hb, z1)] },
    ];
    const reduced = this.detail === 'reduced';
    for (const face of reduced ? faces.slice(0, 1) : faces) {
      const centre = face.p.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
      const toEye = [b.eye[0] - centre[0], b.eye[1] - centre[1], b.eye[2] - centre[2]];
      if (dot(face.n, toEye) <= 0) continue;
      this.polygon(b, face.p, shade(colour, faceShade(face.n)));
    }
  }

  // ------------------------------------------------------------ drawing
  draw(simulation) {
    const c = this.ctx;
    const { width: w, height: h } = this;
    if (!w || !h) return;
    this.useNetwork(simulation.network);
    const network = this.network;
    const b = this.basis();
    this.stats = { faces: 0, vehicles: 0 };

    // Sky above the horizon, ground below it.
    const horizon = b.cy - Math.tan(this.camera.pitch) * b.focal;
    c.fillStyle = PALETTE.ground; c.fillRect(0, 0, w, h);
    if (horizon > 0) {
      const sky = c.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, PALETTE.sky); sky.addColorStop(1, PALETTE.horizon);
      c.fillStyle = sky; c.fillRect(0, 0, w, Math.min(h, horizon));
    }

    // Ground grid: fixed 50 m squares, a consistent sense of scale at any zoom.
    if (this.detail === 'full') {
      const { minX, maxX, minY, maxY } = this.bounds;
      const pad = 150, x0 = Math.floor((minX - pad) / GRID_SPACING) * GRID_SPACING, y0 = Math.floor((minY - pad) / GRID_SPACING) * GRID_SPACING;
      const x1 = maxX + pad, y1 = maxY + pad;
      c.beginPath();
      for (let x = x0; x <= x1; x += GRID_SPACING) this.segment(b, [x, y0, 0], [x, y1, 0]);
      for (let y = y0; y <= y1; y += GRID_SPACING) this.segment(b, [x0, y, 0], [x1, y, 0]);
      c.strokeStyle = PALETTE.grid; c.lineWidth = 1; c.stroke();
    }

    // Road surfaces, junction boxes and the roundabout island, at true scale.
    for (const link of network.links) {
      const width = link.lanes * LANE_WIDTH;
      if (link.pocket) {
        this.band(b, link, LANE_WIDTH, width, 0, link.length, PALETTE.road);
        this.band(b, link, 0, LANE_WIDTH, link.pocket.start, link.length, PALETTE.road);
      } else this.band(b, link, 0, width, 0, link.length, PALETTE.road);
    }
    for (const node of network.nodes) {
      const s = node.half;
      this.polygon(b, [[node.x - s, node.y - s, 0], [node.x + s, node.y - s, 0], [node.x + s, node.y + s, 0], [node.x - s, node.y + s, 0]], PALETTE.box);
    }
    if (network.island) {
      const { x, y, radius } = network.island;
      const points = Array.from({ length: 32 }, (_, i) => [x + Math.cos(i / 32 * 2 * Math.PI) * radius, y + Math.sin(i / 32 * 2 * Math.PI) * radius, 0]);
      this.polygon(b, points, PALETTE.island, PALETTE.islandEdge);
    }

    // Lane markings (3 m dashes, 3 m gaps), the median line, and stop or give-way lines.
    if (this.detail === 'full') {
      const at = SceneRenderer.along;
      c.beginPath();
      for (const link of network.links) {
        for (let k = 1; k < link.lanes; k++) {
          const start = link.pocket && k === 1 ? link.pocket.start : 0;
          for (let s = start; s < link.length; s += 6) this.segment(b, at(link, k * LANE_WIDTH, s), at(link, k * LANE_WIDTH, Math.min(link.length, s + 3)));
        }
      }
      c.strokeStyle = PALETTE.marking; c.lineWidth = 1; c.stroke();
      c.beginPath();
      for (const link of network.links.filter(l => l.kind === 'exit' || l.kind === 'internal')) this.segment(b, at(link, 0.1, 0), at(link, 0.1, link.length));
      c.strokeStyle = PALETTE.median; c.lineWidth = 1.5; c.stroke();
    }

    const signals = [];
    for (const link of inboundLinks(network)) {
      const node = network.nodeById[link.to];
      const width = link.lanes * LANE_WIDTH;
      const state = simulation.links[link.id];
      let colour = null;
      if (node.control === 'signal') {
        colour = armSignal(node.plan, simulation.time, node.offset, link.toArm, state.movementTypes);
        signals.push({ link, colour });
      }
      // Stop line, tinted by the movement permission overlay; give-way lines are dashed.
      const stopColour = this.overlays.signals && colour ? SIGNAL_LAMPS[colour === 'partial' ? 'yellow' : colour] : PALETTE.stop;
      if (node.control === 'priority') {
        if (link.kind === 'entry') for (let m = 0.3; m < width - 0.3; m += 1.2) this.band(b, link, m, Math.min(width - 0.3, m + 0.6), link.length - 0.5, link.length - 0.1, PALETTE.stop);
      } else this.band(b, link, 0.2, width - 0.2, link.length - 0.6, link.length - 0.1, stopColour);
      if (this.overlays.queues && state.queue > 5) this.band(b, link, width + 0.3, width + 1.3, Math.max(0, link.length - state.queue), link.length, PALETTE.queue);
      if (this.selected === link.id) this.band(b, link, width + 1.5, width + 2.3, 0, link.length, PALETTE.selected);
    }

    // Solid objects, painted far to near.
    const objects = [];
    const speedColour = v => SPEED_BINS.find(bin => bin.test(v)).colour;
    const addVehicle = (v, x, y, angle) => {
      const [breadth, height] = BODY[v.type] ?? BODY.car;
      const mid = [x - Math.cos(angle) * v.length / 2, y - Math.sin(angle) * v.length / 2];
      const depth = toCamera(b, mid[0], mid[1], height / 2)[2];
      if (depth < CAMERA_LIMITS.near - v.length) return;
      objects.push({ depth, draw: () => {
        this.box(b, x, y, angle, v.length, breadth, height, this.overlays.speed ? speedColour(v) : FLEET[v.type].colour);
        if (v.speed < 2 && !this.overlays.speed && this.detail === 'full') this.box(b, x - Math.cos(angle) * (v.length - 0.12), y - Math.sin(angle) * (v.length - 0.12), angle, 0.12, breadth * 0.9, 0.35, '#e0533d', height * 0.45);
      } });
      const p = projectPoint(b, mid[0], mid[1], height / 2);
      if (p) this.drawnVehicles.push({ id: v.id, x: p.x, y: p.y, depth: p.depth, radius: Math.max(6, (v.length / 2) * b.focal / p.depth) });
      this.stats.vehicles++;
    };
    this.drawnVehicles = [];
    for (const link of network.links) {
      const state = simulation.links[link.id];
      const angle = Math.atan2(link.dy, link.dx);
      state.lanes.forEach((lane, laneIndex) => {
        for (const v of lane) {
          const [x, y] = lanePoint(link, laneIndex, Math.min(link.length, v.position));
          addVehicle(v, x, y, angle);
        }
      });
    }
    for (const v of simulation.crossing) {
      const p = pointOnPath(v.path, v.progress);
      addVehicle(v, p.x, p.y, p.angle);
    }
    for (const { link, colour } of signals) {
      const width = link.lanes * LANE_WIDTH;
      const [x, y] = SceneRenderer.along(link, width + 1.6, link.length - 2);
      const angle = Math.atan2(link.dy, link.dx);
      const depth = toCamera(b, x, y, 3)[2];
      objects.push({ depth, draw: () => this.signalHead(b, x, y, angle, colour) });
    }
    objects.sort((p, q) => q.depth - p.depth);
    for (const object of objects) object.draw();

    this.drawOverlays(b, simulation);
  }

  // A pole with a three-lamp head facing approaching traffic.
  signalHead(b, x, y, angle, colour) {
    this.box(b, x + Math.cos(angle) * 0.1, y + Math.sin(angle) * 0.1, angle, 0.2, 0.2, 3.1, PALETTE.pole);
    this.box(b, x + Math.cos(angle) * 0.25, y + Math.sin(angle) * 0.25, angle, 0.5, 0.5, 1.3, PALETTE.housing, 3.0);
    // Lamps sit on the face towards traffic; draw them only when that face is visible.
    const fx = x - Math.cos(angle) * 0.27, fy = y - Math.sin(angle) * 0.27;
    if ((b.eye[0] - fx) * -Math.cos(angle) + (b.eye[1] - fy) * -Math.sin(angle) <= 0) return;
    const lit = { red: colour === 'red' || colour === 'partial', yellow: colour === 'yellow', green: colour === 'green' || colour === 'partial' };
    [['red', 4.05], ['yellow', 3.65], ['green', 3.25]].forEach(([lamp, z]) => {
      const p = projectPoint(b, fx, fy, z);
      if (!p) return;
      const r = Math.max(1.2, 0.16 * b.focal / p.depth);
      this.ctx.fillStyle = lit[lamp] ? SIGNAL_LAMPS[lamp] : '#4b524e';
      this.ctx.beginPath(); this.ctx.arc(p.x, p.y, r, 0, Math.PI * 2); this.ctx.fill();
    });
  }

  // Screen-space annotations: constant pixel size, so they stay legible at any zoom.
  drawOverlays(b, simulation) {
    const c = this.ctx;
    const network = this.network;
    const pill = (text, p, { strong = false, colour = '#33402f' } = {}) => {
      if (!p || p.x < -50 || p.x > this.width + 50 || p.y < -20 || p.y > this.height + 20) return;
      c.font = `${strong ? 700 : 600} 10px system-ui, sans-serif`;
      const tw = c.measureText(text).width;
      c.fillStyle = strong ? 'rgba(111,154,85,.95)' : 'rgba(250,251,246,.9)';
      c.beginPath(); c.roundRect?.(p.x - tw / 2 - 5, p.y - 8, tw + 10, 16, 4); c.fill();
      c.fillStyle = strong ? '#ffffff' : colour; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(text, p.x, p.y);
      c.textBaseline = 'alphabetic';
    };
    if (this.overlays.labels) {
      for (const link of network.links.filter(l => l.kind === 'entry')) {
        const [x, y] = SceneRenderer.along(link, link.lanes * LANE_WIDTH / 2, Math.min(25, link.length / 4));
        pill(link.label.replace(' approach', ''), projectPoint(b, x, y, 2), { strong: link.id === this.selected });
      }
      if (network.nodes.length > 1 && network.nodes.every(n => n.control === 'signal')) {
        for (const node of network.nodes) pill(node.label, projectPoint(b, node.x, node.y, 7));
      }
      for (const link of network.links.filter(l => l.kind === 'internal' && l.id === this.selected)) {
        pill(link.label, projectPoint(b, ...SceneRenderer.along(link, link.lanes * LANE_WIDTH / 2, link.length / 2, 2)), { strong: true });
      }
    }
    if (this.overlays.queues) {
      for (const link of inboundLinks(network)) {
        const queue = simulation.links[link.id].queue;
        if (queue < 30) continue;
        const [x, y] = SceneRenderer.along(link, link.lanes * LANE_WIDTH + 0.8, Math.max(0, link.length - queue));
        pill(`Queue ${Math.round(queue)} m`, projectPoint(b, x, y, 1.5), { colour: '#7a5418' });
      }
    }
    if (this.selectedVehicle !== null) {
      const found = findVehicle(simulation, this.selectedVehicle);
      if (found) {
        const height = (BODY[found.v.type] ?? BODY.car)[1];
        const p = projectPoint(b, found.x - Math.cos(found.angle) * found.v.length / 2, found.y - Math.sin(found.angle) * found.v.length / 2, height + 1.2);
        if (p) {
          c.fillStyle = '#6f9a55'; c.strokeStyle = '#ffffff'; c.lineWidth = 1.5;
          c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - 7, p.y - 11); c.lineTo(p.x + 7, p.y - 11); c.closePath(); c.fill(); c.stroke();
        }
      }
    }
    this.drawContext(b);
  }

  // Scale context and an overview map of the study area with the camera's footprint.
  drawContext(b) {
    const c = this.ctx;
    const { width: w, height: h } = this;
    const target = this.camera.target;
    const eyeHeight = b.eye[2];
    const scale = `Grid squares ${GRID_SPACING} m · camera ${Math.round(this.camera.distance)} m from target, ${eyeHeight.toFixed(eyeHeight < 10 ? 1 : 0)} m up`;
    c.font = '9px system-ui, sans-serif'; c.textAlign = 'left';
    c.fillStyle = 'rgba(250,251,246,.88)';
    c.beginPath(); c.roundRect?.(10, h - 57, c.measureText(scale).width + 12, 17, 4); c.fill();
    c.fillStyle = '#56644f';
    c.fillText(scale, 16, h - 45);
    if (this.network.nodes.length < 2 || w < 420) return;
    const size = 96, pad = 8, x0 = w - size - 16, y0 = h - size - 52;
    const { minX, minY, maxX, maxY } = this.bounds;
    const k = (size - 2 * pad) / Math.max(maxX - minX, maxY - minY);
    const ox = x0 + pad + ((size - 2 * pad) - (maxX - minX) * k) / 2, oy = y0 + pad + ((size - 2 * pad) - (maxY - minY) * k) / 2;
    const map = (x, y) => [ox + (clamp(x, minX - 40, maxX + 40) - minX) * k, oy + (clamp(y, minY - 40, maxY + 40) - minY) * k];
    c.fillStyle = 'rgba(250,251,246,.88)'; c.strokeStyle = '#cdd5c2'; c.lineWidth = 1;
    c.beginPath(); c.roundRect?.(x0, y0, size, size, 6); c.fill(); c.stroke();
    c.strokeStyle = '#7b8679'; c.lineWidth = 1.5; c.beginPath();
    for (const link of this.network.links) { const p = map(link.x0, link.y0), q = map(link.x1, link.y1); c.moveTo(...p); c.lineTo(...q); }
    c.stroke();
    // The camera's ground footprint (where the screen corners meet the ground).
    const corners = [[0, h], [w, h], [w, 0], [0, 0]].map(([sx, sy]) => groundPoint(b, sx, sy) ?? (() => {
      const far = this.camera.distance * 4;
      return { x: target.x + Math.sin(this.camera.yaw) * far + (sx ? 1 : -1) * Math.cos(this.camera.yaw) * far, y: target.y - Math.cos(this.camera.yaw) * far + (sx ? 1 : -1) * Math.sin(this.camera.yaw) * far };
    })());
    c.fillStyle = 'rgba(111,154,85,.18)'; c.strokeStyle = '#6f9a55'; c.beginPath();
    corners.forEach((p, i) => { const [x, y] = map(p.x, p.y); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.closePath(); c.fill(); c.stroke();
    const [tx, ty] = map(target.x, target.y);
    c.fillStyle = '#6f9a55'; c.beginPath(); c.arc(tx, ty, 2.5, 0, Math.PI * 2); c.fill();
  }

  // What is under a screen point: a vehicle first, then an approach road.
  pick(sx, sy) {
    if (!this.network || !this.camera) return null;
    // The vehicle whose centre is closest to the pointer, nearer vehicles winning ties.
    let vehicle = null, bestDistance = Infinity;
    for (const v of this.drawnVehicles) {
      const d = Math.hypot(v.x - sx, v.y - sy);
      if (d > v.radius + 4) continue;
      if (d < bestDistance - 0.5 || (Math.abs(d - bestDistance) <= 0.5 && v.depth < vehicle.depth)) { vehicle = v; bestDistance = d; }
    }
    if (vehicle) return { type: 'vehicle', id: vehicle.id };
    const ground = groundPoint(this.basis(), sx, sy);
    if (!ground) return null;
    let best = null;
    for (const link of inboundLinks(this.network)) {
      const rx = ground.x - link.x0, ry = ground.y - link.y0;
      const s = rx * link.dx + ry * link.dy, lateral = rx * link.dy - ry * link.dx;
      const width = link.lanes * LANE_WIDTH;
      if (s < -2 || s > link.length + 2 || lateral < -1.5 || lateral > width + 2.5) continue;
      const miss = Math.abs(lateral - width / 2);
      if (!best || miss < best.miss) best = { miss, id: link.id };
    }
    return best ? { type: 'link', id: best.id } : null;
  }
}

// Browser wiring: canvas sizing, pointer, touch, wheel and keyboard navigation.
export class SceneView {
  constructor(canvas, { select, onCamera = () => {}, onVehicle = () => {}, onFollowEnd = () => {}, onFailure = () => {} }) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    this.supported = Boolean(ctx);
    this.renderer = new SceneRenderer(ctx);
    this.callbacks = { select, onCamera, onVehicle, onFollowEnd, onFailure };
    this.following = null;          // { id, previous camera }
    this.pointers = new Map();
    this.failed = false;
    if (!this.supported) return;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener('contextlost', () => this.fail(new Error('the graphics context was lost')));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => this.pointerDown(e));
    canvas.addEventListener('pointermove', e => this.pointerMove(e));
    canvas.addEventListener('pointerup', e => this.pointerUp(e));
    canvas.addEventListener('pointercancel', e => this.pointers.delete(e.pointerId));
    canvas.addEventListener('wheel', e => { e.preventDefault(); if (this.ready) this.changed(this.renderer.zoom(Math.exp(e.deltaY * 0.0012))); }, { passive: false });
    canvas.addEventListener('keydown', e => this.keyDown(e));
    this.resize();
  }

  get ready() { return Boolean(this.renderer.camera); }
  get camera() { return this.renderer.camera; }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.renderer.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.renderer.setSize(rect.width, rect.height);
  }

  changed(camera) { this.callbacks.onCamera(camera); }
  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.callbacks.onFailure(error);
  }

  preset(name) {
    if (!this.ready) return;
    this.stopFollowing(false);
    this.changed(this.renderer.applyPreset(name));
  }
  setCamera(camera) { if (this.ready) { this.stopFollowing(false); this.changed(this.renderer.setCamera(camera)); } }
  orbit(dYaw, dPitch) { if (this.ready) this.changed(this.renderer.orbit(dYaw, dPitch)); }
  zoom(factor) { if (this.ready) this.changed(this.renderer.zoom(factor)); }
  pan(dx, dy) { if (this.ready) { this.stopFollowing(false); this.changed(this.renderer.pan(dx, dy)); } }

  selectVehicle(id) {
    this.renderer.selectedVehicle = id;
    this.callbacks.onVehicle(id);
  }

  follow(id) {
    if (!this.ready || id === null) return;
    this.following = { id, previous: this.following?.previous ?? { ...this.camera, target: { ...this.camera.target } } };
    // Move in close enough to see the vehicle and its neighbours.
    this.changed(this.renderer.setCamera({ ...this.camera, distance: Math.min(this.camera.distance, 70), pitch: Math.min(this.camera.pitch, 40 * DEG) }));
  }

  // Ends following; optionally returns to the view from before following began.
  stopFollowing(restore = true, message = '') {
    if (!this.following) return;
    const { previous } = this.following;
    this.following = null;
    if (restore) this.changed(this.renderer.setCamera(previous));
    this.callbacks.onFollowEnd(message);
  }

  draw(simulation) {
    if (!this.supported || this.failed) return;
    try {
      if (this.following) {
        const found = findVehicle(simulation, this.following.id);
        if (found) this.renderer.setCamera({ ...this.camera, target: { x: found.x, y: found.y } });
        else {
          const id = this.following.id;
          this.renderer.useNetwork(simulation.network);
          this.stopFollowing(true, `Vehicle ${id} has left the network. The camera has returned to the previous view.`);
          if (this.renderer.selectedVehicle === id) this.selectVehicle(null);
        }
      }
      this.renderer.draw(simulation);
    } catch (error) { this.fail(error); }
  }

  point(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  pointerDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.point(e);
    this.pointers.set(e.pointerId, { ...p, start: p, button: e.button, pan: e.button === 2 || e.shiftKey || e.ctrlKey });
    this.moved = this.pointers.size > 1;
  }

  pointerMove(e) {
    const pointer = this.pointers.get(e.pointerId);
    if (!pointer || !this.ready) return;
    const p = this.point(e);
    const dx = p.x - pointer.x, dy = p.y - pointer.y;
    if (Math.hypot(p.x - pointer.start.x, p.y - pointer.start.y) > 4) this.moved = true;
    if (this.pointers.size === 2) {
      // Pinch to zoom; move both fingers to pan.
      const [a, b] = [...this.pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      pointer.x = p.x; pointer.y = p.y;
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0 && after > 0) this.renderer.zoom(before / after);
      this.pan(dx / 2, dy / 2);
      return;
    }
    pointer.x = p.x; pointer.y = p.y;
    if (!this.moved) return;
    if (pointer.pan) this.pan(dx, dy);
    else this.orbit(-dx * 0.008, dy * 0.006);
  }

  pointerUp(e) {
    const pointer = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!pointer || this.moved || this.pointers.size || !this.ready) return;
    const hit = this.renderer.pick(pointer.start.x, pointer.start.y);
    if (hit?.type === 'vehicle') this.selectVehicle(hit.id);
    else if (hit?.type === 'link') { this.callbacks.select(hit.id); if (this.renderer.selectedVehicle !== null && !this.following) this.selectVehicle(null); }
  }

  keyDown(e) {
    if (!this.ready) return;
    const step = 40, turn = 7.5 * DEG;
    const actions = {
      ArrowLeft: () => e.shiftKey ? this.orbit(turn, 0) : this.pan(step, 0),
      ArrowRight: () => e.shiftKey ? this.orbit(-turn, 0) : this.pan(-step, 0),
      ArrowUp: () => e.shiftKey ? this.orbit(0, -turn) : this.pan(0, step),
      ArrowDown: () => e.shiftKey ? this.orbit(0, turn) : this.pan(0, -step),
      '+': () => this.zoom(0.8), '=': () => this.zoom(0.8), '-': () => this.zoom(1.25), _: () => this.zoom(1.25),
      Home: () => this.preset('fit'),
      Escape: () => this.following ? this.stopFollowing(true, 'Stopped following. The camera has returned to the previous view.') : this.selectVehicle(null),
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  }
}
