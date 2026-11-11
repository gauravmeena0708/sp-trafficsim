export function cycleLength(signals) {
  return signals.eastWest + signals.northSouth + 2 * (signals.yellow + signals.allRed);
}

// Fixed-time two-group plan. `offset` shifts the plan start for coordination.
export function signalState(signals, time, offset = signals.offset ?? 0) {
  const cycle = cycleLength(signals);
  let t = ((time + offset) % cycle + cycle) % cycle;
  const phases = [
    ['eastWest', 'green', signals.eastWest],
    ['eastWest', 'yellow', signals.yellow],
    ['all', 'red', signals.allRed],
    ['northSouth', 'green', signals.northSouth],
    ['northSouth', 'yellow', signals.yellow],
    ['all', 'red', signals.allRed],
  ];
  for (const [group, colour, duration] of phases) {
    if (t < duration) return { group, colour, remaining: duration - t };
    t -= duration;
  }
  return { group: 'all', colour: 'red', remaining: 0 };
}

export function groupColour(signals, time, group, offset) {
  const phase = signalState(signals, time, offset);
  return phase.group === group ? phase.colour : 'red';
}

// Only green admits new entries to the junction; yellow is treated as closed.
export const groupGreen = (signals, time, group, offset) => groupColour(signals, time, group, offset) === 'green';

export function isGreen(signals, time, direction, offset) {
  return groupGreen(signals, time, ['east', 'west'].includes(direction) ? 'eastWest' : 'northSouth', offset);
}
