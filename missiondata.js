'use strict';
// missiondata.js — every environment value shown in the "Mission data" panel, read from data/ files.
// No value is typed in here: numbers, sols, notes and credits all come from the JSON files.
// Temperature, pressure, wind, humidity, dust, UV and radiation are single-site measurements (site-wide).

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, 'data');
function load(name) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); }
    catch (error) { console.warn(`data/${name} could not be read: ${error.message}`); return null; }
}
const ENV = load('environment_meda.json');
const SUN = load('sun_elevation.json');
const SOURCES = load('kaynaklar_v3.json');
const WAYPOINTS = load('waypoint_images.json');

const SEASONS = [0, 90, 180, 270];
const num = v => (Number.isFinite(v) ? v : null);
const round = (x, n = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : null);
const kToC = k => (Number.isFinite(k) ? round(k - 273.15, 1) : null);
const solRange = sols => (Array.isArray(sols) && sols.length ? `${Math.min(...sols)}–${Math.max(...sols)}` : null);

function parseSeason(ls) {
    if (ls === undefined || ls === null || ls === '' || ls === 'all') return null;
    const v = Number(ls);
    return SEASONS.includes(v) ? v : null;
}
function clampHour(hour) {
    const h = Math.round(Number(hour));
    return Number.isFinite(h) ? Math.max(0, Math.min(23, h)) : 13;
}

function temperatureSection(h) {
    const t = ENV?.temperature;
    const row = (t?.by_ltst_hour || []).find(x => x.hour === h);
    const block = b => (b ? {
        median_k: num(b.median), p10_k: num(b.p10), p90_k: num(b.p90),
        median_c: kToC(b.median), p10_c: kToC(b.p10), p90_c: kToC(b.p90)
    } : null);
    return {
        site_wide: true,
        source: t?.instrument || 'Perseverance MEDA TIRS',
        air: block(row?.air_temp_k), ground: block(row?.ground_temp_k),
        n_sols: row?.n_sols ?? null
    };
}
function pressureSection(h) {
    const p = ENV?.pressure, b = p?.by_hour_ltst?.[String(h)];
    return { site_wide: true, source: p?.instrument || 'Perseverance MEDA PS', median_pa: num(b?.median), p10_pa: num(b?.p10), p90_pa: num(b?.p90), note: p?.note || null };
}
function windSection(h) {
    const w = ENV?.wind, b = w?.by_hour_ltst?.[String(h)];
    const sols = solRange(w?.sols);
    return {
        site_wide: true, source: w?.instrument || 'Perseverance MEDA WS',
        median_m_s: num(b?.median), p90_m_s: num(b?.p90),
        note: `${sols ? `measured sols ${sols}; ` : ''}affects dust and visibility`
    };
}
function humiditySection(h) {
    const r = ENV?.humidity, b = r?.by_hour_ltst?.[String(h)];
    return { site_wide: true, source: r?.instrument || 'Perseverance MEDA HS', median_pct: num(b?.median), p90_pct: num(b?.p90), note: r?.quality || null };
}
function dustSection(season) {
    const d = ENV?.dust_opacity;
    const b = season === null ? d?.all : d?.by_ls_30deg?.[String(season)];
    return {
        site_wide: true, source: d?.instrument || 'Perseverance Mastcam-Z', license: d?.license || null, doi: d?.doi || null,
        scope: season === null ? 'all seasons' : `Ls ${season}–${season + 30}`,
        median_tau: num(b?.median), p90_tau: num(b?.p90)
    };
}
function uvSection(h) {
    const u = ENV?.uv, b = u?.by_hour_ltst?.[String(h)];
    return {
        site_wide: true, source: u?.instrument || 'Perseverance MEDA RDS',
        median_w_m2: num(b?.median), p90_w_m2: num(b?.p90),
        note: 'relative daily cycle only (narrow field of view)'
    };
}
function sunSection(h, season) {
    const key = `${String(h).padStart(2, '0')}:00`;
    const tableFor = s => num(SUN?.by_ls?.[String(s)]?.[key]);
    let elevation = null, range = null;
    if (season !== null) elevation = tableFor(season);
    else {
        const vals = SEASONS.map(tableFor).filter(Number.isFinite);
        if (vals.length) range = { min_deg: Math.min(...vals), max_deg: Math.max(...vals) };
    }
    // measured MEDA geometry: same hour bin over all sols
    const measured = Object.values(SUN?.measured_meda || {}).map(v => num(v?.elev_by_hour_bin?.[String(h).padStart(2, '0')] ?? v?.elev_by_hour_bin?.[String(h)])).filter(Number.isFinite);
    // lowest sun elevation inside the EVA window (whole hours start..end) for the season(s)
    const eva = ENV?.recommended_eva_window_ltst;
    const evaStart = eva ? Number(String(eva.start).slice(0, 2)) : null, evaEnd = eva ? Number(String(eva.end).slice(0, 2)) : null;
    let evaMin = null;
    if (Number.isFinite(evaStart) && Number.isFinite(evaEnd)) {
        const seasons = season === null ? SEASONS : [season];
        const vals = [];
        for (const s of seasons) for (let hh = evaStart; hh <= evaEnd; hh++) {
            const v = num(SUN?.by_ls?.[String(s)]?.[`${String(hh).padStart(2, '0')}:00`]);
            if (Number.isFinite(v)) vals.push(v);
        }
        if (vals.length) evaMin = Math.min(...vals);
    }
    return {
        source: 'NASA GISS Mars24 (Allison & McEwen 2000); MEDA ancillary',
        hour_ltst: h,
        season: season === null ? 'all' : `Ls ${season}`,
        elevation_deg: elevation,
        elevation_range_deg: range,
        measured_range_deg: measured.length ? { min_deg: Math.min(...measured), max_deg: Math.max(...measured), sols: measured.length } : null,
        eva_window_ltst: eva ? `${eva.start}–${eva.end}` : null,
        eva_min_elevation_deg: evaMin
    };
}
function radiationSection() {
    const r = ENV?.radiation;
    return {
        site_wide: true,
        source: r?.citation ? `Curiosity RAD (${r.citation.split(',').slice(0, 2).join(',')})` : 'Curiosity RAD',
        mgy_per_day: num(r?.dose_rate_mgy_per_day), mgy_uncertainty: num(r?.dose_rate_uncertainty_mgy_per_day),
        msv_per_day: num(r?.dose_equivalent_msv_per_day), msv_uncertainty: num(r?.dose_equivalent_uncertainty_msv_per_day),
        measured_at: r?.measured_at || null,
        note: 'Gale crater value, no Jezero measurement'
    };
}
function sourcesSection() {
    const list = Array.isArray(SOURCES?.sources) ? SOURCES.sources : [];
    return list.map(s => ({ id: s.id, title: s.name || s.id, license: s.license || null, url: s.url || null }));
}

