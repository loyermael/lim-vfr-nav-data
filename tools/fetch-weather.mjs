#!/usr/bin/env node
/**
 * Télécharge METAR, TAF et SIGMET internationaux (aviationweather.gov, NOAA) dans data/weather/.
 *
 * - Le navigateur ne peut pas appeler cette API (pas d'en-tête CORS) : ce script le fait, puis l'application importe les fichiers.
 * - Données du gouvernement américain, libres de droits.
 * - Zone par défaut : France métropolitaine et abords (boîte 41,0 N / -5,5 E / 51,5 N / 10,0 E). Autre zone :
 *     npm run data:weather -- 40 -6 52 10      (sud, ouest, nord, est)
 *
 * Usage : npm run data:weather
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://aviationweather.gov/api/data";
const OUT = "data/weather";
const nums = process.argv.slice(2).map(Number);
const bbox = nums.length === 4 && nums.every(Number.isFinite) ? nums : [41.0, -5.5, 51.5, 10.0];
if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
  console.error("Boîte invalide : sud ouest nord est (sud < nord, ouest < est).");
  process.exit(1);
}
const box = bbox.join(",");

const requests = [
  { name: "metar.json", url: `${BASE}/metar?bbox=${box}&format=json&hours=3` },
  { name: "taf.json", url: `${BASE}/taf?bbox=${box}&format=json` },
  { name: "isigmet.json", url: `${BASE}/isigmet?format=json` },
];

mkdirSync(OUT, { recursive: true });
const manifest = {
  source: "aviationweather.gov (NOAA Aviation Weather Center)",
  licence: "Données du gouvernement américain, libres",
  warning: "Aide à la préparation : le briefing officiel reste celui de Météo-France / SOFIA",
  downloadedAt: new Date().toISOString(),
  bbox,
  files: [],
};

let failed = 0;
for (const r of requests) {
  // Délai maximum de 45 s par tentative et jusqu'à 3 tentatives : le service est parfois lent ou coupe la connexion.
  let res;
  let lastError = "";
  for (let attempt = 1; attempt <= 3 && !res; attempt++) {
    try {
      res = await fetch(r.url, { signal: AbortSignal.timeout(45_000) });
    } catch (e) {
      lastError = e.cause?.code ?? e.message;
      if (attempt < 3) await new Promise((ok) => setTimeout(ok, 2000 * attempt));
    }
  }
  if (!res) {
    console.error(`${r.name} : réseau indisponible après 3 tentatives (${lastError})`);
    failed++;
    continue;
  }
  if (!res.ok) {
    console.error(`${r.name} : HTTP ${res.status}, ignoré`);
    failed++;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    console.error(`${r.name} : JSON invalide, ignoré`);
    failed++;
    continue;
  }
  if (!Array.isArray(parsed)) {
    console.error(`${r.name} : un tableau était attendu, ignoré`);
    failed++;
    continue;
  }
  writeFileSync(`${OUT}/${r.name}`, buf);
  manifest.files.push({ name: r.name, items: parsed.length, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  console.log(`${r.name} : ${parsed.length} éléments, ${(buf.length / 1e6).toFixed(2)} Mo`);
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Écrit dans ${OUT}/ à ${manifest.downloadedAt}`);
process.exit(failed > 0 ? 1 : 0);
