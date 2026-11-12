import { FLEET } from '../model/project.js';
import { ARM_VECTORS, laneOffset, pointOnPath } from '../model/network.js';
import { armSignal } from '../simulation/signals.js';

const SIGNAL_COLOURS = { green: '#7fbf5a', yellow: '#e2b33c', red: '#d8735a', partial: '#7fbf5a' };
const MIN_LANE_PX = 5;

// Schematic renderer for any compiled network. Lateral dimensions (lane widths,
// junction boxes) may be drawn wider than the longitudinal scale for legibility;
// the scale bar reports longitudinal distance. Rendering never changes physics.
export class NetworkCanvas {
  constructor(canvas, select) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.selected = null;
    this.layout = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener('click', e => {
      if (!this.layout) return;
      const rect = canvas.getBoundingClientRect();
      const id = this.hit(e.clientX - rect.left, e.clientY - rect.top);
      if (id) select(id);
    });
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.layout = null;
  }

  // Screen layout: nodes keep their world order; links are stretched between
  // node box edges (or the boundary) using the longitudinal scale.
  // Place nodes by walking links between junctions: each junction box is drawn at
  // the lateral scale and each road at the longitudinal scale.
  static place(network, scale, lateral) {
    const half = network.nodes[0].half;
    const centres = { [network.nodes[0].id]: { x: 0, y: 0 } };
    for (let changed = true; changed;) {
      changed = false;
      for (const link of network.links) {
        if (!link.from || !link.to || !centres[link.from] || centres[link.to]) continue;
        // Circulating links are compact, so they share the junction (lateral) scale.
        const step = 2 * half * lateral + link.length * (link.kind === 'ring' ? lateral : scale);
        centres[link.to] = { x: centres[link.from].x + link.dx * step, y: centres[link.from].y + link.dy * step };
        changed = true;
      }
    }
    const ends = {};
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const link of network.links) {
      const edge = (nodeId, sign) => ({ x: centres[nodeId].x + sign * link.dx * half * lateral, y: centres[nodeId].y + sign * link.dy * half * lateral });
      const start = link.from ? edge(link.from, 1) : null;
      const end = link.to ? edge(link.to, -1) : null;
      const s = start ?? { x: end.x - link.dx * link.length * scale, y: end.y - link.dy * link.length * scale };
      const e = end ?? { x: start.x + link.dx * link.length * scale, y: start.y + link.dy * link.length * scale };
      ends[link.id] = { s, e, pxPerMetre: Math.hypot(e.x - s.x, e.y - s.y) / link.length };
      for (const p of [s, e]) { box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x); box.minY = Math.min(box.minY, p.y); box.maxY = Math.max(box.maxY, p.y); }
    }
    return { centres, ends, box, width: box.maxX - box.minX, height: box.maxY - box.minY };
  }

  computeLayout(network) {
    const { width: w, height: h } = this;
    const availableW = w - 2 * 34, availableH = h - 2 * 58;
    const minLateral = MIN_LANE_PX / 3.5;
    // Extent is linear in scale for a fixed lateral scale: solve from two samples.
    const solve = lateral => {
      const a = NetworkCanvas.place(network, 1, lateral), b = NetworkCanvas.place(network, 2, lateral);
      const fit = (one, two, available) => (available - (2 * one - two)) / Math.max(1e-9, two - one);
      return Math.min(fit(a.width, b.width, availableW), fit(a.height, b.height, availableH));
    };
    let scale = Math.max(0.05, solve(minLateral));
    let lateral = minLateral;
    if (scale > minLateral) {
      // Room for true proportions: draw lanes and roads at one uniform scale.
      const unit = NetworkCanvas.place(network, 1, 1);
      scale = lateral = Math.min(availableW / unit.width, availableH / unit.height);
    }
    const placed = NetworkCanvas.place(network, scale, lateral);
    const dx = (w - placed.width) / 2 - placed.box.minX, dy = (h - placed.height) / 2 - placed.box.minY;
    const shift = p => ({ x: p.x + dx, y: p.y + dy });
    const centres = Object.fromEntries(Object.entries(placed.centres).map(([id, p]) => [id, shift(p)]));
    const ends = Object.fromEntries(Object.entries(placed.ends).map(([id, e]) => [id, { s: shift(e.s), e: shift(e.e), pxPerMetre: e.pxPerMetre }]));
    this.layout = { network, scale, lateral, centres, ends, key: `${w}x${h}` };
    return this.layout;
  }

  // Screen point at distance `s` along a link, `metres` to the left of its centre line.
  offsetPoint(link, metres, s) {
    const { ends, lateral } = this.layout;
    const { s: a, pxPerMetre } = ends[link.id];
    const offset = metres * lateral;
    return { x: a.x + link.dx * s * pxPerMetre + link.dy * offset, y: a.y + link.dy * s * pxPerMetre - link.dx * offset };
  }

  linkPoint(link, lane, s) { return this.offsetPoint(link, laneOffset(link, lane), s); }

  line(link, metres, from, to, colour, width, dash = []) {
    const p = this.offsetPoint(link, metres, from), q = this.offsetPoint(link, metres, to);
    const c = this.ctx;
    c.strokeStyle = colour; c.lineWidth = width; c.setLineDash(dash);
    c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke();
    c.setLineDash([]);
  }

  worldToScreen(nodeId, x, y) {
    const node = this.layout.network.nodeById[nodeId];
    const c = this.layout.centres[nodeId];
    return { x: c.x + (x - node.x) * this.layout.lateral, y: c.y + (y - node.y) * this.layout.lateral };
  }

  hit(x, y) {
    let best = null, bestDistance = Infinity;
    for (const link of this.layout.network.links.filter(l => l.to)) {
      const mid = this.linkPoint(link, Math.floor(link.lanes / 2), link.length * 0.6);
      const d = Math.hypot(mid.x - x, mid.y - y);
      if (d < bestDistance) { best = link.id; bestDistance = d; }
    }
    return bestDistance < 120 ? best : null;
  }

  draw(simulation) {
    const { ctx: c, width: w, height: h } = this;
    if (!w || !h) return;
    const network = simulation.network;
    const layout = this.layout?.network === network && this.layout.key === `${w}x${h}` ? this.layout : this.computeLayout(network);
    const { lateral, centres } = layout;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#f0f3e9'; c.fillRect(0, 0, w, h);
    // A schematic planning surface, intentionally not presented as geographic data.
    c.strokeStyle = '#e5eadc'; c.lineWidth = 0.5;
    for (let x = 0; x < w; x += 28) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y < h; y += 28) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }

    // Carriageways: each directed link paints its lanes to the left of the centre line.
    const band = (link, from, to, start, end) => {
      const corners = [this.offsetPoint(link, from, start), this.offsetPoint(link, from, end), this.offsetPoint(link, to, end), this.offsetPoint(link, to, start)];
      c.beginPath(); corners.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.fill();
    };
    for (const link of network.links) {
      const width = link.lanes * 3.5;
      c.fillStyle = '#5e6965';
      if (link.pocket) {
        // The pocket (median-most lane) exists only over its final stretch.
        band(link, 3.5, width, 0, link.length);
        band(link, 0, 3.5, link.pocket.start, link.length);
        this.line(link, 3.5, link.pocket.start, link.length, '#d2d8cb', .7, [3, 3]);
        for (let k = 2; k < link.lanes; k++) this.line(link, k * 3.5, 0, link.length, '#d2d8cb', .7, [6, 6]);
      } else {
        band(link, 0, width, 0, link.length);
        for (let k = 1; k < link.lanes; k++) this.line(link, k * 3.5, 0, link.length, '#d2d8cb', .7, [6, 6]);
      }
      if (link.kind === 'exit' || link.kind === 'internal') this.line(link, 0, 0, link.length, '#c6ccab', 1.4);
    }
    for (const node of network.nodes) {
      const centre = centres[node.id];
      const size = node.half * lateral;
      c.fillStyle = '#64706a'; c.fillRect(centre.x - size, centre.y - size, size * 2, size * 2);
      c.fillStyle = '#839270'; c.font = '600 9px system-ui'; c.textAlign = 'left';
      if (network.nodes.length > 1 && node.control === 'signal') c.fillText(node.label.toUpperCase(), centre.x + size + 6, centre.y - size - 6);
    }
    if (network.island) {
      // Central island: drawn between the circulating links, not to scale.
      const ids = network.nodes.map(n => centres[n.id]);
      const cx = ids.reduce((s, p) => s + p.x, 0) / ids.length, cy = ids.reduce((s, p) => s + p.y, 0) / ids.length;
      const radius = Math.hypot(ids[0].x - cx, ids[0].y - cy) - network.nodes[0].half * lateral - 2;
      c.fillStyle = '#dbe4cf'; c.strokeStyle = '#c8d4b9'; c.lineWidth = 1;
      c.beginPath(); c.arc(cx, cy, Math.max(4, radius), 0, Math.PI * 2); c.fill(); c.stroke();
    }
    for (const link of network.links.filter(l => l.to)) {
      const node = network.nodeById[link.to];
      const width = link.lanes * 3.5;
      const stopA = this.offsetPoint(link, 0.3, link.length), stopB = this.offsetPoint(link, width - 0.3, link.length);
      if (node.control === 'priority') {
        // Give-way line (dashed) for entries; circulating traffic has priority.
        if (link.kind === 'entry') {
          c.strokeStyle = '#eef0df'; c.lineWidth = 1.6; c.setLineDash([2, 2]);
          c.beginPath(); c.moveTo(stopA.x, stopA.y); c.lineTo(stopB.x, stopB.y); c.stroke(); c.setLineDash([]);
        }
      } else {
        c.strokeStyle = '#eef0df'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(stopA.x, stopA.y); c.lineTo(stopB.x, stopB.y); c.stroke();
        const colour = armSignal(node.plan, simulation.time, node.offset, link.toArm, simulation.links[link.id].movementTypes);
        const lamp = this.offsetPoint(link, width + 1.6, link.length - 2);
        c.fillStyle = SIGNAL_COLOURS[colour];
        c.beginPath(); c.arc(lamp.x, lamp.y, 3.2, 0, Math.PI * 2); c.fill();
        // Some movements green, others red (e.g. a right-turn-only phase): red ring.
        if (colour === 'partial') { c.strokeStyle = SIGNAL_COLOURS.red; c.lineWidth = 1.6; c.beginPath(); c.arc(lamp.x, lamp.y, 4.4, 0, Math.PI * 2); c.stroke(); }
      }
      const state = simulation.links[link.id];
      if (state.queue > 5) this.line(link, width + 0.9, link.length, link.length - state.queue, '#d2a052', 2);
      if (this.selected === link.id) this.line(link, width + 1.9, 0, link.length, '#8da878', 2);
      if (link.kind === 'entry') {
        const [vx, vy] = ARM_VECTORS[link.toArm];
        const label = this.offsetPoint(link, 0, 0);
        c.fillStyle = '#839270'; c.font = '600 9px system-ui'; c.textAlign = 'center';
        c.fillText(link.label.replace(' approach', '').toUpperCase(), label.x + vx * 16, label.y + vy * 16 + 3);
      }
    }
    const drawVehicle = (v, x, y, angle) => {
      const length = Math.max(3.5, v.length * layout.scale * 1.2);
      const breadth = v.type === 'twoWheeler' ? 2.2 : Math.max(3, 3.5 * lateral * .62);
      c.save(); c.translate(x, y); c.rotate(angle);
      c.fillStyle = FLEET[v.type].colour;
      c.fillRect(-length, -breadth / 2, length, breadth);
      if (v.speed < 2) { c.fillStyle = '#f6af8a'; c.fillRect(-1, -breadth / 2, 1, breadth); }
      c.restore();
    };
    for (const link of network.links) {
      const state = simulation.links[link.id];
      const angle = Math.atan2(link.dy, link.dx);
      state.lanes.forEach((lane, laneIndex) => {
        for (const v of lane) {
          const p = this.linkPoint(link, laneIndex, Math.min(link.length, v.position));
          drawVehicle(v, p.x, p.y, angle);
        }
      });
    }
    for (const v of simulation.crossing) {
      const point = pointOnPath(v.path, v.progress);
      const p = this.worldToScreen(v.path.node, point.x, point.y);
      drawVehicle(v, p.x, p.y, point.angle);
    }
    c.strokeStyle = '#7c8c6d'; c.lineWidth = 1;
    const metres = 50;
    const bar = metres * layout.scale;
    c.beginPath(); c.moveTo(20, h - 44); c.lineTo(20 + bar, h - 44); c.stroke();
    c.fillStyle = '#869578'; c.font = '8px system-ui'; c.textAlign = 'left';
    c.fillText(`${metres} m along roads`, 20, h - 49);
  }
}
