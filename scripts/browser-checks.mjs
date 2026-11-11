// Dependency-free browser checks driven through the Chrome DevTools Protocol.
// Usage: npm run test:browser [-- --browser <path>] [-- --source]
// Serves the built site (dist/) by default, or the source tree with --source.
// Works with Chromium-based browsers (Chrome, Edge, Chromium). Firefox and
// Safari do not expose this protocol and are not covered here.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseProject, SCHEMA_VERSION } from '../src/model/project.js';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const siteRoot = args.includes('--source') ? root : join(root, 'dist');

function findBrowser() {
  const candidates = [option('--browser'), process.env.BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  const found = candidates.find(p => existsSync(p));
  if (!found) throw new Error('No Chromium-based browser found. Pass --browser <path> or set BROWSER_PATH.');
  return found;
}

// ---------------------------------------------------------------- processes
const work = mkdtempSync(join(tmpdir(), 'junction-browser-'));
const downloads = join(work, 'downloads');
const children = [];
function cleanup() { for (const child of children) child.kill(); try { rmSync(work, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);

async function startServer() {
  if (!existsSync(join(siteRoot, 'index.html'))) throw new Error(`No site at ${siteRoot}. Run npm run build first, or pass --source.`);
  const server = spawn(process.execPath, [join(root, 'scripts/serve.mjs'), siteRoot], { env: { ...process.env, PORT: '0' } });
  children.push(server);
  let output = '';
  server.stdout.on('data', d => { output += d; });
  for (let i = 0; i < 100 && !/http:\/\/[\d.]+:\d+/.test(output); i++) await wait(50);
  const url = output.match(/http:\/\/[\d.]+:\d+/)?.[0];
  if (!url) throw new Error('The local server did not start.');
  return `${url}/`;
}

async function startBrowser(path) {
  const profile = join(work, 'profile');
  const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'];
  if (process.env.CI) flags.unshift('--no-sandbox');
  children.push(spawn(path, flags, { stdio: 'ignore' }));
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await wait(50);
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  let version;
  for (let i = 0; i < 40 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await wait(100); } }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  return { browserUrl: version.webSocketDebuggerUrl, pageUrl: pages.find(p => p.type === 'page').webSocketDebuggerUrl, product: version.Browser };
}

// ---------------------------------------------------------------- protocol
async function connect(url, errors) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.addEventListener('open', ok); ws.addEventListener('error', fail); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (!errors) return;
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const n = ++id;
    pending.set(n, msg => msg.error ? fail(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}

// ---------------------------------------------------------------- test runner
const results = [];
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`  ✔ ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log(`  ✖ ${name}\n      ${error.message}`); }
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const browserPath = findBrowser();
const siteUrl = await startServer();
const { browserUrl, pageUrl, product } = await startBrowser(browserPath);
console.log(`Browser checks · ${product} · ${siteUrl}`);
const pageErrors = [];
const browser = await connect(browserUrl);
const page = await connect(pageUrl, pageErrors);
await page.send('Runtime.enable');
await page.send('Page.enable');
await page.send('DOM.enable');
await page.send('Accessibility.enable');
await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

const evaluate = async expression => {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};
async function waitFor(expression, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await wait(100); }
  throw new Error(`Timed out: ${message}`);
}
const setViewport = (width, height, mobile = false) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
const key = async (keyName, code = keyName, keyCode = 0, modifiers = 0) => {
  const text = keyName === 'Enter' ? '\r' : keyName === ' ' ? ' ' : undefined;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers, text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
};
// Raw touch events: Chrome turns a short touch into a click, as on a phone.
const tap = async (x, y) => {
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await wait(40);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const activeId = () => evaluate('document.activeElement?.id || document.activeElement?.dataset?.link || document.activeElement?.tagName');
async function nextDownload(previous, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const files = existsSync(downloads) ? readdirSync(downloads).filter(f => !f.endsWith('.crdownload') && !previous.includes(f)) : [];
    if (files.length) { await wait(200); return join(downloads, files[0]); }
    await wait(100);
  }
  throw new Error('Timed out waiting for a download.');
}
// Optional screenshots for visual review: --screenshots <dir>.
const shotDir = option('--screenshots');
const screenshot = async name => {
  if (!shotDir) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
};
const listDownloads = () => existsSync(downloads) ? readdirSync(downloads) : [];
async function load() {
  await setViewport(1440, 1000);
  await page.send('Page.navigate', { url: siteUrl });
  await waitFor(`document.readyState === 'complete' && document.querySelectorAll('[data-link]').length > 0`, 'workbench rendered');
  await evaluate(`localStorage.clear()`);
  await page.send('Page.reload', { ignoreCache: true });
  await waitFor(`document.readyState === 'complete' && document.querySelectorAll('[data-link]').length > 0`, 'workbench re-rendered');
}

// ---------------------------------------------------------------- checks
await load();

await check('workbench loads with no script errors', async () => {
  assert(await evaluate(`document.querySelectorAll('[data-link]').length === 4`), 'expected four approach buttons');
  assert(await evaluate(`!document.getElementById('play-button').disabled`), 'run button disabled on a valid default scenario');
  assert(!pageErrors.length, pageErrors.join('; '));
});

await check('keyboard: tabs, run control, inspector and dialog work without a mouse', async () => {
  await evaluate(`document.getElementById('tab-design').focus()`);
  await key('ArrowRight', 'ArrowRight', 39);
  assert(await activeId() === 'tab-compare', 'ArrowRight did not move focus to the compare tab');
  assert(await evaluate(`!document.getElementById('compare-panel').hidden`), 'compare panel not shown');
  await key('Home', 'Home', 36);
  assert(await evaluate(`!document.getElementById('design-panel').hidden`), 'Home did not return to the design tab');
  await evaluate(`document.getElementById('play-button').focus()`);
  await key('Enter', 'Enter', 13);
  await waitFor(`document.getElementById('run-state').textContent === 'Running' || document.getElementById('run-state').textContent === 'Warm-up'`, 'Enter starts the run');
  await waitFor(`!document.getElementById('simulation-time').textContent.startsWith('00:00')`, 'simulated time advances');
  await key(' ', 'Space', 32);
  await waitFor(`document.getElementById('run-state').textContent === 'Paused'`, 'Space pauses the run');
  await evaluate(`document.querySelector('[data-link="north"]').focus()`);
  await key('Enter', 'Enter', 13);
  assert(await evaluate(`document.getElementById('approach-title').textContent === 'North approach'`), 'Enter on an approach button did not select it');
  await evaluate(`document.getElementById('help-button').focus()`);
  await key('Enter', 'Enter', 13);
  assert(await evaluate(`document.getElementById('about-dialog').open`), 'help dialog did not open');
  await key('Escape', 'Escape', 27);
  assert(await evaluate(`!document.getElementById('about-dialog').open`), 'Escape did not close the dialog');
});

await check('keyboard: Tab reaches the main controls in order with a visible focus style', async () => {
  await evaluate(`document.activeElement?.blur(); window.scrollTo(0, 0)`);
  const seen = [];
  for (let i = 0; i < 80; i++) {
    await key('Tab', 'Tab', 9);
    const id = await activeId();
    seen.push(id);
    if (id === 'play-button') {
      const outline = await evaluate(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none'; })()`);
      assert(outline, 'the focused run button has no visible focus indicator');
    }
  }
  for (const id of ['import-button', 'save-button', 'tab-design', 'scenario-select', 'play-button']) assert(seen.includes(id), `Tab never reached #${id}`);
  assert(seen.indexOf('save-button') < seen.indexOf('play-button'), 'unexpected focus order');
});

