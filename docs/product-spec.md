# Product Plan: Traffic Planning and Scenario Comparison Tool

> Agent and contributor working rules live in [CLAUDE.md](../CLAUDE.md). This document describes the intended product; build it in the phased order below.

Implementation progress is tracked in [the delivery roadmap](roadmap.md). The [README](../README.md) describes the current runnable slice and GitHub Pages setup; this specification describes the full intended product.

## 1. Purpose and users

Build a user-friendly application for city road planners and traffic engineering teams to explore road layouts and traffic management changes before construction or implementation.

Planners should be able to identify where queues form, test road geometry and signal changes, explore population growth and vehicle-mix assumptions, and compare alternatives across the whole study area. The tool must reveal when an apparent improvement moves congestion to another road or disadvantages a particular movement or group of travellers.

Start with a small connected study area. Citywide forecasting is a later capability, not a first-release promise.

## 2. Core planner workflow

1. **Create the study area:** Draw a connected network or start from a template, with dimensions in metres.
2. **Define traffic demand:** Enter counts, turning movements, or origin-destination demand. Later, estimate trips from population and land use using explicit assumptions.
3. **Set up the baseline:** Configure lanes, junctions, signals, vehicle mix, crossings, and bus operations.
4. **Check the model:** Resolve disconnected roads, impossible turns, conflicting signal permissions, and invalid demand inputs.
5. **Run the baseline:** Inspect queues, journey times, and likely congestion contributors.
6. **Create alternatives:** Duplicate the baseline and change geometry, controls, demand, or fleet composition.
7. **Compare fairly:** Evaluate alternatives with consistent demand and run settings, identifying deliberately changed assumptions.
8. **Export findings:** Include layouts, results, uncertainty, assumptions, and validation evidence in a reproducible report.

Save projects, scenarios, and run results separately. Editing a scenario must not silently overwrite earlier results. Mark displayed results as stale after relevant inputs change.

## 3. Road network and geometry

### First-release editor

- Editable connected segments and junctions rather than a fixed four-lane corridor.
- Configurable road length, lane count, lane width, speed limit, and direction.
- Explicit left-hand traffic support and readable lane/movement labels.
- T-junctions, four-arm junctions, and basic single-lane roundabouts with configurable approaches and yielding.
- Turning lanes, turning-pocket storage lengths, and permitted/prohibited movements.
- Medians, median openings, and U-turn paths where geometry permits.
- Lane closures and temporary obstructions.
- Kerbside bus stops and recessed bus bays with configurable dwell distributions.
- Basic pedestrian crossings with configurable demand and explicit priority or signal control.
- Pan, zoom, snap-to-connect, property editing, undo/redo, and clear dimensions.

Validate connections, turn paths, crossing conflicts, and storage. Roundabouts must model entry yielding and circulating traffic, not simply display circular roads.

### Later extensions

Add reviewed GIS/OpenStreetMap import, complex roundabouts, slip roads, grade separation, parking access, cycling infrastructure, and larger networks. Imported map data must remain editable and must not be treated as verified lane, priority, or signal information.

## 4. Traffic demand, population, and vehicle types

### Demand inputs

- Time-varying entry demand in vehicles/hour, turning proportions, and/or origin-destination trip tables.
- Peak/off-peak profiles, simulation duration, warm-up period, and growth assumptions.
- Two-wheelers, auto-rickshaws, cars, buses, and trucks with configurable shares.
- Per-class dimensions, desired speed distributions, acceleration, braking, headway, occupancy, and lateral behaviour.
- Bus paths, service frequency, stops, dwell distributions, and occupancy assumptions.
- Validation of units, nonnegative values, valid destinations, and shares that sum correctly.

Use vehicle counts as the primary demand input. If passenger car units (PCU) are displayed, disclose conversion factors rather than treating them as universal constants. Behaviour must be configurable and informed by observations rather than stereotypes about particular vehicle classes.

### Population and land-use estimation

Provide zones with population, households or jobs, and land-use categories such as residential, office, school, and market. Make the conversion explicit:

**Population/land use -> trips by time period -> destinations -> mode shares -> occupancy -> vehicle trips -> network routes.**

