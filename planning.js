'use strict';
// planning.js — mission-planning helpers that sit on top of the route engine.
// None of these change routing rules (20° limit, safety buffer, cost); they only read the terrain and the computed route.

const MAX_BASE_SEARCH_RINGS = 60; // 60 cells = 3.6 km search radius for a passable base cell

/**
 * Base camp = exact centre cell of the terrain grid. If that cell fails the engine's own endpoint check
 * (too steep, unknown terrain, or safety buffer), move to the nearest cell (ground distance) that passes.
 */
function computeBase(terrain) {
    const row0 = Math.floor(terrain.H / 2), col0 = Math.floor(terrain.W / 2);
    const [lon0, lat0] = terrain.cellCenterLonLat(row0, col0);
    const centreProblem = terrain.checkPoint(row0, col0);
    let best = centreProblem ? null : { row: row0, col: col0, d: 0 };
    for (let ring = 1; !best && ring <= MAX_BASE_SEARCH_RINGS; ring++) {
        for (let dr = -ring; dr <= ring; dr++) {
            for (let dc = -ring; dc <= ring; dc++) {
                if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
                const r = row0 + dr, c = col0 + dc;
                if (terrain.checkPoint(r, c)) continue;
                const [lon, lat] = terrain.cellCenterLonLat(r, c);
                const d = terrain.groundDistance(lon0, lat0, lon, lat);
                if (!best || d < best.d) best = { row: r, col: c, d };
            }
        }
    }
    if (!best) return { available: false, note: `No passable cell within ${MAX_BASE_SEARCH_RINGS} cells of the map centre.` };
    const [lon, lat] = terrain.cellCenterLonLat(best.row, best.col);
    const i = best.row * terrain.W + best.col;
    return {
        available: true,
        name: 'Base',
        lon, lat,
        row: best.row, col: best.col,
        elevation_m: terrain.elev[i],
        slope_max_deg: terrain.slopeMax[i],
        map_centre: { lon: lon0, lat: lat0, row: row0, col: col0 },
        adjusted: !!centreProblem,
        adjustment_m: Math.round(best.d),
        adjustment_reason: centreProblem ? centreProblem[1] : null
    };
}

module.exports = { computeBase };
