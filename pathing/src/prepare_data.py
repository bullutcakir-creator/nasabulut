"""Prepare the routing grid for the Martian Map prototype.

Reads the USGS Mars 2020 Science Investigation CTX DEM mosaic (20 m/px), crops it to the
~58 x 58 km Jezero-centred work area, computes terrain slope with ground-true horizontal
spacing, aggregates it to the routing grid and writes:

  app/build/terrain.npz          routing grid arrays (elevation, slope max/mean, validity)
  app/build/terrain_meta.json    georeferencing + provenance of the grid
  app/static/layers/*.png        hillshade + impassable overlay for the web map

Every georeferencing number is taken from the raster's own CRS/transform; the script stops
if the CRS is not the expected equirectangular sphere, rather than guessing.

Usage:  app/.venv/bin/python -I app/prepare_data.py   (run from the mars/ folder)
"""
import datetime as dt
import json
import math
import os
import sys

import numpy as np
import rasterio
from rasterio.windows import Window
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEM_PATH = os.path.join(ROOT, "veri", "M20_JezeroCrater_CTXDEM_20m.tif")
HIRISE_PATH = os.path.join(ROOT, "veri", "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif")
HIRISE_PCT = 90            # percentile of 1 m slopes used as the cell's limiting slope
HIRISE_MIN_VALID = 0.9     # min fraction of a cell with valid 1 m slopes to use HiRISE for that cell
HIST_BIN_DEG = 0.1         # histogram bin for per-cell percentile (value reported = bin upper edge)
BUILD = os.path.join(HERE, "build")
LAYERS = os.path.join(HERE, "static", "layers")

# Work-area centre: IAU Gazetteer of Planetary Nomenclature, feature "Jezero" (ID 2866 search
# result row: centre 18.41 N, 77.69 E, planetocentric, +East 0-360, diameter 47.52 km).
# https://planetarynames.wr.usgs.gov/SearchResults?Target=20_Mars&Feature%20Name=Jezero
CENTER_LAT = 18.41
CENTER_LON = 77.69
HALF_SIDE_GROUND_M = 29_000.0       # 58 km square (user-defined approximate work area)
AGG = 3                             # 3 x 3 DEM pixels (20 m) -> 60 m routing cell
SLOPE_LIMIT_DEG = 20.0              # prototype heuristic, NOT a NASA standard


def check_crs(src):
    d = src.crs.to_dict()
    need = {"proj": "eqc", "lat_0": 0, "lon_0": 0, "x_0": 0, "y_0": 0, "units": "m"}
    for k, v in need.items():
        if d.get(k) != v:
            sys.exit(f"Unexpected CRS parameter {k}={d.get(k)!r} (expected {v!r}); refusing to guess.")
    if "R" not in d or "lat_ts" not in d:
        sys.exit("CRS lacks sphere radius R or lat_ts; refusing to guess.")
    if src.transform.b != 0 or src.transform.d != 0:
        sys.exit("Rotated raster transform not supported.")
    return float(d["R"]), float(d["lat_ts"])


