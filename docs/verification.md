# Verification record

## Grid network editor — 12 November 2026

- Existing templates are unchanged: full results for the four-arm, T-junction, corridor and roundabout templates (plain, with turning, and with a protected-right-turn custom plan; 11 cases) hash identically before and after the change.
- `npm test`: 54 passed (8 new in `test/grid-network.test.js`):
  - the default 2 × 2 grid compiles to 4 junctions with 8 internal, 8 boundary and 8 exit links, and every road can reach an exit;
  - a grid run conserves demand at every step and is deterministic;
  - the layout checks catch arms facing nothing, crossing boundary roads (cleared by shorter approaches), disconnected junctions, shared cells, two-arm junctions, cells off the grid, too many junctions, and layouts on other templates;
  - 200 sampled routes from every entry of a 2 × 3 grid all end at an exit without revisiting a junction;
  - a shared custom plan fits a mix of T and four-arm junctions, and every entry happens on that movement's green at that junction's offset;
  - offsets shift one junction's plan, while paired seeds keep arrivals identical;
  - change summaries name grid edits ("Junction E grid position: no junction → column 3, row 1"), model checks describe directional demand and loops, old projects migrate, and the map places every junction;
  - per-approach demand: zero demand on one approach generates no traffic there, doubling it roughly doubles arrivals, other approaches' arrival times are unchanged, an override equal to the shared value gives identical results, it is classed as an assumption change, and model checks flag unused directional values and demand set on internal links.
- `npm run test:browser`: 15 passed in Chrome 157. The new check:
  - switches to the grid (4 junctions, 16 inspectable approaches);
  - adds a junction that makes roads cross (rejected, focus moved to the new junction), then completes the block (valid, 6 junctions);
  - removes and restores an arm (rejected, then valid, with focus kept on the toggle);
  - gives one boundary approach its own demand (shown as the effective value; no demand field on links between junctions);
  - confirms the settings column does not scroll sideways;
  - runs until trips complete across the grid;
  - leaves the grid and confirms that the layout was removed.
- Benchmark (600 s, five seeds): four-arm 85.6 ms, corridor 191.9 ms, roundabout 134.3 ms, and the new 2 × 2 grid with turns 457.9 ms.

## Signal phase editor — 11 November 2026

- `npm test`: 46 passed (8 new in `test/signal-phases.test.js`):
  - custom cycle arithmetic, phase names, movement-level greens and a "partial" signal head;
  - validation of crossing straights, unserved and non-existent movements, and phase count;
  - every preset valid on every signalised template;
  - a custom plan equal to the two-phase plan reproduces it exactly;
  - with protected right-turn phases, every junction entry happened on that movement's green, and no right turn ever had to give way;
  - with pockets, right-turners waiting for their phase raise no persistent-queue events, while in a single shared lane they do;
  - sweeps target one phase without modifying the source;
  - model checks name permitted right turns and ignored per-junction greens.
- `npm run test:browser`: 14 passed in Chrome 157 and Edge 157. The new check covers:
  - switching to custom phases starts from the equivalent two phases with yielding rights marked;
  - the protected preset gives four phases with none yielding;
  - adding a crossing movement is rejected and blocks the run, with focus kept on the toggle;
  - running shows the right-turn phase by name;
  - phase sweep targets appear;
  - the settings column does not scroll sideways. This caught and fixed an over-wide select.

## Change summaries and precision-based replications — 11 November 2026

- `npm test`: 38 passed (5 new in `test/comparisons.test.js`):
  - change summaries give labels, units and design/assumption/run classes, with turning shares classed as assumptions and design changes first;
  - each precision verdict follows the rule;
  - a 5 s east–west green is clearly **higher** delay, identical inputs are **equivalent**, and different demand is **not paired**, all settled at the initial 5 paired seeds;
  - a marginal 1 s change adds seeds in steps of at most 2 within 5–20 seeds;
  - the CSV and printed report carry change lists, verdicts and the stopping rule.
- `npm run test:browser`: 13 passed in Chrome 157. The new check confirms the design view lists an alternative's change (hidden for the baseline), and an "until precise" comparison shows a higher-delay verdict and a one-change list in the results.

## v0.4 demand profiles, time series and persistent queues — 11 November 2026

- `npm test`: 33 passed (7 new in `test/demand-and-events.test.js`):
  - a profile of equal factors reproduces constant-demand arrivals exactly;
  - a mean-1 peak keeps the request count;
  - a zero-factor period has no arrivals, and a 2× period's count lies within four Poisson standard deviations of expectation;
  - the last factor holds after the profile ends;
  - series sample every 10 s and end at the run totals;
  - light demand gives no persistent-queue events, while east–west overload gives dated, two-cycle events on those approaches only;
  - an over-capacity roundabout raises events and a light one does not;
  - profile validation and model checks.
- `npm run test:browser`: 12 passed in Chrome 157 (2 new):
  - comparison time charts show a legend for both alternatives, a crosshair tooltip listing every series, a keyboard-readable plot (End reads 10:00) and a table view;
  - the profile editor switches to custom on edit, flags a profile that adds demand, and blocks an out-of-range factor;
  - a surge run draws the live queue chart, lists a persistent queue, selects its approach on click, and marks it on the timeline.
- Screenshots of the comparison charts, the live inspector and the profile editor were reviewed.
- The chart palette was validated with the dataviz checker on a white surface: all hard checks pass. Three slots are below 3:1 contrast, so the charts keep a legend, direct labels for up to four series, and a table view.
- Default-scenario results are unchanged from v0.3: 391 completed trips with seed 42, because a constant profile uses the same draws.

## Browser checks — 11 November 2026

`npm run test:browser` (`scripts/browser-checks.mjs`) runs against the built site in CI and locally. It passed 10/10 in Chrome 157 and Edge 157 on Windows, against both `dist/` and the source tree. It verifies:

- **Keyboard.** Arrow, Home and End keys switch tabs. Enter starts a run and Space pauses it. Enter selects an approach. Enter opens the help dialog and Escape closes it. Tab reaches the project, tab, scenario and run controls in order, and the focused run button has a visible focus indicator.
- **Accessible names.** Every button, text field, number field, select, checkbox, slider, tab and link in the accessibility tree has a name (design and compare views).
- **Project files.** **Save project** downloads a current-schema file that `parseProject` accepts. **Open project** applies an imported corridor scenario and discards fabricated results with a notice. An invalid file is rejected with an explanation and leaves the current project unchanged.
- **Export and print.** A two-scenario comparison exports a CSV with 6 per-seed rows, and a formula-like scenario name is neutralised. **Print report** calls `window.print` with complete report metadata. Under print media, the editing UI is hidden and the results table is shown.
- **Touch and small screens.** At 390 × 844 with touch emulation, the page does not scroll horizontally, approach buttons are at least 24 px, tapping a button selects that approach, and tapping the map selects the nearest arm.
- **No script errors** during any of the above.

One defect was found and fixed: pausing during warm-up still showed **Warm-up**. The run state now reads **Paused**, or **Ready** before the first step.

**Not covered:**

- Firefox and Safari (no DevTools protocol support);
- real screen readers;
- real touch hardware;
- actual printed output and the operating system's file dialogs (the checks call `window.print` and set files directly).

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

On 11 November 2026 the Pages source was switched to **GitHub Actions**, so the site now deploys only from the workflow, after check, test and build pass.

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