await check('every interactive control has an accessible name', async () => {
  await evaluate(`document.getElementById('tab-compare').click()`);
  const { nodes } = await page.send('Accessibility.getFullAXTree');
  const roles = new Set(['button', 'textbox', 'spinbutton', 'combobox', 'checkbox', 'slider', 'tab', 'link']);
  const unnamed = nodes.filter(n => !n.ignored && roles.has(n.role?.value) && !(n.name?.value ?? '').trim());
  await evaluate(`document.getElementById('tab-design').click()`);
  assert(!unnamed.length, `unnamed controls: ${unnamed.map(n => n.role.value).join(', ')}`);
});

let savedProjectPath;
await check('Save project downloads a valid, re-importable project file', async () => {
  const before = listDownloads();
  await evaluate(`document.getElementById('save-button').click()`);
  savedProjectPath = await nextDownload(before);
  assert(savedProjectPath.endsWith('.json'), `unexpected file ${savedProjectPath}`);
  const project = parseProject(readFileSync(savedProjectPath, 'utf8'));
  assert(project.schemaVersion === SCHEMA_VERSION && project.scenarios.length === 1, 'downloaded project did not round-trip');
});

await check('Open project imports a file, applies it, and discards imported results', async () => {
  const project = JSON.parse(readFileSync(savedProjectPath, 'utf8'));
  project.scenarios[0].name = 'Imported corridor study';
  project.scenarios[0].template = 'corridor';
  project.results = [{ status: 'Validated', name: 'fabricated' }];
  const file = join(work, 'import.json');
  writeFileSync(file, JSON.stringify(project));
  const { root: doc } = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await waitFor(`document.getElementById('scenario-select').selectedOptions[0]?.textContent.includes('Imported corridor study')`, 'imported scenario shown');
  assert(await evaluate(`document.querySelector('[data-path="template"]').value === 'corridor'`), 'imported template not applied');
  assert(await evaluate(`document.querySelectorAll('[data-link]').length === 8`), 'corridor approaches not rendered');
  assert(await evaluate(`document.getElementById('notice').textContent.includes('Imported results are not trusted')`), 'no notice about discarded results');
});