function missionData({ hour = 13, ls = null } = {}) {
    const h = clampHour(hour), season = parseSeason(ls);
    return {
        hour_ltst: h,
        season: season === null ? 'all' : season,
        temperature: temperatureSection(h),
        pressure: pressureSection(h),
        wind: windSection(h),
        humidity: humiditySection(h),
        dust: dustSection(season),
        uv: uvSection(h),
        sun: sunSection(h, season),
        radiation: radiationSection(),
        sources: sourcesSection()
    };
}

// ---------------- Perseverance waypoint closest to a route ----------------
const CREDITS = (() => {
    // "Credits: NAVCAM NASA/JPL-Caltech; Mastcam-Z NASA/JPL-Caltech/ASU."
    const text = WAYPOINTS?.meta?.notes || '';
    const m = text.match(/Credits:\s*([^]*?)(?:\.\s*$|$)/);
    const out = {};
    if (m) for (const part of m[1].split(';')) {
        const t = part.trim(), i = t.indexOf(' ');
        if (i > 0) out[t.slice(0, i).toUpperCase()] = t.slice(i + 1).replace(/\.$/, '');
    }
    return out;
})();
function creditFor(instrument) {
    const key = String(instrument || '').toUpperCase();
    if (key.startsWith('NAVCAM')) return CREDITS.NAVCAM || null;
    if (key.startsWith('MCZ')) return CREDITS['MASTCAM-Z'] || null;
    return null;
}
/**
 * @param {Array<[number, number]>} coordinates route vertices (lon, lat)
 * @param {(lon1:number, lat1:number, lon2:number, lat2:number) => number} distance ground distance in metres
 */
function nearestPerseverance(coordinates, distance) {
    if (!WAYPOINTS?.waypoints?.length || !coordinates?.length) return { available: false };
    let best = null;
    for (const w of WAYPOINTS.waypoints) {
        if (!w.images?.length) continue;
        for (const [lon, lat] of coordinates) {
            const d = distance(lon, lat, w.lon, w.lat);
            if (!best || d < best.d) best = { w, d };
        }
    }
    if (!best) return { available: false };
    const img = best.w.images[0];
    return {
        available: true,
        source: 'NASA Raw Images (Perseverance)',
        sol: best.w.sol, site: best.w.site, drive: best.w.drive, lat: best.w.lat, lon: best.w.lon,
        distance_m: Math.round(best.d),
        image: img ? { url_small: img.url_small || null, url_full: img.url_full || null, instrument: img.instrument || null, credit: creditFor(img.instrument) } : null
    };
}

module.exports = { missionData, nearestPerseverance };
