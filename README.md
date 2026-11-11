# lim-nav-data

Paquet de données (espaces aériens, terrains, météo) pour l'application L!M VFR Nav. Ce dépôt ne contient AUCUN code d'application.

- `tools/build-data-pack.mjs` construit le paquet (`manifest.json` + fichiers, avec SHA-256) ; `tools/serve-pack.mjs` le sert en local.
- `.github/workflows/publish-data.yml` le reconstruit et le publie sur GitHub Pages (toutes les heures).

Sources : openAIP (CC BY-NC 4.0, usage non commercial, attribution « openAIP », données communautaires non officielles) et
aviationweather.gov (NOAA, libres). Aide à la préparation : toujours vérifier sur les documents officiels (SIA, Météo-France).
