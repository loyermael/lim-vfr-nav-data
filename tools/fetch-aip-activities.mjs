#!/usr/bin/env node
/**
 * Activités aériennes sportives et récréatives (AIP France, ENR 5.5, SIA, licence ouverte) : parachutage, voltige, vol à voile, aéromodélisme,
 * ballons, treuillage, câbles… Ce sont elles que la carte OACI dessine avec leur numéro de référence. Chaque activité a une position (point ou
 * zone : on garde le centre des sommets), des limites verticales et des horaires.
 *
 *   node tools/fetch-aip-activities.mjs [sortie.json]       télécharge l'ENR 5.5 du cycle AIRAC en vigueur
 *   node tools/fetch-aip-activities.mjs sortie.json fichier.html   lit un fichier déjà téléchargé
 *
 * Source : Service de l'Information Aéronautique (SIA), eAIP France, mention de la source et de la date obligatoire.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Cycle AIRAC en vigueur (28 jours depuis le 22/01/2026) : dossier eAIP « 29_OCT_2026 » et date « 2026-10-29 ». */
export function currentCycle(today = new Date()) {
  const base = Date.UTC(2026, 0, 22);
  const days = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - base) / 86400000);
  const d = new Date(base + 28 * Math.floor(days / 28) * 86400000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { folder: `${dd}_${MONTHS[d.getUTCMonth()]}_${d.getUTCFullYear()}`, iso: d.toISOString().slice(0, 10) };
}

const decode = (s) =>
  s.replace(/<br[^>]*>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** « 50°41'17"N » → degrés décimaux (signe selon N/S/E/W) ; null si illisible. */
export function dms(s) {
  const m = /(\d{1,3})\D+(\d{1,2})\D+(\d{1,2}(?:[.,]\d+)?)\D*([NSEW])/.exec(s);
  if (!m) return null;
  const v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3].replace(",", ".")) / 3600;
  return m[4] === "S" || m[4] === "W" ? -v : v;
}

/** Type d'activité normalisé d'après le texte de l'AIP. */
export function activityKind(label) {
  const t = label.toLowerCase();
  if (/parachut/.test(t)) return "para";
  if (/voltige|acrobat/.test(t)) return "acro";
  if (/v[ée]lisurface|planeur|vol [àa] voile|treuill|gld|glid/.test(t)) return "glider";
  if (/a[ée]romod|mod[èe]le/.test(t)) return "aeromodel";
  if (/ballon|montgolfi/.test(t)) return "balloon";
  if (/c[âa]ble/.test(t)) return "cable";
  if (/delta|parapente|vol libre|ulm/.test(t)) return "freeflight";
  return "other";
}

/** Lit le HTML de l'ENR 5.5 : une activité par groupe de lignes (identification, nom, plafond, horaires, sommets, plancher). */
export function parseActivities(html) {
  const rows = html.split(/<tr\b/i).slice(1);
  const out = [];
  let cur = null;
  const grab = (row, key) => {
    // l'identifiant se trouve sur le <span> : la ligne <tr> porte aussi un identifiant qui contient les mêmes mots
    const m = new RegExp(`<span[^>]*\\bid="[^"]*${key}[^"]*"[^>]*>([\\s\\S]*?)</span>`, "i").exec(row);
    return m ? decode(m[1]) : null;
  };
  for (const row of rows) {
    const ref = grab(row, "AIRSPACE\\.TXT_NAME");
    if (ref !== null && /^[0-9A-Z-]+$/i.test(ref)) {
      // ligne d'identification : le type est le premier texte du deuxième cadre, le nom suit
      const tds = row.split(/<td\b/i);
      const second = tds[2] ?? "";
      const spans = [...second.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((x) => decode(x[1])).filter(Boolean);
      const name = grab(row, "NOM_USUEL");
      cur = {
        ref, label: spans[0] && spans[0] !== name ? spans[0] : "", name: name ?? spans.at(-1) ?? "",
        upper: grab(row, "VAL_DIST_VER_UPPER"), hours: grab(row, "TXT_RMK_WORK_HR"), lower: null, lats: [], lons: [],
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const lat = grab(row, "GEO_LAT");
    const lon = grab(row, "GEO_LONG");
    if (lat !== null && lon !== null) {
      const a = dms(lat), o = dms(lon);
      if (a !== null && o !== null) { cur.lats.push(a); cur.lons.push(o); }
    }
    const lower = grab(row, "VAL_DIST_VER_LOWER");
    if (lower && cur.lower === null) cur.lower = lower;
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  return out
    .filter((a) => a.lats.length > 0)
    .map((a) => ({
      ref: a.ref, kind: activityKind(`${a.label} ${a.name}`), label: a.label, name: a.name, lat: Math.round(mean(a.lats) * 1e5) / 1e5, lon: Math.round(mean(a.lons) * 1e5) / 1e5,
      upper: a.upper, lower: a.lower, hours: a.hours, vertices: a.lats.length,
    }));
}

async function main() {
  const [outPath = "aip-activities.json", file] = process.argv.slice(2);
  const cyc = currentCycle();
  let html;
  if (file) html = readFileSync(file, "utf8");
  else {
    const url = `https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_${cyc.folder}/FRANCE/AIRAC-${cyc.iso}/html/eAIP/FR-ENR-5.5-fr-FR.html`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": "LIM-VFR-Nav-data/0.1 (GitHub loyermael/lim-vfr-nav-data)" } });
    if (!res.ok) throw new Error(`ENR 5.5 : HTTP ${res.status} (${url})`);
    html = await res.text();
  }
  const items = parseActivities(html);
  if (items.length === 0) throw new Error("aucune activité lue : la page de l'AIP a-t-elle changé de format ?");
  const kinds = {};
  for (const a of items) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
  mkdirSync(dirname(outPath) || ".", { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    format: "lim-nav-activities", version: 1, source: "Service de l'Information Aéronautique (SIA) - AIP France ENR 5.5, licence ouverte", cycle: cyc.iso, generatedAt: new Date().toISOString(), items,
  }));
  console.log(`${items.length} activités (${JSON.stringify(kinds)}) -> ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("fetch-aip-activities.mjs")) main().catch((e) => { console.error(e.message); process.exit(1); });
