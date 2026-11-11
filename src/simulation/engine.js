import { DIRECTIONS, ENGINE_VERSION, FLEET, fingerprint, validateScenario } from '../model/project.js';
import { armGroup, chooseRoute, compileNetwork, junctionPath, laneForMovement, pathsConflict } from '../model/network.js';
import { randomGenerator } from './random.js';
import { groupGreen, signalState } from './signals.js';

export const STEP = 0.2;
export const GAP = 2.5;
const CRITICAL_GAP_SECONDS = 4;
const GAP_ACCEPTANCE_RANGE = 60;
const CROSSING_SPEED = { straight: 8, left: 5, right: 6 };
export const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

export const QUEUE_SPEED = 2;
export const QUEUE_SPACING = 10;
// Queue: a chain of vehicles below QUEUE_SPEED starting at the stop line, where
// each follower's front is within QUEUE_SPACING of its leader's rear. Returns the
// longest such chain over all lanes, measured back from the stop line.
export function queueExtent(link) {
  let extent = 0;
  for (const lane of link.lanes) {
    let edge = link.length;
    let rear = null;
    for (const v of lane) {
      if (v.speed >= QUEUE_SPEED || edge - v.position > QUEUE_SPACING) break;
      rear = v.position - v.length;
      edge = rear;
    }
    if (rear !== null) extent = Math.max(extent, link.length - Math.max(0, rear));
  }
  return extent;
}

// Illustrative lane-based network model, deliberately isolated from the UI.
// Vehicles follow declared routes over directed links. Junction entry requires a
// green signal, no conflicting path in use, permissive gap acceptance for right
// turns, and committed space on the receiving lane (no blocking the box).
// No mid-link lane changes, sublane filtering, bus dwell or pedestrian model.
export class Simulation {
  constructor(scenario) {
    const errors = validateScenario(scenario);
    if (errors.length) throw new Error(errors.join(' '));
    this.scenario = structuredClone(scenario);
    this.network = compileNetwork(this.scenario);
    this.time = 0;
    this.ticks = 0;
    this.nextId = 0;
    this.requested = 0;
    this.admitted = 0;
    this.completed = 0;
    this.delay = 0;
    this.personDelay = 0;
    this.measuredRequested = 0;
    this.measuredPeople = 0;
    this.journeys = [];
    this.crossing = [];
    this.exitCounts = {};
    this.links = Object.fromEntries(this.network.links.map((link, index) => [link.id, {
      ...link, index,
      lanes: Array.from({ length: link.lanes }, () => []),
      nextRelease: Array(link.lanes).fill(0),
      held: Array(link.lanes).fill(false),
      waiting: [], queue: 0, maxQueue: 0, queueSum: 0, samples: 0,
      blockedSeconds: 0, spillbackSeconds: 0, downstreamBlockedSeconds: 0,
    }]));
    // Downstream links first so space released this step can be used upstream.
    this.order = Object.values(this.links).sort((a, b) => (a.to ? 1 : 0) - (b.to ? 1 : 0) || a.index - b.index);
    this.entries = Object.values(this.links).filter(l => l.kind === 'entry').map(link => {
      // Stream seeds depend on the arm and junction only, so arrivals and fleet
      // identities are paired across timing, turning and geometry alternatives.
      const n = DIRECTIONS.indexOf(link.demandKey) + 4 * this.network.nodes.findIndex(node => node.id === link.to);
      const arrival = randomGenerator(this.scenario.run.seed + n * 100003);
      link.random = randomGenerator(this.scenario.run.seed + n * 200003 + 101);
      link.routeRandom = randomGenerator(this.scenario.run.seed + n * 300007 + 211);
      link.arrival = arrival;
      link.nextArrival = this.interarrival(link);
      return link;
    });
  }

  // Backwards-compatible view of entry approaches keyed by link id.
  get approaches() { return Object.fromEntries(Object.values(this.links).filter(l => l.to).map(l => [l.id, l])); }

  interarrival(link) {
    const rate = this.scenario.demand[link.demandKey] * this.scenario.demand.multiplier / 3600;
    return rate ? -Math.log(Math.max(1e-12, 1 - link.arrival())) / rate : Infinity;
  }

