// Unit + HTTP tests: routing rules, validation, objectives, HiRISE source, explanation checker, Express API.
// Run from app/:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, round } from '../server/routing.js';
import * as explain from '../server/explain.js';

const R = 3396190.0;

/** Synthetic terrain: slope[r][c] (deg; NaN = unknown), flat elevation, 60 m cells, lat_ts = 0. */
function make(slope, { dx = null, source = null } = {}) {
  const H = slope.length, W = slope[0].length;
  const flat = Float64Array.from(slope.flat());
  const meta = { grid: { sphere_radius_m: R, lat_ts_deg: 0, cell_map_m: [60, 60], origin_map_m: { x_left: 0, y_top: 60 * H },
    bounds_lonlat: null, crs_proj4: 'test' } };
  return new Terrain({ H, W, slopeMax: flat, slopeMean: Float64Array.from(flat), elev: new Float64Array(H * W),
    dx: dx || new Float64Array(H).fill(60), dy: 60, source: source ? Uint8Array.from(source.flat()) : undefined }, meta);
}
const grid = (H, W, v) => Array.from({ length: H }, () => new Array(W).fill(v));
const pt = (T, r, c) => { const [lon, lat] = T.cellCenterLonLat(r, c); return { lon, lat }; };
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

test('no corner cutting', () => {
  const s = grid(3, 3, 0); s[0][1] = 30; s[1][0] = 30;     // (0,0) enclosed except via the forbidden diagonal
  const T = make(s);
  const result = T.compute(pt(T, 0, 0), pt(T, 2, 2));
  assert.equal(result.status, 'fallback');
  assert.equal(result.routes[0].validation.passed, false);
  assert.ok(result.routes[0].validation.blocked_cells > 0);
  assert.ok(!result.routes[0].validation.checks.some(check => check.includes('corner')));
});

test('routes never use steep or unknown cells', () => {
  const rnd = mulberry32(1), s = grid(40, 40, 0).map(row => row.map(() => rnd() * 30));
  for (let r = 5; r < 35; r++) s[r][20] = NaN;
  s[0][0] = 1; s[39][39] = 1;
  const T = make(s), res = T.compute(pt(T, 0, 0), pt(T, 39, 39));
  for (const r of res.routes) {
    if (r.validation.passed) {
      for (const [lon, lat] of r.geometry.coordinates.slice(1, -1)) {
        const [rr, cc] = T.cellOf(lon, lat);
        assert.equal(T.passable[rr * T.W + cc], 1);
      }
    } else {
      assert.equal(res.status, 'fallback');
      assert.ok(r.validation.blocked_cells > 0);
    }
    assert.ok(Number.isFinite(r.max_slope_deg));
  }
});

test('validator catches bad paths', () => {
  const s = grid(6, 6, 0); s[2][3] = 25; s[3][2] = 25;
  const T = make(s), i = (r, c) => r * T.W + c, st = i(0, 0), en = i(5, 5);
  assert.ok(T.validatePath([st, i(2, 2), en], st, en).some(e => e.includes('not to an adjacent')));
  assert.ok(T.validatePath([st, i(1, 1), i(2, 3), i(3, 4), en], st, en).some(e => e.includes('impassable')));
  assert.ok(T.validatePath([st, i(2, 2), i(3, 3), en], st, en).some(e => e.includes('corner')));
  assert.ok(T.validatePath([st, i(1, 1)], st, en).some(e => e.includes('endpoints')));
  assert.deepEqual(T.validatePath([st, i(0, 1), i(0, 2), i(0, 3), i(0, 4), i(0, 5), i(1, 5), i(2, 5), i(3, 5), i(4, 5), en], st, en), []);
});

test('invalid points are rejected, not moved', () => {
  const s = grid(5, 5, 0); s[0][0] = 25; s[4][4] = NaN;
  const T = make(s);
  let res = T.compute(pt(T, 0, 0), pt(T, 4, 4));
  assert.equal(res.status, 'fallback');
  assert.equal(res.routes[0].validation.fallback, true);
  assert.ok(res.routes[0].validation.unknown_cells > 0);
  assert.equal(T.compute({ lon: -5, lat: 0 }, pt(T, 2, 2)).errors[0].code, 'outside_work_area');
  assert.equal(T.compute(pt(T, 2, 2), pt(T, 2, 2)).errors[0].code, 'same_cell');
  assert.equal(T.compute({ lon: 'x', lat: 0 }, pt(T, 2, 2)).errors[0].code, 'malformed');
  assert.equal(T.compute({ lon: null, lat: 0 }, pt(T, 2, 2)).errors[0].code, 'malformed');
});

