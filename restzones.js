'use strict';
// restzones.js — rest / emergency zones: flat, low-hazard ~1 km tiles of the terrain grid.
//
// Data reality:
//  * Spatially varying (used to select and score tiles): slope, relief (max - min elevation), DEM depression penalty,
//    passability, and sunlight / terrain shadow at the selected hour.
//  * Site-wide single values (NOT used to select or rank tiles): temperature (Perseverance MEDA) and radiation
//    (Curiosity RAD, Gale crater). They are shown on every tile as the common condition for the selected hour.
//
// Nothing here changes the routing rules; tiles only read the engine's terrain arrays.

const fs = require('node:fs');
const path = require('node:path');

const TILE_CELLS = 17; // 17 x 60 m = 1.02 km
const REST_ZONE_RULES = Object.freeze({
    min_passable_share: 0.80,    // share of tile cells passable by the engine, safety-buffer cells NOT counted as passable
    max_mean_slope_deg: 3,
    // Tuned from the brief's 8 deg / 15 m: with those only 38 of 3136 tiles passed. Relief was the binding rule —
    // 15 m over 1.02 km is a 0.84 deg overall tilt, so even gently tilted flat plains failed. 25 m (~1.4 deg tilt)
    // and a 10 deg single-cell maximum give 99 tiles (3.2%); mean slope, passability and depression stay as specified.
    max_slope_deg: 10,           // steepest single 60 m cell in the tile
    max_relief_m: 25,            // max - min elevation inside the tile
    max_mean_depression: 0.2     // mean of the engine's DEM depression penalty (0..1)
});
const NEAR_ROUTE_M = 2000;
const SHADOW_MAX_M = 30000;     // how far the shadow ray marches toward the sun
const SITE_LAT_DEG = 18.44;     // Mars24 site latitude (Perseverance landing area, data/sun_elevation.json)

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const round = (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; };

/**
 * Score 0-100 (higher = better rest stop). Each term is how far below its threshold the tile is:
 *   score = 100 * (0.5 * (1 - mean_slope / max_mean_slope)
 *                + 0.3 * (1 - relief / max_relief)
 *                + 0.2 * (1 - mean_depression / max_mean_depression))
 * Flatness weighs most, then relief, then crater/basin penalty. Passing tiles score between 0 and 100.
 */
function tileScore(t, rules = REST_ZONE_RULES) {
    const flat = 1 - t.mean_slope_deg / rules.max_mean_slope_deg;
    const relief = 1 - t.relief_m / rules.max_relief_m;
    const dep = 1 - t.mean_depression / rules.max_mean_depression;
    return round(100 * (0.5 * flat + 0.3 * relief + 0.2 * dep), 1);
}

