#!/bin/bash
# release.sh — build + publication d'une version (GitHub Releases)
#
# Usage :
#   ./release.sh 1.3.1 changelog.txt        # changelog depuis un fichier
#   ./release.sh 1.3.1 -m "▶ Fix retag…"    # changelog inline
#   ./release.sh 1.3.1 -m "…" --dry-run     # s'arrête après le build (ni git, ni GitHub)
#
# Enchaîne : bump APP_VERSION → tests non-régression → ZIP → commit + push
#            → gh release create (tag vX.Y.Z, notes = changelog, asset = ZIP).
# La release publiée EST le déclencheur de MAJ : launcher.py et l'app interrogent
# l'API releases/latest au démarrage.
#
# Dépôt local optionnel (distribution initiale interne) : créer release-config.local
# (gitignoré) avec :  DIST_DIR="/chemin/vers/dossier/de/distribution"
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: ./release.sh X.Y.Z (changelog.txt | -m \"texte\")"; exit 1; }

# ── Changelog ──
if [[ "${2:-}" == "-m" ]]; then
  CHANGELOG="${3:?texte du changelog manquant après -m}"
elif [[ -f "${2:-}" ]]; then
  CHANGELOG="$(cat "$2")"
else
  echo "Changelog requis : fichier ou -m \"texte\""; exit 1
fi

HTML="audit-accessibilite-sharepoint.html"
ZIP_NAME="audit-accessibilite-sharepoint-v${VERSION}.zip"
PACK="/tmp/Audit-accessibilite-SharePoint"

# ── 1. Bump APP_VERSION ──
CURRENT=$(grep -o 'APP_VERSION="[^"]*"' "$HTML" | head -1 | cut -d'"' -f2)
if [[ "$CURRENT" != "$VERSION" ]]; then
  sed -i '' "s/APP_VERSION=\"$CURRENT\"/APP_VERSION=\"$VERSION\"/" "$HTML"
  echo "→ APP_VERSION : $CURRENT → $VERSION"
else
  echo "→ APP_VERSION déjà à $VERSION"
fi
grep -q "APP_VERSION=\"$VERSION\"" "$HTML" || { echo "✗ bump APP_VERSION échoué"; exit 1; }

# ── 2. Tests de non-régression ──
echo "→ Tests…"
node tests/run-tests.js || { echo "✗ Tests en échec — release annulée"; exit 1; }

# ── 3. Build ZIP ──
echo "→ Build ZIP…"
rm -rf "$PACK" && mkdir -p "$PACK"
cp "$HTML" audit-injector-ui.js start.py launcher.py "Démarrer (Mac).command" "Démarrer (Windows).bat" Démarrer.vbs UPDATES-SETUP.md "$PACK/"
cp -R Démarrer.app "$PACK/"
chmod +x "$PACK/Démarrer (Mac).command" "$PACK/Démarrer.app/Contents/MacOS/Demarrer"
(cd /tmp && rm -f "$ZIP_NAME" && zip -r -q "$ZIP_NAME" "$(basename "$PACK")" -x "*.DS_Store")
echo "  $(du -h "/tmp/$ZIP_NAME" | cut -f1) — /tmp/$ZIP_NAME"

if [[ "${*: -1}" == "--dry-run" ]]; then
  echo ""
  echo "✓ DRY-RUN terminé (ZIP dans /tmp — git checkout $HTML pour annuler le bump)"
  exit 0
fi

# ── 4. Git : commit + push ──
git add -A
git commit -q -m "Release v${VERSION}" || echo "  (rien à committer)"
git push origin main
echo "→ Poussé sur main"

# ── 5. GitHub Release (crée le tag v${VERSION} sur HEAD) ──
gh release create "v${VERSION}" "/tmp/$ZIP_NAME" --title "v${VERSION}" --notes "$CHANGELOG"
echo "→ Release v${VERSION} publiée — les agents verront la MAJ au prochain lancement"

# ── 6. Dépôt local optionnel (distribution initiale interne) ──
if [[ -f release-config.local ]]; then
  # shellcheck disable=SC1091
  source release-config.local
  if [[ -n "${DIST_DIR:-}" && -d "$DIST_DIR" ]]; then
    cp "/tmp/$ZIP_NAME" "$DIST_DIR/"
    echo "→ ZIP déposé dans $DIST_DIR"
  fi
fi

echo ""
echo "✓ Release v${VERSION} terminée"
