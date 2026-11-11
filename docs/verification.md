# Initial verification record

Checked on 11 November 2026.

## Automated checks

- JavaScript syntax and relative module dependencies: passed.
- Entry-point asset paths for GitHub Pages subpath hosting: passed.
- Node correctness suite: 10 tests passed, 0 failed.
- Static production build: passed.
- HTTP smoke checks: source entry point, stylesheet, main module and module worker returned 200 with expected content types. Built entry point and worker also returned 200 under the `/dist/` subpath.

Tests cover signal phase boundaries, the 5/300-second endpoints, repeatability, conservation and lane spacing under overload, non-conflicting crossing occupancy, empty demand, paired arrival/fleet streams, import validation, sweep limits, sample standard deviation, seed metadata, stale results and CSV formula safety.

## Engine performance sample

Run `npm run benchmark` to reproduce the workload. The initial sample used Windows, Node v24.19.0, and an Intel Core i5-10400 at 2.90 GHz.

Workload: one four-arm junction, two lanes per direction, 250 m approaches, 2,500 requested vehicles/hour in total, 600 simulated seconds, and a 0.2-second time step. Five measured seeds after one warm-up execution took 28.3–75.5 ms each (median 48.6 ms). Requested vehicle counts ranged from 396 to 441.

This measures the engine without rendering. It is neither a browser frame-rate benchmark nor evidence of traffic-model accuracy. Results vary with runtime and hardware.

## Verification still required

Launching a headless browser was rejected by the environment's automatic approval policy. Visual layout, browser interactions, download/print behaviour, accessibility, and browser worker execution were therefore not verified in an actual browser during this session. HTTP checks do not substitute for these checks.

No remote repository was configured and no GitHub Pages deployment was attempted. The workflow must be verified after pushing to a repository with Pages configured for GitHub Actions. Field calibration and independent validation have not been performed.
