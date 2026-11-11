#!/usr/bin/env node
/**
 * Télécharge les exports publics d'openAIP (espaces aériens « asp » et terrains « apt ») dans data/openaip/.
 *
 * - Aucun compte ni clé : exports anonymes (https://www.openaip.net/docs, « Scheduled Data Exports »), mis à jour chaque nuit.
 * - Licence CC BY-NC 4.0 : usage NON commercial, attribution « openAIP ». Les fichiers ne sont PAS redistribués avec le dépôt
 *   (le dossier data/ est ignoré par git).
 * - Le navigateur ne peut pas les télécharger lui-même (pas d'en-tête CORS) : ce script les récupère, puis l'application
 *   les importe depuis le disque (Cartes → Importer les données aéronautiques).
 *
 * Usage : npm run data:openaip            (France)
 *         npm run data:openaip -- fr ch   (plusieurs pays, codes à deux lettres)
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://storage.openaip.net/openaip-system-exports";
const OUT = "data/openaip";
// Jeux complémentaires pour la carte aéro (balises, points de report, obstacles, décollages, points chauds) : leur absence ne fait pas échouer.
const OPTIONAL = ["nav", "rpp", "obs", "hgl", "hot"];

/** Obstacles : on ne garde que ce qu'affiche la carte (7 Mo → environ 1,5 Mo). `what` = indice OpenStreetMap (éolienne, cheminée, pylône…). */
function slimObstacles(list) {
  return list.map((o) => ({
    name: o.name, type: o.type, geometry: o.geometry, elevation: o.elevation, height: o.height,
    what: o.osmTags?.["generator:source"] === "wind" ? "wind" : o.osmTags?.man_made ?? o.osmTags?.power ?? undefined,
  }));
}
const countries = process.argv.slice(2).map((c) => c.toLowerCase());
if (countries.length === 0) countries.push("fr");
if (!countries.every((c) => /^[a-z]{2}$/.test(c))) {
  console.error("Codes pays invalides : deux lettres attendues (fr, ch, it…).");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const manifest = {
  source: "openAIP (https://www.openaip.net)",
  licence: "CC BY-NC 4.0 — usage non commercial, attribution « openAIP »",
  warning: "Base communautaire, non alignée sur le cycle AIRAC et non validée par le SIA",
  downloadedAt: new Date().toISOString(),
  files: [],
};

let failed = 0;
for (const c of countries) {
  for (const kind of ["apt", "asp", ...OPTIONAL]) {
    const required = !OPTIONAL.includes(kind);
    const name = `${c}_${kind}.json`;
    let res;
    try {
      res = await fetch(`${BASE}/${name}`, { signal: AbortSignal.timeout(180_000) });
    } catch (e) {
      console.error(`${name} : réseau indisponible (${e.message})`);
      if (required) failed++;
      continue;
    }
    if (!res.ok) {
      console.error(`${name} : HTTP ${res.status}, ignoré`);
      if (required) failed++;
      continue;
    }
    let buf = Buffer.from(await res.arrayBuffer());
    // Refuse un fichier tronqué ou qui n'est pas un tableau : on n'écrase jamais un bon fichier par un mauvais.
    let parsed;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      console.error(`${name} : JSON invalide (fichier tronqué ?), ignoré`);
      if (required) failed++;
      continue;
    }
    if (!Array.isArray(parsed)) {
      console.error(`${name} : un tableau était attendu, ignoré`);
      if (required) failed++;
      continue;
    }
    if (kind === "obs") buf = Buffer.from(JSON.stringify(slimObstacles(parsed)));
    writeFileSync(`${OUT}/${name}`, buf);
    manifest.files.push({
      name,
      items: parsed.length,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      lastModified: res.headers.get("last-modified"),
    });
    console.log(`${name} : ${parsed.length} éléments, ${(buf.length / 1e6).toFixed(1)} Mo, export du ${res.headers.get("last-modified")}`);
  }
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Écrit dans ${OUT}/`);
process.exit(failed > 0 ? 1 : 0);
