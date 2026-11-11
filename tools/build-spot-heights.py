#!/usr/bin/env python3
"""
Points cotés indicatifs de la carte aéro : sommets du relief (maxima locaux) calculés sur les tuiles d'altitude Terrarium (AWS Open Data, zoom 9).
La carte OACI en porte des centaines issus de la BD de l'IGN ; ici ce sont des maxima locaux du modèle numérique de terrain (précision de quelques dizaines
de mètres) : ils sont donc INDICATIFS et affichés comme tels. Calcul unique (le relief ne change pas), résultat publié avec le paquet de données.

  python tools/build-spot-heights.py tools/data/fr_spot.json
"""
import io
import json
import math
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

Z = 9
BBOX = (-5.3, 41.2, 9.8, 51.3)  # ouest, sud, est, nord (France métropolitaine et Corse)
FT = 3.28084


def tile_x(lon):
    return int((lon + 180) / 360 * 2 ** Z)


def tile_y(lat):
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** Z)


def fetch(xy):
    x, y = xy
    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png"
    for _ in range(3):
        try:
            return xy, Image.open(io.BytesIO(urllib.request.urlopen(url, timeout=40).read())).convert("RGB")
        except Exception:
            pass
    return xy, None


def main():
    out = sys.argv[1]
    x0, x1, y0, y1 = tile_x(BBOX[0]), tile_x(BBOX[2]), tile_y(BBOX[3]), tile_y(BBOX[1])
    coords = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    mosaic = np.full(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), -9999.0, dtype=np.float32)
    with ThreadPoolExecutor(8) as ex:
        for (x, y), im in ex.map(fetch, coords):
            if im is None:
                continue
            a = np.asarray(im, dtype=np.float32)
            mosaic[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    # sommets : maximum de leur voisinage (≈ 4 km) et au moins 120 m au-dessus du point le plus bas à ≈ 9 km
    mx = ndi.maximum_filter(mosaic, size=21)
    mn = ndi.minimum_filter(np.where(mosaic < -9000, 99999, mosaic), size=45)
    peaks = np.argwhere((mosaic == mx) & (mosaic - mn >= 120) & (mosaic > 150))
    n = 2.0 ** Z * 256
    pts = []
    for r, c in peaks:
        px, py = x0 * 256 + c + 0.5, y0 * 256 + r + 0.5
        lon = px / n * 360 - 180
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / n))))
        if BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]:
            pts.append((round(lon, 4), round(lat, 4), int(round(float(mosaic[r, c]) * FT))))
    json.dump({"format": "lim-nav-spots", "version": 1, "source": "Mapzen / AWS Open Data (Terrarium), maxima locaux : indicatif", "items": pts}, open(out, "w"), separators=(",", ":"))
    print(f"{len(pts)} points cotés -> {out}")


if __name__ == "__main__":
    main()