await check('Open project rejects an invalid file with an explanation', async () => {
  const file = join(work, 'bad.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 3, scenarios: [{ name: 'x' }] }));
  const { root: doc } = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#import-file' });
  await page.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await waitFor(`document.getElementById('notice').textContent.startsWith('Could not open project')`, 'error notice');
  assert(await evaluate(`document.getElementById('scenario-select').selectedOptions[0].textContent.includes('Imported corridor study')`), 'a rejected import replaced the current project');
});

await check('comparison exports a safe per-seed CSV and a printable report', async () => {
  await evaluate(`document.getElementById('duplicate-button').click()`);
  await evaluate(`(() => { const el = document.querySelector('[data-path="name"]'); el.value = '=HYPERLINK("x")'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.getElementById('tab-compare').click(); document.getElementById('compare-button').click()`);
  await waitFor(`document.getElementById('experiment-status').textContent.includes('seeds each')`, 'comparison finished', 90000);
  const before = listDownloads();
  await evaluate(`document.getElementById('csv-button').click()`);
  const csv = readFileSync(await nextDownload(before), 'utf8').split('\r\n');
  assert(csv[0].startsWith('"scenario","engine","seed"'), 'missing CSV header');
  assert(csv.length === 1 + 2 * 3, `expected 6 data rows, found ${csv.length - 1}`);
  assert(csv.some(row => row.startsWith(`"'=HYPERLINK`)), 'formula-like scenario name was not neutralised');
  await evaluate(`window.__printed = 0; window.print = () => { window.__printed++; }`);
  await evaluate(`document.getElementById('report-button').click()`);
  assert(await evaluate('window.__printed') === 1, 'print was not requested');
  const metadata = await evaluate(`document.getElementById('report-metadata').textContent`);
  assert(/ILLUSTRATIVE PLANNING REPORT/.test(metadata) && /Engine: illustrative-network/.test(metadata), 'report metadata incomplete');
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });
  const printLayout = await evaluate(`({ design: getComputedStyle(document.getElementById('design-panel')).display, header: getComputedStyle(document.querySelector('.app-header')).display, table: document.querySelector('#results-table table')?.getBoundingClientRect().height ?? 0 })`);
  await page.send('Emulation.setEmulatedMedia', { media: '' });
  assert(printLayout.design === 'none' && printLayout.header === 'none', 'print layout shows editing controls');
  assert(printLayout.table > 0, 'results table not visible when printing');
});

await check('comparison time charts show a legend, a crosshair tooltip and a table view', async () => {
  assert(await evaluate(`!document.getElementById('time-charts').hidden`), 'time charts hidden after a comparison');
  assert(await evaluate(`document.querySelectorAll('#time-charts svg').length === 2`), 'expected two time charts');
  assert(await evaluate(`document.querySelectorAll('#time-charts .line-chart')[0].querySelectorAll('.chart-legend span').length === 2`), 'legend should list both alternatives');
  const box = await evaluate(`(() => { const svg = document.querySelector('#time-charts svg'); svg.scrollIntoView({ block: 'center' }); const r = svg.getBoundingClientRect(); return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.5 }; })()`);
  await wait(100);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await waitFor(`!document.querySelector('#time-charts .chart-tooltip').hidden`, 'tooltip appears on hover');
  assert(await evaluate(`document.querySelector('#time-charts .chart-tooltip').querySelectorAll('strong').length === 2`), 'tooltip should list every series');
  assert(await evaluate(`document.querySelector('#time-charts .chart-table tbody tr') !== null`), 'table view has no rows');
  // Keyboard reading: focus the plot and step with the arrow keys.
  await evaluate(`document.querySelector('#time-charts svg rect[tabindex]').focus()`);
  await key('End', 'End', 35);
  assert(await evaluate(`document.querySelector('#time-charts .chart-tooltip-time').textContent === '10:00'`), 'End should read the last sample');
  await screenshot('time-charts');
});

