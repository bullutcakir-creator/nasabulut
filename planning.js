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

// ---------------- travel time (rover + final walk) ----------------
// Information only: computed from the route length the engine already produced; the route geometry never changes.
const TRAVEL_DEFAULTS = Object.freeze({
    rover_kmh: 9,          // Apollo LRV design speed 9-13 km/h; Apollo 15/16 actual averages were lower (NASA NTRS 20250011301)
    walk_kmh: 3.5,         // 2.2 mph, highest nominal Apollo walking speed (NASA ICES-2026, Mars Spacesuit Mass Requirements)
    walk_m: 500,           // team assumption: final leg on foot
    walkback_limit_m: 10000, // Apollo-derived walk-back limit (NASA JSC 10 km Walkback Test)
    start_hour: 11         // LTST; EVA window below
});
const TRAVEL_LIMITS = Object.freeze({ rover_kmh: [0.5, 20], walk_kmh: [0.5, 8], walk_m: [0, 2000], start_hour: [0, 23.99] });
const EVA_WINDOW = Object.freeze({ start_hour: 11, end_hour: 15 });
const CAREER_LIMIT_MSV = 600; // NASA-STD-3001 Vol. 1 career effective dose limit
const TRAVEL_SOURCES = Object.freeze({
    rover_kmh: 'Apollo LRV design speed 9-13 km/h; Apollo 15/16 actual averages were lower (NASA NTRS 20250011301)',
    walk_kmh: '2.2 mph, highest nominal Apollo walking speed (NASA ICES-2026, Mars Spacesuit Mass Requirements)',
    walk_m: 'Team assumption; adjustable 0-2000 m',
    walkback_limit_m: 'Apollo-derived walk-back limit (NASA JSC 10 km Walkback Test)',
    radiation: 'Curiosity RAD, Gale crater (Hassler et al. 2014); no Jezero measurement exists',
    career_limit: 'NASA-STD-3001 career limit 600 mSv'
});

function travelSettings(input = {}) {
    const out = {};
    for (const [key, fallback] of Object.entries(TRAVEL_DEFAULTS)) {
        const value = Number(input?.[key]);
        const limits = TRAVEL_LIMITS[key];
        out[key] = Number.isFinite(value) && input?.[key] !== '' && input?.[key] !== null
            ? (limits ? Math.min(limits[1], Math.max(limits[0], value)) : value)
            : fallback;
    }
    return out;
}
const round = (x, n = 0) => { const f = 10 ** n; return Math.round(x * f) / f; };
function hhmm(hours) {
    const minutes = Math.round(hours * 60);
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
function clock(hourOfSol) {
    const minutes = Math.round(hourOfSol * 60);
    const day = Math.floor(minutes / 1440), m = minutes - day * 1440;
    return { text: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, sols_later: day };
}

/**
 * @param {object} p
 * @param {number} p.route_length_m        surface distance of the computed route
 * @param {number} p.farthest_from_base_m  largest straight-line distance from the base to any route vertex
 * @param {number|null} p.radiation_msv_per_day  site-wide dose rate (Curiosity RAD, Gale)
 * @param {object} p.settings              user settings (see TRAVEL_DEFAULTS)
 */
function computeTravel({ route_length_m, farthest_from_base_m = null, radiation_msv_per_day = null, settings = {} }) {
    const s = travelSettings(settings);
    const L = Math.max(0, Number(route_length_m) || 0);
    const walk_m = Math.min(s.walk_m, L);
    const drive_m = L - walk_m;
    const drive_h = drive_m / 1000 / s.rover_kmh;
    const walk_h = walk_m / 1000 / s.walk_kmh;
    const total_h = drive_h + walk_h;
    const arrivalHour = s.start_hour + total_h;
    const arrival = clock(arrivalHour);
    const inEva = s.start_hour >= EVA_WINDOW.start_hour && arrivalHour <= EVA_WINDOW.end_hour;
    const beyondWalkback = Number.isFinite(farthest_from_base_m) && farthest_from_base_m > s.walkback_limit_m;
    const dose = Number.isFinite(radiation_msv_per_day) ? radiation_msv_per_day * total_h / 24 : null;
    const warnings = [];
    if (!inEva) warnings.push('Arrival is outside the EVA window');
    if (beyondWalkback) warnings.push(`Beyond ${round(s.walkback_limit_m / 1000, 1)} km walk-back limit if the rover fails`);
    return {
        settings: s,
        route_length_m: round(L, 1),
        drive_m: round(drive_m, 1),
        walk_m: round(walk_m, 1),
        drive_time_h: round(drive_h, 3),
        walk_time_h: round(walk_h, 3),
        total_time_h: round(total_h, 3),
        drive_time_hhmm: hhmm(drive_h),
        walk_time_hhmm: hhmm(walk_h),
        total_time_hhmm: hhmm(total_h),
        rover_speed_kmh: s.rover_kmh,
        rover_speed_m_per_min: round(s.rover_kmh * 1000 / 60, 1),
        walk_speed_kmh: s.walk_kmh,
        walk_speed_m_per_min: round(s.walk_kmh * 1000 / 60, 1),
        start_time_ltst: clock(s.start_hour).text,
        arrival_time_ltst: arrival.text,
        arrival_sols_later: arrival.sols_later,
        eva_window_ltst: `${String(EVA_WINDOW.start_hour).padStart(2, '0')}:00-${EVA_WINDOW.end_hour}:00`,
        arrival_in_eva_window: inEva,
        farthest_from_base_m: Number.isFinite(farthest_from_base_m) ? round(farthest_from_base_m) : null,
        walkback_limit_m: s.walkback_limit_m,
        beyond_walkback_limit: beyondWalkback,
        radiation_rate_msv_per_day: radiation_msv_per_day,
        eva_dose_msv: dose === null ? null : round(dose, 4),
        career_limit_msv: CAREER_LIMIT_MSV,
        eva_dose_pct_of_career_limit: dose === null ? null : round(dose / CAREER_LIMIT_MSV * 100, 4),
        radiation_is_site_wide: true,
        warnings,
        sources: TRAVEL_SOURCES,
        note: 'Information only; travel time does not change the route.'
    };
}

/** Largest straight-line distance from the base to any vertex of the route (lon/lat coordinates). */
function farthestFromBase(coordinates, base, terrain) {
    if (!base?.available || !coordinates?.length) return null;
    let max = 0;
    for (const [lon, lat] of coordinates) max = Math.max(max, terrain.groundDistance(base.lon, base.lat, lon, lat));
    return max;
}

module.exports = { computeBase, computeTravel, farthestFromBase, travelSettings, TRAVEL_DEFAULTS };