Expose each rate and assumption, including how public transport trips relate to bus service. A population-density slider must not directly multiply road traffic without explaining this conversion.

Offer low, central, and high demand estimates. Label estimated demand and allow replacement with observed counts or external forecasts. Prevent double-counting between observed-demand and estimated-demand modes.

## 5. Signals and junction control

- Configurable phase sequences, green times, yellow times, all-red clearance, and cycle length.
- Explicit permitted movements, protected/permissive turns where supported, and pedestrian phases.
- Validation against incompatible protected movements and impossible timing combinations.
- Fixed-time signals and offsets for coordinating nearby junctions in the first release.
- Actual stop lines, finite turning storage, downstream blocking, unsignalized priority, and roundabout gap acceptance.
- Actuated/adaptive controllers in a later phase, with documented behaviour.

Signal settings must control simulated movement permissions; a visual red/green toggle is insufficient.

### Timing experiments: 5 seconds to 5 minutes

- Allow planners to test individual phase green durations from **5 to 300 seconds**, using direct entry or a slider with explicit units. This range is an experimental capability, not a recommendation for every junction.
- Keep phase green duration distinct from total cycle length. Derive the cycle from all phase durations and transition intervals; display the resulting red/waiting times for other movements.
- Validate each candidate against configured movement, pedestrian-clearance, yellow, and all-red requirements. Explain why an incompatible candidate cannot run; do not shorten required clearance to fit a requested green time.
- In Phase 1, provide a batch timing sweep with user-selected start, end, and increment, including explicit endpoint tests at 5 and 300 seconds when valid. Compare the same candidates under low, central, and high traffic demand and directional imbalances.
- Plot green duration against delay, queues, throughput, pedestrian waiting, and maximum approach waiting. Report trade-offs rather than assuming longer greens improve the network.

### Traffic-responsive timing

In Phase 3, provide an explicit actuated/adaptive mode that adjusts green durations using measured per-approach conditions. Distinguish **density** (vehicles per kilometre per lane), **flow** (vehicles per hour), detector occupancy, and queue length; they are separate inputs, not interchangeable labels.

Expose detector locations, measurement windows, update intervals, and the controller's extension/termination rule. Let planners configure minimum and maximum greens within the 5-300 second experimental range, maximum red/waiting constraints, and downstream-blocking rules. Preserve valid phase transitions, pedestrian service, and clearance intervals. Explain infeasible combinations of limits rather than silently violating them.

Log the measurements and reasons behind every timing change. Compare the responsive controller with fixed-time plans under identical time-varying demand and paired seeds, including sudden surges, uneven approach demand, and saturated downstream links. Density-based adjustment must not automatically allocate more green to an approach whose receiving link cannot accept traffic.

## 6. Simulation engine and architecture

### Engine selection

Evaluate an established microscopic engine, such as SUMO, against a custom engine before committing to implementation. Record a decision covering mixed traffic, lateral behaviour, signals, roundabouts, calibration, licensing, deployment, and browser/service integration.

A browser interface may use a local or hosted simulation service. If a lightweight custom browser engine is selected for the prototype, label results illustrative until validation criteria are met. Do not require a single HTML file or prohibit simulation libraries.

### Required simulation behaviour

- Explicit topology, lane connections, turning trajectories, and priorities.
- Documented car-following and lane-changing models with configurable parameters and limitations.
- Mixed-fleet dimensions and behaviour distributions.
- Sublane motion and two-wheeler filtering only where realistic lateral clearance and collision avoidance are supported.
- Finite road storage, merging, blocked turning pockets, and downstream spillback.
- Declared/fixed routes or a documented routing rule initially; adaptive rerouting later.
- Entry queues when the network cannot admit vehicles. Never silently discard demand.
- Fixed simulation time steps independent of display frame rate, reproducible seeds, and explicit warm-up/measurement windows.

### Engineering requirements

Separate editing, demand generation, simulation, event collection, diagnostics, rendering, persistence, and reporting. Run computation in workers or a service to keep the interface responsive.

Support pause, resume, reset, replay, speed controls, and batch execution without animation. Benchmark on a documented reference machine and workload, recording network size, vehicle load, simulation step, runtime, and rendering performance. Do not promise universal 60 FPS.

