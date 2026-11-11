# Model v0.4: assumptions and interpretation

**Status: illustrative. No field calibration or independent validation has been performed.**

Engine identifier: `illustrative-network/0.4.0`. Project schema version 4. Older projects are migrated on import:

- schema 1 becomes a straight-through four-arm junction;
- schema 2 gains empty per-approach and per-junction settings;
- schema 3 gains a constant demand profile.

## Network

Scenarios choose a template that compiles to an explicit graph (`src/model/network.js`): junction nodes, directed links with lanes, and lane-to-lane paths through each junction.

| Template | Junctions | Arms |
| --- | --- | --- |
| Four-arm junction | 1 | north, east, south, west |
| T-junction | 1 | east, south, west (no north arm) |
| Two-junction corridor | 2 (A west of B) | each has north and south side roads; A–B and B–A links of configurable length |
| Single-lane roundabout | 4 priority junctions on a clockwise ring (24 m radius) | north, east, south, west |

Roads take shared length, lane count and speed limit unless an approach has its own settings (below). The corridor link length is set separately and has finite storage. Traffic keeps left. Lane 0 is the kerbside lane and the highest lane index is the median lane. The map is a schematic, not a surveyed layout. Lane widths and junction boxes are drawn wider than the longitudinal scale for legibility; the scale bar shows distance along roads.

### Per-approach settings

Any approach (boundary or corridor link) can override lanes (1–3), speed limit, length (boundary approaches only), left and right turning shares, and a right-turn pocket length. A blank setting uses the shared value. Exit roads always use the shared lane count and speed. Junction boxes are sized for the widest approach.

### Right-turn pockets

A pocket adds a median-side lane over the final *P* metres of an approach, at signalised junctions only. Right-turners travel in the median through lane until the pocket entrance, then move into the pocket if its last vehicle has left room. If the pocket is full, the right-turner stops at the entrance and holds every vehicle behind it in that lane: overflow blocks through traffic. Pocket-overflow seconds count post-warm-up time when this happens. A pocket must be at least 10 m shorter than its approach.

### Roundabout

The roundabout is single-lane throughout: approach, circulating and exit lane counts and pockets are ignored, and the model checks say so. Circulation is clockwise for left-hand traffic, with four short straight circulating links (about 21 m) between entry/exit nodes. Each entry gives way to circulating traffic (see junction entry). Left, straight and right turning shares select the first, second and third exit. Circulating speed is capped at 30 km/h. Under the default fleet, throughput levelled off at about 1,500 vehicles/hour in total in a demand sweep (2,400–6,000 veh/h offered, 25% left and 25% right). That plateau is a property of these simplified rules, not a capacity estimate. Compare the roundabout with a one-lane signalised junction for a like-for-like test.

Free-form network drawing, median openings and U-turns are not yet available.

## Routes and lanes

- Each vehicle's whole route is drawn at departure from declared turning shares (left %, right %, remainder straight), applied at every junction it reaches. Movements a junction does not offer are removed and the remaining shares rescaled; if none of the remaining shares is positive, the available movements are equally likely. U-turns are not offered.
- Left turns use the kerbside lane and right turns the median through lane, then the pocket where one exists. Straight-ahead vehicles enter the through lane with most room and keep their lane index through a junction. Pockets are never used by straight or left-turning traffic.
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
6. **Roundabout give-way:** there is no signal. An entering vehicle waits while any circulating vehicle would reach the entry within 3.5 seconds, wherever it will exit; entering drivers are not assumed to know. It also needs 3 m of spare room on the circulating lane beyond its own length. Without this buffer the ring could fill and lock up under heavy demand. A vehicle may start behind one already in the junction on a converging path if, at its speed cap, it reaches the shared lane at least one vehicle length plus gap later, with a 25% margin.

Vehicles cross at a constant speed capped by movement (8 m/s straight, 6 m/s right, 5 m/s left and merging, 6 m/s circulating or leaving a roundabout), following any leader on the same path. A vehicle's desired speed is the current link's speed limit × its class factor × an individual factor drawn at departure. These entry rules are conservative and are not a calibrated saturation-flow or gap-acceptance model.

## Signals

Two fixed-time groups alternate: east–west, then north–south. On the T-junction the north–south group serves the south arm only. Greens accept 5–300 seconds; each group has separate yellow and all-red intervals. On the corridor, each junction uses the shared greens unless it has its own east–west and/or north–south greens; yellow and all-red stay shared. Junction B's plan starts `offset` seconds later. Timing sweeps change the shared green, so they do not move a junction that has its own value for that group. Pedestrian clearance is not calculated because pedestrians are not modelled. Adaptive control is not implemented.

## Arrivals and comparison

Demand at each boundary approach is a Poisson process whose rate is the arm's vehicles/hour × the demand multiplier × the **demand profile** factor for the current period.

The profile is a list of 1–48 factors (0–3) with a period of 1–60 minutes, shared by every approach. The last factor holds after the profile ends. Presets (constant, mid-run peak, short surge, steadily rising) are written out as explicit factors spanning the run in six periods, so a saved scenario reproduces exactly.

