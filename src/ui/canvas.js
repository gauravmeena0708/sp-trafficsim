import { DIRECTIONS, FLEET } from '../model/project.js';
import { isGreen } from '../simulation/signals.js';

const vectors = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const labels = { north: 'NORTH', east: 'EAST', south: 'SOUTH', west: 'WEST' };

export class NetworkCanvas {
  constructor(canvas, select) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.selected = 'west';
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener('click', e => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      const direction = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'east' : 'west') : (y > 0 ? 'south' : 'north');
      select(direction);
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
  }

  draw(simulation) {
    const { ctx: c, width: w, height: h } = this;
    if (!w || !h) return;
    const { geometry } = simulation.scenario;
    const scale = Math.min(w / 2 - 45, h / 2 - 53) / (geometry.length + simulation.crossingLength / 2);
    const laneWidth = Math.max(5, 3.5 * scale);
    const half = geometry.lanes * laneWidth + 4;
    const arm = Math.min(w / 2 - 30, h / 2 - 36);
    const roadLength = arm - half;
    const roadScale = roadLength / geometry.length;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#f0f3e9'; c.fillRect(0, 0, w, h);
    // A schematic planning surface, intentionally not presented as geographic data.
    c.strokeStyle = '#e5eadc'; c.lineWidth = 0.5;
    for (let x = 0; x < w; x += 28) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y < h; y += 28) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.save(); c.translate(w / 2, h / 2);
    const blocks = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [sx, sy] of blocks) {
      const bx = sx < 0 ? -arm + 15 : half + 22;
      const by = sy < 0 ? -arm + 35 : half + 22;
      const bw = Math.max(10, arm - half - 40), bh = Math.max(10, arm - half - 60);
      c.fillStyle = '#e6ecdc'; c.fillRect(bx, by, bw, bh);
      c.strokeStyle = '#dce4d2'; c.strokeRect(bx, by, bw, bh);
      c.fillStyle = '#dbe4d0'; c.fillRect(bx + 8, by + 8, bw * .5, Math.min(24, bh * .3));
      c.fillRect(bx + 8, by + Math.min(40, bh * .5), bw * .7, Math.min(22, bh * .2));
      for (let i = 0; i < 3; i++) {
        c.beginPath(); c.arc(bx + bw - 9, by + 12 + i * 15, 4, 0, Math.PI * 2); c.fillStyle = '#cfdbbd'; c.fill();
      }
    }
    // Pavement and the intersection conflict area.
    c.fillStyle = '#5e6965';
    c.fillRect(-arm, -half, 2 * arm, half * 2);
    c.fillRect(-half, -arm, half * 2, 2 * arm);
    c.fillStyle = '#64706a'; c.fillRect(-half, -half, half * 2, half * 2);
    for (const direction of DIRECTIONS) {
      const [dx, dy] = vectors[direction];
      c.save();
      // Local x runs outward, local y is the incoming left-hand carriageway.
      c.rotate(Math.atan2(dy, dx));
      c.fillStyle = '#c6ccab'; c.fillRect(half + 5, -1.4, roadLength - 5, 2.8);
      c.strokeStyle = '#d2d8cb'; c.lineWidth = .7;
      for (const sign of [-1, 1]) {
        c.beginPath(); c.moveTo(half, sign * (half - 2)); c.lineTo(arm, sign * (half - 2)); c.stroke();
        c.setLineDash([6, 6]);
        for (let lane = 1; lane < geometry.lanes; lane++) {
          const lateral = sign * (3 + lane * laneWidth);
          c.beginPath(); c.moveTo(half + 7, lateral); c.lineTo(arm, lateral); c.stroke();
        }
        c.setLineDash([]);
      }
      // Incoming traffic is on positive local y; rotate preserves left-hand flow.
      c.strokeStyle = '#eef0df'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(half + 3, 4); c.lineTo(half + 3, half - 3); c.stroke();
      if (this.selected === direction) {
        c.fillStyle = '#d9e6ba20'; c.fillRect(half + 6, 3, roadLength - 6, half - 6);
        c.strokeStyle = '#8da878'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(half + 6, half + 5); c.lineTo(arm, half + 5); c.stroke();
      }
      const q = simulation.approaches[direction].queue;
      if (q > 5) {
        c.strokeStyle = '#d2a052'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(half + 5, half + 9); c.lineTo(Math.min(arm, half + q * roadScale), half + 9); c.stroke();
      }
      c.fillStyle = isGreen(simulation.scenario.signals, simulation.time, direction) ? '#b6db93' : '#db9c83';
      c.beginPath(); c.arc(half + 5, -half - 7, 3, 0, Math.PI * 2); c.fill();
      c.restore();
      c.fillStyle = '#839270'; c.font = '600 9px system-ui'; c.textAlign = 'center';
      c.fillText(labels[direction], dx * (arm + 15), dy * (arm + 15) + 3);
    }
    const vehicle = (v, direction, distance, incoming = true) => {
      const [dx, dy] = vectors[direction];
      const lateral = 3 + laneWidth * (v.lane + .5);
      c.save(); c.rotate(Math.atan2(dy, dx));
      const length = Math.max(3.5, v.length * roadScale);
      const breadth = v.type === 'twoWheeler' ? 2.2 : Math.max(3, laneWidth * .7);
      c.fillStyle = FLEET[v.type].colour;
      const x = incoming ? distance : distance - length;
      c.fillRect(x, incoming ? lateral - breadth / 2 : -lateral - breadth / 2, length, breadth);
      if (v.speed < 2 && incoming) { c.fillStyle = '#f6af8a'; c.fillRect(x + length - 1, lateral - breadth / 2, 1, breadth); }
      c.restore();
    };
    for (const direction of DIRECTIONS) {
      for (const lane of simulation.approaches[direction].lanes) for (const v of lane) vehicle(v, direction, half + (geometry.length - v.position) * roadScale);
    }
    for (const v of simulation.exiting) vehicle(v, v.exit, half + v.position * roadScale, false);
    for (const v of simulation.crossing) {
      const distance = half - (v.crossProgress / simulation.crossingLength) * 2 * half;
      vehicle(v, v.direction, distance);
    }
    c.restore();
    c.strokeStyle = '#7c8c6d'; c.lineWidth = 1;
    const bar = Math.min(60, 50 * roadScale);
    c.beginPath(); c.moveTo(20, h - 44); c.lineTo(20 + bar, h - 44); c.stroke();
    c.fillStyle = '#869578'; c.font = '8px system-ui'; c.textAlign = 'left';
    c.fillText(`${Math.round(bar / roadScale)} m`, 20, h - 49);
  }
}
