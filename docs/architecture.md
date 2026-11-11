# Architecture and engine decision

## Decision 001: static first slice, replaceable engine

The hosting target is GitHub Pages. The initial workbench uses native browser modules, Canvas, and a module worker, with dependency-free Node build and test tooling. There is no router requiring server rewrites, no server-side state, and no credentials. Relative assets work under repository subpaths.

This is a bounded first implementation, not completion of Phase 1. A single editable junction allows timing, demand, reproducibility, storage, comparison, and accounting contracts to be exercised before a connected-network editor is added.

## Alternatives considered

| Option | Advantages | Costs and current decision |
| --- | --- | --- |
| SUMO with a service | Established modelling capabilities, signals, routing, roundabouts and sublane support; suitable for deeper calibration work | A normal SUMO service cannot run on GitHub Pages alone. Requires separately hosted compute or a verified browser-compatible integration. Retain as the leading established-engine candidate for later evaluation. |
| Custom browser model | Runs entirely on static hosting; inspectable and deterministic; low deployment complexity | Requires substantial validation and lacks mature behaviour models. Selected only for an explicitly illustrative, straight-through junction slice. |
| Browser WebAssembly integration | Could retain static hosting with a more capable engine | Packaging, licensing, performance, supported engine interfaces, and reproducibility need a dedicated feasibility study before adoption. |

SUMO's [sublane documentation](https://sumo.dlr.de/docs/Simulation/SublaneModel.html) provides a reference for required future lateral behaviour. Do not assume this prototype implements equivalent physics.

## Boundaries

- `model`: validates and serializes scenarios independently of the DOM.
- `simulation`: consumes a scenario, steps time, and produces snapshots/results; no DOM dependencies.
- `diagnostics`: interprets recorded state without claiming exact causal proof.
- `ui`: renders state and exports results without changing physics.
- `main`: connects browser controls and persistence to those modules.
- `worker`: executes the same engine for repeated-seed experiments without blocking the workbench.

Engine results include a version, exact inputs, random seed, measurement duration, boundary accounting, and model status. Preserve these contracts when introducing a service or another engine; maintain an adapter rather than moving physics into UI handlers.

## Persistence and security

Schema version 1 supports up to 30 scenarios and project imports up to 5 MB. Imports validate all required numerical ranges and unique IDs. Imported reports are discarded rather than accepting a fabricated validated status. Model status is always illustrative in this release.

Project names are escaped before HTML insertion. CSV cells guard against spreadsheet formula prefixes. The development server binds only to loopback and checks resolved paths. Generated output is ignored by Git. No analytics, remote fonts, external scripts, secrets, or storage services are used.

## Verification

Node tests exercise phase boundaries, non-conflicting crossing groups, deterministic demand streams, vehicle conservation at every time step under overload, lane spacing, empty demand, import validation, sweep endpoints, statistical calculations, stale results, and CSV safety. Static checks verify JavaScript syntax and relative entry-point assets. Browser interaction and deployment verification remain separate from model validation.
