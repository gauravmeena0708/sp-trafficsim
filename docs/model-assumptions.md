# Model v0.1: assumptions and interpretation

**Status: illustrative. No field calibration or independent validation has been performed.**

## Geometry and movement

The prototype contains a four-arm, left-hand-traffic junction. All arms share length, lanes, and speed limit. Each requested vehicle travels straight through to the opposite arm. There are no turns, lane changes, roundabouts, sublane filtering, pedestrian interactions, bus stops, parking, or downstream junctions.

Vehicles use explicit lengths, per-class acceleration, desired speed variation and occupancy assumptions. The longitudinal model uses bounded acceleration and speed limits based on available headway/gap, with a 2.5 m minimum gap. It is not an implementation of IDM. Deceleration is simplified and is not a calibrated comfort or emergency-braking model.

Crossings use a conservative reservation: only one vehicle per directional lane occupies the crossing at once, while compatible opposing straight movements may run concurrently. A different signal group cannot enter until the preceding group has cleared. This deliberately limits discharge and is not a calibrated saturation-flow estimate. Outbound lanes also preserve spacing. No arbitrary vehicle removal is used.

The map is a schematic concept layout, not a surveyed map. Class glyphs and lane widths have minimum display sizes for readability; the engine uses physical dimensions separately. The scale bar represents longitudinal approach distance.

## Signals

Two fixed-time groups alternate: east–west and north–south. Individual greens accept 5–300 seconds. Each group has a separate yellow and all-red interval. New crossings start only during green and when the conflict area/receiving lane allows entry. Yellow is conservatively treated as closed to new entrants. No pedestrian clearance calculation is available because pedestrians are not yet modelled.

Adaptive traffic-responsive control is not implemented. A fixed-time sweep tests green durations against a declared demand condition; it does not adjust signals automatically during a run.

## Arrivals and comparison

Per-approach independent Poisson arrival processes represent constant demand multiplied by the selected sensitivity factor. Separate seeded streams generate arrivals and vehicle attributes. Timing changes therefore preserve the requested arrival times and vehicle fleet for a paired seed. Vehicle shares must total 100%.

Playback speed changes wall-clock execution only. Physics uses 0.2-second time steps. Batch runs use the same engine, adding one to the base seed for each replication. Results report mean and sample standard deviation, not statistical confidence intervals; three default replications are an exploratory starting point, not proof of sufficient precision.

## Measurement windows and metrics

- Warm-up traffic remains in the model. Queue summaries are sampled after warm-up across all present vehicles.
- Queue length is the distance from the stop line to the rear of the furthest vehicle below 2 m/s on an approach; moving gaps may be included. This is a slow-vehicle extent estimate, not a validated persistent-queue measure.
- Completed-trip mean and p95 journey times use vehicles requested after warm-up and completed by the run horizon. They include entry waiting and may be biased toward completed/shorter trips. Read completion and unfinished counts alongside them.
- Accrued delay integrates `max(0, 1 - speed / desiredSpeed)` over time for post-warm-up requested vehicles, including waiting outside. It is divided by the number of those requests, including unfinished trips. Person delay weights both delay and the denominator using disclosed fixed class occupancy assumptions. It is accrued delay to the run horizon, not an estimate of eventual total trip delay.
- Boundary accounting covers the whole run: `requested = completed + inNetwork + waitingOutside`, and `admitted = completed + inNetwork`.
- Max queue and entry-blocked seconds cover the post-warm-up measurement window. A low completed-trip mean is not sufficient evidence of a better design.

## Explanations and limits

Inspector messages describe current signal holds, slow vehicles, or exhausted storage. They do not prove a unique root cause, estimate crash risk, or establish real-world road capacity. Unknown causal relationships are not relabelled phantom jams.

Long greens may worsen waiting on other approaches. Wider roads and different traffic mixes also have consequences outside this model. Use the tool to structure questions and compare illustrative mechanisms, then obtain observed data and appropriate engineering analysis.
