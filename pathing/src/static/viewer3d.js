// Modular 3D terrain viewport. It is deliberately NOT tied to any specific model.
//
// Contract (app/terrain_model/manifest.json, served via /api/config -> terrain_model):
// {
//   "file": "jezero.glb",                 // .glb or .gltf placed in app/terrain_model/
//   "source": "...", "license": "...",
//   "georeference": {                    // optional; without it the model is shown but routes/picking stay off
//     "verified": true,                  // set only after app/inspect_model.py + a known-point check
//     "lonlat_to_scene": { "x": [a, b, c], "z": [d, e, f] },   // x = a*lon + b*lat + c ; z = d*lon + e*lat + f
//     "elevation_to_y":  [s, o]          // y = s*elevation_m + o
//   }
// }
// No transform is ever guessed here: if the manifest does not provide one, 3D routes are not drawn.

export class TerrainViewport {
  constructor(el) { this.el = el; this.routes = []; this.ready = false; }

  init(status, onPick) {
    this.status = status || { status: 'not_provided' };
    this.onPick = onPick;
    if (this.status.status !== 'provided') return this._placeholder();
    this._load().catch(e => this._placeholder(`Model could not be loaded: ${e.message}`));
  }

  _placeholder(extra) {
    const s = this.status;
    this.el.innerHTML = `<div class="placeholder3d"><h3>3D terrain view — no model loaded</h3>
      <p>${s.message || 'No 3D terrain model has been provided yet.'}</p>
      ${extra ? `<p>${extra}</p>` : ''}
      <p>Point picking and route display work on the <b>2D map</b> tab, which is georeferenced from the CTX DEM.
      When a terrain model (.glb/.gltf) is supplied and its format, scale, CRS and extent are verified,
      it will load here; routes are drawn in 3D only if the model ships with a verified lon/lat → scene transform.</p></div>`;
  }

  async _load() {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
    this.THREE = THREE;
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 600;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h); this.el.innerHTML = ''; this.el.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0d0b0a);
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1e7);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x332211, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(1, 2, 1); scene.add(sun);
    const gltf = await new GLTFLoader().loadAsync(this.status.url);
    scene.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    camera.position.copy(c).add(new THREE.Vector3(0, size.length() * 0.6, size.length() * 0.6)); camera.lookAt(c);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(c);
    Object.assign(this, { renderer, scene, camera, controls, model: gltf.scene, routeGroup: new THREE.Group() });
    scene.add(this.routeGroup);
    const g = this.status.georeference;
    this.geo = g && g.verified && g.lonlat_to_scene && g.elevation_to_y ? g : null;
    const note = document.createElement('div'); note.className = 'placeholder3d';
    note.style.cssText = 'position:absolute;top:44px;right:10px;margin:0;max-width:300px;background:rgba(20,17,15,.85)';
    note.textContent = this.geo ? 'Model georeferenced (manifest). Double-click terrain to pick points.'
      : 'Model shown without a verified georeference: routes and picking are disabled in 3D.';
    this.el.appendChild(note);
    if (this.geo) renderer.domElement.addEventListener('dblclick', e => this._pick(e));
    const loop = () => { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); }; loop();
    this.ready = true; this.setRoutes(this.routes);
  }

  _toScene([lon, lat], elev) {
    const { x, z } = this.geo.lonlat_to_scene, [s, o] = this.geo.elevation_to_y;
    return new this.THREE.Vector3(x[0] * lon + x[1] * lat + x[2], s * elev + o, z[0] * lon + z[1] * lat + z[2]);
  }

  _pick(e) {
    const T = this.THREE, r = this.renderer.domElement.getBoundingClientRect();
    const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = ray.intersectObject(this.model, true)[0]; if (!hit) return;
    const { x, z } = this.geo.lonlat_to_scene, det = x[0] * z[1] - x[1] * z[0];   // invert the 2x2 affine
    const px = hit.point.x - x[2], pz = hit.point.z - z[2];
    this.onPick && this.onPick({ lng: (px * z[1] - x[1] * pz) / det, lat: (x[0] * pz - z[0] * px) / det });
  }

  setRoutes(routes) {
    this.routes = routes || [];
    if (!this.ready || !this.geo) return;
    const T = this.THREE; this.routeGroup.clear();
    const colors = { shortest: 0x4cc9f0, lowest_slope: 0x80ed99, balanced: 0xffb703 };
    this.routes.forEach(r => {
      const pts = r.geometry.coordinates.map((c, i) => this._toScene(c, r.geometry.vertex_elevation_m[i]));
      const line = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: colors[r.objective] }));
      line.userData.id = r.route_id; this.routeGroup.add(line);
    });
  }

  highlight(id) {
    if (!this.ready || !this.geo) return;
    this.routeGroup.children.forEach(l => { l.material.opacity = !id || l.userData.id === id ? 1 : 0.2; l.material.transparent = true; });
  }

  setPoints() { /* markers in 3D are added once a georeferenced model exists */ }

  resize() {
    if (!this.ready) return;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
}
