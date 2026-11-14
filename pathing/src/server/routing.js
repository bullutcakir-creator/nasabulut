// Deterministic route engine (Node.js port of the original Python engine; same rules and JSON).
//
// Graph: 8-connected routing grid built by app/prepare_data.py. A cell is passable iff its elevation
// is known and its limiting slope <= SLOPE_LIMIT_DEG. A diagonal move is allowed only when both
// orthogonally adjacent cells are passable (no corner cutting). Edge length = horizontal ground
// distance between cell centres (east-west spacing corrected per row for latitude).
//
// Objectives
//   shortest      minimise total horizontal distance (exact on the grid).
//   balanced      minimise 0.5*D/D_short + 0.5*S/(D_short*limit), S = sum(edge length * edge slope).
//                 Edge-additive -> Dijkstra gives the exact optimum on the grid.
//   lowest_slope  lowest length-weighted mean slope among a fixed candidate family (LOWEST_SLOPE_K).
//                 Ratio objective: best candidate, NOT a proven global optimum.
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = '1.0.0';
export const SLOPE_LIMIT_DEG = 20.0;
export const SAFETY_BUFFER_CELLS = 1;
export const LOWEST_SLOPE_K = [0, 1, 2, 4, 8, 16, 32, 64]; // weight = len * (1 + k * edge_slope / limit)
const DEPRESSION_RADII = [8, 16, 32];
const DEPRESSION_RELIEF_M = 12;
const MOVES = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
const SOURCE_NAMES = { 0: 'ctx_20m', 1: 'hirise_1m' };
const LABEL = { shortest: 'Shortest', lowest_slope: 'Lowest mean slope', balanced: 'Balanced' };

export const round = (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; };
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

/** Binary min-heap of (key, node) pairs on typed arrays; stale entries are skipped by the caller. */
class MinHeap {
  constructor(cap = 1 << 16) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, node) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = node;
  }
  pop() { // returns node; key in this.lastKey
    const topK = this.k[0], topV = this.v[0];
    const key = this.k[--this.n], node = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = node;
    this.lastKey = topK; return topV;
  }
}

