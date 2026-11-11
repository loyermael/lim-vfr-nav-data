#!/usr/bin/env python3
"""
Géoréférencement AUTOMATIQUE d'une VAC du SIA, sans OCR ni saisie : les VAC sont orientées nord et portent un graticule
(repères tous les 1' de latitude et de longitude : un petit trait sur le cadre + une étiquette « 43°46' », « 002° 00' »).

Méthode (vérifiée sur AD-2.LFCQ.pdf) :
  1. le texte du PDF est codé par un chiffrement propre à chaque police (glyphes « MT48 » = code ASCII 48) : on le décode
     avec la table de caractères (charset) de la police CFF intégrée ;
  2. on repère les étiquettes de graticule et le trait de repère correspondant (ligne verticale/horizontale du cadre) ;
  3. on ajuste x ↔ longitude et y ↔ latitude (Mercator) par moindres carrés, avec la même échelle sur les deux axes (carte
     conforme) ; on contrôle les résidus, le rapport d'échelle et la position de l'ARP écrite dans l'en-tête de la carte.

Sortie JSON : transformation pixel→Mercator pour un rendu à l'échelle 2 (2 px par point PDF, comme l'appli), cadre de la
carte, ARP lu, qualité. Refuse (statut « manual ») plutôt que de livrer un calage douteux.

Usage : python tools/vac_georef.py AD-2.LFCQ.pdf [page]
"""
import io
import json
import math
import re
import sys

import fitz  # PyMuPDF
from fontTools.cffLib import CFFFontSet

R = 6378137.0
RAD = math.pi / 180.0
RENDER_SCALE = 2  # pixels de rendu par point PDF (identique à apps/app/src/pdfRender.ts)


def merx(lon):
    return R * lon * RAD


def mery(lat):
    return R * math.log(math.tan(math.pi / 4 + lat * RAD / 2))


# ------------------------------------------------------------------ texte
def font_tables(doc, page):
    """Par police : indice de glyphe → caractère, d'après les noms de glyphes « MT<code> » du CFF intégré."""
    out = {}
    for f in page.get_fonts(full=True):
        try:
            _, _, _, buf = doc.extract_font(f[0])
            cff = CFFFontSet()
            cff.decompile(io.BytesIO(buf), None)
            charset = list(cff[cff.fontNames[0]].charset)
        except Exception:
            continue
        table = []
        for g in charset:
            m = re.fullmatch(r"MT(\d+)", g)
            table.append(chr(int(m.group(1))) if m else "?")
        out[f[3]] = table
    return out


def decoded_chars(doc, page):
    """Liste de (caractère, x0, y0, x1, y1) dans l'ordre du flux, texte décodé."""
    tables = font_tables(doc, page)
    chars = []
    for span in page.get_texttrace():
        table = tables.get(span["font"])
        if table is None:
            for k, v in tables.items():
                if k.split("+")[-1] == span["font"].split("+")[-1]:
                    table = v
        for c in span["chars"]:
            gid, bbox = c[1], c[3]
            ch = table[gid] if table and gid < len(table) else "?"
            chars.append((ch, bbox[0], bbox[1], bbox[2], bbox[3]))
        chars.append((" ", None, None, None, None))  # séparateur entre deux « Tj »
    return chars


def find_labels(chars):
    """Étiquettes de graticule : (« lat » ou « lon », valeur en degrés décimaux, bbox)."""
    text = "".join(c[0] for c in chars)
    labels = []
    for kind, rx in (("lat", r"(\d{2})\s?°\s?(\d{2})[’'\x92]"), ("lon", r"(\d{3})\s?°\s*(\d{2})[’'\x92]")):
        for m in re.finditer(rx, text):
            cs = [c for c in chars[m.start():m.end()] if c[1] is not None]
            if not cs:
                continue
            x0, y0 = min(c[1] for c in cs), min(c[2] for c in cs)
            x1, y1 = max(c[3] for c in cs), max(c[4] for c in cs)
            labels.append((kind, int(m.group(1)) + int(m.group(2)) / 60.0, (x0, y0, x1, y1)))
    return labels, text


