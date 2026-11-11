# Junction — Traffic planning workbench

A browser-based workbench for exploring road-planning ideas before implementation. This repository starts the first phase of the [product plan](docs/product-spec.md), with four-arm, T-junction and two-junction corridor templates on an explicit network model, turning traffic, spillback between junctions, and reproducible signal-timing experiments.

**Current status: illustrative prototype, not field-calibrated or validated.** Do not interpret its results as engineering predictions.

## Run locally

Use Node.js 22 or newer. There are no third-party runtime or build dependencies.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Serve the app over HTTP; opening `index.html` as a file will not load module workers correctly.

```sh
npm run check
npm test
npm run build
npm run preview
npm run benchmark
npm run test:browser   # after build; needs Chrome, Edge or Chromium
```

`test:browser` drives a headless Chromium-based browser through the DevTools protocol. It covers:

- keyboard use and accessible names;
- project save and import (including rejected files);
- CSV export and print layout;
- a phone-sized touch layout.

Pass `--browser <path>` to choose a browser, or `--source` to test the source tree instead of `dist/`. Firefox and Safari are not covered.

`build` creates a standalone static site in `dist/`. All app asset and worker paths are relative, so GitHub repository subpaths work without a custom base-path configuration.

## Try a study

1. Choose a layout template: four-arm, T-junction, two-junction corridor or single-lane roundabout. Then configure shared road lengths, lane counts, speed limits, directional demand, turning shares and vehicle mix. Under **Approach settings**, give any approach its own lanes, speed, length, turning shares or a right-turn pocket. On the corridor, set the link length, junction B's offset, and optionally each junction's own green times.
2. Review the **Model checks** under the settings. They separate blocking errors from assumptions worth reviewing, such as ignored demand, right-turners sharing a single lane, or demand above an indicative discharge rate.
3. Set independent east–west and north–south green durations from **5 to 300 seconds**. Yellow and all-red intervals are separate.
4. Run, pause, change playback speed, and inspect each approach — including links between junctions — for signal holds, blocked receiving lanes and spillback.
5. Duplicate the baseline and modify an alternative.
6. Open **Compare options** and run paired-seed replications (with 95% intervals on the change from the baseline), or sweep either signal group's green under low, central and high demand.
7. Compare delay with completed trips and waiting demand. Read the charts over time for queues that build and never clear, and the persistent-queue columns. Export per-seed CSV, print a report, or download the complete project JSON.

Under **Traffic demand → Demand over time**, choose a preset (mid-run peak, short surge, steadily rising) or enter your own factors per period to model a peak rather than a flat hour. While a run plays, the inspector charts the selected approach's queue and lists **persistent queues**: approaches where vehicles waiting at the start of green were still there at its end, two cycles running.

Valid scenario inputs are automatically saved in this browser. Download project files for portable backups. Imported result claims are discarded; rerun experiments to produce trusted local outputs. No project data is sent to a server. Static hosting will still receive normal page/asset requests.

## Host on GitHub Pages

The repository is initialized on `main`; no remote repository is assumed or created.

1. Create an empty GitHub repository and add its URL as the `origin` remote.
2. Commit and push this project to `main`.
3. In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source. (If it is left on *Deploy from a branch*, the deploy workflow fails at `configure-pages`.)
4. The **Deploy GitHub Pages** workflow checks, tests, and builds the app before deploying `dist/`. If the first push preceded the Pages setting, rerun that workflow or dispatch it manually.

```sh
git add .
git commit -m "Start traffic planning workbench"
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```

The expected project-site URL is `https://YOUR-ACCOUNT.github.io/YOUR-REPOSITORY/`. A separate check workflow runs on pushes and pull requests. No API keys, paid hosting, backend server, or secrets are needed for this slice. Deployment permissions are limited to the deploy job.

See [GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Structure

```text
index.html                 Accessible workbench shell
styles.css                 Responsive interface and print styles
src/
  model/project.js         Versioned scenarios, validation, migration, import
  model/network.js         Template → network graph, routes, pockets, roundabout, conflicts
  model/checks.js          Pre-run model checks
  simulation/
    engine.js              Deterministic fixed-step network simulation
    signals.js             Two-group fixed-time signals with offsets
    random.js              Seeded random generator
    experiments.js         Replications, sweep candidates, statistics
    worker.js              Background comparisons and sweeps
  diagnostics/explain.js   Evidence-limited queue explanations
  ui/canvas.js             Schematic rendering of any compiled network
  ui/reports.js            Comparison display, CSV, print metadata
  main.js                  UI state and feature integration
scripts/                   Dependency-free development/build/check tools
test/                      Simulation and persistence correctness checks
docs/                      Product spec, architecture, model assumptions, roadmap, verification
CLAUDE.md                  Working rules for contributors and coding agents
.github/workflows/         CI and GitHub Pages deployment
```

Read the [architecture decision](docs/architecture.md), [model assumptions](docs/model-assumptions.md), [delivery roadmap](docs/roadmap.md), and [verification record](docs/verification.md) before extending the engine. No project license has been selected yet; public hosting does not itself grant an open-source license.