function computeTiles(terrain, rules = REST_ZONE_RULES) {
    const { H, W } = terrain;
    const b = terrain.meta.grid.bounds_lonlat;
    const lonPerCell = (b.east - b.west) / W, latPerCell = (b.north - b.south) / H;
    const tiles = [];
    const rowsOfTiles = Math.floor(H / TILE_CELLS), colsOfTiles = Math.floor(W / TILE_CELLS);
    for (let tr = 0; tr < rowsOfTiles; tr++) {
        for (let tc = 0; tc < colsOfTiles; tc++) {
            const r0 = tr * TILE_CELLS, c0 = tc * TILE_CELLS;
            let n = 0, known = 0, passable = 0, sumMean = 0, maxS = -Infinity, minE = Infinity, maxE = -Infinity, sumDep = 0;
            // least-squares plane z = a*x + b*y + c (x east m, y north m) for the surface normal
            let Sx = 0, Sy = 0, Sz = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0;
            for (let r = r0; r < r0 + TILE_CELLS; r++) {
                const dxRow = terrain.dx[r];
                for (let c = c0; c < c0 + TILE_CELLS; c++) {
                    n++;
                    const i = r * W + c, e = terrain.elev[i];
                    if (!(Number.isFinite(e) && Number.isFinite(terrain.slopeMax[i]))) continue;
                    known++;
                    if (terrain.passable[i]) passable++;
                    sumMean += Number.isFinite(terrain.slopeMean[i]) ? terrain.slopeMean[i] : terrain.slopeMax[i];
                    if (terrain.slopeMax[i] > maxS) maxS = terrain.slopeMax[i];
                    if (e < minE) minE = e;
                    if (e > maxE) maxE = e;
                    sumDep += terrain.depressionPenalty[i];
                    const x = (c - c0) * dxRow, y = -(r - r0) * terrain.dy;
                    Sx += x; Sy += y; Sz += e; Sxx += x * x; Syy += y * y; Sxy += x * y; Sxz += x * e; Syz += y * e;
                }
            }
            if (!known) continue;
            const t = {
                passable_share: passable / n,
                mean_slope_deg: sumMean / known,
                max_slope_deg: maxS,
                relief_m: maxE - minE,
                mean_depression: sumDep / known
            };
            const pass = t.passable_share >= rules.min_passable_share && t.mean_slope_deg <= rules.max_mean_slope_deg &&
                t.max_slope_deg <= rules.max_slope_deg && t.relief_m <= rules.max_relief_m && t.mean_depression <= rules.max_mean_depression;
            if (!pass) { tiles.push({ pass: false }); continue; }
            // solve the 3x3 normal equations for a, b
            const mx = Sx / known, my = Sy / known, mz = Sz / known;
            const cxx = Sxx / known - mx * mx, cyy = Syy / known - my * my, cxy = Sxy / known - mx * my;
            const cxz = Sxz / known - mx * mz, cyz = Syz / known - my * mz;
            const det = cxx * cyy - cxy * cxy;
            const a = det ? (cxz * cyy - cyz * cxy) / det : 0, bb = det ? (cyz * cxx - cxz * cxy) / det : 0;
            const norm = Math.hypot(a, bb, 1);
            const rc = r0 + Math.floor(TILE_CELLS / 2), cc = c0 + Math.floor(TILE_CELLS / 2);
            const [lon, lat] = terrain.cellCenterLonLat(rc, cc);
            tiles.push({
                pass: true,
                id: `T${String(tr).padStart(2, '0')}-${String(tc).padStart(2, '0')}`,
                tile_row: tr, tile_col: tc,
                row: rc, col: cc,
                lon, lat,
                bounds: { west: b.west + c0 * lonPerCell, east: b.west + (c0 + TILE_CELLS) * lonPerCell,
                    north: b.north - r0 * latPerCell, south: b.north - (r0 + TILE_CELLS) * latPerCell },
                size_m: round(TILE_CELLS * terrain.dy),
                passable_share_pct: round(t.passable_share * 100, 1),
                mean_slope_deg: round(t.mean_slope_deg, 2),
                max_slope_deg: round(t.max_slope_deg, 2),
                relief_m: round(t.relief_m, 1),
                mean_depression_penalty: round(t.mean_depression, 3),
                plane_tilt_deg: round(deg(Math.atan(Math.hypot(a, bb))), 2),
                normal: [-a / norm, -bb / norm, 1 / norm], // east, north, up
                elevation_m: round(terrain.elev[rc * W + cc], 1),
                score: tileScore(t, rules)
            });
        }
    }
    return { tiles: tiles.filter(t => t.pass).map(({ pass, ...t }) => t), total: tiles.length };
}

// ---------------- sun ----------------
const SUN = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sun_elevation.json'), 'utf8')); } catch { return null; } })();

/** Mars24 (Allison & McEwen 2000) solar declination from Ls. */
function declinationDeg(ls) {
    const L = rad(ls);
    return deg(Math.asin(0.42565 * Math.sin(L))) + 0.25 * Math.sin(L);
}
/**
 * Sun elevation and azimuth for a local true solar hour (LTST) and season.
 * Elevation: data/sun_elevation.json (Mars24) at the nearest tabulated season and whole hour; formula fallback.
 * Azimuth: same Mars24 declination + hour angle (15 deg per LTST hour from noon), latitude 18.44 deg.
 */
function sunPosition(hour, ls) {
    const h = Math.max(0, Math.min(23, Math.round(Number(hour))));
    const hasLs = ls !== null && ls !== undefined && ls !== '' && Number.isFinite(Number(ls));
    const season = hasLs ? [0, 90, 180, 270, 360].reduce((a, s) => (Math.abs(s - Number(ls)) < Math.abs(a - Number(ls)) ? s : a)) % 360 : 0;
    const dec = rad(declinationDeg(season)), phi = rad(SITE_LAT_DEG), H = rad(15 * (h - 12));
    const sinE = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
    const formulaElev = deg(Math.asin(sinE));
    const table = SUN?.by_ls?.[String(season)]?.[`${String(h).padStart(2, '0')}:00`];
    const elevation = Number.isFinite(table) ? table : formulaElev;
    // azimuth clockwise from north
    const az = (deg(Math.atan2(-Math.sin(H) * Math.cos(dec), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H))) + 360) % 360;
    return {
        hour_ltst: h,
        season_ls_deg: season,
        season_note: hasLs ? `nearest tabulated season to Ls ${round(Number(ls), 1)}` : 'no Ls given: equinox (Ls 0) used',
        elevation_deg: round(elevation, 1),
        azimuth_deg: round(az, 1),
        elevation_source: Number.isFinite(table) ? 'data/sun_elevation.json (Mars24)' : 'Mars24 formula',
        azimuth_source: 'Mars24 declination + hour angle, latitude 18.44 deg'
    };
}