export class Terrain {
  /**
   * @param {object} a  {slopeMax, slopeMean, elev: Float64Array(H*W), dx: Float64Array(H), dy, H, W, source?: Uint8Array}
   * @param {object} meta  contents of terrain_meta.json (grid georeferencing)
   */
  constructor(a, meta = {}) {
    Object.assign(this, { H: a.H, W: a.W, slopeMax: a.slopeMax, slopeMean: a.slopeMean, elev: a.elev, dx: a.dx, dy: a.dy, meta });
    this.depressionPenalty = a.depressionPenalty || this.computeDepressionPenalty();
    this.source = a.source || new Uint8Array(a.H * a.W);
    const N = a.H * a.W;
    this.rawPassable = new Uint8Array(N);
    this.passable = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      this.rawPassable[i] = Number.isFinite(this.slopeMax[i]) && Number.isFinite(this.elev[i]) && this.slopeMax[i] <= SLOPE_LIMIT_DEG ? 1 : 0;
      this.passable[i] = this.rawPassable[i];
    }
    for (let r = 0; r < this.H; r++) {
      for (let c = 0; c < this.W; c++) {
        const index = r * this.W + c;
        if (this.rawPassable[index]) continue;
        for (let dr = -SAFETY_BUFFER_CELLS; dr <= SAFETY_BUFFER_CELLS; dr++) {
          for (let dc = -SAFETY_BUFFER_CELLS; dc <= SAFETY_BUFFER_CELLS; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < this.H && cc >= 0 && cc < this.W) this.passable[rr * this.W + cc] = 0;
          }
        }
      }
    }
  }

  /**
   * Estimate crater-like basins from the DEM itself. A cell is penalized when it
   * sits materially below samples around it at multiple scales. This is a soft
   * routing cost, not a new passability rule; steep/unknown cells remain hard
   * blocked by the existing slope mask.
   */
  computeDepressionPenalty() {
    const penalty = new Float32Array(this.H * this.W);
    const samples = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
    for (let r = 0; r < this.H; r++) {
      for (let c = 0; c < this.W; c++) {
        const index = r * this.W + c;
        const center = this.elev[index];
        if (!Number.isFinite(center)) continue;
        let score = 0;
        for (const radius of DEPRESSION_RADII) {
          let sum = 0;
          let count = 0;
          for (const [dr, dc] of samples) {
            const rr = r + dr * radius;
            const cc = c + dc * radius;
            if (rr < 0 || rr >= this.H || cc < 0 || cc >= this.W) continue;
            const value = this.elev[rr * this.W + cc];
            if (Number.isFinite(value)) { sum += value; count++; }
          }
          if (count) score = Math.max(score, Math.max(0, (sum / count - center) / DEPRESSION_RELIEF_M));
        }
        penalty[index] = Math.min(1, score);
      }
    }
    return penalty;
  }

  static load(buildDir) {
    const man = JSON.parse(fs.readFileSync(path.join(buildDir, 'grid_manifest.json'), 'utf8'));
    const meta = JSON.parse(fs.readFileSync(path.join(buildDir, 'terrain_meta.json'), 'utf8'));
    const read = name => {
      const d = man.arrays[name];
      const buf = fs.readFileSync(path.join(buildDir, d.file));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const T = { float32: Float32Array, float64: Float64Array, uint8: Uint8Array }[d.dtype];
      return { arr: new T(ab), shape: d.shape };
    };
    const sm = read('slope_max');
    const [H, W] = sm.shape;
    const f64 = x => Float64Array.from(x);
    return new Terrain({
      H, W, slopeMax: f64(sm.arr), slopeMean: f64(read('slope_mean').arr), elev: f64(read('elev').arr),
      dx: f64(read('cell_dx_ground').arr), dy: meta.grid.cell_map_m[1],
      source: man.arrays.slope_source ? read('slope_source').arr : undefined,
    }, meta);
  }

  /** Same edge set as the Python CSR graph: in-bounds, both ends passable, no corner cutting. */
  *neighbours(u) {
    const { W, H, passable: P } = this;
    const r = Math.floor(u / W), c = u - r * W;
    for (const [dr, dc] of MOVES) {
      const r2 = r + dr, c2 = c + dc;
      if (r2 < 0 || r2 >= H || c2 < 0 || c2 >= W) continue;
      const v = r2 * W + c2;
      if (!P[v]) continue;
      if (dr && dc && !(P[(r + dr) * W + c] && P[r * W + c + dc])) continue;
      const midDx = 0.5 * (this.dx[r] + this.dx[r2]);
      yield [v, Math.hypot(midDx * Math.abs(dc), this.dy * Math.abs(dr))];
    }
  }

  /** Dijkstra with weight = len * (1 + k * edge_slope / limit); stops when t is settled. */
  path(k, s, t) {
    const { H, W, dx, dy, passable: P } = this, N = H * W, sm = this.slopeMean;
    const dist = new Float64Array(N).fill(Infinity), pred = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N), heap = new MinHeap();
    dist[s] = 0; heap.push(0, s);
    while (heap.n) {
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === t) break;
      const du = heap.lastKey;
      // Inlined copy of neighbours() (same edge rules) for speed: generators are slow in this hot loop.
      const r = Math.floor(u / W), c = u - r * W;
      for (let m = 0; m < 8; m++) {
        const dr = MOVES[m][0], dc = MOVES[m][1], r2 = r + dr, c2 = c + dc;
        if (r2 < 0 || r2 >= H || c2 < 0 || c2 >= W) continue;
        const v = r2 * W + c2;
        if (!P[v] || done[v]) continue;
        if (dr && dc && !(P[r2 * W + c] && P[r * W + c2])) continue;
        const len = dc ? (dr ? Math.hypot(0.5 * (dx[r] + dx[r2]), dy) : 0.5 * (dx[r] + dx[r2])) : dy;
        const edgeSlope = 0.5 * (sm[u] + sm[v]);
        const edgeRise = Math.abs(this.elev[u] - this.elev[v]);
        const depression = 0.5 * (this.depressionPenalty[u] + this.depressionPenalty[v]);
        const ridgeRisk = Math.max(0, edgeSlope - 10) / 6;
        const climbRisk = Math.max(0, edgeRise - 8) / 20;
        const hazard = ridgeRisk + 2.5 * depression + climbRisk;
        const nd = du + len * (1 + k * edgeSlope / SLOPE_LIMIT_DEG + 4 * hazard);
        if (nd < dist[v]) { dist[v] = nd; pred[v] = u; heap.push(nd, v); }
      }
    }
    if (!done[t]) return null;
    const p = [t];
    while (p[p.length - 1] !== s) p.push(pred[p[p.length - 1]]);
    return p.reverse();
  }

  leastRiskPath(s, t) {
    const N = this.H * this.W;
    const distances = new Float64Array(N).fill(Infinity);
    const parents = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N);
    const heap = new MinHeap();
    const penalty = cell => {
      if (!Number.isFinite(this.elev[cell]) || !Number.isFinite(this.slopeMax[cell])) return 1e12;
      if (this.passable[cell]) return 0;
      if (this.rawPassable[cell]) return 1e6;
      const excess = Math.max(0, this.slopeMax[cell] - SLOPE_LIMIT_DEG);
      return 1e9 + excess * excess * 1e6;
    };
    distances[s] = 0;
    parents[s] = s;
    heap.push(0, s);

    while (heap.n) {
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === t) break;
      const row = Math.floor(u / this.W), col = u % this.W;
      for (const [dr, dc] of MOVES) {
        const nextRow = row + dr, nextCol = col + dc;
        if (nextRow < 0 || nextRow >= this.H || nextCol < 0 || nextCol >= this.W) continue;
        const v = nextRow * this.W + nextCol;
        if (done[v]) continue;
        const diagonal = dr !== 0 && dc !== 0;
        if (diagonal && (!this.passable[row * this.W + nextCol] || !this.passable[nextRow * this.W + col])) continue;
        const length = Math.hypot(0.5 * (this.dx[row] + this.dx[nextRow]) * Math.abs(dc), this.dy * Math.abs(dr));
        const slope = Number.isFinite(this.slopeMean[u]) && Number.isFinite(this.slopeMean[v])
          ? 0.5 * (this.slopeMean[u] + this.slopeMean[v]) : 90;
        const relief = Number.isFinite(this.elev[u]) && Number.isFinite(this.elev[v])
          ? Math.abs(this.elev[v] - this.elev[u]) : 0;
        const terrainCost = 1 + (penalty(u) + penalty(v)) * 0.5 + slope * 0.05 + relief * 0.01;
        const nextDistance = distances[u] + length * terrainCost;
        if (nextDistance < distances[v]) {
          distances[v] = nextDistance;
          parents[v] = u;
          heap.push(nextDistance, v);
        }
      }
    }
    if (!done[t]) return null;
    const route = [t];
    while (route[route.length - 1] !== s) route.push(parents[route[route.length - 1]]);
    return route.reverse();
  }

  fallbackResult(base, s, t, start, destination, reason) {
    const path = this.leastRiskPath(s, t);
    if (!path) return Object.assign(base, { status: 'no_route', routes: [], reason });
    const metrics = this.pathMetrics(path);
    const blockedCells = path.filter(cell => !this.passable[cell]).length;
    const unknownCells = path.filter(cell => !Number.isFinite(this.elev[cell]) || !Number.isFinite(this.slopeMax[cell])).length;
    const route = this.routeJson('least_risk_fallback', path, metrics,
      'Least-risk fallback Dijkstra; minimizes hazardous exposure before distance.', start, destination,
      { fallback_cost: Math.round(this.leastRiskCost(path) * 100) / 100 });
    route.validation = {
      passed: false,
      fallback: true,
      blocked_cells: blockedCells,
      unknown_cells: unknownCells,
      warnings: ['This is the least-risk available path, not a fully passable safe route.',
        'The rover may encounter slopes above the normal limit or terrain inside the safety buffer.'],
      checks: this.validatePath(path, s, t).slice(0, 20)
    };
    route.risk = { blocked_cells: blockedCells, unknown_cells: unknownCells, max_slope_deg: metrics.max_slope_deg };
    return Object.assign(base, {
      status: 'fallback',
      routes: [route],
      reason: { code: 'least_risk_fallback', message: reason.message || 'No fully passable route exists; returning the least-risk available path.' }
    });
  }

  leastRiskCost(path) {
    let cost = 0;
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1], b = path[index];
      const ar = Math.floor(a / this.W), br = Math.floor(b / this.W);
      const ac = a % this.W, bc = b % this.W;
      const length = Math.hypot(0.5 * (this.dx[ar] + this.dx[br]) * Math.abs(bc - ac), this.dy * Math.abs(br - ar));
      const penalty = cell => !Number.isFinite(this.elev[cell]) || !Number.isFinite(this.slopeMax[cell]) ? 1e12
        : this.passable[cell] ? 0 : this.rawPassable[cell] ? 1e6
          : 1e9 + Math.max(0, this.slopeMax[cell] - SLOPE_LIMIT_DEG) ** 2 * 1e6;
      cost += length * (1 + 0.5 * (penalty(a) + penalty(b)));
    }
    return cost;
  }

  reachableCount(s) {
    const seen = new Uint8Array(this.H * this.W), stack = [s];
    seen[s] = 1; let n = 0;
    while (stack.length) {
      const u = stack.pop(); n++;
      for (const [v] of this.neighbours(u)) if (!seen[v]) { seen[v] = 1; stack.push(v); }
    }
    return n;
  }

  // ---------- geometry ----------
  cellOf(lon, lat) {
    const g = this.meta.grid, R = g.sphere_radius_m, cosTs = Math.cos(rad(g.lat_ts_deg));
    const x = R * cosTs * rad(lon), y = R * rad(lat);
    return [Math.floor((g.origin_map_m.y_top - y) / g.cell_map_m[1]), Math.floor((x - g.origin_map_m.x_left) / g.cell_map_m[0])];
  }

  cellCenterLonLat(r, c) {
    const g = this.meta.grid, R = g.sphere_radius_m, cosTs = Math.cos(rad(g.lat_ts_deg));
    const x = g.origin_map_m.x_left + (c + 0.5) * g.cell_map_m[0];
    const y = g.origin_map_m.y_top - (r + 0.5) * g.cell_map_m[1];
    return [deg(x / (R * cosTs)), deg(y / R)];
  }

  /** Great-circle distance on the Mars 2000 sphere (m). */
  groundDistance(lon1, lat1, lon2, lat2) {
    const R = this.meta.grid.sphere_radius_m, p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
  }

  // ---------- validation ----------
  checkPoint(r, c) {
    if (!(r >= 0 && r < this.H && c >= 0 && c < this.W)) {
      return ['outside_work_area', 'The point is outside the 58 x 58 km work area covered by the terrain grid.'];
    }
    const i = r * this.W + c;
    if (!(Number.isFinite(this.elev[i]) && Number.isFinite(this.slopeMax[i]))) {
      return ['unknown_terrain', 'The DEM has no valid elevation (NODATA) for this cell.'];
    }
    if (this.slopeMax[i] > SLOPE_LIMIT_DEG) {
      const src = this.source[i] === 1 ? 'HiRISE 1 m p90 / CTX 20 m' : 'CTX 20 m';
      return ['too_steep', `The terrain cell's limiting slope (${src}) is ${this.slopeMax[i].toFixed(1)} deg, above the ` +
        `${SLOPE_LIMIT_DEG.toFixed(0)} deg prototype limit.`];
    }
    if (!this.passable[i]) {
      return ['safety_buffer', `The point is within ${SAFETY_BUFFER_CELLS} cell of extreme or unknown terrain and is reserved as a rover safety buffer.`];
    }
    return null;
  }

  /** Re-check a path with exactly the routing rules. Returns a list of violations. */
  validatePath(p, s, t) {
    const errs = [], { W, passable: P } = this;
    if (!p || !p.length || p[0] !== s || p[p.length - 1] !== t) errs.push('endpoints do not match start/destination cells');
    if (new Set(p).size !== p.length) errs.push('path revisits a cell');
    p.forEach((n, i) => {
      const r = Math.floor(n / W), c = n - r * W;
      if (!P[n]) errs.push(`cell ${i} (${r},${c}) is impassable or unknown`);
      if (i) {
        const pr = Math.floor(p[i - 1] / W), pc = p[i - 1] - pr * W, dr = r - pr, dc = c - pc;
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== 1) errs.push(`step ${i} is not to an adjacent cell`);
        else if (dr && dc && !(P[(pr + dr) * W + pc] && P[pr * W + pc + dc])) errs.push(`step ${i} cuts the corner of an impassable cell`);
      }
    });
    return errs;
  }

  // ---------- metrics ----------
  pathMetrics(p) {
    const { W } = this;
    let D = 0, S = 0, surf = 0, up = 0, down = 0, maxS = -Infinity, maxM = -Infinity;
    let unknownCells = 0;
    const counts = { ctx_20m: 0, hirise_1m: 0 };
    p.forEach((n, i) => {
      const knownSlope = Number.isFinite(this.slopeMax[n]);
      const knownMean = Number.isFinite(this.slopeMean[n]);
      if (!knownSlope || !Number.isFinite(this.elev[n])) unknownCells++;
      maxS = Math.max(maxS, knownSlope ? this.slopeMax[n] : 90);
      maxM = Math.max(maxM, knownMean ? this.slopeMean[n] : 90);
      counts[SOURCE_NAMES[this.source[n]]]++;
      if (!i) return;
      const u = p[i - 1], ru = Math.floor(u / W), r = Math.floor(n / W);
      const dr = r - ru, dc = (n - r * W) - (u - ru * W);
      const seg = Math.hypot(0.5 * (this.dx[ru] + this.dx[r]) * Math.abs(dc), this.dy * Math.abs(dr));
      const dz = Number.isFinite(this.elev[n]) && Number.isFinite(this.elev[u]) ? this.elev[n] - this.elev[u] : 0;
      const slopeU = Number.isFinite(this.slopeMean[u]) ? this.slopeMean[u] : 90;
      const slopeN = Number.isFinite(this.slopeMean[n]) ? this.slopeMean[n] : 90;
      D += seg; S += seg * 0.5 * (slopeU + slopeN); surf += Math.hypot(seg, dz);
      if (dz > 0) up += dz; else down -= dz;
    });
    return {
      distance_m: D, slope_integral_deg_m: S, mean_slope_deg: D > 0 ? S / D : 0, max_slope_deg: maxS,
      max_cell_mean_slope_deg: maxM, surface_distance_m: surf, ascent_m: up, descent_m: down,
      elevation_start_m: this.elev[p[0]], elevation_end_m: this.elev[p[p.length - 1]], cells: p.length,
      cells_by_slope_source: counts, unknown_cells: unknownCells,
    };
  }

  // ---------- main entry ----------
  /** start/destination: {lon, lat} in degrees (Mars 2000 sphere, planetocentric, east-positive). */
  compute(start, destination) {
    const errors = [], cells = {};
    for (const [name, p] of [['start', start], ['destination', destination]]) {
      const lon = Number(p?.lon), lat = Number(p?.lat);
      if (p?.lon == null || p?.lat == null || typeof p.lon === 'boolean' || typeof p.lat === 'boolean' ||
          !Number.isFinite(lon) || !Number.isFinite(lat)) {
        errors.push({ field: name, code: 'malformed', message: 'lon/lat must be finite numbers.' });
        continue;
      }
      const [r, c] = this.cellOf(lon, lat);
      if (!(r >= 0 && r < this.H && c >= 0 && c < this.W)) {
        errors.push({ field: name, code: 'outside_work_area', message: 'The point is outside the terrain grid.' });
      } else {
        cells[name] = [r, c];
        const bad = this.checkPoint(r, c);
        if (bad) errors.push({ field: name, code: bad[0], message: `${bad[1]} Please choose a new point.` });
      }
    }
    if (!errors.length && cells.start[0] === cells.destination[0] && cells.start[1] === cells.destination[1]) {
      errors.push({ field: 'destination', code: 'same_cell', message: 'Start and destination fall in the same 60 m cell. Please choose a farther destination.' });
    }
    const base = this.envelope(start, destination);
    const fatalErrors = errors.filter(error => error.code === 'malformed' || error.code === 'outside_work_area');
    if (fatalErrors.length || !cells.start || !cells.destination) return Object.assign(base, { status: 'invalid_input', errors, routes: [] });

    const terrainErrors = errors.filter(error => error.code !== 'same_cell');
    if (terrainErrors.length) {
      const s = cells.start[0] * this.W + cells.start[1], t = cells.destination[0] * this.W + cells.destination[1];
      return this.fallbackResult(base, s, t, start, destination, { message: 'One or both requested endpoints are unsafe; returning the least-risk available path.' });
    }
    if (errors.some(error => error.code === 'same_cell')) return Object.assign(base, { status: 'invalid_input', errors, routes: [] });

    const s = cells.start[0] * this.W + cells.start[1], t = cells.destination[0] * this.W + cells.destination[1];
    for (const [name, [r, c]] of Object.entries(cells)) {
      const [lon, lat] = this.cellCenterLonLat(r, c), i = r * this.W + c;
      base[name].cell = { row: r, col: c, center_lon: lon, center_lat: lat, slope_max_deg: this.slopeMax[i], elevation_m: this.elev[i] };
    }

    const candidates = new Map();
    for (const k of LOWEST_SLOPE_K) {
      const p = this.path(k, s, t);
      if (!p) {
        const n = this.reachableCount(s);
        const meanDx = this.dx.reduce((a, b) => a + b, 0) / this.dx.length;
        return this.fallbackResult(base, s, t, start, destination, {
            code: 'disconnected',
            message: `No path exists from start to destination through passable cells (known elevation, max slope <= ${SLOPE_LIMIT_DEG.toFixed(0)} deg) ` +
              `with 8-connected moves and no corner cutting. The start cell's passable region has ${n} cells ` +
              `(${(n * this.dy * meanDx / 1e6).toFixed(2)} km2) and does not contain the destination.`,
            reachable_cells_from_start: n,
        });
      }
      candidates.set(k, p);
    }
    const metr = new Map([...candidates].map(([k, p]) => [k, this.pathMetrics(p)]));
    let kLow = LOWEST_SLOPE_K[0];
    for (const k of LOWEST_SLOPE_K) { // key (round(mean, 9), distance), first wins ties
      const a = metr.get(k), b = metr.get(kLow);
      const am = round(a.mean_slope_deg, 9), bm = round(b.mean_slope_deg, 9);
      if (am < bm || (am === bm && a.distance_m < b.distance_m)) kLow = k;
    }
    const Dshort = metr.get(0).distance_m;
    const cost = m => {
      const nd = m.distance_m / Dshort, ns = m.slope_integral_deg_m / (Dshort * SLOPE_LIMIT_DEG);
      return { normalized_distance: nd, normalized_slope: ns, weight_distance: 0.5, weight_slope: 0.5, balanced_cost: 0.5 * nd + 0.5 * ns };
    };
    const plan = [
      ['shortest', candidates.get(0), 'Dijkstra, edge weight = horizontal length (exact optimum on the grid).'],
      ['lowest_slope', candidates.get(kLow),
        `Best length-weighted mean slope among ${LOWEST_SLOPE_K.length} candidate paths ` +
        `(Dijkstra with weight = length * (1 + k * edge_slope / ${SLOPE_LIMIT_DEG.toFixed(0)}), k in [${LOWEST_SLOPE_K.join(', ')}]); ` +
        `selected k = ${kLow}. Not a proven global optimum.`],
      ['balanced', candidates.get(1), 'Dijkstra on the balanced cost (exact optimum on the grid).'],
    ];
    const routes = [], seen = new Map();
    for (const [obj, p, method] of plan) {
      const key = p.join(',');
      if (seen.has(key)) { seen.get(key).also_satisfies_objectives.push(obj); continue; }
      const errs = this.validatePath(p, s, t);
      if (errs.length) { // never return a route that breaks the routing rules
        (base.rejected_routes ||= []).push({ objective: obj, violations: errs.slice(0, 10) });
        continue;
      }
      const m = obj === 'lowest_slope' ? metr.get(kLow) : this.pathMetrics(p);
      const route = this.routeJson(obj, p, m, method, start, destination, cost(m));
      if (obj === 'lowest_slope') {
        route.cost_breakdown.candidates = LOWEST_SLOPE_K.map(k => ({
          k, distance_m: round(metr.get(k).distance_m, 1), mean_slope_deg: round(metr.get(k).mean_slope_deg, 3) }));
      }
      seen.set(key, route); routes.push(route);
    }
    addComparisons(routes);
    Object.assign(base, { status: routes.length ? 'ok' : 'no_route', routes });
    if (!routes.length) base.reason = { code: 'validation_failed', message: 'Every computed path failed re-validation.' };
    return base;
  }

  routeJson(obj, p, m, method, start, dest, cost) {
    const coords = [[Number(start.lon), Number(start.lat)]];
    for (const n of p) {
      const r = Math.floor(n / this.W), [lon, lat] = this.cellCenterLonLat(r, n - r * this.W);
      coords.push([round(lon, 7), round(lat, 7)]);
    }
    coords.push([Number(dest.lon), Number(dest.lat)]);
    const el = p.map(n => round(this.elev[n], 1));
    const elev = [el[0], ...el, el[el.length - 1]];
    // sub-cell legs from the clicked points to their own (passable) cell centres
    const leg = this.groundDistance(...coords[0], ...coords[1]) + this.groundDistance(...coords[coords.length - 2], ...coords[coords.length - 1]);
    const cb = {};
    for (const [k, v] of Object.entries(cost)) cb[k] = typeof v === 'number' && !Number.isInteger(v) ? round(v, 4) : v;
    cb.definition = 'balanced_cost = 0.5 * distance_m/shortest_grid_distance_m + 0.5 * slope_integral/(shortest_grid_distance_m * 20 deg); ' +
      'slope_integral = sum(edge length * mean slope of the two cells)';
    cb.slope_integral_deg_m = round(m.slope_integral_deg_m, 1);
    return {
      route_id: obj, objective: obj, also_satisfies_objectives: [], method,
      geometry: {
        type: 'LineString', coordinates: coords, coordinate_order: '[lon, lat]',
        crs: 'Mars 2000 sphere (R = 3396190 m), planetocentric latitude, east-positive longitude, degrees',
        note: 'First/last vertices are the requested points; the rest are 60 m routing-cell centres.',
        vertex_elevation_m: elev,
        vertex_elevation_note: 'CTX DEM elevation (m) of the routing cell under each vertex; same order as coordinates.',
      },
      distance_m: round(m.distance_m + leg, 1),
      grid_distance_m: round(m.distance_m, 1),
      surface_distance_m: round(m.surface_distance_m + leg, 1),
      mean_slope_deg: round(m.mean_slope_deg, 2),
      max_slope_deg: round(m.max_slope_deg, 2),
      ascent_m: round(m.ascent_m, 1),
      descent_m: round(m.descent_m, 1),
      cells: m.cells,
      cells_by_slope_source: m.cells_by_slope_source,
      hirise_cell_share_pct: round(100 * m.cells_by_slope_source.hirise_1m / m.cells, 1),
      cost_breakdown: cb,
      validation: {
        passed: true,
        checks: ['adjacent steps', 'no corner cutting', `every cell max slope <= ${SLOPE_LIMIT_DEG.toFixed(0)} deg`,
          'no unknown/NODATA cells', 'start/destination cells match', 'no revisits'],
      },
    };
  }

  envelope(start, destination) {
    const req = p => (p && typeof p === 'object' ? { requested: { lon: p.lon ?? null, lat: p.lat ?? null } } : {});
    const g = this.meta.grid || {};
    return {
      schema_version: SCHEMA_VERSION, result_type: 'martian_map_routes', status: null,
      start: req(start), destination: req(destination),
      units: { distance: 'm', elevation: 'm', slope: 'deg' },
      map_context: {
        work_area: g.bounds_lonlat ?? null,
        coordinate_convention: 'Mars 2000 sphere, planetocentric latitude, east-positive longitude (degrees)',
        grid_crs_proj4: g.crs_proj4 ?? null,
        cell_size_m: 60,
        slope_limit_deg: SLOPE_LIMIT_DEG,
        slope_limit_note: 'Prototype heuristic chosen by the team; not a NASA standard.',
        mean_slope_definition: "Length-weighted mean over path edges; each edge's slope = mean of the two cells' " +
          'mean slopes (HiRISE cells: mean 1 m slope; other cells: mean 20 m CTX slope). max_slope_deg = max limiting slope of the cells.',
        limiting_slope_definition: 'HiRISE-covered cells: max(HiRISE p90 of 1 m slopes, CTX max 20 m slope). ' +
          'Other cells: CTX max 20 m slope. A cell is impassable if this exceeds the limit.',
        slope_sources: {
          hirise_1m: 'Mars 2020 TRN HiRISE DTM mosaic, 1 m (partial coverage)',
          ctx_20m: 'Mars 2020 Science Investigation CTX DEM mosaic, 20 m (full work area)',
        },
        engine: 'Node.js port (app/server/routing.js)',
      },
      routes: [],
    };
  }
}