def hirise_cell_stats(R, lat_ts, gx0, gy0, cell, H, W):
    """1 m HiRISE slope statistics per routing cell (cells defined in the CTX map grid).

    HiRISE CRS (read from file) must be eqc on the same sphere with lat_ts = 0, lon_0 = 0. A HiRISE pixel
    centre (x_h, y_h) maps exactly to the CTX grid via lon = x_h / R, lat = y_h / R:
        x_ctx = R*cos(lat_ts_ctx)*lon = x_h*cos(lat_ts_ctx),  y_ctx = y_h.
    No resampling: every valid 1 m slope is assigned to the cell containing its centre.
    """
    nb = int(round(90 / HIST_BIN_DEG))
    hist = None
    with rasterio.open(HIRISE_PATH) as h:
        d = h.crs.to_dict()
        for k, v in {"proj": "eqc", "lat_ts": 0, "lon_0": 0, "x_0": 0, "y_0": 0, "units": "m"}.items():
            if d.get(k) != v:
                sys.exit(f"HiRISE CRS {k}={d.get(k)!r}, expected {v!r}; refusing to guess.")
        if float(d.get("R", -1)) != R:
            sys.exit(f"HiRISE sphere R={d.get('R')} differs from CTX R={R}; refusing to mix.")
        if h.transform.b or h.transform.d:
            sys.exit("Rotated HiRISE transform not supported.")
        hx0, hy0, hp = h.transform.c, h.transform.f, h.transform.a
        if hp != 1.0 or h.transform.e != -1.0:
            sys.exit("Expected 1 m HiRISE pixels.")
        cos_ts = math.cos(math.radians(lat_ts))
        info = {"file": os.path.basename(HIRISE_PATH), "bytes": os.path.getsize(HIRISE_PATH), "crs_proj4": h.crs.to_proj4(),
                "size_px": [h.width, h.height], "pixel_size_map_m": [hp, hp], "nodata": h.nodata}
        cols = np.arange(h.width)
        cell_col = np.floor(((hx0 + cols + 0.5) * cos_ts - gx0) / cell).astype(np.int64)
        okc = (cell_col >= 0) & (cell_col < W)
        n_valid = np.zeros((H, W), np.int64)
        s_sum = np.zeros((H, W))
        s_max = np.full((H, W), np.nan)
        hist = np.zeros((H, W, nb), np.int32)
        for r in range(H):
            yt, yb = gy0 - r * cell, gy0 - (r + 1) * cell
            i0 = max(0, int(math.ceil(hy0 - yt - 0.5)))         # first HiRISE row whose centre is <= yt
            i1 = min(h.height, int(math.ceil(hy0 - yb - 0.5)))  # exclusive
            if i1 <= i0:
                continue
            a0, a1 = max(0, i0 - 1), min(h.height, i1 + 1)     # 1-row halo for central differences
            z = h.read(1, window=Window(0, a0, h.width, a1 - a0)).astype("float64")
            z[(z == h.nodata) | ~np.isfinite(z) | (z < -1e30)] = np.nan
            lat = np.radians((hy0 - (np.arange(a0, a1) + 0.5)) / R)
            gx = np.gradient(z, axis=1) / (hp * np.cos(lat))[:, None]   # lat_ts = 0: ground E-W = map dx * cos(lat)
            gy = np.gradient(z, axis=0) / hp
            sl = np.degrees(np.arctan(np.hypot(gx, gy)))[i0 - a0:i1 - a0][:, okc]
            cc = np.broadcast_to(cell_col[okc], sl.shape)
            v = np.isfinite(sl)
            if not v.any():
                continue
            sv, cv = sl[v], cc[v]
            n_valid[r] = np.bincount(cv, minlength=W)
            s_sum[r] = np.bincount(cv, weights=sv, minlength=W)
            mx = np.full(W, -np.inf); np.maximum.at(mx, cv, sv); mx[np.isinf(mx)] = np.nan; s_max[r] = mx
            b = np.minimum((sv / HIST_BIN_DEG).astype(np.int64), nb - 1)
            hist[r] = np.bincount(cv * nb + b, minlength=W * nb).reshape(W, nb)
    expected = cell * cell / cos_ts                    # HiRISE pixels whose centres fall in one cell
    valid_frac = n_valid / expected
    cum = np.cumsum(hist, axis=2)
    need = np.ceil(n_valid * HIRISE_PCT / 100.0)[..., None]
    k = np.argmax(cum >= np.maximum(need, 1), axis=2)
    with np.errstate(all="ignore"):
        p = np.where(n_valid > 0, (k + 1) * HIST_BIN_DEG, np.nan)
        mean = np.where(n_valid > 0, s_sum / n_valid, np.nan)
    p = np.minimum(p, np.where(np.isnan(s_max), p, s_max))   # bin edge never exceeds the true max
    use = valid_frac >= HIRISE_MIN_VALID
    return {"p": p, "mean": mean, "max": s_max, "valid_frac": valid_frac, "use": use, "info": info}