test('no_route reason', () => {
  const s = grid(6, 6, 0); for (let r = 0; r < 6; r++) s[r][3] = 40;
  const T = make(s), res = T.compute(pt(T, 0, 0), pt(T, 5, 5));
  assert.equal(res.status, 'fallback');
  assert.equal(res.reason.code, 'least_risk_fallback');
  assert.ok(res.routes[0].validation.blocked_cells > 0);
});

test('identical routes are not duplicated', () => {
  const T = make(grid(5, 12, 2)), res = T.compute(pt(T, 2, 0), pt(T, 2, 11));
  assert.equal(res.routes.length, 1);
  assert.deepEqual(new Set(res.routes[0].also_satisfies_objectives), new Set(['lowest_slope', 'balanced']));
});

function corridor() {   // straight corridor is steep-ish (15 deg); a detour is flat
  const s = grid(9, 15, 0.5);
  for (const r of [3, 4, 5]) for (let c = 1; c < 14; c++) s[r][c] = 15;
  const T = make(s);
  return [T, T.compute(pt(T, 4, 0), pt(T, 4, 14))];
}

test('objectives', () => {
  const [, res] = corridor();
  const by = Object.fromEntries(res.routes.map(r => [r.objective, r]));
  const find = o => by[o] || res.routes.find(r => r.also_satisfies_objectives.includes(o));
  for (const a of res.routes) assert.ok(a.distance_m >= by.shortest.distance_m - 1e-6);
  assert.ok(find('lowest_slope').mean_slope_deg <= by.shortest.mean_slope_deg);
  const costs = res.routes.map(r => r.cost_breakdown.balanced_cost);
  assert.ok(Math.abs(find('balanced').cost_breakdown.balanced_cost - Math.min(...costs)) < 1e-4);
});

test('latitude-corrected spacing', () => {
  // East-west step at 60 deg latitude: ground spacing = 60 * cos(60) / cos(lat_ts = 0) = 30 m.
  const T = make([[0, 0, 0]], { dx: Float64Array.of(60 * Math.cos(Math.PI / 3)) });
  assert.ok(Math.abs(T.pathMetrics([0, 1, 2]).distance_m - 60) < 1e-6);
});

test('HiRISE: source counts and HiRISE-only block', () => {
  // Combined limiting slope: a HiRISE cell at 25 deg blocks even though CTX would say 5 deg.
  const ctx = grid(5, 9, 5), hir = grid(5, 9, 8), src = grid(5, 9, 0);
  for (let r = 0; r < 5; r++) { hir[r][4] = r <= 1 ? 8 : 25; for (const c of [2, 3, 4, 5, 6]) src[r][c] = 1; }
  const combined = ctx.map((row, r) => row.map((v, c) => (src[r][c] ? Math.max(hir[r][c], v) : v)));
  const T = make(combined, { source: src }), res = T.compute(pt(T, 4, 0), pt(T, 4, 8));
  assert.equal(res.status, 'ok');
  for (const r of res.routes) {
    const rows = r.geometry.coordinates.slice(1, -1).map(([lon, lat]) => T.cellOf(lon, lat)).filter(([, c]) => c === 4).map(([rr]) => rr);
    assert.deepEqual(new Set(rows), new Set([0]));           // buffer keeps the crossing away from the steep wall
    const n = r.cells_by_slope_source;
    assert.equal(n.ctx_20m + n.hirise_1m, r.cells);
    assert.ok(n.hirise_1m > 0);
    assert.deepEqual(explain.checkText(explain.templateText(r), r.explanation_facts), []);
  }
});

test('HiRISE pixel -> CTX cell mapping is the exact composition of the two eqc transforms', () => {
  const latTs = 18.4663 * Math.PI / 180, lon = 77.45 * Math.PI / 180;
  assert.ok(Math.abs(R * lon * Math.cos(latTs) - R * Math.cos(latTs) * lon) < 1e-6);
});

