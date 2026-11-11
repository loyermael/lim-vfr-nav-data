#!/usr/bin/env python3
"""
Obstacles à la navigation aérienne de l'AIP France (ENR 5.4.1, SIA / DGAC, licence ouverte) : le fichier officiel dont la carte OACI tire ses obstacles
(hauteur au-dessus du sol, altitude du sommet, balisage de nuit, éoliennes). Plus complet et plus juste que les obstacles d'OpenStreetMap.

  python tools/fetch-aip-obstacles.py sortie.json [fichier.xlsx]

Sans fichier, télécharge celui du cycle AIRAC en vigueur (nécessite openpyxl : pip install openpyxl).
Sortie : {"format": "lim-nav-obstacles", "items": [[lat, lon, hauteur_ft, sommet_ft, éolienne(0/1), balisé_de_nuit(0/1)], ...]}
"""
import datetime
import json
import sys
import urllib.request

import openpyxl

MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def cycle(today=None):
    today = today or datetime.date.today()
    base = datetime.date(2026, 1, 22)
    d = base + datetime.timedelta(days=28 * ((today - base).days // 28))
    return f"{d.day:02d}_{MONTHS[d.month - 1]}_{d.year}", d.strftime("%Y%m%d"), d.isoformat()


def main():
    out = sys.argv[1]
    path = sys.argv[2] if len(sys.argv) > 2 else None
    folder, stamp, iso = cycle()
    if not path:
        url = f"https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_{folder}/FRANCE/ObstaclesDataZone1MFRANCE_{stamp}.xlsx"
        path = out + ".xlsx"
        req = urllib.request.Request(url, headers={"User-Agent": "LIM-VFR-Nav-data/0.1 (GitHub loyermael/lim-vfr-nav-data)"})
        with open(path, "wb") as f:
            f.write(urllib.request.urlopen(req, timeout=120).read())
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["Data"] if "Data" in wb.sheetnames else wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    head = [str(h or "").strip().upper() for h in next(rows)]
    col = {h: i for i, h in enumerate(head)}
    need = ["TYPE", "LATITUDE DECIMALE", "LONGITUDE DECIMALE", "ALTITUDE AU SOMMET", "HAUTEUR HORS SOL", "UNITE", "BALISAGE"]
    if any(n not in col for n in need):
        raise SystemExit(f"colonnes attendues absentes : {[n for n in need if n not in col]}")
    items = []
    for r in rows:
        try:
            lat, lon = float(r[col["LATITUDE DECIMALE"]]), float(r[col["LONGITUDE DECIMALE"]])
            h, top = float(r[col["HAUTEUR HORS SOL"]]), float(r[col["ALTITUDE AU SOMMET"]])
        except (TypeError, ValueError):
            continue
        unit = str(r[col["UNITE"]] or "FT").upper()
        if unit.startswith("M"):  # mètres → pieds
            h, top = h * 3.28084, top * 3.28084
        typ = str(r[col["TYPE"]] or "").lower()
        bal = str(r[col["BALISAGE"]] or "").lower()
        wind = 1 if "olien" in typ else 0
        lit = 1 if "nuit" in bal else 0
        items.append([round(lat, 5), round(lon, 5), int(round(h)), int(round(top)), wind, lit])
    if not items:
        raise SystemExit("aucun obstacle lu")
    json.dump({"format": "lim-nav-obstacles", "version": 1, "source": "Service de l'Information Aéronautique (SIA) / DGAC, AIP France ENR 5.4.1, licence ouverte", "cycle": iso, "items": items}, open(out, "w"), separators=(",", ":"))
    print(f"{len(items)} obstacles (dont {sum(i[4] for i in items)} éoliennes) -> {out}")


if __name__ == "__main__":
    main()
