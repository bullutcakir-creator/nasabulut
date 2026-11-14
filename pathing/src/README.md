# Interplanetary Survival Guide: Martian Map — route prototype

Student prototype for the NASA Space Apps Challenge 2026 ("Interplanetary Survival Guide: Martian Map").
**Not affiliated with or endorsed by NASA. Not for real mission planning.**

A user picks a start and a destination inside a ~58 × 58 km work area centred on Jezero crater.
Deterministic code computes up to three walking routes from the CTX DEM and returns versioned JSON. The web UI draws the routes and comparison cards.
Gemma 4 (optional) only rewords code-generated facts, and its output is checked against them.

## Run (from the `app/` folder)

The server, route engine and explanation layer run on **Node.js (≥ 20) + Express**.
Python is used only once, offline, to read the GeoTIFFs (rasterio) and build the routing grid.

```bash
python3 -m venv .venv && .venv/bin/pip install rasterio numpy scipy pillow   # once, for data prep
npm run prepare-data     # builds build/* (grid .bin files + metadata) and map layers (~20 s)
npm install              # once: installs Express
npm start                # http://127.0.0.1:8765 (loopback only); PORT=... or --port ... to change
npm test                 # node:test unit + HTTP tests
```

Optional Gemma access, set on the **server** only (never in the browser):
- `GEMINI_API_KEY=...` uses the Gemini API with model code `gemma-4-26b-a4b-it`.
- `GEMMA_OPENAI_BASE_URL=http://127.0.0.1:8080/v1` uses a local OpenAI-compatible server (llama.cpp, LM Studio or vLLM) serving `google/gemma-4-26B-A4B-it`.
  `GEMMA_LOCAL_MODEL` overrides the model name.

With neither set, routing still works and the UI says the model explanations are unavailable.

## Architecture

| File | Role |
|---|---|
| `prepare_data.py` (Python, offline) | Crops the CTX DEM to the work area. Computes CTX and HiRISE slopes with latitude-corrected ground spacing, aggregates them into 60 m cells and writes `build/` (raw little-endian `*.bin` arrays described by `grid_manifest.json`, plus `terrain_meta.json`) and map PNGs (~20 s). |
| `server/routing.js` | 8-connected grid, Dijkstra with a typed-array heap, no corner cutting, three objectives, path re-validation, JSON builder. |
| `server/explain.js` | Template text, Gemma client (built-in `fetch`), number and topic checker with template fallback. |
| `server/server.js` | Express 4 app bound to 127.0.0.1: static UI plus the JSON API. `createApp()` is exported for tests. |
| `tests/routing.test.js` | `node:test` suite: routing rules, validation, objectives, HiRISE source, explanation checker, Express API. |
| `static/` | Leaflet UI (the stack of the existing `harita/jezero_harita.html`) and the `viewer3d.js` module. |
| `inspect_model.py` | Checks a future .glb/.gltf (format, bounds, transforms, georeference hints). |
| `data_sources.json` | Provenance register: URL, licence, CRS, units, NODATA, download time. |

### API
- `POST /api/routes` with `{"start":{"lon","lat"},"destination":{"lon","lat"},"map_context":{...}}`.
  Coordinates are degrees on the Mars 2000 sphere: planetocentric latitude, east-positive longitude.
- `POST /api/explanations` with `{"result_id"}`. Facts are taken from the server-side cached result, never from the client.
- `GET /api/config`, `GET /api/waypoints`, `GET /api/rover_photos?rmc=<site_drive>`.

### Route JSON (schema_version 1.0.0)
Top level: `status` is `ok`, `invalid_input` or `no_route`. It also carries `start`, `destination`, `routes`, `data_sources`, `limitations`, `map_context`, `units`, `result_id`, and either `errors` or `reason`.
Each route has:
- `route_id`, `objective` and `also_satisfies_objectives`
- `geometry`: a GeoJSON LineString in `[lon, lat]` order, with the CRS stated and per-vertex elevation
- `distance_m`, `mean_slope_deg`, `max_slope_deg`, `ascent_m`, `descent_m`
- `cost_breakdown` and `validation`
- `explanation_facts`: advantages, disadvantages and pairwise comparisons

