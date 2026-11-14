// Martian Map prototype – UI. All route numbers come from the backend JSON (/api/routes);
// this file only displays them. Coordinates: Mars 2000 sphere, planetocentric lat, east-positive lon.
import { TerrainViewport } from '/static/viewer3d.js';

const COLORS = { shortest: '#4cc9f0', lowest_slope: '#80ed99', balanced: '#ffb703' };
const LABEL = { shortest: 'Shortest', lowest_slope: 'Lowest mean slope', balanced: 'Balanced' };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = ll => `${ll.lat.toFixed(5)}° N, ${ll.lng.toFixed(5)}° E`;

let cfg, start = null, dest = null, routeLayers = {}, lastResult = null, selected = null;

// L.CRS.EPSG4326 is used only as a plain lon/lat (plate carrée) grid; nothing Earth-specific is computed.
// No scale bar on purpose: Leaflet measures with Earth's radius, which would be wrong on Mars.
const map = L.map('map', { crs: L.CRS.EPSG4326, center: [18.41, 77.69], zoom: 9, minZoom: 6, maxZoom: 16 });
const ctxTiles = L.tileLayer('https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}',
  { zoomOffset: -1, minZoom: 1, maxNativeZoom: 13, attribution: 'CTX tiles: NASA/JPL/MSSS/Caltech Murray Lab/Esri' });
const viewer = new TerrainViewport($('terrain3d'));

function setMsg(text, kind = 'info') { $('msg').innerHTML = text ? `<div class="${kind}">${text}</div>` : ''; }

function updatePoints() {
  $('startTxt').textContent = start ? fmt(start.getLatLng()) : '–';
  $('destTxt').textContent = dest ? fmt(dest.getLatLng()) : '–';
  $('computeBtn').disabled = !(start && dest);
  $('pickHint').innerHTML = !start ? 'Click the map to set the <b>start</b>.' : !dest ? 'Click the map to set the <b>destination</b>.'
    : 'Press Reset to choose new points.';
  viewer.setPoints(start && start.getLatLng(), dest && dest.getLatLng());
}

function marker(ll, title, color) {
  const m = L.circleMarker(ll, { radius: 8, color: '#000', weight: 2, fillColor: color, fillOpacity: 1 }).bindTooltip(title);
  return m.addTo(map);
}

function inArea(ll) {
  const b = cfg.work_area; return ll.lat >= b.south && ll.lat <= b.north && ll.lng >= b.west && ll.lng <= b.east;
}

function pick(ll) {
  if (!inArea(ll)) { setMsg('That point is outside the 58 × 58 km work area (dashed box). Please choose a point inside it.', 'err'); return; }
  setMsg('');
  if (!start) start = marker(ll, 'Start', '#fff');
  else if (!dest) dest = marker(ll, 'Destination', '#e07a4f');
  else return;
  updatePoints();
  if (start && dest) compute();
}

function clearRoutes() {
  Object.values(routeLayers).forEach(l => map.removeLayer(l)); routeLayers = {}; selected = null;
  $('cards').innerHTML = '<p class="hint">Routes will appear here.</p>'; $('modelNote').textContent = '';
  viewer.setRoutes([]);
}

function reset() {
  [start, dest].forEach(m => m && map.removeLayer(m)); start = dest = null; lastResult = null;
  clearRoutes(); setMsg(''); updatePoints();
}

async function compute() {
  clearRoutes();
  setMsg('Computing routes…');
  const s = start.getLatLng(), d = dest.getLatLng();
  let res;
  try {
    const r = await fetch('/api/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: { lon: s.lng, lat: s.lat }, destination: { lon: d.lng, lat: d.lat },
        map_context: { work_area: 'jezero_58km', view: 'leaflet_lonlat' } }) });
    res = await r.json();
    if (!r.ok) throw new Error(res.error || r.status);
  } catch (e) { setMsg('Route service error: ' + esc(e.message), 'err'); return; }
  lastResult = res;
  if (res.status === 'invalid_input') {
    // Never move a point silently: remove the rejected marker(s) and ask for a new one.
    const lines = res.errors.map(e => `<b>${e.field === 'start' ? 'Start' : 'Destination'}:</b> ${esc(e.message)}`);
    res.errors.forEach(e => {
      if (e.field === 'start' && start) { map.removeLayer(start); start = null; }
      if (e.field === 'destination' && dest) { map.removeLayer(dest); dest = null; }
    });
    updatePoints(); setMsg(lines.join('<br>'), 'err'); return;
  }
  if (res.status === 'no_route') { setMsg('<b>No route found.</b> ' + esc(res.reason?.message), 'err'); return; }
  setMsg(`${res.routes.length} distinct route${res.routes.length > 1 ? 's' : ''} found.`);
  drawRoutes(res.routes);
  renderCards(res.routes, null);
  loadExplanations(res.result_id);
}

