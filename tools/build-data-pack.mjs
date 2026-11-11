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
 * Jeux de données (chacun se met à jour INDÉPENDAMMENT dans l'appli) :
 *   airspaces  espaces aériens (openAIP)             }  package du pays, rafraîchis si > 20 h
 *   airfields  terrains, pistes, fréquences (openAIP) }
 *   navdata    balises, points de report, obstacles (OSM via openAIP), décollages, points chauds : pour la carte aéro
 *   weather    METAR, TAF, SIGMET (aviationweather.gov) : donnée « vivante », sans package, rafraîchie à chaque exécution
 * Pas encore dans le paquet : fonds de carte, cartes VAC, NOTAM (sources non vérifiées), voir docs/j9-donnees-auto.md.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

const old = readJson(join(out, "manifest.json")) ?? (prev ? readJson(join(prev, "manifest.json")) : null);
const oldDs = (id) => old?.countries?.find((c) => c.code === country)?.datasets?.find((d) => d.id === id) ?? null;
const hoursSince = (iso) => (Date.now() - Date.parse(iso)) / 3.6e6;
const datasets = [];
let failed = 0;

/** Lance un script de téléchargement dans un dossier de travail propre ; retourne le dossier des fichiers produits. */
function run(script, scriptArgs, kind) {
  const work = join(out, "_work", kind);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const r = spawnSync(process.execPath, [join(here, script), ...scriptArgs], { cwd: work, stdio: "inherit" });
  return r.status === 0 ? join(work, "data", kind === "aero" ? "openaip" : "weather") : null;
}

/** Écrit un jeu de données : copie des fichiers choisis, empreintes, entrée de manifeste. */
function publish(id, title, srcDir, names, meta) {
  const dest = join(out, country, id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const n of names) cpSync(join(srcDir, n), join(dest, n));
  const files = names.map((n) => { const buf = readFileSync(join(dest, n)); return { path: `${country}/${id}/${n}`, bytes: buf.length, sha256: sha(buf) }; });
  datasets.push({ id, title, updatedAt: meta.updatedAt, maxAgeHours: meta.maxAgeHours, live: meta.live, source: meta.source, licence: meta.licence, files });
}

/** Garde un jeu du paquet précédent (copie ses fichiers dans la sortie) ; faux si impossible. */
function keep(id) {
  const p = oldDs(id);
  if (!p) return false;
  const from = existsSync(join(out, country, id)) ? out : prev && existsSync(join(prev, country, id)) ? prev : null;
  if (!from) return false;
  if (from !== out) cpSync(join(from, country, id), join(out, country, id), { recursive: true });
  datasets.push(p);
  return true;
}

mkdirSync(out, { recursive: true });

if (!only || only === "aero") {
  const fresh = ["airspaces", "airfields", "navdata"].every((id) => oldDs(id) && hoursSince(oldDs(id).updatedAt) < AERO_MAX_AGE_H);
  if (fresh && ["airspaces", "airfields", "navdata"].every(keep)) console.log("espaces, terrains et données de navigation : paquet précédent encore récent, conservé");
  else {
    const dir = run("fetch-openaip.mjs", [country], "aero");
    if (dir && existsSync(join(dir, "manifest.json"))) {
      const man = readJson(join(dir, "manifest.json"));
      const meta = { updatedAt: man?.downloadedAt ?? new Date().toISOString(), maxAgeHours: 24, live: false, source: man?.source ?? "openAIP", licence: man?.licence ?? "CC BY-NC 4.0" };
      publish("airspaces", "Espaces aériens", dir, [`${country}_asp.json`, "manifest.json"], meta);
      publish("airfields", "Terrains", dir, [`${country}_apt.json`, "manifest.json"], meta);
      const nav = ["nav", "rpp", "obs", "hgl", "hot"].map((k) => `${country}_${k}.json`).filter((n) => existsSync(join(dir, n)));
      if (nav.length > 0) publish("navdata", "Balises, points de report, obstacles", dir, [...nav, "manifest.json"], meta);
      else keep("navdata");
    } else {
      failed++;
      console.error("espaces et terrains : échec du téléchargement ; on garde l'ancienne version si elle existe");
      ["airspaces", "airfields", "navdata"].forEach(keep);
    }
  }
} else ["airspaces", "airfields", "navdata"].forEach(keep);

if (!only || only === "weather") {
  const dir = run("fetch-weather.mjs", COUNTRIES[country].weatherBbox.map(String), "weather");
  if (dir && existsSync(join(dir, "manifest.json"))) {
    const man = readJson(join(dir, "manifest.json"));
    publish("weather", "Météo (METAR, TAF, SIGMET)", dir, readdirSync(dir).filter((f) => f.endsWith(".json")), {
      updatedAt: man?.downloadedAt ?? new Date().toISOString(), maxAgeHours: 1, live: true,
      source: man?.source ?? "aviationweather.gov", licence: man?.licence ?? "Données du gouvernement américain, libres",
    });
  } else {
    failed++;
    console.error("météo : échec du téléchargement ; on garde l'ancienne version si elle existe");
    keep("weather");
  }
} else keep("weather");

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
process.exit(datasets.length === 0 || (failed > 0 && datasets.length === 0) ? 1 : 0);
