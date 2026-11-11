# Working rules for this repository

Junction is a static, dependency-free browser workbench for exploring traffic-planning ideas. The product target is [docs/product-spec.md](docs/product-spec.md); progress is tracked in [docs/roadmap.md](docs/roadmap.md).

## Commands

Node.js 22+. No runtime or build dependencies.

```sh
npm run dev        # serve source on http://127.0.0.1:5173 (module workers need HTTP)
npm test           # node:test correctness suite
npm run check      # syntax, relative imports, GitHub Pages-safe asset paths
npm run build      # static site in dist/
npm run benchmark  # headless engine timing on the declared reference workload
```

Run `npm run check && npm test` before every commit. CI runs check, test and build on every push; `.github/workflows/pages.yml` deploys `dist/` from `main`.

## Module boundaries

- `src/model/` — schema, validation, import/export, network compilation. No DOM.
- `src/simulation/` — engine, signals, random streams, experiments, worker. No DOM. Physics lives only here.
- `src/diagnostics/` — evidence-limited explanations read from simulation state.
- `src/ui/` — rendering and report formatting. Must not change physics or results.
- `src/main.js` — wires browser controls and persistence to the modules above.

Renderers and diagnostics read the compiled network and engine state; never hard-code a single junction shape in new code.

## Non-negotiable modelling rules

- Results are **Illustrative**. Never present them as calibrated, validated, or predictive. Status changes need documented evidence (spec §10).
- Never silently discard demand. `requested = completed + inNetwork + waitingOutside` must hold at every step.
- Fixed 0.2 s time step independent of frame rate; identical inputs and seeds must give identical results.
- Signal settings must control simulated movement permissions, not just drawing.
- Diagnostics describe likely contributors with evidence; unknown stays unknown. No "phantom jam" labels.
- Report unfinished trips and entry waiting alongside delay; a scenario must not look better because fewer vehicles were served.
- Do not tick a roadmap item by adding controls without implementing and testing the simulated effect.

## Change discipline

- Bump `ENGINE_VERSION` in `src/model/project.js` when physics or metric definitions change; bump `SCHEMA_VERSION` (with a migration) when the saved project shape changes.
- Update `docs/model-assumptions.md` whenever behaviour or a metric definition changes.
- Keep asset and worker paths relative so the site works under a repository subpath.
- Imported results are never trusted; they are discarded on import.
