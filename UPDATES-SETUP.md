# Publication des mises à jour (mainteneur)

Le système de MAJ repose entièrement sur **GitHub Releases** : la dernière release publiée sur le repo est la version de référence.

## Comment ça marche côté utilisateur

Les mises à jour se font **entièrement depuis le navigateur** (plus de dialog Tkinter au démarrage) :

1. La page localhost **et** le panneau injecté sur SharePoint interrogent `https://api.github.com/repos/<owner>/<repo>/releases/latest` (via le proxy `start.py` pour passer les proxys d'entreprise)
2. Si `tag_name` > version locale → bannière (page) ou bouton « 🚀 Installer la mise à jour » (panneau)
3. Un clic → `POST /api/install-update` : `start.py` télécharge l'asset `.zip`, backup dans `.backup/`, extrait par-dessus, et **redémarre** (le nouveau serveur attend que l'ancien ait libéré le port → reprise propre)

`launcher.py` ne sert plus qu'à lancer `start.py`. Les fichiers de config locaux (`ai-config.json`, `update-config.json`, `release-config.local`) ne sont pas dans le ZIP : ils survivent aux mises à jour.

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