Version the project schema. Each result must identify the exact network, demand, controls, engine version, parameters, seed, and measurement window used.

## 7. Congestion diagnosis and explanations

Identify **likely contributing causes supported by simulation evidence**. Do not promise an exact single initiating cause for every queue.

### Detection and evidence

- Define consistent, configurable queue speed/spacing thresholds, persistence duration, and recovery rules.
- Group queues using road connectivity, movements, and direction rather than screen proximity or the greatest x-coordinate.
- Track queue heads/tails, growth, duration, affected movements, and spillback.
- Record signal holds, downstream blocking, lane closures, bus dwell, cut-ins, failed merges, and turning-pocket overflow.
- Maintain event histories and upstream influence links where the engine supplies sufficient evidence.
- Estimate queue propagation from positions over time; do not display a fixed shockwave speed as a measured result.

Support multiple contributors: geometry/capacity restrictions, lane closures, weaving/merge conflict, bus-stop friction, signal delay, turning-storage overflow, downstream spillback, demand exceeding discharge capacity, and stop-and-go instability when evidence supports it.

Unknown or ambiguous cases must remain unknown or ambiguous. Do not classify unexplained queues as phantom jams. Distinguish normal signal stopping from persistent congestion across cycles.

### Congestion inspector

Selecting a queue displays affected roads/movements, initiation time, duration, queue length, delay, likely contributors, supporting events, evidence limitations, and upstream/downstream relationships.

Offer candidate interventions with explanations and an action to create a test scenario: for example, change signal splits, extend turning storage, relocate a bus stop, or change junction geometry. These are hypotheses until evaluated. Where feasible, compare a controlled run with the suspected contributor modified. Evidence scores must not be presented as calibrated probabilities without validation.

## 8. Scenario comparison and decision support

Provide named baseline/alternative scenarios, duplication, change summaries, side-by-side results, and saved comparison sets.

### Required indicators

- Mean and percentile journey times for the study area and selected routes.
- Delay per vehicle and per person, with occupancy and reference-travel-time assumptions disclosed.
- Mean, maximum, and percentile queue lengths by approach/movement, with aggregation defined.
- Throughput, completed trips, stops, spillback duration, and blocked junction time.
- Requested departures, admitted vehicles, completed trips, vehicles still in the network, and vehicles waiting to enter.
- Per-route and per-mode results where supported.

Report unfinished trips and entry waiting explicitly. A scenario must not appear better simply because fewer vehicles entered or completed their journeys.

### Fairness and uncertainty

- Hold demand, measurement windows, warm-up policy, and model parameters consistent across infrastructure/control alternatives.
- Pair corresponding random seeds across alternatives and run multiple seeds. Declare an initial replication count and an uncertainty-based rule for adding runs.
- Show variability and appropriately calculated uncertainty intervals, including paired differences where applicable.
- Distinguish random run variation from uncertainty in growth, trip rates, and other inputs.
- Test low, central, and high demand; flag conclusions that change between cases.
- Flag invalid, unstable, or failed runs rather than silently including them in summaries.
- Show trade-offs rather than an opaque best-design score. Disclose any user-selected weights.

Later versions may include approximate construction costs, emissions, and conflict-based safety indicators with documented models. Do not equate conflict indicators with predicted crash counts without a separately validated method.

## 9. User experience and accessibility

Use clear terms: **Road layout, Traffic demand, Signals, Run simulation, Congestion, Compare options, Export report**.

Provide guided setup and common planning templates; a map/canvas workspace with contextual properties and results; distinct editing/running/comparison states; optional queue/speed heatmaps and route highlights; and plain-language explanations with units and access to technical detail.

Use colour-blind-friendly palettes, readable contrast, legends, keyboard-accessible controls, and tabular alternatives for important results. Support desktop layouts with scrollable panels when necessary rather than hiding controls. Include local project save/load and versioned export without requiring an account in the initial prototype.

Avoid military terminology, unexplained abbreviations, and decorative diagnostics that imply unsupported certainty.

## 10. Calibration, validation, and reports

### Model credibility

