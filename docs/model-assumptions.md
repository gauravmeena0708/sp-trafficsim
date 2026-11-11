# Model v0.2: assumptions and interpretation

**Status: illustrative. No field calibration or independent validation has been performed.**

Engine identifier: `illustrative-network/0.2.0`. Project schema version 2 (schema 1 projects are migrated on import as straight-through four-arm junctions).

## Network

Scenarios choose a template that compiles to an explicit graph (`src/model/network.js`): junction nodes, directed links with lanes, and lane-to-lane paths through each junction.

| Template | Junctions | Arms |
| --- | --- | --- |
| Four-arm junction | 1 | north, east, south, west |
| T-junction | 1 | east, south, west (no north arm) |
| Two-junction corridor | 2 (A west of B) | each has north and south side roads; A–B and B–A links of configurable length |

All roads share length, lane count and speed limit. The corridor link length is set separately and has finite storage. Traffic keeps left. Lane 0 is the kerbside lane and the highest lane index is the median lane. The map is a schematic, not a surveyed layout. Lane widths and junction boxes are drawn wider than the longitudinal scale for legibility; the scale bar shows distance along roads.

Free-form network drawing, independent per-road properties, roundabouts, pockets, median openings and U-turns are not yet available.

## Routes and lanes

- Each vehicle's whole route is drawn at departure from declared turning shares (left %, right %, remainder straight), applied at every junction it reaches. Movements a junction does not offer are removed and the remaining shares rescaled; if none of the remaining shares is positive, the available movements are equally likely. U-turns are not offered.
- Left turns use the kerbside lane and right turns the median lane. Straight-ahead vehicles enter the boundary lane with most room, and keep their lane index through a junction.
- There are no mid-link lane changes. A vehicle that needs a different lane for its next junction takes it while crossing the upstream junction. A turning vehicle at the head of a shared lane therefore blocks straight traffic behind it.

## Longitudinal motion

Vehicles use explicit lengths, per-class acceleration, desired-speed variation and occupancy assumptions. Speed is bounded by acceleration, the speed limit and the gap to the leader, with a 2.5 m minimum gap. This is not IDM, and deceleration is not a calibrated comfort or emergency-braking model.

## Junction entry

A head vehicle at the stop line enters the junction only when all of these hold:

1. **Signal:** its approach's group is green. Yellow is treated as closed to new entrants.
2. **Headway:** a per-lane release headway has elapsed since the previous vehicle entered.
3. **No conflicting path in use:** no vehicle currently in the junction is on a path whose sampled centre line passes within 2.6 m of this vehicle's path. Vehicles on the identical path may follow each other.
4. **Room to clear the junction:** the receiving lane has room for this vehicle after all vehicles already committed to it. This prevents blocking the box, and lets queues spill back from a full link into the upstream junction.
5. **Permissive right turns:** a right-turning vehicle yields while any straight or left-turning vehicle on another green approach has a conflicting path and would reach the stop line within 4 seconds (searched up to 60 m). An opposing vehicle that is itself held by a full receiving lane does not hold the turn.

Vehicles cross at a constant speed capped by movement (8 m/s straight, 6 m/s right, 5 m/s left), following any leader on the same path. These entry rules are conservative and are not a calibrated saturation-flow or gap-acceptance model.

## Signals

Two fixed-time groups alternate: east–west, then north–south. On the T-junction the north–south group serves the south arm only. Greens accept 5–300 seconds; each group has separate yellow and all-red intervals. Both corridor junctions share one plan, and junction B's plan starts `offset` seconds later. Pedestrian clearance is not calculated because pedestrians are not modelled. Adaptive control is not implemented.

## Arrivals and comparison

Demand at each boundary approach is a Poisson process: the arm's vehicles/hour times the demand multiplier. On the corridor, the north and south values apply to each junction's side road. Separate seeded streams generate arrival times, vehicle attributes and route draws per boundary approach, so paired seeds keep arrivals and the fleet identical across timing, turning-share and geometry alternatives. Every vehicle uses exactly two route draws, so changing turning shares changes routes but not the arrival times or vehicle types. Vehicle shares must total 100%.

Physics uses 0.2-second steps; playback speed changes wall-clock execution only. Replication *i* uses seed `base + i`.

## Statistics

- Results report the mean and sample standard deviation across seeds.
- Scenario comparisons also report the **paired difference** between each alternative and the first (baseline) scenario. Runs are matched by seed, and a two-sided 95% interval uses Student's t with n − 1 degrees of freedom. Pairing is only claimed when demand, fleet and run settings match; otherwise the difference is withheld.
- These intervals describe run-to-run random variation only. They do not cover uncertainty in demand, behaviour parameters or model form. Three replications is an exploratory default, not a precision target.
- Timing sweeps can vary either signal group's green and test low (0.75×), central (1×) and high (1.25×) demand. The lowest-mean-delay candidate is reported per demand level, and a warning appears when it differs between levels.

## Measurement windows and metrics

- Warm-up traffic remains in the model. Queue statistics are sampled after warm-up.
- **Queue:** for each lane, a chain of vehicles slower than 2 m/s that starts within 10 m of the stop line, where each follower's front is within 10 m of its leader's rear. A link's queue is the longest lane chain, measured back from the stop line. (v0.1 counted any slow vehicle anywhere on the approach, including vehicles that had just entered at rest; that overstated queues.)
- **Entry-blocked seconds:** post-warm-up time with vehicles waiting outside a boundary approach.
- **Spillback seconds:** post-warm-up time with a corridor link's queue within 15 m of its upstream junction.
- **Downstream-blocked seconds:** post-warm-up time when a stop-line vehicle had green but its receiving lane was queued (storage exhausted, not merely spacing behind a departing vehicle).
- Completed-trip mean and p95 journey times use vehicles requested after warm-up and completed by the horizon. They include entry waiting and are biased towards completed trips; read them with completion and unfinished counts.
- **Accrued delay** integrates `max(0, 1 − speed / desiredSpeed)` over time for post-warm-up requests, including waiting outside and time in junctions, divided by those requests (including unfinished trips). Person delay weights by disclosed fixed class occupancies. It is delay accrued to the run horizon, not eventual total trip delay.
- **Boundary accounting** covers the whole run: `requested = completed + inNetwork + waitingOutside`, and `admitted = completed + inNetwork`. Both are checked at every step in tests.

## Explanations and limits

Inspector messages describe signal holds, blocked receiving lanes, a corridor link full back to its upstream junction, exhausted entry storage, and queues persisting during green. They name likely contributors from simulated evidence. They do not prove a unique root cause, estimate crash risk, or establish real-world capacity. Unexplained queues are not labelled phantom jams.

Use the tool to structure questions and compare illustrative mechanisms, then obtain observed data and appropriate engineering analysis.
