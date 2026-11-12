# Architecture and engine decisions

## Decision 001: static first slice, replaceable engine

The hosting target is GitHub Pages. The workbench uses native browser modules, Canvas, and a module worker, with dependency-free Node build and test tooling. There is no router requiring server rewrites, no server-side state, and no credentials. Relative assets work under repository subpaths.

## Decision 002 (11 November 2026): keep a custom browser engine through Phase 1, on an explicit network graph

**Context.** Before connected networks, turns and spillback were built, the engine choice was revisited (spec §6). Those features are where custom engines become expensive.

| Option | Assessment |
| --- | --- |
| SUMO as a hosted service (TraCI) | Mature car-following, lane-changing, sublane, roundabout and signal models, plus established calibration practice. Requires separately hosted compute, which GitHub Pages cannot provide; adds operations, cost and a network dependency to every run. SUMO is EPL-2.0 licensed. Browser visualisers such as SUMO-Web3D still drive a server-side SUMO process. |
| SUMO compiled to WebAssembly | No official or maintained browser build was found (desk search, November 2026). A port would require a dedicated feasibility project: build, file-system shims, performance and licence review. |
| Custom browser engine | Runs entirely on static hosting, is deterministic and inspectable, and is cheap to deploy. Its behaviour models are simplified and must stay labelled illustrative until calibrated and validated. |

**Decision.** Continue the custom engine for Phase 1, under these constraints:

- The engine consumes a compiled **network graph** (nodes, directed links with lanes, lane-level junction paths) rather than a hard-coded junction. Templates compile into this graph, and a future free-form editor will produce the same structure.
- Result contracts (inputs, seed, engine version, measurement window, boundary accounting, status) stay engine-independent, so a SUMO adapter could produce the same result shape.
- **Revisit triggers:** the start of Phase 2 calibration work; a requirement for lane changing or sublane filtering beyond what can be validated here; or networks too large for browser-worker run times on the reference benchmark. At that point, evaluate a hosted SUMO adapter behind the existing worker interface.

SUMO's [sublane documentation](https://sumo.dlr.de/docs/Simulation/SublaneModel.html) remains the reference for future lateral behaviour. Do not assume this prototype implements equivalent physics.

## Decision 003 (12 November 2026): a dependency-free 3D view on Canvas 2D

The spec (§14) asks for a maintained browser 3D renderer to be evaluated before adoption. The options considered:

- **three.js** (MIT) and **Babylon.js** (Apache-2.0) are mature WebGL renderers with lighting, depth buffers and instancing. Either would add the project's first runtime dependency, at several hundred kilobytes of minified script. Each would also need a vendored copy for offline and subpath hosting, a version-pinning and update policy, and a separate WebGL fallback path.
- **Raw WebGL** avoids a dependency, but needs shaders, buffers and context-loss handling for a scene that is small: at most eight junctions and a few hundred box-shaped vehicles.
- **Perspective projection onto Canvas 2D** (chosen):
  - roughly 700 lines in `src/ui/scene3d.js`, with no dependency and no assets;
  - the same browser support as the 2D plan;
  - a 2D fallback that needs no other graphics stack.

  It clips polygons to the near plane, culls back faces of vehicle boxes, shades faces with a fixed light, and paints solid objects far to near.

The measured cost is low. On a 1200 × 700 canvas, the 2 × 2 grid with 203 vehicles draws in a median of about 3 ms (90th percentile under 5 ms) at full detail, and 1.0 ms at reduced detail. That is in headless Chrome 157 with software rendering (`--disable-gpu`); see the browser checks.

The frame budget is 50 ms on that workload, which the browser checks enforce. Revisit this decision if the 3D view needs:
- depth-correct overlap;
- textured scenery or terrain;
- networks much larger than eight junctions.

## Boundaries

- `model/project.js`: versioned scenarios, validation, schema migration, import. No DOM.
- `model/network.js`: compiles templates and per-approach settings to the network graph; movement classification, route choice from declared shares, pockets, priority (roundabout) nodes, junction path geometry and conflict detection. No DOM.
- `model/checks.js`: pre-run model checks, separating blocking errors from assumptions to review. No DOM.
- `simulation`: consumes a scenario, steps time, and produces snapshots and results. No DOM.
- `diagnostics`: interprets recorded state without claiming exact causal proof.
- `ui`: renders any compiled network (2D plan in `canvas.js`, 3D view in `scene3d.js`) and exports results without changing physics.
- `main`: connects browser controls and persistence to those modules.
- `worker`: runs the same engine for repeated-seed experiments without blocking the workbench.

Keep physics in `simulation` and graph construction in `model/network.js`. Maintain an adapter rather than moving physics into UI handlers.

## Persistence and security

Schema version 7 adds project-level camera bookmarks, which are sanitised on import and never affect scenario inputs. Projects support up to 30 scenarios and project imports up to 5 MB. Schema 1 and 2 projects and browser storage are migrated on load. Imports validate all required numerical ranges, template names, per-approach and per-junction settings, pocket lengths and unique IDs. Imported reports are discarded rather than accepted with a fabricated validated status. Model status is always illustrative in this release.

Project names are escaped before HTML insertion. CSV cells guard against spreadsheet formula prefixes. The development server binds only to loopback and checks resolved paths. Generated output is ignored by Git. No analytics, remote fonts, external scripts, secrets, or storage services are used.

## Verification

See [verification.md](verification.md). Node tests check conservation, spacing and conflict-free junction occupancy at every step for every template. Browser behaviour is exercised separately through a headless-browser drive of the built-in workflows. Neither is model validation.