- Import observed counts, turning movements, travel times, and queues with source/time metadata.
- Set project-specific calibration targets before tuning.
- Calibrate demand and model behaviour against representative observations; validate against a separate period or dataset.
- Report fit measures, discrepancies, parameter changes, missing data, and checked operating conditions.
- Show status: **Illustrative**, **Calibrated for stated conditions**, or **Validated against the stated independent dataset**.
- Require documented evidence for status changes and reassess status after material changes.
- Explain that validation for one location, demand range, or fleet composition does not establish accuracy elsewhere.

### Exported report

Include layouts, alternative descriptions, demand assumptions, fleet mix, controls, measurement windows, engine versions, seeds, metrics with uncertainty, congestion explanations, calibration/validation evidence, limitations, and reproducible project files. Export indicators as CSV and provide a printable report.

## 11. Phased delivery

### Phase 1: Small-network planning prototype

Deliver several connected editable junctions; T/four-arm and single-lane roundabout templates; lane/turn editing; fixed-time signals and offsets; simple bus stops and crossings; mixed vehicle classes; manual/observed time-varying demand; baseline duplication; batch runs; core indicators; congestion explanations; local save/load; and report export.

Provide a simple demand-growth multiplier, explicitly labelled as sensitivity analysis rather than population forecasting. State supported lateral behaviour and omissions. Complete engine selection, correctness checks, and a reference benchmark before expanding scope.

### Phase 2: Demand estimation and field calibration

Add population/land-use zones and the explicit trip-generation pipeline, observed-data import, calibration workflows, independent validation, richer bus/pedestrian demand, and improved mixed-traffic behaviour informed by field evidence.

### Phase 3: Larger studies and advanced alternatives

Add reviewed map import, larger networks, adaptive signals, complex geometry, route-choice responses, and optional cost/environmental indicators. Introduce guided parameter searches only after reproducibility and comparison metrics are established; generated alternatives must remain inspectable.

## 12. Acceptance and verification

Every fixture must specify geometry, demand, parameters, seeds, measurement windows, and pass criteria before assessment. Numerical tolerances must come from reference calculations, analytical bounds, or observations, not arbitrary expected animations.

1. **Signal timing comparison:** Sweep valid phase green durations across 5-300 seconds under low, central, and high demand, including valid endpoints and directional imbalances. Verify cycle arithmetic, movement permissions, clearance validation, and approach-level queues/delay. In Phase 3, test responsive timing against the same fixed-time alternatives; verify measurement-driven changes, configured bounds, maximum-wait constraints, downstream-blocking behaviour, and reproducible controller logs.
2. **Roundabout alternative:** Replace an eligible intersection and verify yielding, valid routes, and storage under balanced and unbalanced demand. Do not require roundabouts to outperform signals.
3. **Turning-storage overflow:** Exceed pocket capacity, detect obstruction of through traffic, and compare longer storage or changed timing under unchanged demand.
4. **Lane closure:** Verify merging/queuing without passage through the obstruction, evidence-supported attribution, and upstream effects.
5. **Bus-stop placement:** Compare kerbside stop and bus bay with matching schedules/dwell samples. Report bus and adjacent-traffic effects without prescribing exact queue lengths.
6. **Downstream spillback:** Restrict downstream discharge; verify upstream blocking as storage fills and identification of the downstream relationship.
7. **Demand growth:** Compare explicit low/central/high cases. In Phase 2, verify population/land-use changes propagate through declared assumptions without double-counting.
8. **Boundary accounting:** Overload an entry. Verify conservation across requested departures, entry waiting, vehicles in the network, completed trips, and explicitly logged failures/removals.
9. **Reproducibility:** Repeat identical inputs/seeds within a declared execution tolerance. Verify batch aggregation, units, paired differences, uncertainty calculations, and stale-result detection.
10. **Independent validation:** Compare outputs with reserved observations and report whether predefined targets were met. Retain illustrative status without supporting evidence.

Also check connectivity, demand conservation, signal conflicts, collision/overlap detection, invalid inputs, and save/load round trips. Performance checks must use the declared reference workload.

## 13. Technical references

