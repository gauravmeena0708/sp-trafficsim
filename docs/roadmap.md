# Delivery roadmap

The [product plan](product-spec.md) defines the target. This checklist distinguishes what exists from what remains.

## Implemented first slice

- [x] Modular static application and GitHub Pages workflow.
- [x] Configurable four-arm straight-through junction: shared length, lanes, speed.
- [x] Two fixed-time phase groups with 5–300 second greens and separate clearance intervals.
- [x] Directional constant demand, fleet composition, occupancy assumptions and sensitivity multiplier.
- [x] Deterministic time-stepped animation, run controls and approach inspector.
- [x] Boundary waiting and conservation; unfinished demand remains visible.
- [x] Scenario duplication, local persistence, versioned project download/import.
- [x] Worker-based paired-seed comparisons and configurable timing sweeps.
- [x] CSV per-seed results, printable report, input/seed/version metadata and stale-result warnings.
- [x] Automated core correctness checks and documented illustrative status.

## Complete Phase 1

### Next increment: navigable 3D

- [ ] Shared simulation state for 2D and 3D views, with no change to numerical results.
- [ ] Zoom, orbit, tilt, pan, fit/reset presets, and accessible mouse/touch/keyboard controls.
- [ ] Simple road, signal, and vehicle geometry; selectable objects and legible overlays.
- [ ] Camera bookmarks, optional vehicle following, and a 2D fallback.
- [ ] Renderer/dependency evaluation, GitHub Pages asset checks, and browser performance verification.

See Sections 14–16 of the product plan for the full extension requirements and acceptance criteria.

### Remaining planning capabilities

- [ ] Editable connected-network graph with independent per-road properties.
- [ ] Explicit turn trajectories, lane connections, pockets, median cuts and U-turns.
- [ ] T-junction, four-arm and single-lane roundabout templates with actual priority rules.
- [ ] Finite downstream storage and multi-junction spillback.
- [ ] Fixed-time coordination offsets exposed in the editor.
- [ ] Time-varying demand profiles and declared routes/turning shares.
- [ ] Bus routes/stops/dwell, basic pedestrian demand and clearance-aware phase validation.
- [ ] Persistent queue events and stronger evidence links for contributing causes.
- [ ] Low/central/high batch matrix, route/mode indicators, paired-difference confidence intervals and precision-based additional replications.
- [ ] Undo/redo and guided planning templates.
- [ ] Baseline locking, autosave recovery, and actionable pre-run model checks.
- [ ] Deterministic event replay with checkpoints and timeline navigation.
- [ ] Synchronised comparison views, change summaries, time-series charts, and annotated exports.
- [ ] Reference hardware/workload benchmark and expanded browser/accessibility checks.

## Phase 2

Population and land-use zones; transparent trip generation/distribution, mode and occupancy assumptions; observed-data import; calibration targets and workflow; independent validation; evidence-informed mixed lateral behaviour; established-engine integration decision revisited.

## Phase 3

Density/flow/occupancy/queue measurement inputs; explainable responsive signals within configurable 5–300 second bounds; maximum-wait constraints and downstream checks; reviewed GIS import; larger networks; adaptive routing; optional cost/environment models.

Do not mark these capabilities complete by adding controls without implementing and checking their simulated effects.
