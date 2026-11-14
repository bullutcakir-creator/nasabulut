// Express demo server for the Martian Map prototype. Listens on 127.0.0.1 only.
//
//   GET  /                       web UI (app/static)
//   GET  /api/config             work area, layers, model + terrain-model status
//   POST /api/routes             {"start": {"lon","lat"}, "destination": {"lon","lat"}, "map_context": {...}}
//   POST /api/explanations       {"result_id": "..."}  -> Gemma (or template) text for a cached result
//   GET  /api/waypoints          Perseverance waypoints inside the work area (GeoJSON)
//   GET  /api/rover_photos?rmc=  raw images taken at that waypoint's exact site/drive
//
// Run from app/:  npm start   (or: node server/server.js --port 8765)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Terrain, SLOPE_LIMIT_DEG, SCHEMA_VERSION } from './routing.js';
import * as explainer from './explain.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.dirname(APP);
const STATIC = path.join(APP, 'static');
const MODEL_DIR = path.join(APP, 'terrain_model');
const GEOLOGY_DIR = path.join(ROOT, 'harita', 'katmanlar');
const HOST = '127.0.0.1';

export const LIMITATIONS = [
  'Slope source differs by place: inside the HiRISE DTM footprint (~286 km2 around the landing site, cyan tint) cells use ' +
  '1 m HiRISE slopes (p90 per 60 m cell) plus the CTX check; everywhere else only the 20 m CTX DEM is available.',
  'Outside HiRISE coverage, features smaller than ~20-60 m (boulders, small scarps) are not resolved: an earlier comparison ' +
  'in this folder found 20 m CTX slopes catch only ~26% of the cells that 1 m HiRISE shows steeper than 20 deg.',
  'Mean slopes from 1 m HiRISE data are systematically higher than 20 m CTX slopes (more small-scale roughness), so mean ' +
  'slopes of routes with different HiRISE shares are not strictly comparable; each card shows its source share.',
  'Using the 90th percentile of 1 m slopes per cell (not the max) is a prototype heuristic: up to 10% of a passable cell can be steeper than the limit.',
  'The 20 deg passability limit is a prototype heuristic chosen by the team, not a NASA standard.',
  'Routing cells are 60 m (3x3 DEM pixels); a cell is impassable if any of its 20 m slopes exceeds the limit.',
  'lowest_slope is the best of a fixed candidate family, not a proven global optimum.',
  'No weather, temperature, dust, soil-strength, rock-abundance or radiation data are used in routing.',
  'Distances are horizontal ground distances on the Mars 2000 sphere (R = 3396190 m).',
  'Work area: ~58 x 58 km square centred on the IAU Gazetteer centre of Jezero; it is a user-defined approximation.',
  'This is a student hackathon prototype; it is not endorsed by NASA and must not be used for real mission planning.',
];