- [FHWA Traffic Analysis Toolbox Volume III, 2019](https://ops.fhwa.dot.gov/publications/fhwahop18036/): planning, data, calibration, and alternatives analysis.
- [FHWA introduction and workflow](https://ops.fhwa.dot.gov/publications/fhwahop18036/introduction.htm): model inputs, calibration, and repeated alternative evaluations.
- [SUMO sublane model documentation](https://sumo.dlr.de/docs/Simulation/SublaneModel.html): lateral resolution and mixed lateral behaviour for engine evaluation.

These references guide implementation; citing them does not establish that this application is calibrated or validated.

## 14. Extended experience: 2D editing and navigable 3D

Add a 3D view of the same simulation, while retaining the overhead 2D editor. Both views must read the same network, vehicle positions, signal states, selections, and timestamps. Changing a camera or switching views must not restart the run, change physics, or change its results.

### Camera and navigation

- Zoom from the entire study area to an individual junction or vehicle.
- Orbit, tilt, and pan using mouse, trackpad, touch, and keyboard controls with visible guidance.
- Provide overhead, angled overview, street-level, fit-to-study, and reset-view presets.
- Allow selection of a road or vehicle to focus the camera; optionally follow a vehicle and return to the previous view when following ends.
- Bound zoom and camera movement to prevent getting lost beneath the ground or inside geometry. A failed or unavailable tracked target must leave a usable camera view.
- Include a north indicator, scale/context indicator, and an overview map for larger networks.
- Save named camera bookmarks with a project, separately from simulation inputs. Camera-only changes must not mark simulation results stale.

### Rendering and inspection

- Begin with simple roads, lane markings, signals, crossings, and recognisable vehicle shapes. Show dimensions consistently in world units.
- Keep simulation coordinates independent of renderer coordinates; define the origin, axes, units, and conversion explicitly.
- Make roads, junctions, queues, and vehicles selectable in either view, opening the same inspector.
- Provide selectable overlays for speed, queue extent, demand, movement permissions, and congestion events. Use legends and text as well as colour.
- Keep annotations readable at different zoom levels; allow hiding buildings and other scenery that obstruct a queue or junction.
- Treat buildings, trees, and other context as optional visual layers unless a separately implemented model gives them a behavioural effect.
- Add road elevation and grade-separated structures only alongside corresponding network connectivity and movement rules; visually crossing roads must not automatically connect.

### Performance and hosting

Evaluate a maintained browser 3D renderer for static GitHub Pages deployment. Record its license, dependency version, bundle size, and supported browsers before adoption. Bundle required assets with the app and use repository-relative paths.

Use shared geometry, efficient repeated-vehicle drawing, and adjustable detail. Keep simulation time independent of rendering frequency. Provide a usable 2D fallback when 3D is unsupported or the graphics context is lost. Document a browser/device benchmark and frame-time target for a declared workload rather than promising a universal frame rate.

## 15. Additional improvements for practical planning

### A. Guided study setup and model checks

Offer a short wizard: select a planning question, choose a layout, enter demand, review assumptions, and create a baseline. Include examples for a busy junction, school arrival peak, market access, bus-stop obstruction, and roundabout comparison as their required model capabilities become available.

Provide a pre-run checklist that identifies disconnected routes, missing demand, impossible turns, invalid phases, and unsupported features. Each finding must explain the problem, locate it in the editor, and offer a concrete correction. Separate blocking errors from assumptions the planner can review.

### B. More capable road editing

- Draw roads by placing connected points; support snapping, alignment guides, measured distances, and editable curves.
- Edit each approach independently, including lane widths, direction, speed, turning storage, and connections.
- Offer road cross-section previews and explicit movement arrows so a planner can review the intended design before running it.
- Add undo/redo, duplicate selection, autosave recovery, and an explicit baseline lock to prevent accidental changes to the reference design.
- Validate geometry edits before simulation. Decorative changes must not imply additional capacity or movement permissions.

### C. Replay and event investigation

Provide a timeline with pause, step, speed control, and replay of completed runs. Mark events such as queue formation, spillback reaching a junction, and prolonged approach waiting. Selecting an event should move to its recorded time and location and show the supporting measurements.

Implement seeking through recorded states or deterministic checkpoints and replay. Do not reverse physics by applying negative time steps. Record enough state to reproduce random streams and controller decisions, and expose storage limits for long runs.

### D. Stronger comparisons and reports

- Show baseline and alternative side by side, with optional synchronised cameras and simulation clocks. Identify when geometries differ enough that camera matching is approximate.
- Present absolute results and changes from baseline, including queues on every approach, completed/unfinished trips, person delay, and pedestrian/bus impacts when modelled.
- Include a scenario change list and notes explaining the planning hypothesis.
- Add charts over time so an average cannot hide a severe short peak or a queue that has not cleared by the run horizon.
- Export annotated views and charts with scenario name, timestamp, seed/model metadata, and illustrative/calibration status.
- Provide a portable study package containing inputs, scenario changes, run manifests, and reports. Clearly label images as simulated views.

### E. Demand variation and stress testing

Add scheduled demand profiles, directional surges, school/event peaks, temporary lane closures, and staged roadworks. Let planners vary the start time and duration of a disturbance while retaining a matching baseline.

Batch-test uncertain demand and vehicle shares within declared ranges. Distinguish those input variations from random-seed variability. Report where a design begins to leave persistent queues or unserved demand, using an explicit threshold rather than claiming a universal capacity limit.

### F. Accessibility and transit outcomes

As pedestrian, cycling, and bus behaviour is implemented, include crossing wait, crossing completion, bus journey reliability, and passenger-weighted delay. Make their assumptions and coverage visible. A design should not be judged only by car throughput.

Represent bus bays, stop dwell, pedestrian phases, and cycling conflicts through actual behaviour before presenting comparative results for those interventions.

### G. Explainable alternative search

After validated comparison and reproducibility are established, allow a planner to specify objectives, constraints, and a bounded set of editable parameters. Examples include signal green ranges, maximum approach waiting, turning-pocket lengths, or available road width.

Generate several candidate alternatives with visible settings and trade-offs. Preserve the baseline and candidate run records. Test shortlisted candidates against additional seeds and demand conditions, including conditions not used to select them. Describe them as tested candidates, not a guaranteed optimal design. An initial implementation can use transparent parameter sweeps; an AI component is not required.

## 16. Priority and acceptance for the extensions

This sequence refines the delivery phases in Section 11; it does not mark existing planned functionality complete.

| Priority | Deliverable | Completion evidence |
| --- | --- | --- |
| Next increment | 3D junction with zoom, orbit, pan, camera presets, selection, and 2D toggle | The same run remains continuous across views; camera actions leave numerical outputs unchanged; desktop/touch controls and fallback are checked in browsers. |
| Following increment | Independent road properties, connected-network editing, turns, and a basic roundabout | Geometry and connectivity checks pass; routes follow actual movements; downstream storage and priority behaviour are exercised. |
| Complete Phase 1 | Guided setup, undo/redo, time-varying demand, bus/crossing behaviour, replay, richer comparisons | End-to-end study fixtures can be saved, replayed, compared, and exported with correct accounting and limitations. |
| Phase 2 | Population demand pipeline, observed-data import, calibration and independent validation | Traceable inputs, declared fit targets, and reserved-data validation results support each stated accuracy claim. |
| Phase 3 | Responsive signals, larger mapped studies, and constrained alternative search | Controller bounds and explanations are tested; candidate choices survive declared robustness checks. |

Additional acceptance checks:

1. Switch between 2D and 3D during a seeded run and verify identical vehicle counts, signal states, and final metrics to a run with no view changes.
2. Confirm selections refer to the same object in both views and remain usable after edits or vehicle departure.
3. Test zoom/orbit/pan, fit-to-study, keyboard navigation, touch gestures, resized windows, and unsupported/lost graphics contexts.
4. Replay a recorded event from a checkpoint and verify the state and metrics match the original run within declared tolerances.
5. Save/load camera bookmarks, project edits, and baseline locks without changing the physics-input fingerprint.
6. Test the built site under a repository subpath, including 3D assets, workers, project download/import, and print/export controls.
7. Measure browser rendering and simulation throughput separately on a declared workload. Reduced visual detail must not reduce simulated demand or alter the engine time step.