/** Code-generated facts for cards and the explanation model. Only uses numbers already in the route. */
export function addComparisons(routes) {
  if (!routes.length) return;
  const dmin = Math.min(...routes.map(r => r.distance_m));
  const smin = Math.min(...routes.map(r => r.mean_slope_deg));
  const xmin = Math.min(...routes.map(r => r.max_slope_deg));
  const multi = routes.length > 1;
  for (const r of routes) {
    const f = {
      objective: r.objective, also_satisfies_objectives: r.also_satisfies_objectives,
      distance_m: r.distance_m, distance_km: round(r.distance_m / 1000, 2),
      mean_slope_deg: r.mean_slope_deg, max_slope_deg: r.max_slope_deg,
      ascent_m: r.ascent_m, descent_m: r.descent_m, slope_limit_deg: SLOPE_LIMIT_DEG, route_count: routes.length,
      hirise_cell_share_pct: r.hirise_cell_share_pct, hirise_resolution_m: 1, ctx_resolution_m: 20,
    };
    const adv = [], dis = [], comp = [];
    for (const o of routes) {
      if (o === r) continue;
      const dd = round(r.distance_m - o.distance_m, 1);
      comp.push({
        other_route_id: o.route_id, distance_difference_m: dd, distance_difference_pct: round(100 * dd / o.distance_m, 1),
        mean_slope_difference_deg: round(r.mean_slope_deg - o.mean_slope_deg, 2),
        max_slope_difference_deg: round(r.max_slope_deg - o.max_slope_deg, 2),
      });
    }
    if (multi) {
      if (r.distance_m === dmin) adv.push({ code: 'shortest_distance', text: 'Shortest of the returned routes' });
      else dis.push({ code: 'longer', text: `${round(r.distance_m - dmin, 1)} m longer than the shortest returned route` });
      if (r.mean_slope_deg === smin) adv.push({ code: 'lowest_mean_slope', text: 'Lowest mean slope of the returned routes' });
      else dis.push({ code: 'steeper_mean', text: `Mean slope ${round(r.mean_slope_deg - smin, 2)} deg higher than the gentlest returned route` });
      if (r.max_slope_deg === xmin) adv.push({ code: 'lowest_max_slope', text: 'Lowest maximum slope of the returned routes' });
    } else {
      adv.push({ code: 'only_route', text: 'All objectives produced this same route' });
    }
    Object.assign(f, { advantages: adv, disadvantages: dis, comparisons: comp });
    r.explanation_facts = f;
  }
}

export { LABEL };
