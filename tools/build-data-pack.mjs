#!/usr/bin/env node
/**
 * Construit le « paquet de données » que l'appli télécharge toute seule : un dossier de fichiers statiques
 * (manifest.json + un sous-dossier par pays et par jeu de données), publiable sur n'importe quel hébergement statique
 * (GitHub Pages, Cloudflare Pages…). Les en-têtes CORS de ces hébergeurs permettent à l'appli de les lire directement.
 *
 *   node tools/build-data-pack.mjs --out pack                 construit tout (France)
 *   node tools/build-data-pack.mjs --out pack --only weather  ne remet à jour que la météo
 *   node tools/build-data-pack.mjs --out pack --prev ancien    reprend un jeu encore récent du paquet précédent (évite de re-télécharger)
 *
 * Jeux de données : « aero » (espaces et terrains, openAIP, mis à jour chaque nuit à la source, rafraîchi si > 20 h)
 *                   « weather » (METAR, TAF, SIGMET, aviationweather.gov, rafraîchi à chaque exécution).
 * Pas encore dans le paquet : fonds de carte, cartes VAC (sources non vérifiées), voir docs/j9-donnees-auto.md.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const out = resolve(opt("out", "pack"));
const prev = opt("prev", null) ? resolve(opt("prev")) : null;
const only = opt("only", null);
const country = opt("country", "fr");
const here = resolve(import.meta.dirname);
const AERO_MAX_AGE_H = 20;

const COUNTRIES = { fr: { name: "France", weatherBbox: [41.0, -5.5, 51.5, 10.0] } };
if (!COUNTRIES[country]) { console.error(`Pays inconnu : ${country} (disponible : ${Object.keys(COUNTRIES).join(", ")})`); process.exit(1); }
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

/** Lance un script de téléchargement dans un dossier de travail propre ; retourne le dossier des fichiers produits. */
function run(script, scriptArgs, subdir) {
  const work = join(out, "_work", subdir);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const r = spawnSync(process.execPath, [join(here, script), ...scriptArgs], { cwd: work, stdio: "inherit" });
  if (r.status !== 0) return null;
  return join(work, "data", subdir === "aero" ? "openaip" : "weather");
}

function dataset(id, title, dir, source, licence, maxAgeHours, updatedAt) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const buf = readFileSync(join(dir, f));
    return { path: `${country}/${id}/${f}`, bytes: buf.length, sha256: sha(buf) };
  });
  return { id, title, updatedAt, maxAgeHours, source, licence, files };
}

mkdirSync(out, { recursive: true });
const old = readJson(join(out, "manifest.json")) ?? (prev ? readJson(join(prev, "manifest.json")) : null);
const oldCountry = old?.countries?.find((c) => c.code === country);
const oldDs = (id) => oldCountry?.datasets?.find((d) => d.id === id);
const datasets = [];
let failed = 0;

async function build(id) {
  const keepFrom = existsSync(join(out, country, id)) ? out : prev && existsSync(join(prev, country, id)) ? prev : null;
  const previous = oldDs(id);
  if (id === "aero" && previous && keepFrom && (Date.now() - Date.parse(previous.updatedAt)) / 3.6e6 < AERO_MAX_AGE_H) {
    if (keepFrom !== out) cpSync(join(keepFrom, country, id), join(out, country, id), { recursive: true });
    console.log(`aero : paquet précédent encore récent (${previous.updatedAt}), conservé`);
    datasets.push(previous);
    return;
  }
  const dir = id === "aero"
    ? run("fetch-openaip.mjs", [country], "aero")
    : run("fetch-weather.mjs", COUNTRIES[country].weatherBbox.map(String), "weather");
  if (!dir || !existsSync(dir)) {
    failed++;
    console.error(`${id} : échec du téléchargement`);
    // On ne casse jamais ce qui marche : on garde l'ancienne version du jeu, si elle existe.
    if (previous && keepFrom) {
      if (keepFrom !== out) cpSync(join(keepFrom, country, id), join(out, country, id), { recursive: true });
      datasets.push(previous);
    }
    return;
  }
  const dest = join(out, country, id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(dir, dest, { recursive: true });
  const man = readJson(join(dest, "manifest.json"));
  datasets.push(id === "aero"
    ? dataset("aero", "Espaces aériens et terrains", dest, man?.source ?? "openAIP", man?.licence ?? "CC BY-NC 4.0", 24, man?.downloadedAt ?? new Date().toISOString())
    : dataset("weather", "Météo (METAR, TAF, SIGMET)", dest, man?.source ?? "aviationweather.gov", man?.licence ?? "Données du gouvernement américain, libres", 1, man?.downloadedAt ?? new Date().toISOString()));
}

for (const id of ["aero", "weather"]) if (!only || only === id) await build(id);
// Jeu non demandé : on le reprend tel quel du paquet existant.
for (const id of ["aero", "weather"]) {
  if (datasets.some((d) => d.id === id)) continue;
  const p = oldDs(id);
  const keepFrom = existsSync(join(out, country, id)) ? out : prev && existsSync(join(prev, country, id)) ? prev : null;
  if (p && keepFrom) {
    if (keepFrom !== out) cpSync(join(keepFrom, country, id), join(out, country, id), { recursive: true });
    datasets.push(p);
  }
}
rmSync(join(out, "_work"), { recursive: true, force: true });

const manifest = {
  format: "lim-nav-data",
  version: 1,
  generatedAt: new Date().toISOString(),
  countries: [{ code: country, name: COUNTRIES[country].name, datasets: datasets.sort((a, b) => a.id.localeCompare(b.id)) }],
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
const total = datasets.flatMap((d) => d.files).reduce((s, f) => s + f.bytes, 0);
console.log(`\nPaquet prêt dans ${out} : ${datasets.length} jeu(x) de données, ${(total / 1048576).toFixed(1)} Mo`);
if (statSync(join(out, "manifest.json")).size === 0 || datasets.length === 0) process.exit(1);
process.exit(failed > 0 && datasets.length === 0 ? 1 : 0);
