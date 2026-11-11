# Junction — Traffic planning workbench

A browser-based workbench for exploring road-planning ideas before implementation. This repository starts the first phase of the [product plan](docs/product-spec.md), with a working four-arm junction and reproducible signal-timing experiments.

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
```

`build` creates a standalone static site in `dist/`. All app asset and worker paths are relative, so GitHub repository subpaths work without a custom base-path configuration.

## Try a study

1. Configure shared approach lengths, lane counts, speed limits, directional demand, and vehicle shares.
2. Set independent east–west and north–south green durations from **5 to 300 seconds**. Yellow and all-red intervals are separate.
3. Run, pause, change playback speed, and inspect each approach's queues and boundary waiting.
4. Duplicate the baseline and modify an alternative.
5. Open **Compare options** and run paired-seed replications, or sweep east–west green durations.
6. Compare delay with completed trips and waiting demand. Export per-seed CSV, print a report, or download the complete project JSON.

Valid scenario inputs are automatically saved in this browser. Download project files for portable backups. Imported result claims are discarded; rerun experiments to produce trusted local outputs. No project data is sent to a server. Static hosting will still receive normal page/asset requests.

## Host on GitHub Pages

The repository is initialized on `main`; no remote repository is assumed or created.

1. Create an empty GitHub repository and add its URL as the `origin` remote.
2. Commit and push this project to `main`.
3. In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.
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
  model/project.js         Versioned scenarios, validation, import
  simulation/
    engine.js              Deterministic fixed-step lane simulation
    signals.js             Two-phase signal state machine
    random.js              Seeded random generator
    experiments.js         Replications, sweep candidates, statistics
    worker.js              Background comparisons and sweeps
  diagnostics/explain.js   Evidence-limited queue explanations
  ui/canvas.js             Schematic junction rendering
  ui/reports.js            Comparison display, CSV, print metadata
  main.js                  UI state and feature integration
scripts/                   Dependency-free development/build/check tools
test/                      Simulation and persistence correctness checks
docs/                      Architecture, model assumptions, roadmap
.github/workflows/         CI and GitHub Pages deployment
```

Read the [architecture decision](docs/architecture.md), [model assumptions](docs/model-assumptions.md), [delivery roadmap](docs/roadmap.md), and [verification record](docs/verification.md) before extending the engine. No project license has been selected yet; public hosting does not itself grant an open-source license.
