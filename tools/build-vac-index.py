#!/usr/bin/env python3
"""
Construit l'INDEX DES VAC : pour chaque carte d'approche à vue du SIA, le calage automatique (graticule, voir vac_georef.py)
indexé par l'empreinte SHA-256 du fichier PDF exact. L'appli compare l'empreinte du PDF qu'on lui donne (ou qu'elle télécharge)
et applique le calage si le fichier est identique : aucune manipulation, aucun point à saisir.

  python tools/build-vac-index.py --out vac --cycle 29_OCT_2026 --icao LFBI LFBL   télécharge puis calage
  python tools/build-vac-index.py --out vac --from-dir dossier_de_pdf              fichiers déjà téléchargés (AD-2.LFxx.pdf ou LFxx.pdf)

L'index ne contient que des FAITS (empreinte, coefficients de calage, date de la carte) : pas de contenu du SIA.
Source des cartes : Service de l'Information Aéronautique (SIA), licence ouverte (sans altération, avec mention de la source et de la date).
"""
import argparse, datetime, hashlib, json, os, re, sys, time, urllib.request, urllib.error
import fitz
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vac_georef import georef_page

BASE = "https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_%s/Atlas-VAC/PDF_AIPparSSection/VAC/AD/AD-2.%s.pdf"

MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

def current_cycle(today=None):
    """Cycle AIRAC en vigueur (un cycle tous les 28 jours depuis le 22/01/2026), au format du dossier eAIP du SIA : 29_OCT_2026."""
    today = today or datetime.date.today()
    base = datetime.date(2026, 1, 22)
    d = base + datetime.timedelta(days=28 * ((today - base).days // 28))
    return f"{d.day:02d}_{MONTHS[d.month - 1]}_{d.year}"

def fetch(icao, cycle):
    req = urllib.request.Request(BASE % (cycle, icao), headers={"User-Agent": "LIM-VFR-Nav-vac-index/0.1 (contact via GitHub loyermael/lim-vfr-nav-data)"})
    for attempt in range(3):
        try:
            return urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 * (attempt + 1))
        except Exception:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{icao} : téléchargement impossible")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="vac")
    ap.add_argument("--cycle", default=None, help="ex. 29_OCT_2026 (dossier eAIP du SIA)")
    ap.add_argument("--icao", nargs="*", default=[])
    ap.add_argument("--icao-from", default=None, help="export openAIP des terrains (fr_apt.json) : tous les codes LFxx")
    ap.add_argument("--print-cycle", action="store_true", help="affiche le cycle AIRAC en vigueur et s'arrête")
    ap.add_argument("--from-dir", default=None)
    ap.add_argument("--pdf-dir", default=None, help="enregistre aussi chaque PDF ici (<OACI>.pdf), à publier tels quels avec la mention du SIA")
    ap.add_argument("--files-base", default=None, help="adresse publique des PDF (écrite dans l'index : l'appli les télécharge de là)")
    ap.add_argument("--delay", type=float, default=0.5, help="pause entre deux téléchargements (politesse envers le SIA)")
    a = ap.parse_args()
    if a.print_cycle:
        print(current_cycle())
        return
    if a.cycle == "auto":
        a.cycle = current_cycle()
    if a.icao_from:
        items = json.load(open(a.icao_from, encoding="utf-8"))
        items = items if isinstance(items, list) else items.get("items", [])
        a.icao = sorted({x["icaoCode"] for x in items if str(x.get("icaoCode") or "").startswith("LF")})
    os.makedirs(a.out, exist_ok=True)
    files = []
    if a.from_dir:
        for f in sorted(os.listdir(a.from_dir)):
            m = re.search(r"(LF[A-Z0-9]{2})", f)
            if f.lower().endswith(".pdf") and m:
                files.append((m.group(1), open(os.path.join(a.from_dir, f), "rb").read()))
    else:
        for ic in a.icao:
            data = fetch(ic, a.cycle)
            if data is None:
                print(f"{ic} : pas de VAC")
                continue
            files.append((ic, data))
            time.sleep(a.delay)
    entries, manual = [], []
    if a.pdf_dir:
        os.makedirs(a.pdf_dir, exist_ok=True)
    for ic, data in files:
        sha = hashlib.sha256(data).hexdigest()
        if a.pdf_dir:
            with open(os.path.join(a.pdf_dir, f"{ic}.pdf"), "wb") as fh:
                fh.write(data)
        try:
            doc = fitz.open(stream=data, filetype="pdf")
            r = georef_page(doc, 0)
        except Exception as e:
            manual.append({"icao": ic, "sha256": sha, "bytes": len(data), "file": f"{ic}.pdf", "reason": repr(e)[:80]})
            continue
        if r["status"] != "ok":
            manual.append({"icao": ic, "sha256": sha, "bytes": len(data), "file": f"{ic}.pdf", "reason": r["reason"]})
            continue
        entries.append({
            "icao": ic, "sha256": sha, "bytes": len(data), "file": f"{ic}.pdf", "chartDate": r.get("chartDate"), "page": 1,
            "georef": {k: round(v, 6) for k, v in r["georef"].items()}, "renderScale": r["renderScale"],
            "frame": [round(x, 2) for x in r["frameBox"]] if r["frameBox"] else None,
            "groundMetersPerPoint": r["groundMetersPerPoint"], "residualPt": r["residualPt"], "arp": r["arpHeader"],
        })
    out = {
        "format": "lim-nav-vac-index", "version": 1, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "Service de l'Information Aéronautique (SIA) - VAC, licence ouverte", "cycle": a.cycle, "filesBase": a.files_base,
        "entries": entries, "manual": manual,
    }
    json.dump(out, open(os.path.join(a.out, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(entries)} VAC calées automatiquement, {len(manual)} à caler à la main -> {a.out}/index.json")

if __name__ == "__main__":
    main()
