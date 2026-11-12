import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createScenario, parseProject, SCHEMA_VERSION } from '../src/model/project.js';
import { compileNetwork, defaultLayout, inboundLinks, lanePoint } from '../src/model/network.js';
import { Simulation } from '../src/simulation/engine.js';
import { CAMERA_LIMITS, SceneRenderer, clampCamera, findVehicle, fitCamera, groundPoint, networkBounds, presetCamera, projectPoint, viewBasis } from '../src/ui/scene3d.js';

const W = 960, H = 600;
// A Canvas 2D stand-in that accepts every call and counts fills.
function fakeContext() {
  const calls = { fill: 0 };
  const store = { calls };
  return new Proxy(store, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return text => ({ width: String(text).length * 6 });
      if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (key === 'fill') return () => { calls.fill++; };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}
const scenarios = () => {
  const make = (template, edit = () => {}) => { const s = createScenario(); s.template = template; edit(s); return s; };
  return {
    fourArm: make('fourArm'), tJunction: make('tJunction'), corridor: make('corridor'), roundabout: make('roundabout'),
    grid: make('grid', s => { s.layout = defaultLayout(); }),
  };
};
const renderer = () => { const r = new SceneRenderer(fakeContext()); r.setSize(W, H); return r; };
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

test('the camera projects its target to the screen centre with north up when overhead', () => {
  const bounds = networkBounds(compileNetwork(createScenario()));
  const camera = clampCamera({ target: { x: 10, y: -5 }, yaw: 0, pitch: CAMERA_LIMITS.maxPitch, distance: 200 }, bounds);
  const b = viewBasis(camera, W, H);
  const centre = projectPoint(b, 10, -5, 0);
  assert.ok(near(centre.x, W / 2, 1e-6) && near(centre.y, H / 2, 1e-6));
  const north = projectPoint(b, 10, -55, 0), east = projectPoint(b, 60, -5, 0);
  assert.ok(north.y < H / 2 && near(north.x, W / 2, 2), 'north is up');
  assert.ok(east.x > W / 2 && near(east.y, H / 2, 2), 'east is right');
  // Turning to face east puts north on the left.
  const turned = viewBasis({ ...camera, yaw: Math.PI / 2 }, W, H);
  assert.ok(projectPoint(turned, 10, -55, 0).x < W / 2);
  // Sight lines through the screen centre meet the ground at the target.
  const ground = groundPoint(viewBasis({ ...camera, pitch: 0.6, yaw: 1.1 }, W, H), W / 2, H / 2);
  assert.ok(near(ground.x, 10, 1e-6) && near(ground.y, -5, 1e-6));
  // Points behind the camera are not drawn.
  assert.equal(projectPoint(viewBasis({ ...camera, pitch: 0.3 }, W, H), 10, 500, 0), null);
});

test('camera bounds keep the eye above the ground and near the study area', () => {
  const bounds = networkBounds(compileNetwork(createScenario()));
  const low = clampCamera({ target: { x: 0, y: 0 }, yaw: 7, pitch: -1, distance: 1 }, bounds);
  assert.ok(low.pitch >= CAMERA_LIMITS.minPitch && low.distance >= CAMERA_LIMITS.minDistance);
  assert.ok(low.distance * Math.sin(low.pitch) >= CAMERA_LIMITS.minEyeHeight - 1e-9, 'eye stays above street level');
  assert.ok(low.yaw > -Math.PI && low.yaw <= Math.PI);
  const far = clampCamera({ target: { x: 1e6, y: -1e6 }, yaw: 0, pitch: 3, distance: 1e7 }, bounds);
  assert.ok(far.pitch <= CAMERA_LIMITS.maxPitch && far.distance <= Math.max(300, bounds.radius * 4));
  assert.ok(far.target.x < bounds.maxX + Math.max(100, bounds.radius) + 1e-9 && far.target.y > bounds.minY - Math.max(100, bounds.radius) - 1e-9);
  const broken = clampCamera({ target: { x: NaN }, yaw: Infinity, pitch: NaN, distance: NaN }, bounds);
  assert.ok(Object.values({ ...broken.target, yaw: broken.yaw, pitch: broken.pitch, distance: broken.distance }).every(Number.isFinite));
});

test('fit and overview presets show every road end for every template', () => {
  for (const [name, s] of Object.entries(scenarios())) {
    const network = compileNetwork(s);
    const bounds = networkBounds(network);
    for (const preset of ['fit', 'overview', 'overhead', 'reset']) {
      const b = viewBasis(presetCamera(preset, network, bounds, { yaw: 0.4, pitch: 0.7 }, W / H), W, H);
      for (const link of network.links) {
        for (const [x, y] of [[link.x0, link.y0], [link.x1, link.y1]]) {
          const p = projectPoint(b, x, y, 0);
          assert.ok(p && p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H, `${name} ${preset}: ${link.id} end off screen`);
        }
      }
    }
    // Street level stands on an approach, a person's height above the road, looking at the stop line.
    const link = inboundLinks(network)[0];
    const street = presetCamera('street', network, bounds, null, W / H, link.id);
    const b = viewBasis(street, W, H);
    assert.ok(b.eye[2] < 3, `${name}: street view is near the ground`);
    const stop = projectPoint(b, ...lanePoint(link, Math.floor(link.lanes / 2), link.length), 0);
    assert.ok(near(stop.x, W / 2, 1) && near(stop.y, H / 2, 1), `${name}: street view looks at the stop line`);
  }
});

test('drawing the 3D view during a run leaves every result unchanged', () => {
  for (const [name, s] of Object.entries(scenarios())) {
    s.run.duration = 240; s.turning = { left: 20, right: 20 };
    const plain = new Simulation(s).runToEnd();
    const viewed = new Simulation(s);
    const view = renderer();
    view.overlays = { labels: true, queues: true, signals: true, speed: true };
    const presets = ['overview', 'street', 'overhead', 'fit'];
    let k = 0, faces = 0;
    while (!viewed.done) {
      viewed.step();
      if (++k % 50 === 0) {
        view.draw(viewed);
        faces += view.stats.faces;
        view.applyPreset(presets[k / 50 % presets.length]);
        view.orbit(0.3, -0.1); view.pan(40, -25); view.zoom(0.7);
        view.detail = view.detail === 'full' ? 'reduced' : 'full';
      }
    }
    assert.ok(faces > 0, `${name}: something was drawn`);
    const strip = r => ({ ...r, inputs: null });
    assert.deepEqual(strip(viewed.result()), strip(plain), `${name}: results changed by drawing`);
  }
});

test('picking finds the vehicle or approach road under the pointer', () => {
  const s = createScenario(); s.run.duration = 120;
  const simulation = new Simulation(s);
  for (let i = 0; i < 400; i++) simulation.step();
  const view = renderer();
  view.useNetwork(simulation.network);
  view.applyPreset('overhead');
  view.draw(simulation);
  const b = view.basis();
  const west = simulation.network.byId.west;
  const road = projectPoint(b, ...lanePoint(west, 0, west.length * 0.3), 0);
  // Pick the road away from any vehicle.
  view.drawnVehicles = [];
  assert.deepEqual(view.pick(road.x, road.y), { type: 'link', id: 'west' });
  view.draw(simulation);
  const target = view.drawnVehicles[0];
  assert.ok(target, 'vehicles are drawn');
  assert.deepEqual(view.pick(target.x, target.y), { type: 'vehicle', id: target.id });
  const found = findVehicle(simulation, target.id);
  assert.ok(found && Number.isFinite(found.x) && found.where, 'a selected vehicle can be located');
  assert.equal(findVehicle(simulation, -1), null);
  // The sky is not a road.
  view.setCamera({ ...view.camera, pitch: CAMERA_LIMITS.minPitch });
  view.drawnVehicles = [];
  assert.equal(view.pick(W / 2, 2), null);
});

test('camera bookmarks are saved with the project, sanitised, and migrate from schema 6', () => {
  assert.equal(SCHEMA_VERSION, 7);
  assert.deepEqual(createProject().views, { bookmarks: [] });
  const project = createProject();
  const camera = { target: { x: 12, y: -40 }, yaw: 0.5, pitch: 0.8, distance: 220 };
  project.views.bookmarks = [
    { name: '  West queue  ', camera },
    { name: 'Broken', camera: { ...camera, yaw: 'left' } },
    { name: '', camera },
    { name: 'x'.repeat(80), camera, extra: 'dropped' },
  ];
  const loaded = parseProject(JSON.stringify(project));
  assert.deepEqual(loaded.views.bookmarks.map(b => b.name), ['West queue', 'x'.repeat(40)]);
  assert.deepEqual(loaded.views.bookmarks[0].camera, camera);
  assert.ok(!('extra' in loaded.views.bookmarks[1]));
  project.views.bookmarks = Array.from({ length: 30 }, (_, i) => ({ name: `V${i}`, camera }));
  assert.equal(parseProject(JSON.stringify(project)).views.bookmarks.length, 20);
  const old = createProject(); delete old.views; old.schemaVersion = 6;
  const migrated = parseProject(JSON.stringify(old));
  assert.equal(migrated.schemaVersion, 7);
  assert.deepEqual(migrated.views, { bookmarks: [] });
});
