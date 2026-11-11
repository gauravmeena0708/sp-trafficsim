import { DIRECTIONS, ENGINE_VERSION, FLEET, fingerprint, validateScenario } from '../model/project.js';
import { randomGenerator } from './random.js';
import { isGreen, signalState } from './signals.js';

export const STEP = 0.2;
const GAP = 2.5;
const opposite = { north: 'south', east: 'west', south: 'north', west: 'east' };
const axis = d => ['east', 'west'].includes(d) ? 'eastWest' : 'northSouth';
export const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

// Illustrative straight-through lane model, deliberately isolated from the UI.
// No turn movements, lane changes, sublane filtering, bus dwell or pedestrian model.
export class Simulation {
  constructor(scenario) {
    const errors = validateScenario(scenario);
    if (errors.length) throw new Error(errors.join(' '));
    this.scenario = structuredClone(scenario);
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
    this.crossingLength = 2 * scenario.geometry.lanes * 3.5 + 6;
    this.crossing = [];
    this.exiting = [];
    this.approaches = Object.fromEntries(DIRECTIONS.map((direction, i) => {
      const arrival = randomGenerator(scenario.run.seed + i * 100003);
      return [direction, {
        random: randomGenerator(scenario.run.seed + i * 200003 + 101), arrival,
        nextArrival: this.interarrival(direction, arrival), waiting: [],
        lanes: Array.from({ length: scenario.geometry.lanes }, () => []),
        nextRelease: Array(scenario.geometry.lanes).fill(0),
        queue: 0, maxQueue: 0, queueSum: 0, samples: 0, blockedSeconds: 0,
      }];
    }));
  }

  interarrival(direction, random) {
    const rate = this.scenario.demand[direction] * this.scenario.demand.multiplier / 3600;
    return rate ? -Math.log(Math.max(1e-12, 1 - random())) / rate : Infinity;
  }

  makeVehicle(direction, departure, random) {
    const draw = random() * 100;
    let sum = 0;
    const type = Object.keys(FLEET).find(k => { sum += this.scenario.fleet[k]; return draw < sum; }) ?? 'car';
    const spec = FLEET[type];
    const desired = this.scenario.geometry.speed / 3.6 * spec.speedFactor * (0.9 + random() * 0.2);
    const measured = departure >= this.scenario.run.warmup;
    if (measured) { this.measuredRequested++; this.measuredPeople += spec.occupancy; }
    return { id: ++this.nextId, direction, type, length: spec.length, desired, speed: 0, position: spec.length,
      departure, measured, lane: 0, occupancy: spec.occupancy };
  }

  accrueDelay(vehicle, elapsed = STEP) {
    if (!vehicle.measured) return;
    const delay = Math.max(0, elapsed * (1 - vehicle.speed / vehicle.desired));
    this.delay += delay;
    this.personDelay += delay * vehicle.occupancy;
  }