Arrivals use the cumulative-intensity method: each arrival spends one unit exponential draw across the periods. A constant profile therefore gives exactly the v0.3 arrivals. A profile whose factors average 1 over the run gives the same number of requests, redistributed in time. The model checks note profiles that add or remove demand overall. On the corridor, the north and south values apply to each junction's side road. Separate seeded streams generate arrival times, vehicle attributes and route draws per boundary approach, so paired seeds keep arrivals and the fleet identical across timing, turning-share and geometry alternatives. Every vehicle uses exactly two route draws, so changing turning shares changes routes but not the arrival times or vehicle types. Vehicle shares must total 100%.

Physics uses 0.2-second steps; playback speed changes wall-clock execution only. Replication *i* uses seed `base + i`.

## Statistics

- Results report the mean and sample standard deviation across seeds.
- Scenario comparisons also report the **paired difference** between each alternative and the first (baseline) scenario. Runs are matched by seed, and a two-sided 95% interval uses Student's t with n − 1 degrees of freedom. Pairing is only claimed when demand, fleet and run settings match; otherwise the difference is withheld.
- These intervals describe run-to-run random variation only. They do not cover uncertainty in demand, behaviour parameters or model form. Three replications is an exploratory default, not a precision target.
- **Until precise (declared stopping rule).** The primary indicator is accrued delay per request.
  - Every scenario runs 5 seeds. Then 2 more seeds are added to *every* scenario at a time, keeping them paired, until each alternative's paired 95% interval on delay either excludes zero (**lower** or **higher** delay than the baseline) or has a half-width within the target (**no difference beyond the target**). The target is the larger of ±1 s and ±5% of the baseline mean delay.
  - The limit is 20 seeds; anything still open is reported **inconclusive**.
  - Alternatives whose demand, fleet or run settings differ are **not paired** and get no verdict.
  - The verdict concerns delay only. Read queues, waiting demand and completed trips alongside it. Repeatedly checking the interval as seeds are added makes the 95% coverage approximate, and the limit bounds the effect. Sweeps always use 5 seeds.
- **Change summaries.** Each alternative lists what differs from the first (baseline) scenario, in planner terms (for example "West approach: right-turn pocket: shared value → 40 m"). Changes are classed as:
  - **design:** layout, approach geometry, signals;
  - **assumption:** demand, turning shares, demand profile, fleet;
  - **run:** duration, warm-up, seed.

  An alternative with only design changes is labelled an infrastructure-only comparison. The list appears in the design view, the results table, the CSV and the printed report.
- Timing sweeps can vary either signal group's green and test low (0.75×), central (1×) and high (1.25×) demand. The lowest-mean-delay candidate is reported per demand level, and a warning appears when it differs between levels.

## Measurement windows and metrics

- Warm-up traffic remains in the model. Queue statistics are sampled after warm-up.
- **Queue:** for each lane, a chain of vehicles slower than 2 m/s that starts within 10 m of the stop line, where each follower's front is within 10 m of its leader's rear. A link's queue is the longest lane chain, measured back from the stop line. (v0.1 counted any slow vehicle anywhere on the approach, including vehicles that had just entered at rest; that overstated queues.)
- **Entry-blocked seconds:** post-warm-up time with vehicles waiting outside a boundary approach.
- **Spillback seconds:** post-warm-up time with a corridor link's queue within 15 m of its upstream junction.
- **Downstream-blocked seconds:** post-warm-up time when a stop-line vehicle had green but its receiving lane was queued (storage exhausted, not merely spacing behind a departing vehicle).
- **Persistent queues (cycle failures).** When an approach's green starts, every vehicle then waiting in its queue is tagged: slower than 2 m/s, with the stop line or the vehicle ahead within 10 m. A vehicle that has just entered at rest far upstream is not tagged. If any tagged vehicle is still on the approach when that green ends, the cycle *failed to clear*.
  - Two consecutive failures open a persistent queue event, dated from the first failing green. The first cycle that clears closes it.
  - Roundabout links have no cycles, so consecutive 60-second windows stand in for them.
  - **Persistent queue time** is the event time inside the measurement window, summed over approaches (reported in link-minutes). **Unresolved at end** counts events still open at the run horizon: queues that had not cleared when the run stopped.
  - This separates normal stopping at red, which clears each cycle, from congestion that carries over. It does not say why a queue persists; see the inspector's contributor descriptions.
- **Time series** are sampled every 10 simulated seconds: each approach's queue, the longest approach queue, vehicles waiting to enter, vehicles in the network, and cumulative requested and completed trips. Comparisons store the mean across seeds at each sample, not each seed's series.
- Completed-trip mean and p95 journey times use vehicles requested after warm-up and completed by the horizon. They include entry waiting and are biased towards completed trips; read them with completion and unfinished counts.
- **Accrued delay** integrates `max(0, 1 − speed / desiredSpeed)` over time for post-warm-up requests, including waiting outside and time in junctions, divided by those requests (including unfinished trips). Person delay weights by disclosed fixed class occupancies. It is delay accrued to the run horizon, not eventual total trip delay.
- **Boundary accounting** covers the whole run: `requested = completed + inNetwork + waitingOutside`, and `admitted = completed + inNetwork`. Both are checked at every step in tests.

## Explanations and limits

Inspector messages describe signal holds, blocked receiving lanes, a corridor link full back to its upstream junction, exhausted entry storage, and queues persisting during green. They name likely contributors from simulated evidence. They do not prove a unique root cause, estimate crash risk, or establish real-world capacity. Unexplained queues are not labelled phantom jams.

Use the tool to structure questions and compare illustrative mechanisms, then obtain observed data and appropriate engineering analysis.
