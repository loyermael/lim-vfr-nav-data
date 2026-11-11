// Sert un dossier de paquet de données (voir build-data-pack.mjs) en local, avec les en-têtes CORS, pour essayer l'appli
// sans rien publier :  node tools/serve-pack.mjs pack [port]   puis, dans l'appli : Réglages > Avancé > http://localhost:8800
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "pack");
const port = Number(process.argv[3] ?? 8800);
createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^([/\\])+/, "");
  const file = join(root, rel);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end("not found"); return; }
  res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "application/octet-stream");
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`Paquet servi sur http://localhost:${port} (dossier ${root})`));