function drawRoutes(routes) {
  const all = [];
  routes.slice().reverse().forEach(r => {
    const ll = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    all.push(...ll);
    const line = L.polyline(ll, { color: COLORS[r.objective], weight: 4, opacity: .9 }).addTo(map);
    line.on('click', () => select(r.route_id));
    routeLayers[r.route_id] = line;
  });
  map.fitBounds(L.latLngBounds(all).pad(0.15));
  viewer.setRoutes(routes);
}

function select(id) {
  selected = selected === id ? null : id;
  Object.entries(routeLayers).forEach(([rid, l]) => {
    l.setStyle({ weight: rid === selected ? 7 : 4, opacity: !selected || rid === selected ? .95 : .25 });
    if (rid === selected) l.bringToFront();
  });
  document.querySelectorAll('.card').forEach(c => c.classList.toggle('sel', c.dataset.id === selected));
  viewer.highlight(selected);
}

function renderCards(routes, expl) {
  const ex = {}; (expl?.explanations || []).forEach(e => ex[e.route_id] = e);
  $('cards').innerHTML = routes.map(r => {
    const f = r.explanation_facts, e = ex[r.route_id];
    const also = r.also_satisfies_objectives.length ? `<span class="also">also: ${r.also_satisfies_objectives.map(o => LABEL[o]).join(', ')}</span>` : '';
    const text = e ? `<div class="expl">${esc(e.text)}<span class="badge">${e.source === 'gemma' ? 'Gemma 4 · checked' : 'template'}</span></div>`
      : '<div class="expl hint">Loading explanation…</div>';
    return `<div class="card${r.route_id === selected ? ' sel' : ''}" data-id="${r.route_id}" style="--c:${COLORS[r.objective]}">
      <h3>${LABEL[r.objective]} ${also}</h3>
      <div class="stats">
        <div><b>${(r.distance_m / 1000).toFixed(2)} km</b><span>distance</span></div>
        <div><b>${r.mean_slope_deg.toFixed(2)}°</b><span>mean slope</span></div>
        <div><b>${r.max_slope_deg.toFixed(1)}°</b><span>max slope</span></div>
      </div>
      <p class="hint">Slope source: ${r.hirise_cell_share_pct}% HiRISE 1 m · ${(100 - r.hirise_cell_share_pct).toFixed(1)}% CTX 20 m</p>
      <ul class="pros">${f.advantages.map(a => `<li>${esc(a.text)}</li>`).join('')}</ul>
      <ul class="cons">${f.disadvantages.map(a => `<li>${esc(a.text)}</li>`).join('')}</ul>
      ${text}
      <details><summary>Cost breakdown &amp; method</summary>
        <p>Ascent ${r.ascent_m} m · descent ${r.descent_m} m · ${r.cells} cells</p>
        <p>${esc(r.method)}</p><pre>${esc(JSON.stringify(r.cost_breakdown, null, 1))}</pre></details>
    </div>`;
  }).join('');
  document.querySelectorAll('.card').forEach(c => c.addEventListener('click', ev => {
    if (ev.target.closest('details')) return; select(c.dataset.id);
  }));
}

async function loadExplanations(id) {
  try {
    const r = await fetch('/api/explanations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result_id: id }) });
    const ex = await r.json();
    if (!lastResult || lastResult.result_id !== id) return;
    renderCards(lastResult.routes, ex);
    const m = ex.model || {};
    $('modelNote').textContent = m.error === 'model_unavailable' ? 'Gemma 4 explanations unavailable (no model access configured on the server) — showing code-generated template text.'
      : m.error ? `Gemma 4 call failed (${m.error}) — showing template text.`
      : `Explanations: ${m.model} via ${m.provider} (${m.latency_s} s). Any text with numbers or claims not in the route facts is replaced by the template.`;
  } catch (e) { $('modelNote').textContent = 'Explanation service error: ' + e.message; }
}

async function loadWaypoints() {
  const gj = await (await fetch('/api/waypoints')).json();
  const layer = L.geoJSON(gj, {
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 3, color: '#000', weight: 1, fillColor: '#fff', fillOpacity: .9 }),
    onEachFeature: (f, l) => {
      const p = f.properties;
      l.bindPopup(`<b>Perseverance waypoint</b><br>Sol ${p.sol} · site ${p.site} · drive ${p.drive}<br>${esc(p.note || '')}
        <br><button class="ghost" data-rmc="${esc(p.rmc)}">Rover photos taken here</button><div class="photos"></div>`);
      l.on('popupopen', e => {
        const el = e.popup.getElement(); const btn = el.querySelector('button[data-rmc]');
        btn.onclick = ev => { ev.stopPropagation(); loadPhotos(btn.dataset.rmc, el.querySelector('.photos'), btn); };
      });
    }
  });
  return { layer, n: gj.features.length };
}

