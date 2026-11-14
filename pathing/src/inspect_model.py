"""Inspect a candidate 3D terrain model before wiring it into the viewer.

Reports container format, glTF version, generator, extensions, mesh/node count, the POSITION
accessor bounds (min/max) and any CRS/georeference hints found in asset.extras or node extras.
It does NOT invent a georeference: if no CRS/extent is stated, it says so.

Usage:  python3 app/inspect_model.py path/to/model.glb|.gltf [--compare-work-area]
"""
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def read_gltf(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] == b"glTF":
        magic, version, length = struct.unpack_from("<4sII", data, 0)
        clen, ctype = struct.unpack_from("<I4s", data, 12)
        if ctype != b"JSON":
            raise ValueError("first GLB chunk is not JSON")
        return "glb", version, json.loads(data[20:20 + clen])
    try:
        return "gltf", None, json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        ext = os.path.splitext(path)[1].lower()
        raise ValueError(f"not glTF/GLB (extension {ext}); convert to .glb first (e.g. Blender or obj2gltf) and re-run")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    kind, ver, g = read_gltf(path)
    lo, hi = [float("inf")] * 3, [float("-inf")] * 3
    for m in g.get("meshes", []):
        for p in m.get("primitives", []):
            a = g["accessors"][p["attributes"]["POSITION"]]
            if "min" in a and "max" in a:
                lo = [min(x, y) for x, y in zip(lo, a["min"])]
                hi = [max(x, y) for x, y in zip(hi, a["max"])]
    hints = {k: v for k, v in (g.get("asset", {}).get("extras") or {}).items()}
    for n in g.get("nodes", []):
        if n.get("extras"):
            hints.setdefault("node_extras", []).append(n["extras"])
    transforms = [{k: n[k] for k in ("matrix", "scale", "translation", "rotation") if k in n} for n in g.get("nodes", []) if any(k in n for k in ("matrix", "scale", "translation", "rotation"))]
    rep = {
        "file": path, "bytes": os.path.getsize(path), "container": kind, "glb_version": ver,
        "asset": g.get("asset"), "extensions_used": g.get("extensionsUsed", []), "extensions_required": g.get("extensionsRequired", []),
        "meshes": len(g.get("meshes", [])), "nodes": len(g.get("nodes", [])),
        "position_bounds_model_units": {"min": lo, "max": hi, "size": [h - l for l, h in zip(lo, hi)]} if lo[0] != float("inf") else None,
        "node_transforms": transforms[:10],
        "georeference_hints": hints or None,
        "verdict": [],
    }
    if not hints:
        rep["verdict"].append("No CRS / extent / units metadata found in the file. Ask the model author for CRS, units, "
                              "scale and the lon/lat of known points before enabling 3D routes.")
    if "KHR_draco_mesh_compression" in rep["extensions_required"]:
        rep["verdict"].append("Draco-compressed: viewer needs DRACOLoader added.")
    if "--compare-work-area" in sys.argv:
        meta = json.load(open(os.path.join(HERE, "build", "terrain_meta.json")))["grid"]
        rep["work_area_ground_m"] = meta["side_ground_m"]
        if rep["position_bounds_model_units"]:
            rep["verdict"].append("Compare the model's horizontal size with work_area_ground_m only after its units are confirmed.")
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