def chart_date(text):
    """Date d'édition de la carte, écrite en haut (« 28 NOV 24 »), ou None."""
    m = re.search(r"\b(\d{1,2}) (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) (\d{2})\b", text)
    return f"{m.group(1)} {m.group(2)} 20{m.group(3)}" if m else None


def header_arp(text):
    """ARP de l'en-tête : « LAT : 43 46 07 N … LONG : 002 00 28 E » → (lat, lon) ou None."""
    m = re.search(r"LAT\s*:?\s*(\d{2})\s+(\d{2})\s+(\d{2})\s*([NS]).*?LONG\s*:?\s*(\d{3})\s+(\d{2})\s+(\d{2})\s*([EW])", text, re.S)
    if not m:
        return None
    lat = int(m.group(1)) + int(m.group(2)) / 60 + int(m.group(3)) / 3600
    lon = int(m.group(5)) + int(m.group(6)) / 60 + int(m.group(7)) / 3600
    return (-lat if m.group(4) == "S" else lat, -lon if m.group(8) == "W" else lon)


# ------------------------------------------------------------------ traits de repère
def tick_lines(page):
    v, h = [], []
    for g in page.get_drawings():
        for it in g["items"]:
            if it[0] != "l":
                continue
            a, b = it[1], it[2]
            dx, dy = abs(a.x - b.x), abs(a.y - b.y)
            if dx < 0.2 and 4 < dy < 14:
                v.append((a.x, min(a.y, b.y), max(a.y, b.y)))
            elif dy < 0.2 and 4 < dx < 14:
                h.append((a.y, min(a.x, b.x), max(a.x, b.x)))
    return v, h


