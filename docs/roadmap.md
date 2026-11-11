# Delivery roadmap

The [product plan](product-spec.md) defines the target. This checklist distinguishes what exists from what remains. Do not tick an item by adding controls without implementing and checking its simulated effect.

## Implemented

### First slice (v0.1)

- [x] Modular static application and GitHub Pages workflow.
- [x] Two fixed-time phase groups with 5–300 second greens and separate clearance intervals.
- [x] Directional constant demand, fleet composition, occupancy assumptions and sensitivity multiplier.
- [x] Deterministic time-stepped animation, run controls and approach inspector.
- [x] Boundary waiting and conservation; unfinished demand remains visible.
- [x] Scenario duplication, local persistence, versioned project download/import.
- [x] Worker-based paired-seed comparisons and configurable timing sweeps.
- [x] CSV per-seed results, printable report, input/seed/version metadata and stale-result warnings.

### Network foundation (v0.2)

- [x] Engine decision revisited and recorded ([Decision 002](architecture.md)).
- [x] Network graph model (nodes, directed links, lane-level junction paths) with schema v2 and v1 migration.
- [x] Four-arm, T-junction and two-junction corridor templates compiled to the graph.
- [x] Turning movements from declared shares, with kerbside/median lane use.
- [x] Geometric conflict detection between junction paths; permissive right turns with gap acceptance.
- [x] Finite link storage, no blocking the box, and multi-junction spillback with evidence in the inspector.
- [x] Coordination offset between corridor junctions.
- [x] Paired-difference 95% intervals against the baseline scenario.
- [x] Timing sweeps for either signal group under low/central/high demand, flagging conclusions that change with demand.
- [x] Contiguous queue definition replacing the v0.1 slow-vehicle extent.
- [x] Headless-browser verification of the main workflows.

## Phase 1 — reduced scope

The full Phase 1 in the product plan is large. Deliver it in this order, so each step rests on a tested network engine.

### Next: complete the network editor

- [ ] Independent per-road properties (length, lanes, speed) and per-approach turning shares.
- [ ] Per-junction signal plans, including separate greens per junction.
- [ ] Free-form editing of connected junctions with connectivity checks.
- [ ] Turning pockets with finite storage, and their overflow blocking through traffic.
- [ ] Basic single-lane roundabout with entry yielding to circulating traffic.
- [ ] Pre-run model checks: disconnected routes, impossible turns, invalid phases.

### Then: richer studies

- [ ] Time-varying demand profiles.
- [ ] Persistent queue events across cycles; event timeline.
- [ ] Precision-based additional replications.
- [ ] Time-series charts and change summaries in comparisons.
- [ ] Undo/redo, baseline locking, autosave recovery.

### Then: navigable 3D

Build on the network graph so the renderer is not tied to one junction shape (spec §14 and §16).

- [ ] Shared simulation state for 2D and 3D views, with no change to numerical results.
- [ ] Zoom, orbit, tilt, pan, fit/reset presets; accessible mouse, touch and keyboard controls.
- [ ] Selectable objects, legible overlays, camera bookmarks, optional vehicle following, 2D fallback.
- [ ] Renderer/dependency evaluation, Pages asset checks, and browser performance verification.

### Deferred within Phase 1

- [ ] Bus routes, stops and dwell; basic pedestrian demand and clearance-aware phase validation.
- [ ] Deterministic event replay with checkpoints.
- [ ] Guided planning templates.

## Phase 2

Population and land-use zones; transparent trip generation, distribution, mode and occupancy assumptions; observed-data import; calibration targets and workflow; independent validation; evidence-informed mixed lateral behaviour. Revisit the engine decision (hosted SUMO adapter) at the start of this phase.

## Phase 3

Density/flow/occupancy/queue measurement inputs; explainable responsive signals within configurable 5–300 second bounds; maximum-wait constraints and downstream checks; reviewed GIS import; larger networks; adaptive routing; optional cost/environment models.