  makeVehicle(linkId, departure) {
    const link = this.links[linkId];
    const random = link.random;
    const draw = random() * 100;
    let sum = 0;
    const type = Object.keys(FLEET).find(k => { sum += this.scenario.fleet[k]; return draw < sum; }) ?? 'car';
    const spec = FLEET[type];
    const desired = this.scenario.geometry.speed / 3.6 * spec.speedFactor * (0.9 + random() * 0.2);
    // A fixed number of route draws keeps later vehicles' streams aligned.
    const draws = [link.routeRandom(), link.routeRandom()];
    const { route, moves } = chooseRoute(this.network, linkId, this.scenario.turning, draws);
    const measured = departure >= this.scenario.run.warmup;
    if (measured) { this.measuredRequested++; this.measuredPeople += spec.occupancy; }
    return { id: ++this.nextId, entry: linkId, direction: link.demandKey, type, length: spec.length, desired, speed: 0,
      position: spec.length, departure, measured, lane: 0, occupancy: spec.occupancy, route, moves, leg: 0 };
  }

  accrueDelay(vehicle, elapsed = STEP) {
    if (!vehicle.measured) return;
    const delay = Math.max(0, elapsed * (1 - vehicle.speed / vehicle.desired));
    this.delay += delay;
    this.personDelay += delay * vehicle.occupancy;
  }

  // Lane on `link` for a vehicle that will make movement `moves[leg]` at its end.
  laneOn(link, vehicle, leg, fallback) {
    const definition = this.network.byId[link.id];
    const lane = laneForMovement(definition, vehicle.moves[leg]);
    return lane ?? Math.min(definition.lanes - 1, Math.max(0, fallback));
  }

  nodeGreen(link, time) {
    const node = this.network.nodeById[link.to];
    return groupGreen(this.scenario.signals, time, armGroup(link.toArm), node.offset);
  }

  // Free length at the start of a lane after vehicles already committed to it.
  receivingRoom(link, laneIndex) {
    const lane = this.links[link.id].lanes[laneIndex];
    const tail = lane.length ? lane.at(-1).position - lane.at(-1).length - GAP : link.length;
    const committed = this.crossing.filter(v => v.path.to === link.id && v.path.toLane === laneIndex).reduce((n, v) => n + v.length + GAP, 0);
    return tail - committed;
  }

  plannedPath(vehicle, link, laneIndex) {
    const next = this.links[vehicle.route[vehicle.leg + 1]];
    const toLane = this.laneOn(next, vehicle, vehicle.leg + 1, laneIndex);
    return junctionPath(this.network, link.id, laneIndex, next.id, toLane);
  }

  // Returns null when the head vehicle may enter the junction, otherwise a reason.
  entryRefusal(vehicle, link, laneIndex, now) {
    if (!this.nodeGreen(link, now)) return 'signal';
    if (now < link.nextRelease[laneIndex]) return 'headway';
    const path = this.plannedPath(vehicle, link, laneIndex);
    for (const other of this.crossing) {
      if (other.path.key === path.key) { if (other.progress - other.length - GAP < 0) return 'headway'; }
      else if (pathsConflict(this.network, path, other.path)) return 'conflict';
    }
    if (this.receivingRoom(this.links[path.to], path.toLane) < vehicle.length) {
      // Distinguish a queued receiving lane (storage exhausted) from spacing
      // behind a vehicle that is still moving away.
      const tail = this.links[path.to].lanes[path.toLane].at(-1);
      return tail && tail.speed < QUEUE_SPEED ? 'downstream' : 'spacing';
    }
    if (path.movement === 'right' && this.opposingWithinGap(path, link, now)) return 'yield';
    return null;
  }

  // Permissive right turns yield to approaching straight/left traffic that has
  // green and a conflicting path, within a critical gap. Vehicles held by a
  // blocked exit do not hold the turning vehicle indefinitely.
  opposingWithinGap(path, link, now) {
    const node = this.network.nodeById[link.to];
    for (const arm of node.arms) {
      const otherId = node.inbound[arm];
      if (!otherId || otherId === link.id) continue;
      const other = this.links[otherId];
      if (!this.nodeGreen(other, now)) continue;
      for (let laneIndex = 0; laneIndex < other.lanes.length; laneIndex++) {
        for (const v of other.lanes[laneIndex]) {
          const distance = other.length - v.position;
          if (distance > GAP_ACCEPTANCE_RANGE) break;
          if (v.moves[v.leg] === 'right' || (v === other.lanes[laneIndex][0] && other.held[laneIndex])) continue;
          if (distance / Math.max(v.speed, 0.1) > CRITICAL_GAP_SECONDS) continue;
          if (pathsConflict(this.network, path, this.plannedPath(v, other, laneIndex))) return true;
        }
      }
    }
    return false;
  }