test('explanations: template passes its own checker', () => {
  const [, res] = corridor();
  for (const r of res.routes) assert.deepEqual(explain.checkText(explain.templateText(r), r.explanation_facts), []);
});

test('explanations: checker rejects invented numbers and topics', () => {
  const [, res] = corridor(), f = res.routes[0].explanation_facts;
  assert.ok(explain.checkText('This route is 99.9 km long.', f).length);
  assert.ok(explain.checkText('Temperatures are mild on this path.', f).length);
  assert.ok(explain.checkText('This is the safest route.', f).length);
  assert.deepEqual(explain.checkText(`This route is ${f.distance_km} km long with a mean slope of ${f.mean_slope_deg} deg.`, f), []);
});

test('explanations: no model -> template', async () => {
  delete process.env.GEMINI_API_KEY; delete process.env.GEMMA_OPENAI_BASE_URL;
  const [, res] = corridor(), out = await explain.explain(res);
  assert.equal(out.model.error, 'model_unavailable');
  assert.ok(out.explanations.every(e => e.source === 'template'));
});

test('explanations: model output with an unsupported number is replaced', async () => {
  const [, res] = corridor(), rid = res.routes[0].route_id;
  const orig = { ...explain.model };
  explain.model.provider = () => ({ name: 'fake', model: 'fake' });
  explain.model.callModel = async () => [{ name: 'fake', model: 'fake' }, JSON.stringify({ [rid]: 'It is 123 km.' })];
  try {
    const e = (await explain.explain(res)).explanations.find(x => x.route_id === rid);
    assert.equal(e.source, 'template');
    assert.ok(e.model_rejected_reasons.includes('unsupported number 123'));
  } finally { Object.assign(explain.model, orig); }
});

test('explanations: accepted model text is used', async () => {
  const [, res] = corridor(), r0 = res.routes[0], f = r0.explanation_facts;
  const orig = { ...explain.model };
  explain.model.provider = () => ({ name: 'fake', model: 'fake' });
  explain.model.callModel = async () => [{ name: 'fake', model: 'fake' },
    JSON.stringify({ [r0.route_id]: `This path is ${f.distance_km} km long.` })];
  try {
    const e = (await explain.explain(res)).explanations.find(x => x.route_id === r0.route_id);
    assert.equal(e.source, 'gemma');
  } finally { Object.assign(explain.model, orig); }
});

test('round() helper', () => { assert.equal(round(1.23456, 2), 1.23); assert.equal(round(40410.04, 1), 40410); });

// ---------- Express API (real build data) ----------
test('Express API end to end', async t => {
  const { createApp } = await import('../server/server.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, raw) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body) });

  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.slope_limit_deg, 20);
  assert.ok(cfg.layers.hirise_coverage);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/static/app.js')).status, 200);
  assert.equal((await fetch(base + '/static/../server/server.js')).status, 404);

  const ok = await (await post('/api/routes', { start: { lon: 77.4509, lat: 18.4446 }, destination: { lon: 77.40, lat: 18.50 } })).json();
  assert.equal(ok.status, 'ok');
  assert.equal(ok.routes.length, 3);
  assert.deepEqual(ok.routes.map(r => r.distance_m), [9308.1, 7019.7, 9202.6]);   // stronger crater-rim and ridge penalties push routes around basin walls
  assert.ok(ok.data_sources.some(s => s.id === 'hirise_dtm_1m'));
  const ex = await (await post('/api/explanations', { result_id: ok.result_id })).json();
  assert.equal(ex.explanations.length, 3);

  assert.equal((await post('/api/routes', null, '{"start":{"lon":NaN')).status, 400);
  assert.equal((await post('/api/routes', { start: 1 })).status, 400);
  assert.equal((await post('/api/explanations', { result_id: 'nope' })).status, 404);
  const bad = await (await post('/api/routes', { start: { lon: 80, lat: 18 }, destination: { lon: 77.4, lat: 18.5 } })).json();
  assert.equal(bad.status, 'invalid_input');
  assert.equal(bad.errors[0].code, 'outside_work_area');
});