def nearest_tick(label_bbox, kind, v, h):
    x0, y0, x1, y1 = label_bbox
    if kind == "lon":
        cx = (x0 + x1) / 2
        cands = [t for t in v if x0 - 4 <= t[0] <= x1 + 4 and t[2] >= y0 - 12 and t[1] <= y1 + 12]
        # le trait de graduation de l'étiquette est le plus long de ceux qui la touchent (les traits intermédiaires sont plus courts)
        return min(cands, key=lambda t: (-(t[2] - t[1]) // 1, abs(t[0] - cx)))[0] if cands else None
    cy = (y0 + y1) / 2
    cands = [t for t in h if y0 - 4 <= t[0] <= y1 + 4 and t[2] >= x0 - 12 and t[1] <= x1 + 12]
    return min(cands, key=lambda t: abs(t[0] - cy))[0] if cands else None


# ------------------------------------------------------------------ ajustement
def linfit(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    a = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return a, my - a * mx


def consistent_subset(pts, tol=0.8):
    """pts = [(position, valeur)] ; renvoie le plus grand sous-ensemble sur une même droite position = k·valeur + c (k ≠ 0)."""
    best = []
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            (p1, v1), (p2, v2) = pts[i], pts[j]
            if abs(v1 - v2) < 1e-9:
                continue
            k = (p2 - p1) / (v2 - v1)
            inl = [(p, v) for p, v in pts if abs(p - (p1 + k * (v - v1))) <= tol]
            if len(inl) > len(best) or (len(inl) == len(best) and best and abs(k) > 0 and len({v for _, v in inl}) > len({v for _, v in best})):
                best = inl
    return sorted(set(best))


def georef_page(doc, page_no=0):
    page = doc[page_no]
    chars = decoded_chars(doc, page)
    labels, text = find_labels(chars)
    v, h = tick_lines(page)
    arp = header_arp(text)
    lon_sign = -1.0 if arp and arp[1] < 0 else 1.0
    lat_sign = -1.0 if arp and arp[0] < 0 else 1.0
    lon_pts, lat_pts = [], []
    for kind, val, bbox in labels:
        val = val * (lon_sign if kind == "lon" else lat_sign)
        t = nearest_tick(bbox, kind, v, h)
        if t is None:
            continue
        (lon_pts if kind == "lon" else lat_pts).append((t, val))
    # un même repère peut être étiqueté deux fois (haut et bas du cadre) : on garde les couples distincts
    lon_pts = consistent_subset(sorted(set(lon_pts)), 0.8 * 1.0)
    lat_pts = consistent_subset(sorted(set(lat_pts)), 0.8 * 1.0)
    res = {"status": "manual", "reason": None}
    if len(lon_pts) < 2 or len(lat_pts) < 2:
        res["reason"] = f"repères insuffisants (lon {len(lon_pts)}, lat {len(lat_pts)})"
        return res
    fx = linfit([merx(lo) for _, lo in lon_pts], [t for t, _ in lon_pts])
    fy = linfit([mery(la) for _, la in lat_pts], [t for t, _ in lat_pts])
    if fx is None or fy is None:
        res["reason"] = "repères alignés"
        return res
    a, b = fx
    c, d = fy
    c = -c  # y de la page vers le bas : py = −c·Y + d
    if a <= 0 or c <= 0:
        res["reason"] = f"sens des repères incohérent ({a:.6g} / {c:.6g}) : étiquettes mal associées ou carte pas orientée nord"
        return res
    # Les deux échelles peuvent différer un peu (projection du dessin) : on les garde séparées (transformation affine sans rotation),
    # mais elles doivent rester proches l'une de l'autre, sinon les repères sont mal associés.
    if abs(a - c) / max(a, c) > 0.05:
        res["reason"] = f"échelles x/y trop différentes ({a:.6g} / {c:.6g})"
        return res
    rx = max(abs(a * merx(lo) + b - t) for t, lo in lon_pts)  # écart max en points
    ry = max(abs(-c * mery(la) + d - t) for t, la in lat_pts)
    if max(rx, ry) > 1.2:
        res["reason"] = f"résidus trop grands ({rx:.2f} / {ry:.2f} pt)"
        return res
    # transformation pour le rendu à l'échelle 2 : X = ar·px + tx ; Y = −ay·py + ty (nord en haut ; ay = ar si carte isotrope)
    ar = 1.0 / (RENDER_SCALE * a)
    ay = 1.0 / (RENDER_SCALE * c)
    georef = {"ar": ar, "ai": 0.0, "ay": ay, "tx": -b / a, "ty": d / c}
    s = (a + c) / 2.0
    arp = header_arp(text)
    arp_pt = None
    if arp:
        arp_pt = ((a * merx(arp[1]) + b), (-c * mery(arp[0]) + d))
    # cadre de la carte : plus grand rectangle tracé qui contient les repères
    frame = None
    xs = [t for t, _ in lon_pts]
    ys = [t for t, _ in lat_pts]
    for g in page.get_drawings():
        r = g["rect"]
        if r.width > 250 and r.height > 200 and r.x0 <= min(xs) and r.x1 >= max(xs) and r.y0 <= min(ys) + 1 and g.get("fill") is None:
            area = r.width * r.height
            if frame is None or area < frame[4]:  # le plus petit qui contient tout = le cadre
                frame = (r.x0, r.y0, r.x1, r.y1, area)
    res.update({
        "status": "ok",
        "georef": georef,
        "renderScale": RENDER_SCALE,
        "metersPerPoint": 1.0 / s * math.cos(((-(d - sum(ys) / len(ys))) / s and 0) or 0) if False else None,
        "ticks": {"lon": len(lon_pts), "lat": len(lat_pts)},
        "residualPt": round(max(rx, ry), 3),
        "scaleRatioError": round(abs(a - c) / max(a, c), 5),
        "arpHeader": arp,
        "chartDate": chart_date(text),
        "arpPagePt": arp_pt,
        "frameBox": frame[:4] if frame else None,
        "pageSize": [page.rect.width, page.rect.height],
    })
    # mètres de terrain par point au milieu des repères latitude
    lat_mid = sum(v for _, v in lat_pts) / len(lat_pts)
    res["groundMetersPerPoint"] = round(math.cos(lat_mid * RAD) / s, 3)
    res.pop("metersPerPoint", None)
    return res


if __name__ == "__main__":
    path = sys.argv[1]
    page_no = int(sys.argv[2]) - 1 if len(sys.argv) > 2 else 0
    doc = fitz.open(path)
    print(json.dumps(georef_page(doc, page_no), ensure_ascii=False, indent=1))
