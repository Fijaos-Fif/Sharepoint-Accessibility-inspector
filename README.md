# Audit Accessibilité SharePoint

Outil d'audit **WCAG 2.1 AA / RGAA 4.1** pour pages SharePoint Modern. Zéro dépendance runtime : un fichier HTML autonome, un injecteur JS et un petit serveur local en Python 3 (stdlib uniquement).

## Deux modes d'audit

- **Standalone** : ouvrir `audit-accessibilite-sharepoint.html` dans un navigateur et coller le HTML d'une page → rapport complet (problèmes, lisibilité FR, titres, conformes).
- **In-page** (recommandé) : un favori « Auditer la page » injecte un panneau latéral directement sur la page SharePoint, avec pins numérotés sur les éléments en erreur. Fonctionne aussi en mode édition.

## Démarrage

1. Télécharger le ZIP de la [dernière release](https://github.com/Fijaos-Fif/Sharepoint-Accessibility-inspector/releases/latest)
2. Dézipper, puis double-cliquer `Démarrer.app` (Mac) ou `Démarrer.vbs` (Windows) — Python 3 requis
3. Suivre l'onboarding pour installer le favori et, si besoin, connecter le service d'IA de votre organisation (URL « chat completions » + clé API)

Les mises à jour sont détectées automatiquement au lancement (API GitHub Releases de ce repo).

## Contenu du repo

| Fichier | Rôle |
|---|---|
| `audit-accessibilite-sharepoint.html` | Moteur d'audit + UI standalone |
| `audit-injector-ui.js` | Panneau in-page (Shadow DOM) |
| `start.py` | Serveur local (bundle injecteur, proxy vers votre service IA, auto-update) |
| `launcher.py` | Vérification de mise à jour au démarrage (GitHub Releases) |
| `Démarrer.*` | Lanceurs Mac / Windows |
| `release.sh` | Build + publication d'une release |
| `tests/run-tests.js` | Harness de non-régression (jsdom) |

## Tests

```bash
node tests/run-tests.js
```

(les pages d'exemple étant des contenus internes, elles ne sont pas versionnées — le harness les attend dans `tests/`)