await check('alternatives list their changes and "until precise" comparisons give a verdict', async () => {
  await evaluate(`document.getElementById('tab-design').click()`);
  // The active scenario is the duplicate created earlier; change one design input.
  await evaluate(`(() => { const el = document.querySelector('input[type="number"][data-path="signals.eastWest"]'); el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(await evaluate(`!document.getElementById('change-summary').hidden`), 'change summary hidden for an alternative');
  assert(await evaluate(`/East–west green: 40 s → 12 s/.test(document.getElementById('change-summary').textContent)`), 'change summary does not list the green change');
  await evaluate(`document.getElementById('scenario-select').selectedIndex = 0; document.getElementById('scenario-select').dispatchEvent(new Event('change'))`);
  assert(await evaluate(`document.getElementById('change-summary').hidden`), 'the baseline should not show a change summary');
  await evaluate(`document.getElementById('tab-compare').click(); document.getElementById('replications').value = 'adaptive'; document.getElementById('compare-button').click()`);
  await waitFor(`document.getElementById('experiment-status').textContent.includes('added until precise')`, 'adaptive comparison finished', 120000);
  assert(await evaluate(`/Higher delay than baseline/.test(document.querySelector('#results-table .verdict')?.textContent ?? '')`), 'a 12 s east–west green should show a clear higher-delay verdict');
  assert(await evaluate(`/1 change vs baseline/.test(document.querySelector('#results-table .change-list summary')?.textContent ?? '')`), 'results table does not list changes');
  await evaluate(`document.getElementById('replications').value = '3'`);
  await screenshot('adaptive-comparison');
});

await check('signal phase editor: presets, conflict validation, phase display and phase sweeps', async () => {
  await evaluate(`document.getElementById('tab-design').click()`);
  await evaluate(`(() => { const el = document.querySelector('[data-path="template"]'); el.value = 'fourArm'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`(() => { const el = document.querySelector('[data-plan-mode]'); el.value = 'custom'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(await evaluate(`document.querySelectorAll('.phase-card').length === 2`), 'switching to custom should start from two equivalent phases');
  assert(await evaluate(`document.querySelectorAll('.phase-card .movement.permitted').length > 0`), 'two-phase plan should mark permitted right turns');
  await evaluate(`(() => { const el = document.querySelector('select[data-phase-action="preset"]'); el.value = 'protectedRights'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert(await evaluate(`document.querySelectorAll('.phase-card').length === 4`), 'protected-rights preset should give four phases');
  assert(await evaluate(`document.querySelectorAll('.phase-card .movement.permitted').length === 0`), 'protected right turns should not be marked as yielding');
  assert(!(await evaluate(`document.getElementById('play-button').disabled`)), 'a valid preset should allow running');
  const overflow = await evaluate(`(() => { const p = document.querySelector('.settings-panel'); return p.scrollWidth - p.clientWidth; })()`);
  const culprit = overflow > 1 ? await evaluate(`(() => { const p = document.querySelector('.settings-panel').getBoundingClientRect(); return [...document.querySelectorAll('.settings-panel *')].filter(e => e.getBoundingClientRect().right > p.right + 1).slice(0, 4).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().width)).join(', '); })()`) : '';
  assert(overflow <= 1, `settings panel scrolls sideways by ${overflow}px with the phase editor open: ${culprit}`);
  // Adding north straight to the east–west through phase conflicts.
  await evaluate(`(() => { const el = document.querySelector('[data-phase="0"][data-movement="north:straight"]'); el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(await evaluate(`/Phase 1 runs .*north straight ahead.* together, but their paths cross/.test(document.getElementById('validation').textContent)`), 'conflicting movements should be rejected');
  assert(await evaluate(`document.getElementById('play-button').disabled`), 'an invalid plan should block running');
  assert(await evaluate(`document.activeElement?.dataset?.movement === 'north:straight'`), 'focus should stay on the toggled movement');
  await evaluate(`(() => { const el = document.querySelector('[data-phase="0"][data-movement="north:straight"]'); el.checked = false; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(!(await evaluate(`document.getElementById('play-button').disabled`)), 'removing the conflict should allow running again');
  await evaluate(`document.getElementById('speed-select').value = '32'; document.getElementById('play-button').click()`);
  await waitFor(`/East–west right turns/.test(document.getElementById('phase-label').textContent)`, 'the phase label should name the right-turn phase', 30000);
  await evaluate(`document.getElementById('play-button').click()`);
  await screenshot('phase-editor');
  await evaluate(`document.getElementById('tab-compare').click()`);
  const options = await evaluate(`[...document.getElementById('sweep-group').options].map(o => o.textContent)`);
  assert(options.length === 4 && /Phase 2 \(East–west right turns\) green/.test(options[1]), `sweep targets: ${options.join(' / ')}`);
  await evaluate(`document.getElementById('tab-design').click()`);
  await evaluate(`(() => { const el = document.querySelector('[data-plan-mode]'); el.value = 'twoPhase'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
});

await check('demand profile editor, live queue chart and persistent-queue list', async () => {
  await evaluate(`document.getElementById('tab-design').click()`);
  await evaluate(`(() => { const el = document.querySelector('[data-profile="preset"]'); el.value = 'surge'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(await evaluate(`document.querySelectorAll('.profile-preview span').length === 6`), 'surge preset should show six periods');
  await evaluate(`(() => { const el = document.querySelector('[data-profile="factors"]'); el.value = '1, 2.5'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(await evaluate(`document.querySelector('[data-profile="preset"]').value === 'custom'`), 'editing factors should switch to custom');
  assert(await evaluate(`[...document.querySelectorAll('#model-checks li')].some(li => /more demand overall/.test(li.textContent))`), 'missing check for a profile that adds demand');
  await evaluate(`(() => { const el = document.querySelector('[data-profile="factors"]'); el.value = '1, 9'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(await evaluate(`document.getElementById('play-button').disabled && /between 0 and 3/.test(document.getElementById('validation').textContent)`), 'an out-of-range factor should block the run');
  await evaluate(`(() => { const el = document.querySelector('[data-profile="factors"]'); el.value = '1, 2.5'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.getElementById('speed-select').value = '32'; document.getElementById('play-button').click()`);
  await waitFor(`document.querySelector('#live-chart svg') !== null`, 'live queue chart draws', 30000);
  await waitFor(`document.querySelectorAll('#queue-events button').length > 0`, 'surge produces a persistent queue event', 60000);
  await evaluate(`document.getElementById('play-button').click()`);
  const target = await evaluate(`document.querySelector('#queue-events button').dataset.eventLink`);
  await evaluate(`document.querySelector('#queue-events button').click()`);
  assert(await evaluate(`document.querySelector('[data-link="${target}"]').getAttribute('aria-pressed') === 'true'`), 'clicking an event should select its approach');
  assert(await evaluate(`document.querySelectorAll('#timeline-markers span').length > 0`), 'timeline should mark persistent queues');
  await evaluate(`document.getElementById('live-chart').scrollIntoView({ block: 'center' })`);
  await screenshot('live-insights');
  await evaluate(`document.querySelector('.profile-preview').scrollIntoView({ block: 'center' })`);
  await screenshot('profile-editor');
});

await check('phone-sized touch layout has no horizontal scrolling and taps select approaches', async () => {
  await load();
  await setViewport(390, 844, true);
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await wait(300);
  const overflow = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
  assert(overflow <= 1, `page scrolls horizontally by ${overflow}px`);
  const box = await evaluate(`(() => { const b = document.querySelector('[data-link="south"]'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  assert(box.w >= 24 && box.h >= 24, `approach button touch target is ${Math.round(box.w)}×${Math.round(box.h)} px`);
  await tap(box.x, box.y);
  await waitFor(`document.getElementById('approach-title').textContent === 'South approach'`, 'tap selects the approach');
  // Tapping the map near the east arm selects the east approach.
  const map = await evaluate(`(() => { const c = document.getElementById('network-canvas'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.x + r.width * 0.8, y: r.y + r.height / 2 - 6 }; })()`);
  await wait(200);
  await tap(map.x, map.y);
  await waitFor(`document.getElementById('approach-title').textContent === 'East approach'`, 'tapping the map selects the nearest approach');
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
});

await check('no script errors were raised during the checks', async () => {
  assert(!pageErrors.length, pageErrors.join('; '));
});

page.close(); browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed · ${product}`);
cleanup();
process.exit(failed.length ? 1 : 0);
