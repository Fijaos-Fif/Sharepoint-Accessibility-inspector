# Publication des mises à jour (mainteneur)

Le système de MAJ repose entièrement sur **GitHub Releases** : la dernière release publiée sur le repo est la version de référence.

## Comment ça marche côté utilisateur

1. Au lancement (`Démarrer.app` / `.vbs`), `launcher.py` interroge `https://api.github.com/repos/<owner>/<repo>/releases/latest`
2. Si `tag_name` > `APP_VERSION` locale → dialog native « Nouvelle version disponible » avec le changelog (= notes de la release)
3. « Installer » télécharge l'asset `.zip` de la release, backup dans `.backup/`, extrait par-dessus, relance
4. La page standalone affiche aussi une bannière de MAJ (même API, check au chargement)

Les fichiers de config locaux (`ai-config.json`, `update-config.json`, `release-config.local`) ne sont pas dans le ZIP : ils survivent aux mises à jour.

## Publier une version

```bash
./release.sh 1.3.1 changelog.txt      # ou -m "▶ texte"
```

Le script : bump `APP_VERSION` → tests (`node tests/run-tests.js`, abort si rouge) → build du ZIP → commit + push → `gh release create v1.3.1 <zip> --notes <changelog>`.

Prérequis : `gh` authentifié (`gh auth login`), Node pour les tests.

## Overrides locaux

- `update-config.json` : `{"updateUrl": "…"}` pour pointer vers une autre API/un autre repo (vide = repo officiel)
- `release-config.local` : `DIST_DIR="…"` pour déposer aussi le ZIP dans un dossier de distribution interne (partage réseau, OneDrive…)

## Pourquoi GitHub Releases

- Une seule source de vérité : le tag EST la version, les notes SONT le changelog, l'asset EST le téléchargement
- API publique sans auth ni CORS (`api.github.com` envoie `Access-Control-Allow-Origin: *`)
- Pas de fichier de version à maintenir à la main, pas de ZIP versionné dans le repo