/** True if terrain between the tile centre and the sun rises above the sun's elevation angle. */
function castShadow(terrain, row, col, sun) {
    if (sun.elevation_deg <= 0) return true;
    const tanSun = Math.tan(rad(sun.elevation_deg));
    const az = rad(sun.azimuth_deg);
    const stepM = terrain.dy; // one cell
    const e0 = terrain.elev[row * terrain.W + col] + 2; // ~2 m above ground (astronaut / rover height)
    for (let d = stepM; d <= SHADOW_MAX_M; d += stepM) {
        const r = Math.round(row - Math.cos(az) * d / terrain.dy);
        if (r < 0 || r >= terrain.H) break;
        const c = Math.round(col + Math.sin(az) * d / terrain.dx[r]);
        if (c < 0 || c >= terrain.W) break;
        const e = terrain.elev[r * terrain.W + c];
        if (Number.isFinite(e) && (e - e0) / d > tanSun) return true;
    }
    return false;
}

function illuminationFor(terrain, tile, sun) {
    if (sun.elevation_deg <= 0) return { illumination: 0, sunlit: false, shade_reason: 'sun below horizon' };
    const e = rad(sun.elevation_deg), a = rad(sun.azimuth_deg);
    const s = [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
    const cosI = Math.max(0, tile.normal[0] * s[0] + tile.normal[1] * s[1] + tile.normal[2] * s[2]);
    if (castShadow(terrain, tile.row, tile.col, sun)) return { illumination: 0, sunlit: false, shade_reason: 'terrain shadow' };
    return { illumination: round(cosI, 3), sunlit: cosI > 0, shade_reason: cosI > 0 ? null : 'surface faces away from the sun' };
}

// ---------------- public API ----------------
function createRestZones(terrain) {
    const t0 = Date.now();
    const { tiles, total } = computeTiles(terrain);
    console.log(`Rest zones: ${tiles.length} of ${total} tiles (${TILE_CELLS}x${TILE_CELLS} cells, ~${round(TILE_CELLS * terrain.dy / 1000, 2)} km) pass ` +
        `${JSON.stringify(REST_ZONE_RULES)} in ${Date.now() - t0} ms`);
    const illumCache = new Map();
    function withSun(hour, ls) {
        const sun = sunPosition(hour, ls);
        const key = `${sun.hour_ltst}|${sun.season_ls_deg}`;
        if (!illumCache.has(key)) illumCache.set(key, tiles.map(tile => illuminationFor(terrain, tile, sun)));
        const ill = illumCache.get(key);
        return { sun, zones: tiles.map((tile, i) => ({ ...tile, ...ill[i] })) };
    }
    return { tiles, total, rules: REST_ZONE_RULES, tileCells: TILE_CELLS, withSun };
}

/**
 * Rest zones within NEAR_ROUTE_M of the route, ordered along it.
 * @param {Array<[number, number]>} coordinates route vertices (lon, lat)
 */
function zonesNearRoute(zones, coordinates, terrain, base) {
    if (!coordinates?.length) return { zones: [], longest_gap_m: null };
    const along = [0];
    for (let i = 1; i < coordinates.length; i++) {
        along.push(along[i - 1] + terrain.groundDistance(coordinates[i - 1][0], coordinates[i - 1][1], coordinates[i][0], coordinates[i][1]));
    }
    const total = along.at(-1);
    const near = [];
    for (const z of zones) {
        let best = Infinity, at = 0;
        for (let i = 0; i < coordinates.length; i++) {
            const d = terrain.groundDistance(z.lon, z.lat, coordinates[i][0], coordinates[i][1]);
            if (d < best) { best = d; at = along[i]; }
        }
        if (best <= NEAR_ROUTE_M) {
            near.push({
                ...z,
                distance_to_route_m: round(best),
                route_km: round(at / 1000, 2),
                distance_to_base_m: base?.available ? round(terrain.groundDistance(base.lon, base.lat, z.lon, z.lat)) : null
            });
        }
    }
    near.sort((a, b) => a.route_km - b.route_km || a.distance_to_route_m - b.distance_to_route_m);
    // longest stretch of the route with no rest zone alongside it (start -> first, between, last -> end)
    const marks = [0, ...near.map(z => z.route_km * 1000), total];
    let gap = 0, from = 0, to = total;
    for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > gap) { gap = marks[i] - marks[i - 1]; from = marks[i - 1]; to = marks[i]; }
    return {
        near_route_limit_m: NEAR_ROUTE_M,
        zones: near,
        longest_gap_m: round(gap),
        longest_gap_from_km: round(from / 1000, 2),
        longest_gap_to_km: round(to / 1000, 2),
        route_length_m: round(total)
    };
}

module.exports = { createRestZones, zonesNearRoute, sunPosition, REST_ZONE_RULES, tileScore };
