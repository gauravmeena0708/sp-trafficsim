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

### Network editing (v0.3)

- [x] Independent per-approach lanes, speed, length and turning shares.
- [x] Per-junction green times on the corridor.
- [x] Right-turn pockets with finite storage; overflow blocks through traffic.
- [x] Single-lane roundabout with entries giving way to circulating traffic.
- [x] Pre-run model checks: invalid inputs, ignored demand or settings, shared-lane right turns, indicative over-capacity.

## Phase 1 — reduced scope

The full Phase 1 in the product plan is large. Deliver it in this order, so each step rests on a tested network engine.

### Next: free-form editing

- [x] Grid network editor: place and connect up to 8 signalised junctions on a grid, with per-junction offsets and connectivity checks (arms facing nothing, crossing roads, disconnected junctions, roads with no exit).
- [ ] Free-form geometry: angled and curved roads, two-arm bends, priority (give-way) and unsignalised junctions within a network.
- [x] Per-approach demand on any boundary approach (overrides the directional value; arrivals elsewhere stay paired).
- [x] Custom signal phase plans: movement-level greens, protected/permitted right turns, conflict validation, presets, phase sweeps.
- [ ] Left-turn pockets; per-junction custom plans and clearance times; overlapping movements between phases.
- [ ] Roundabout geometry options (radius, entry width) and multi-lane roundabouts.

### Then: richer studies

- [x] Time-varying demand profiles (shared by all approaches; per-approach profiles not yet).
- [x] Persistent queue events across cycles, marked on the run timeline and listed in the inspector. (Seeking to an event needs replay, below.)
- [x] Precision-based additional replications ("until precise": paired seeds added until each verdict is clear, limit 20).
- [x] Time-series charts in comparisons (longest queue, waiting demand) and a live per-approach queue chart.
- [x] Change summaries between alternatives (design / assumption / run), in the design view, results, CSV and report.
- [ ] Undo/redo, baseline locking, autosave recovery.

### Then: navigable 3D

Build on the network graph so the renderer is not tied to one junction shape (spec §14 and §16).

- [x] Shared simulation state for 2D and 3D views, with no change to numerical results (tested for every template and in the browser).
- [x] Zoom, orbit, tilt, pan, fit/reset presets (plus overview, overhead and street level); accessible mouse, touch, keyboard and on-screen controls.
- [x] Selectable roads and vehicles, legible overlays (labels, queues, signal states, speed classes), camera bookmarks saved with the project, optional vehicle following, 2D fallback. Demand and congestion-event overlays, and selecting junctions or queues as objects, are not yet in 3D.
- [x] Renderer/dependency evaluation (architecture decision 003: dependency-free Canvas 2D projection), no new assets, and a browser frame-time check on the grid workload.

### Deferred within Phase 1

- [ ] Bus routes, stops and dwell; basic pedestrian demand and clearance-aware phase validation.
- [ ] Deterministic event replay with checkpoints.
- [ ] Guided planning templates.

## Phase 2

Population and land-use zones; transparent trip generation, distribution, mode and occupancy assumptions; observed-data import; calibration targets and workflow; independent validation; evidence-informed mixed lateral behaviour. Revisit the engine decision (hosted SUMO adapter) at the start of this phase.

## Phase 3

Density/flow/occupancy/queue measurement inputs; explainable responsive signals within configurable 5–300 second bounds; maximum-wait constraints and downstream checks; reviewed GIS import; larger networks; adaptive routing; optional cost/environment models.