  step() {
    if (this.done) return;
    const { geometry, signals, run } = this.scenario;
    const now = this.time;
    // Finish crossings before accepting new movements. Different signal groups
    // cannot enter while a previous group still occupies the conflict area.
    const newlyExiting = [];
    this.crossing = this.crossing.filter(v => {
      v.crossProgress += STEP * v.speed;
      this.accrueDelay(v);
      if (v.crossProgress < this.crossingLength + v.length) return true;
      v.position = Math.min(geometry.length, v.crossProgress - this.crossingLength);
      v.exit = opposite[v.direction];
      newlyExiting.push(v);
      return false;
    });
    const retainedExits = [];
    for (const direction of DIRECTIONS) for (let lane = 0; lane < geometry.lanes; lane++) {
      const vehicles = this.exiting.filter(v => v.exit === direction && v.lane === lane).sort((a, b) => b.position - a.position);
      let leader;
      for (const v of vehicles) {
        const gap = leader ? Math.max(0, leader.position - leader.length - GAP - v.position) : Infinity;
        v.speed = Math.min(v.desired, v.speed + FLEET[v.type].acceleration * STEP, gap / STEP, gap / 1.1);
        v.position += v.speed * STEP;
        this.accrueDelay(v);
        if (v.position < geometry.length + v.length) retainedExits.push(v);
        else {
          this.completed++;
          if (v.measured) this.journeys.push({ time: now + STEP - v.departure, direction: v.direction });
        }
        leader = v;
      }
    }
    this.exiting = [...retainedExits, ...newlyExiting];

    for (const direction of DIRECTIONS) {
      const approach = this.approaches[direction];
      while (approach.nextArrival <= now + 1e-9) {
        approach.waiting.push(this.makeVehicle(direction, approach.nextArrival, approach.random));
        this.requested++;
        approach.nextArrival += this.interarrival(direction, approach.arrival);
      }
      while (approach.waiting.length) {
        const vehicle = approach.waiting[0];
        const candidates = approach.lanes.map((lane, index) => ({ lane, index, room: lane.length ? lane.at(-1).position - lane.at(-1).length - GAP : Infinity }));
        candidates.sort((a, b) => b.room - a.room);
        const best = candidates[0];
        if (best.room < vehicle.length) break;
        vehicle.lane = best.index;
        vehicle.position = vehicle.length;
        vehicle.speed = 0;
        best.lane.push(vehicle);
        approach.waiting.shift();
        this.admitted++;
      }
      for (const vehicle of approach.waiting) this.accrueDelay(vehicle);

      let queueTail = geometry.length;
      let blocked = false;
      for (let laneIndex = 0; laneIndex < approach.lanes.length; laneIndex++) {
        const lane = approach.lanes[laneIndex];
        const exit = opposite[direction];
        const headCandidate = lane[0];
        const receivingClear = !headCandidate || !this.exiting.some(v => v.exit === exit && v.lane === laneIndex && v.position - v.length < headCandidate.length + GAP);
        const clear = receivingClear && !this.crossing.some(v => axis(v.direction) !== axis(direction) || (v.direction === direction && v.lane === laneIndex));
        const green = isGreen(signals, now, direction);
        for (let i = 0; i < lane.length; i++) {
          const v = lane[i];
          const leader = lane[i - 1];
          const limit = leader ? leader.position - leader.length - GAP : geometry.length;
          const gap = Math.max(0, limit - v.position);
          const available = !leader && green && clear && now >= approach.nextRelease[laneIndex];
          const target = available ? v.desired : Math.min(v.desired, Math.sqrt(2 * 3 * gap), gap / 1.1);
          const acceleration = FLEET[v.type].acceleration;
          v.speed = Math.max(0, Math.min(target, v.speed + acceleration * STEP, gap / STEP));
          v.position = Math.min(limit, v.position + v.speed * STEP);
          this.accrueDelay(v);
          if (v.speed < 2) queueTail = Math.min(queueTail, v.position - v.length);
        }
        const head = lane[0];
        if (head && head.position >= geometry.length - 0.15 && green && clear && now >= approach.nextRelease[laneIndex]) {
          lane.shift();
          head.speed = Math.min(head.desired, 8);
          head.crossProgress = 0;
          this.crossing.push(head);
          approach.nextRelease[laneIndex] = now + Math.max(1.5, (head.length + GAP) / head.speed + 0.9);
        }
        if (lane.length && lane.at(-1).position - lane.at(-1).length < 15) blocked = true;
      }
      approach.queue = Math.max(0, geometry.length - queueTail);
      if (now >= run.warmup) {
        approach.maxQueue = Math.max(approach.maxQueue, approach.queue);
        approach.queueSum += approach.queue;
        approach.samples++;
        if (blocked) approach.blockedSeconds += STEP;
      }
    }
    this.ticks++;
    this.time = Math.min(run.duration, this.ticks * STEP);
  }

  get done() { return this.time >= this.scenario.run.duration; }

  runToEnd() { while (!this.done) this.step(); return this.result(); }

  snapshot() {
    return { time: this.time, phase: signalState(this.scenario.signals, this.time), approaches: this.approaches,
      crossing: this.crossing, exiting: this.exiting, requested: this.requested, completed: this.completed };
  }

  result() {
    const queues = Object.fromEntries(DIRECTIONS.map(d => {
      const a = this.approaches[d];
      return [d, { mean: a.samples ? a.queueSum / a.samples : 0, max: a.maxQueue, entryBlockedSeconds: a.blockedSeconds }];
    }));
    const waiting = DIRECTIONS.reduce((n, d) => n + this.approaches[d].waiting.length, 0);
    const onApproaches = DIRECTIONS.reduce((n, d) => n + this.approaches[d].lanes.reduce((m, lane) => m + lane.length, 0), 0);
    const times = this.journeys.map(j => j.time);
    return {
      engineVersion: ENGINE_VERSION, scenarioId: this.scenario.id, name: this.scenario.name,
      fingerprint: fingerprint(this.scenario), inputs: structuredClone(this.scenario), seed: this.scenario.run.seed,
      simulatedSeconds: this.time, status: 'Illustrative',
      requested: this.requested, admitted: this.admitted, completed: this.completed,
      waiting, inNetwork: onApproaches + this.crossing.length + this.exiting.length,
      measuredRequested: this.measuredRequested, measuredCompleted: times.length,
      meanJourney: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
      p95Journey: percentile(times, 0.95),
      accruedDelayPerRequest: this.measuredRequested ? this.delay / this.measuredRequested : null,
      accruedDelayPerPerson: this.measuredPeople ? this.personDelay / this.measuredPeople : null,
      maxQueue: Math.max(...Object.values(queues).map(q => q.max)), queues,
    };
  }
}