export function createApp({ buildDir = path.join(APP, 'build') } = {}) {
  const terrain = Terrain.load(buildDir);
  const sources = JSON.parse(fs.readFileSync(path.join(APP, 'data_sources.json'), 'utf8'));
  const results = new Map();          // result_id -> result (insertion-ordered, capped)
  const photoCache = new Map();
  let waypointCache = null;

  function waypoints() {
    if (waypointCache) return waypointCache;
    const b = terrain.meta.grid.bounds_lonlat;
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'veri', 'M20_waypoints.json'), 'utf8'));
    const clean = v => (v === -9999 ? null : v);   // -9999 = missing value in this file
    const features = [];
    for (const f of src.features) {
      const p = f.properties, lon = p.lon, lat = p.lat;
      if (lon == null || lat == null || lon === -9999 || lat === -9999) continue;
      if (!(lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north)) continue;
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {
        rmc: p.RMC, site: p.site, drive: p.drive, sol: p.sol, elev_geoid_m: clean(p.elev_geoid),
        dist_total_m: clean(p.dist_total_m), note: p.Note } });
    }
    waypointCache = { type: 'FeatureCollection', source: 'veri/M20_waypoints.json (NASA/JPL-Caltech MMGIS)', coordinate_order: '[lon, lat]', features };
    return waypointCache;
  }

  async function roverPhotos(rmc) {
    if (photoCache.has(rmc)) return photoCache.get(rmc);
    const wp = waypoints().features.map(f => f.properties).find(p => p.rmc === rmc);
    if (!wp) return { error: 'unknown waypoint' };
    const found = []; let pages = 0;
    for (let page = 0; page < 6; page++) {
      const url = 'https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json' +
        `&sol=${Math.trunc(wp.sol)}&num=100&page=${page}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json(); pages++;
      const imgs = j.images || [];
      for (const im of imgs) {
        const same = Number.parseInt(im.site, 10) === Number(wp.site) && Number.parseInt(im.drive, 10) === Number(wp.drive);
        if (same && im.image_files?.small) {
          found.push({ thumb: im.image_files.small, link: im.link, title: im.title, credit: im.credit,
            date_taken_utc: im.date_taken_utc, camera: im.camera?.instrument });
        }
      }
      if (found.length >= 12 || imgs.length < 100) break;
    }
    const out = { rmc, sol: wp.sol, site: wp.site, drive: wp.drive, photos: found.slice(0, 12),
      match_rule: "image.site == waypoint.site AND image.drive == waypoint.drive (same rover position), images from the waypoint's sol only",
      pages_scanned: pages };
    photoCache.set(rmc, out);
    return out;
  }

  function terrainModelStatus() {
    const mf = path.join(MODEL_DIR, 'manifest.json');
    if (!fs.existsSync(mf)) {
      return { status: 'not_provided', message: 'No 3D terrain model has been provided yet. Add app/terrain_model/manifest.json + a .glb/.gltf ' +
        'and run app/inspect_model.py to check format, scale, CRS and extent.' };
    }
    let m;
    try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { return { status: 'invalid_manifest', message: e.message }; }
    return { ...m, status: 'provided', url: '/terrain_model/' + path.basename(m.file || ''), georeferenced: Boolean(m.georeference?.verified) };
  }

  function config() {
    const g = terrain.meta.grid;
    const hasGeology = fs.existsSync(path.join(GEOLOGY_DIR, 'jeolojik_birimler.geojson'));
    return {
      schema_version: SCHEMA_VERSION, work_area: g.bounds_lonlat, centre: g.centre, side_ground_m: g.side_ground_m,
      area_km2_approx: g.area_km2_approx, coordinate_convention: g.lonlat_convention,
      slope_limit_deg: SLOPE_LIMIT_DEG, cell_size_m: g.cell_map_m[0], stats: terrain.meta.stats,
      layers: {
        hillshade: '/static/layers/hillshade.png', impassable: '/static/layers/impassable.png',
        hirise_coverage: terrain.meta.hirise ? '/static/layers/hirise_coverage.png' : null,
        geology: hasGeology ? '/harita/katmanlar/jeolojik_birimler.geojson' : null,
      },
      explanation_model: explainer.provider() || { name: null, model: explainer.GEMINI_MODEL, message: 'No model access configured; template text will be used.' },
      terrain_model: terrainModelStatus(),
      data_sources: sources, limitations: LIMITATIONS,
    };
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '100kb', strict: true }));

  app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(STATIC, 'index.html')));
  app.use('/static', express.static(STATIC, { index: false, dotfiles: 'deny' }));
  app.use('/terrain_model', express.static(MODEL_DIR, { index: false, dotfiles: 'deny',
    setHeaders: (res, p) => { if (p.endsWith('.glb')) res.type('model/gltf-binary'); } }));
  app.use('/harita/katmanlar', express.static(GEOLOGY_DIR, { index: false, dotfiles: 'deny' }));

  app.get('/api/config', (req, res) => res.json(config()));
  app.get('/api/waypoints', (req, res) => res.json(waypoints()));
  app.get('/api/rover_photos', async (req, res) => {
    try { res.json(await roverPhotos(String(req.query.rmc ?? ''))); }
    catch (e) { res.status(502).json({ error: `raw image feed unavailable: ${e.name}` }); }   // reported, not hidden
  });

  app.post('/api/routes', (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || typeof b.start !== 'object' || !b.start || typeof b.destination !== 'object' || !b.destination) {
      return res.status(400).json({ error: 'expected {start:{lon,lat}, destination:{lon,lat}}' });
    }
    const result = terrain.compute(b.start, b.destination);
    result.result_id = crypto.randomBytes(6).toString('hex');
    result.map_context.client = b.map_context && typeof b.map_context === 'object' && !Array.isArray(b.map_context) ? b.map_context : null;
    result.data_sources = sources.sources.filter(s => ['ctx_dem_20m', 'hirise_dtm_1m', 'iau_gazetteer_jezero'].includes(s.id));
    result.limitations = LIMITATIONS;
    results.set(result.result_id, result);
    while (results.size > 100) results.delete(results.keys().next().value);
    res.json(result);
  });

  app.post('/api/explanations', async (req, res) => {
    const result = results.get(String(req.body?.result_id));   // facts come from the server cache, never the client
    if (!result) return res.status(404).json({ error: 'unknown result_id; compute routes first' });
    res.json(await explainer.explain(result));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT || 8765);
  const app = createApp();
  app.listen(port, HOST, () => {
    const p = explainer.provider();
    console.log(`Martian Map prototype (Express) on http://${HOST}:${port}  (model: ${p ? `${p.name} ${p.model}` : 'none configured'})`);
  });
}
