export function cycleLength(signals) {
  return signals.eastWest + signals.northSouth + 2 * (signals.yellow + signals.allRed);
}

export function signalState(signals, time) {
  let t = ((time + signals.offset) % cycleLength(signals) + cycleLength(signals)) % cycleLength(signals);
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

export function isGreen(signals, time, direction) {
  const phase = signalState(signals, time);
  const group = ['east', 'west'].includes(direction) ? 'eastWest' : 'northSouth';
  return phase.group === group && phase.colour === 'green';
}