  advanceCrossing() {
    // Follow the leader on the same path; distinct paths never overlap by construction.
    const byPath = new Map();
    for (const v of this.crossing) {
      const list = byPath.get(v.path.key) ?? [];
      list.push(v);
      byPath.set(v.path.key, list);
    }
    const finished = [];
    for (const list of byPath.values()) {
      list.sort((a, b) => b.progress - a.progress);
      let leader;
      for (const v of list) {
        const limit = leader ? leader.progress - leader.length - GAP : Infinity;
        v.speed = Math.max(0, Math.min(v.crossSpeed, (limit - v.progress) / STEP));
        v.progress += v.speed * STEP;
        this.accrueDelay(v);
        if (v.progress >= v.path.length + v.length) finished.push(v);
        leader = v;
      }
    }
    for (const v of finished.sort((a, b) => b.progress - a.progress || a.id - b.id)) {
      this.crossing.splice(this.crossing.indexOf(v), 1);
      const link = this.links[v.path.to];
      const lane = link.lanes[v.path.toLane];
      const tail = lane.length ? lane.at(-1).position - lane.at(-1).length - GAP : Infinity;
      v.leg += 1;
      v.lane = v.path.toLane;
      v.position = Math.max(v.length, Math.min(v.progress - v.path.length, tail));
      delete v.path; delete v.progress; delete v.crossSpeed;
      lane.push(v);
    }
  }

  moveLink(link, now) {
    const { run } = this.scenario;
    let downstreamBlocked = false;
    for (let laneIndex = 0; laneIndex < link.lanes.length; laneIndex++) {
      const lane = link.lanes[laneIndex];
      const head = lane[0];
      const refusal = head && link.to ? this.entryRefusal(head, link, laneIndex, now) : null;
      link.held[laneIndex] = refusal === 'downstream';
      if (refusal === 'downstream' && head.position >= link.length - 15) downstreamBlocked = true;
      const retained = [];
      for (let i = 0; i < lane.length; i++) {
        const v = lane[i];
        const leader = retained.at(-1);
        const exitLink = !link.to;
        const limit = leader ? leader.position - leader.length - GAP : exitLink ? Infinity : link.length;
        const gap = Math.max(0, limit - v.position);
        // Only the original lane head may be released this step; a follower must
        // reach the stop line and pass its own entry checks on a later step.
        const isHead = i === 0;
        const free = isHead && !leader && (exitLink || !refusal);
        const target = free ? v.desired : Math.min(v.desired, Math.sqrt(2 * 3 * gap), gap / 1.1);
        v.speed = Math.max(0, Math.min(target, v.speed + FLEET[v.type].acceleration * STEP, gap / STEP));
        v.position = Math.min(limit, v.position + v.speed * STEP);
        this.accrueDelay(v);
        if (exitLink && v.position >= link.length + v.length) {
          this.completed++;
          this.exitCounts[link.id] = (this.exitCounts[link.id] ?? 0) + 1;
          if (v.measured) this.journeys.push({ time: now + STEP - v.departure, entry: v.entry, exit: link.id });
          continue;
        }
        if (isHead && !refusal && link.to && v.position >= link.length - 0.15) {
          v.path = this.plannedPath(v, link, laneIndex);
          v.crossSpeed = Math.min(v.desired, CROSSING_SPEED[v.path.movement]);
          v.speed = v.crossSpeed;
          v.progress = 0;
          this.crossing.push(v);
          link.nextRelease[laneIndex] = now + Math.max(1.5, (v.length + GAP) / v.speed + 0.9);
          continue;
        }
        retained.push(v);
      }
      link.lanes[laneIndex] = retained;
    }
    if (!link.to) return;
    link.queue = queueExtent(link);
    if (now >= run.warmup) {
      link.maxQueue = Math.max(link.maxQueue, link.queue);
      link.queueSum += link.queue;
      link.samples++;
      if (link.kind === 'entry' && link.waiting.length) link.blockedSeconds += STEP;
      if (link.kind === 'internal' && link.queue >= link.length - 15) link.spillbackSeconds += STEP;
      if (downstreamBlocked) link.downstreamBlockedSeconds += STEP;
    }
  }