### Rules
- **Passable cell:** known elevation and limiting slope ≤ **20°**. The 20° limit is a *prototype heuristic chosen by the team, not a NASA standard*. NODATA cells are impassable.
- **Safety buffer:** the eight neighboring cells around every extreme-slope or unknown cell are also reserved as impassable, keeping the rover away from cliff and crater-wall edges.
- **Limiting slope by source:**
  - Inside the HiRISE DTM footprint (~286 km² around the landing site; the cell needs ≥ 90% valid 1 m slopes) it is max(HiRISE **p90** of the 1 m slopes in the cell, CTX max 20 m slope).
  - Everywhere else it is the CTX max 20 m slope.
  - The reported mean slope uses the HiRISE mean 1 m slope where available. Each route reports `cells_by_slope_source` and `hirise_cell_share_pct`.
  - p90 rather than max is a heuristic: a single 1 m pixel is dominated by DTM noise or one boulder.
- **HiRISE alignment:** no resampling. Each 1 m pixel centre maps exactly to a CTX cell through the shared sphere (`x_ctx = x_hirise·cos(18.4663°)`, `y_ctx = y_hirise`). HiRISE and CTX cell mean slopes correlate best at zero offset (r = 0.852).
- **Diagonal moves:** allowed only when both orthogonal neighbours are passable (no corner cutting).
- **Invalid start or destination:** the point is rejected with a reason and never moved.
- **`shortest`:** exact minimum horizontal distance on the grid.
- **`balanced`:** exact minimum of `0.5·D/D_short + 0.5·Σ(len·slope)/(D_short·20°)`. Every route reports these terms in `cost_breakdown`.
- **Depression avoidance:** the engine adds a soft multi-scale DEM depression penalty to edge cost. This discourages crater-like basins while preserving hard exclusion for cells above the limiting slope; it is a heuristic, not a crater classifier.
- **`lowest_slope`:** lowest length-weighted mean slope among 8 candidate paths, using weights `len·(1 + k·slope/20)` for k = 0…64. It is *not* a proven global optimum.
  - Mean slope = Σ(edge length × edge slope) / Σ(edge length).
  - Edge slope = mean of the two cells' mean 20 m slopes.
- **Duplicates:** identical paths are merged (`also_satisfies_objectives`), never repeated.
- **Validation:** every returned path is re-checked with the same rules (adjacency, corner cutting, slope, unknown cells, endpoints).

## 3D terrain model
No 3D model exists in the repository yet. The 3D tab shows a clearly labelled placeholder.
To add a model:
1. Put a `.glb` or `.gltf` file plus `manifest.json` in `app/terrain_model/`. The contract is documented at the top of `static/viewer3d.js`.
2. Run `python3 app/inspect_model.py <file> --compare-work-area`.

Routes and 3D picking are enabled only if the manifest gives a *verified* lon/lat → scene transform. No transform is ever guessed.

## Data, tools and AI use
See `data_sources.json` for the full register.
- Routing uses the USGS Mars 2020 Science Investigation CTX DEM (20 m, full area; public domain, cite Calef/USGS) and the USGS Mars 2020 TRN HiRISE DTM mosaic (1 m, partial; cite Fergason et al. 2020).
- The work-area centre comes from the IAU Gazetteer (Jezero, 18.41° N, 77.69° E).
- Waypoints and raw images are NASA/JPL-Caltech data. Photos are shown only when an image's site and drive match the waypoint.
- Libraries: Node.js + Express 4.21.2 (server, route engine); rasterio/GDAL, NumPy, Pillow (offline data prep; SciPy is no longer needed); Leaflet 1.9.4, three.js 0.160.0 (loaded only if a model is provided).
- AI tools:
  - Claude Code (Anthropic) wrote this code.
  - Gemma 4 26B A4B IT (Google, Apache-2.0) is the optional explanation model.
- Rehearsal artefacts from before the competition (LoRA adapters, `data/train.jsonl`, `test/`, `g_*`/`h_*` outputs) are **not** used by this app and must not be part of the submission.