def export_raw(elev, s_max, s_mean, source, cell_dx_ground):
    """Raw little-endian arrays (row-major) for the Node.js route engine, described by grid_manifest.json."""
    arrays = {"elev": (elev, "<f4"), "slope_max": (s_max, "<f4"), "slope_mean": (s_mean, "<f4"),
              "slope_source": (source, "u1"), "cell_dx_ground": (cell_dx_ground, "<f8")}
    man = {"format": "raw little-endian, row-major", "arrays": {}}
    for name, (arr, dt) in arrays.items():
        a = np.ascontiguousarray(arr, dtype=dt)
        a.tofile(os.path.join(BUILD, f"{name}.bin"))
        man["arrays"][name] = {"file": f"{name}.bin", "dtype": {"<f4": "float32", "u1": "uint8", "<f8": "float64"}[dt],
                               "shape": list(a.shape)}
    json.dump(man, open(os.path.join(BUILD, "grid_manifest.json"), "w"), indent=1)


def main():
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(LAYERS, exist_ok=True)
    with rasterio.open(DEM_PATH) as src:
        R, lat_ts = check_crs(src)
        cos_ts = math.cos(math.radians(lat_ts))
        px_x, px_y = src.transform.a, -src.transform.e          # 20, 20 map metres
        # Forward eqc: x = R*cos(lat_ts)*lon, y = R*lat (radians). Map-x metres equal ground metres
        # only at lat_ts; at latitude phi, ground = map_x * cos(phi)/cos(lat_ts).
        cx = R * cos_ts * math.radians(CENTER_LON)
        cy = R * math.radians(CENTER_LAT)
        half_x_map = HALF_SIDE_GROUND_M * cos_ts / math.cos(math.radians(CENTER_LAT))
        half_y_map = HALF_SIDE_GROUND_M
        col0 = int(round((cx - half_x_map - src.transform.c) / px_x))
        row0 = int(round((src.transform.f - (cy + half_y_map)) / px_y))
        ncol = int(round(2 * half_x_map / px_x)) // AGG * AGG
        nrow = int(round(2 * half_y_map / px_y)) // AGG * AGG
        if col0 < 0 or row0 < 0 or col0 + ncol > src.width or row0 + nrow > src.height:
            sys.exit("Work area extends beyond the DEM; refusing to pad with invented data.")
        win = Window(col0, row0, ncol, nrow)
        z = src.read(1, window=win, masked=True).astype("float64")
        tr = src.window_transform(win)
        nodata = src.nodata
        dem_info = {
            "file": os.path.basename(DEM_PATH), "bytes": os.path.getsize(DEM_PATH),
            "size_px": [src.width, src.height], "crs_wkt": src.crs.to_wkt(), "crs_proj4": src.crs.to_proj4(),
            "pixel_size_map_m": [px_x, px_y], "nodata": nodata, "dtype": src.dtypes[0],
        }
    z = z.filled(np.nan)
    z[~np.isfinite(z)] = np.nan
    nodata_frac = float(np.isnan(z).mean())

    # Latitude of every DEM row centre (inverse eqc: lat = y / R).
    y_rows = tr.f - (np.arange(nrow) + 0.5) * px_y
    lat_rows = np.degrees(y_rows / R)
    dx_ground = px_x * np.cos(np.radians(lat_rows)) / cos_ts      # per-row E-W ground spacing (m)
    dy_ground = px_y
    gx = np.gradient(z, axis=1) / dx_ground[:, None]
    gy = np.gradient(z, axis=0) / dy_ground
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))               # NaN wherever a stencil touches NODATA

    # Aggregate to routing cells: passability uses the MAX 20 m slope inside the cell (conservative),
    # reporting uses the MEAN; any unknown sub-pixel makes the whole cell unknown.
    H, W = nrow // AGG, ncol // AGG
    blk = slope.reshape(H, AGG, W, AGG).transpose(0, 2, 1, 3).reshape(H, W, AGG * AGG)
    zb = z.reshape(H, AGG, W, AGG).transpose(0, 2, 1, 3).reshape(H, W, AGG * AGG)
    unknown = np.isnan(blk).any(axis=2) | np.isnan(zb).any(axis=2)
    with np.errstate(all="ignore"):
        s_max = np.where(unknown, np.nan, np.nanmax(blk, axis=2))
        s_mean = np.where(unknown, np.nan, np.nanmean(blk, axis=2))
        elev = np.where(unknown, np.nan, np.nanmean(zb, axis=2))
    ctx_max, ctx_mean = s_max.copy(), s_mean.copy()
    cell_m = px_x * AGG
    hr = hirise_cell_stats(R, lat_ts, tr.c, tr.f, cell_m, nrow // AGG, ncol // AGG) if os.path.exists(HIRISE_PATH) else None
    source = np.zeros(s_max.shape, "uint8")              # 0 = CTX 20 m only, 1 = HiRISE 1 m (+ CTX check)
    if hr is not None:
        use = hr["use"] & ~unknown
        source[use] = 1
        # Limiting slope = the stricter of the two sources; a cell is blocked if ANY source exceeds the limit.
        s_max = np.where(use, np.fmax(hr["p"], ctx_max), ctx_max)
        s_mean = np.where(use, hr["mean"], ctx_mean)
    passable = (~unknown) & (s_max <= SLOPE_LIMIT_DEG)

    cell_x, cell_y = px_x * AGG, px_y * AGG
    gx0, gy0 = tr.c, tr.f                     # grid upper-left corner, map metres
    cell_lat = np.degrees((gy0 - (np.arange(H) + 0.5) * cell_y) / R)
    cell_dx_ground = cell_x * np.cos(np.radians(cell_lat)) / cos_ts
    extra = {}
    if hr is not None:
        extra = {"hirise_p": hr["p"].astype("float32"), "hirise_mean": hr["mean"].astype("float32"),
                 "hirise_max": hr["max"].astype("float32"), "hirise_valid_frac": hr["valid_frac"].astype("float32")}
    np.savez_compressed(os.path.join(BUILD, "terrain.npz"), elev=elev.astype("float32"),
                        slope_max=s_max.astype("float32"), slope_mean=s_mean.astype("float32"),
                        ctx_slope_max=ctx_max.astype("float32"), ctx_slope_mean=ctx_mean.astype("float32"),
                        slope_source=source, **extra,
                        passable=passable, cell_dx_ground=cell_dx_ground)

    def to_lonlat(x, y):
        return math.degrees(x / (R * cos_ts)), math.degrees(y / R)

    west, north = to_lonlat(gx0, gy0)
    east, south = to_lonlat(gx0 + W * cell_x, gy0 - H * cell_y)
    side_ew_mid = W * cell_x * math.cos(math.radians(CENTER_LAT)) / cos_ts
    side_ns = H * cell_y
    meta = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "grid": {
            "rows": H, "cols": W, "cell_map_m": [cell_x, cell_y], "aggregation_px": AGG,
            "origin_map_m": {"x_left": gx0, "y_top": gy0},
            "crs_proj4": dem_info["crs_proj4"], "sphere_radius_m": R, "lat_ts_deg": lat_ts,
            "bounds_lonlat": {"west": west, "east": east, "south": south, "north": north},
            "side_ground_m": {"east_west_at_centre_lat": side_ew_mid, "north_south": side_ns},
            "area_km2_approx": side_ew_mid * side_ns / 1e6,
            "lonlat_convention": "Mars 2000 sphere, planetocentric latitude, east-positive longitude (degrees)",
            "centre": {"lat": CENTER_LAT, "lon": CENTER_LON,
                       "source": "IAU Gazetteer of Planetary Nomenclature, feature 'Jezero'"},
        },
        "slope": {
            "computed_from": "CTX DEM 20 m pixels; central differences (numpy.gradient)",
            "horizontal_spacing": "north-south 20 m; east-west 20 m * cos(lat)/cos(lat_ts) per row (eqc map metres are true only at lat_ts)",
            "vertical_units": "metres (USGS product page: 'Vertical Coordinate System Units: Meters')",
            "cell_rule": "routing cell = 3x3 DEM pixels; passability uses max 20 m slope in cell, reporting uses mean",
            "limit_deg": SLOPE_LIMIT_DEG,
            "limit_note": "Prototype heuristic chosen by the team; not a NASA standard.",
        },
        "stats": {
            "dem_nodata_frac_in_area": nodata_frac,
            "cells_total": int(H * W), "cells_unknown": int(unknown.sum()),
            "cells_steeper_than_limit": int(((~unknown) & (s_max > SLOPE_LIMIT_DEG)).sum()),
            "cells_passable": int(passable.sum()),
            "cells_hirise": int((source == 1).sum()),
            "cells_hirise_blocked": int(((source == 1) & ~passable & ~unknown).sum()),
            "cells_hirise_blocked_by_hirise_only": int(((source == 1) & (ctx_max <= SLOPE_LIMIT_DEG) & ~passable & ~unknown).sum()),
        },
        "dem": dem_info,
        "hirise": None if hr is None else {
            **hr["info"],
            "rule": (f"Cells with >= {HIRISE_MIN_VALID:.0%} valid 1 m slopes use HiRISE: limiting slope = max(HiRISE p{HIRISE_PCT} "
                     f"of 1 m slopes, CTX max 20 m slope); reported mean slope = HiRISE mean 1 m slope. Other cells use CTX only."),
            "percentile": HIRISE_PCT, "min_valid_frac": HIRISE_MIN_VALID, "hist_bin_deg": HIST_BIN_DEG,
            "percentile_note": "p90 rather than max: a single 1 m pixel is dominated by DTM noise or one boulder. Heuristic, not a NASA standard.",
            "alignment": "No resampling: HiRISE pixel centres mapped to CTX cells by x_ctx = x_hirise*cos(lat_ts_ctx), y_ctx = y_hirise (same sphere R, lon_0 = 0).",
        },
    }
    json.dump(meta, open(os.path.join(BUILD, "terrain_meta.json"), "w"), indent=1)
    export_raw(elev, s_max, s_mean, source, cell_dx_ground)

    # Web-map layers (same pixel grid, plate-carree lon/lat bounds -> exact Leaflet imageOverlay).
    zf = np.where(np.isnan(z), np.nanmean(z), z)
    az, alt = math.radians(315), math.radians(45)
    aspect = np.arctan2(-gx, gy)
    sl = np.radians(np.nan_to_num(slope))
    hs = np.sin(alt) * np.cos(sl) + np.cos(alt) * np.sin(sl) * np.cos(az - aspect)
    hs = np.clip(hs, 0, 1)
    del zf
    hs_small = hs.reshape(nrow // 2, 2, ncol // 2, 2).mean(axis=(1, 3))
    img = (hs_small * 255).astype("uint8")
    alpha = np.where(np.isnan(z).reshape(nrow // 2, 2, ncol // 2, 2).any(axis=(1, 3)), 0, 255).astype("uint8")
    Image.fromarray(np.dstack([img, img, img, alpha]), "RGBA").save(os.path.join(LAYERS, "hillshade.png"), optimize=True)
    ov = np.zeros((H, W, 4), "uint8")
    ov[(~unknown) & ~passable] = [230, 60, 40, 150]      # steeper than limit
    ov[unknown] = [80, 80, 255, 150]                     # NODATA / unknown
    cov = np.zeros((H, W, 4), "uint8")
    cov[source == 1] = [76, 201, 240, 45]                  # HiRISE-covered cells (light cyan tint)
    Image.fromarray(cov, "RGBA").save(os.path.join(LAYERS, "hirise_coverage.png"), optimize=True)
    Image.fromarray(ov, "RGBA").save(os.path.join(LAYERS, "impassable.png"), optimize=True)
    print(json.dumps({k: meta[k] for k in ("grid", "stats")}, indent=1))


if __name__ == "__main__":
    main()