  admit(link, now) {
    while (link.nextArrival <= now + 1e-9) {
      link.waiting.push(this.makeVehicle(link.id, link.nextArrival));
      this.requested++;
      link.nextArrival += this.interarrival(link);
    }
    while (link.waiting.length) {
      const vehicle = link.waiting[0];
      const room = index => link.lanes[index].length ? link.lanes[index].at(-1).position - link.lanes[index].at(-1).length - GAP : Infinity;
      let laneIndex = laneForMovement(this.network.byId[link.id], vehicle.moves[0]);
      if (laneIndex === undefined) {
        laneIndex = 0;
        for (let i = 1; i < link.lanes.length; i++) if (room(i) > room(laneIndex)) laneIndex = i;
      }
      if (room(laneIndex) < vehicle.length) break;
      vehicle.lane = laneIndex;
      vehicle.position = vehicle.length;
      vehicle.speed = 0;
      link.lanes[laneIndex].push(vehicle);
      link.waiting.shift();
      this.admitted++;
    }
    for (const vehicle of link.waiting) this.accrueDelay(vehicle);
  }

  step() {
    if (this.done) return;
    const now = this.time;
    this.advanceCrossing();
    for (const link of this.entries) this.admit(link, now);
    for (const link of this.order) this.moveLink(link, now);
    this.ticks++;
    this.time = Math.min(this.scenario.run.duration, this.ticks * STEP);
  }

  get done() { return this.time >= this.scenario.run.duration; }

  runToEnd() { while (!this.done) this.step(); return this.result(); }

  phases() {
    return Object.fromEntries(this.network.nodes.map(n => [n.id, signalState(this.scenario.signals, this.time, n.offset)]));
  }

  snapshot() {
    return { time: this.time, phases: this.phases(), links: this.links, crossing: this.crossing, requested: this.requested, completed: this.completed };
  }

  vehiclesOnLinks() {
    return Object.values(this.links).reduce((n, l) => n + l.lanes.reduce((m, lane) => m + lane.length, 0), 0);
  }

  result() {
    const inbound = Object.values(this.links).filter(l => l.to);
    const queues = Object.fromEntries(inbound.map(l => [l.id, { label: l.label, kind: l.kind, mean: l.samples ? l.queueSum / l.samples : 0, max: l.maxQueue,
      entryBlockedSeconds: l.blockedSeconds, spillbackSeconds: l.spillbackSeconds, downstreamBlockedSeconds: l.downstreamBlockedSeconds }]));
    const waiting = this.entries.reduce((n, l) => n + l.waiting.length, 0);
    const times = this.journeys.map(j => j.time);
    return {
      engineVersion: ENGINE_VERSION, scenarioId: this.scenario.id, name: this.scenario.name,
      fingerprint: fingerprint(this.scenario), inputs: structuredClone(this.scenario), seed: this.scenario.run.seed,
      simulatedSeconds: this.time, status: 'Illustrative',
      requested: this.requested, admitted: this.admitted, completed: this.completed,
      waiting, inNetwork: this.vehiclesOnLinks() + this.crossing.length,
      measuredRequested: this.measuredRequested, measuredCompleted: times.length,
      meanJourney: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
      p95Journey: percentile(times, 0.95),
      accruedDelayPerRequest: this.measuredRequested ? this.delay / this.measuredRequested : null,
      accruedDelayPerPerson: this.measuredPeople ? this.personDelay / this.measuredPeople : null,
      maxQueue: Math.max(0, ...Object.values(queues).map(q => q.max)), queues,
      exitCounts: { ...this.exitCounts },
      spillbackSeconds: Object.values(queues).reduce((n, q) => n + q.spillbackSeconds, 0),
    };
  }
}
