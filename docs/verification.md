# Verification record

## v0.3 network editing — 11 November 2026

### Automated checks

- `npm run check`: passed.
- `npm test`: 26 tests passed, 0 failed (9 new, in `test/network-editor.test.js`).

The new tests cover:

- **Roundabout routes:** circulation is clockwise; first/second/third exit maps to left/straight/right; all links are single-lane priority links.
- **Roundabout under heavy load** (900 veh/h per arm, 1,200 s): conservation, spacing and conflict-free occupancy hold at every step (only converging paths share a junction, one behind the other). More than 100 trips still complete in the second half, so it doesn't lock up, and overload is retained as waiting demand.
- **Give-way rule:** an entering vehicle at the give-way line may enter with an empty ring, and must yield when a circulating vehicle is 8 m away at 6 m/s.
- **Pocket overflow:** a 15 m right-turn pocket overflows under 50% right-turners. A 150 m pocket overflows less. Invariants hold at every step, and the pocket geometry compiles as specified.
- **Per-approach overrides** change only their approach: lanes, length, speed (vehicle desired speeds) and turning shares (all west traffic turns left).
- **Corridor per-junction greens:** junction B's own 90 s green differs from A's at t = 60 s, and invariants hold through a run.
- **Validation** of unknown settings, over-long pockets, turning shares over 100%, and out-of-range junction greens.
- **Model checks:** ignored T-junction north demand, shared-lane right turns (cleared by a pocket), unused settings, ignored roundabout lane counts, indicative over-capacity, and blocking errors.
- **Schema 2 → 3 migration.**

### Browser checks

Headless Chrome was driven through the DevTools protocol against `npm run dev`, with no page or console errors. The drive:

1. Set a west-approach right-turn share and pocket. The run reported **Right-turn pocket full** in the inspector.
2. Switched to the corridor and gave junction B its own green. The cycle label showed `75 / 105s` and the phases diverged during the run.
3. Switched to the roundabout. Priority control was shown, the model checks listed the ignored settings, the inspector listed the circulating links, and the timing sweep was refused with an explanation.
4. Entered an invalid lane count. The validation message appeared and **Run** was disabled.

Screenshots were reviewed. Lane widths and the roundabout are drawn at an exaggerated lateral scale for legibility.

**Still not browser-checked:**

- file download, print and import dialogs;
- touch and keyboard-only use;
- screen readers;
- browsers other than Chrome.

### Engine benchmark

Same machine and settings as v0.2 (600 simulated seconds, five seeds):

| Workload | Median run time |
| --- | --- |
| Four-arm straight-through | 85.8 ms |
| Corridor with turns | 209.2 ms |
| Roundabout, 25% left / 25% right | 142.8 ms |

### Deployment

Unchanged: the Pages source must be switched to **GitHub Actions** before the deploy workflow can succeed.

## v0.2 network foundation — 11 November 2026

### Automated checks

- `npm run check` (syntax, relative module dependencies, Pages-safe asset paths): passed.
- `npm test`: 17 tests passed, 0 failed.

The tests check the following at **every time step**, for the four-arm, T-junction and corridor templates under heavy turning demand:

- boundary conservation;
- minimum spacing on every lane of every link;
- no vehicle behind a link start or past a stop line;
- no two vehicles in a junction on conflicting paths.

They also cover:

- routes following connected links and ending at an exit, with no U-turns;
- left-hand movement classification and turning-share routing, including renormalisation on the T-junction stem;
- spillback of a corridor link into the upstream junction under an offset plan;
- the contiguous queue definition;
- schema 1 migration and turning-share validation;
- paired-difference intervals against a hand calculation;
- sweep configuration limits and staleness;
- determinism, paired arrival/fleet streams, CSV safety and the 5/300-second endpoints, as in v0.1.

### Browser checks

A local headless Chrome session was driven through the DevTools protocol against `npm run dev`. With no page errors or console errors, it:

1. switched between all three templates;
2. set turning shares;
3. ran the animated simulation at maximum playback speed;
4. read the inspector for boundary and internal links;
5. duplicated a scenario, changed its green and ran a three-seed comparison, which rendered the paired-difference column;
6. ran a north–south sweep under three demand levels, which rendered the per-demand findings.

Screenshots were reviewed for layout.

**Not yet checked in a browser:**

- file download, print and project import dialogs;
- touch and keyboard-only use;
- screen-reader output;
- browsers other than Chrome.

### Engine benchmark

`npm run benchmark` on Windows, Node v24.19.0, Intel Core i5-10400 at 2.90 GHz, 600 simulated seconds at 0.2-second steps, five seeds each:

| Workload | Median run time | Requested vehicles |
| --- | --- | --- |
| Four-arm, straight-through, 2 lanes, 250 m approaches, default demand | 76.9 ms | 396–441 |
| Corridor, 20% left / 15% right turns, 200 m link | 180.2 ms | 546–633 |

This measures the engine without rendering. The v0.1 single-junction median was 48.6 ms on the same machine; the network engine is slower because of path-conflict and gap-acceptance checks. It is neither a frame-rate benchmark nor evidence of model accuracy.

### Deployment

The repository's Pages source was still **Deploy from a branch**. Under that setting, the first run of the GitHub Actions deploy workflow failed at `configure-pages` ("Get Pages site failed"). Switch **Settings → Pages → Source** to **GitHub Actions**, then re-run the workflow. Field calibration and independent validation have not been performed.

## v0.1 first slice

10 Node tests passed; HTTP smoke checks passed; a headless browser was not available in that session. Benchmark median 48.6 ms for the four-arm straight-through workload.
