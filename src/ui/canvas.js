import { FLEET } from '../model/project.js';
import { ARM_VECTORS, armGroup, laneOffset, pointOnPath } from '../model/network.js';
import { groupColour } from '../simulation/signals.js';

const SIGNAL_COLOURS = { green: '#7fbf5a', yellow: '#e2b33c', red: '#d8735a' };
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
  computeLayout(network) {
    const { width: w, height: h } = this;
    const nodes = network.nodes;
    const half = nodes[0].half;
    const arm = network.links.find(l => l.kind === 'entry').length;
    const span = nodes.at(-1).x - nodes[0].x - 2 * half;
    const margin = 34, marginY = 58;
    const fit = (lateral) => Math.min(
      (w - 2 * margin - 2 * half * lateral * nodes.length) / (2 * arm + Math.max(0, span)),
      (h - 2 * marginY - 2 * half * lateral) / (2 * arm));
    let scale = fit(MIN_LANE_PX / 3.5);
    const lateral = Math.max(scale, MIN_LANE_PX / 3.5);
    scale = Math.max(0.05, fit(lateral));
    const totalWidth = 2 * arm * scale + Math.max(0, span) * scale + 2 * half * lateral * nodes.length;
    const left = (w - totalWidth) / 2 + arm * scale + half * lateral;
    const centres = {};
    nodes.forEach((n, i) => {
      centres[n.id] = { x: left + (i ? (n.x - nodes[0].x - 2 * half) * scale + 2 * half * lateral : 0), y: h / 2 };
    });
    const ends = {};
    for (const link of network.links) {
      const edge = (nodeId, sign) => {
        const c = centres[nodeId];
        return { x: c.x + sign * link.dx * half * lateral, y: c.y + sign * link.dy * half * lateral };
      };
      const start = link.from ? edge(link.from, 1) : null;
      const end = link.to ? edge(link.to, -1) : null;
      const s = start ?? { x: end.x - link.dx * link.length * scale, y: end.y - link.dy * link.length * scale };
      const e = end ?? { x: start.x + link.dx * link.length * scale, y: start.y + link.dy * link.length * scale };
      ends[link.id] = { s, e, pxPerMetre: Math.hypot(e.x - s.x, e.y - s.y) / link.length };
    }
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
    for (const link of network.links) {
      const width = link.lanes * 3.5;
      const corners = [this.offsetPoint(link, 0, 0), this.offsetPoint(link, 0, link.length), this.offsetPoint(link, width, link.length), this.offsetPoint(link, width, 0)];
      c.fillStyle = '#5e6965';
      c.beginPath(); corners.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.fill();
      for (let k = 1; k < link.lanes; k++) this.line(link, k * 3.5, 0, link.length, '#d2d8cb', .7, [6, 6]);
      if (link.kind !== 'entry') this.line(link, 0, 0, link.length, '#c6ccab', 1.4);
    }
    for (const node of network.nodes) {
      const centre = centres[node.id];
      const size = node.half * lateral;
      c.fillStyle = '#64706a'; c.fillRect(centre.x - size, centre.y - size, size * 2, size * 2);
      c.fillStyle = '#839270'; c.font = '600 9px system-ui'; c.textAlign = 'left';
      if (network.nodes.length > 1) c.fillText(node.label.toUpperCase(), centre.x + size + 6, centre.y - size - 6);
    }
    for (const link of network.links.filter(l => l.to)) {
      const node = network.nodeById[link.to];
      const width = link.lanes * 3.5;
      const stopA = this.offsetPoint(link, 0.3, link.length), stopB = this.offsetPoint(link, width - 0.3, link.length);
      c.strokeStyle = '#eef0df'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(stopA.x, stopA.y); c.lineTo(stopB.x, stopB.y); c.stroke();
      const colour = groupColour(simulation.scenario.signals, simulation.time, armGroup(link.toArm), node.offset);
      const lamp = this.offsetPoint(link, width + 1.6, link.length - 2);
      c.fillStyle = SIGNAL_COLOURS[colour];
      c.beginPath(); c.arc(lamp.x, lamp.y, 3.2, 0, Math.PI * 2); c.fill();
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