async function loadPhotos(rmc, box, btn) {
  btn.disabled = true; box.innerHTML = '<span class="hint">Loading…</span>';
  try {
    const r = await fetch('/api/rover_photos?rmc=' + encodeURIComponent(rmc)); const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    box.innerHTML = j.photos.length ? j.photos.map(p => `<a href="${esc(p.link)}" target="_blank" rel="noopener" title="${esc(p.title)} · ${esc(p.credit)}"><img src="${esc(p.thumb)}" alt="${esc(p.title)}"></a>`).join('')
      + '<p class="hint" style="grid-column:1/-1">Raw images whose site/drive equal this waypoint. Credit: NASA/JPL-Caltech. Not a 360° view.</p>'
      : '<span class="hint">No raw images with this exact site/drive on this sol.</span>';
  } catch (e) { box.innerHTML = `<span class="hint">Photos unavailable: ${esc(e.message)}</span>`; }
}

async function init() {
  cfg = await (await fetch('/api/config')).json();
  const b = cfg.work_area, bounds = [[b.south, b.west], [b.north, b.east]];
  document.querySelectorAll('.lim').forEach(e => e.textContent = cfg.slope_limit_deg);
  const hill = L.imageOverlay(cfg.layers.hillshade, bounds, { opacity: 1, attribution: 'CTX DEM hillshade: USGS/NASA (Calef 2021)' }).addTo(map);
  const imp = L.imageOverlay(cfg.layers.impassable, bounds, { opacity: .8 }).addTo(map);
  const hir = cfg.layers.hirise_coverage ? L.imageOverlay(cfg.layers.hirise_coverage, bounds, { opacity: 1 }).addTo(map) : null;
  L.rectangle(bounds, { color: '#e07a4f', weight: 1.5, dashArray: '6 4', fill: false, interactive: false }).addTo(map);
  map.fitBounds(bounds);
  const overlays = { [`Impassable cells (> ${cfg.slope_limit_deg}° or no data)`]: imp };
  if (hir) overlays['HiRISE 1 m slope coverage'] = hir;
  try { const w = await loadWaypoints(); overlays[`Perseverance waypoints (${w.n})`] = w.layer; w.layer.addTo(map); } catch (e) { console.warn(e); }
  if (cfg.layers.geology) {
    const g = await (await fetch(cfg.layers.geology)).json();
    overlays['Geologic units (SIM 3464)'] = L.geoJSON(g, { style: { color: '#222', weight: .4, fillOpacity: .25 } });
  }
  L.control.layers({ 'CTX DEM hillshade (local data)': hill, 'CTX imagery tiles (online)': ctxTiles }, overlays, { collapsed: true }).addTo(map);
  map.on('click', e => pick(e.latlng));
  map.on('mousemove', e => $('cursor').textContent = fmt(e.latlng));
  $('computeBtn').onclick = compute; $('resetBtn').onclick = reset;
  $('limits').innerHTML = cfg.limitations.map(t => `<li>${esc(t)}</li>`).join('');
  $('sources').innerHTML = cfg.data_sources.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> — ${esc(s.provider)}. ${esc(s.used_for)}${s.license ? ' · ' + esc(s.license) : ''}</li>`).join('')
    + `<li>Explanation model: Gemma 4 26B A4B IT (<code>${esc(cfg.explanation_model.model)}</code>, Apache-2.0)${cfg.explanation_model.name ? ' via ' + esc(cfg.explanation_model.name) : ' — not configured'}.</li>`;
  viewer.init(cfg.terrain_model, ll => pick(L.latLng(ll.lat, ll.lng)));
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === t.dataset.view));
    if (t.dataset.view === 'map') map.invalidateSize(); else viewer.resize();
  });
  updatePoints();
}
init().catch(e => setMsg('Failed to load configuration: ' + esc(e.message), 'err'));
