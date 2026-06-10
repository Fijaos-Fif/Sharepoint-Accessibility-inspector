#!/bin/bash
# Démarre l'outil d'audit sur Mac.
# Si Python est installé, lance start.py + ouvre le navigateur.
# Sinon, affiche les instructions d'installation.

# Se place dans le dossier du script
cd "$(dirname "$0")"

clear
echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║     ♿  Audit Accessibilité SharePoint       ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# Vérifie que python3 est installé
if ! command -v python3 &> /dev/null; then
    echo "  ❌ Python n'est pas installé sur votre Mac."
    echo ""
    echo "  📦 Pour l'installer :"
    echo "     1. Ouvrez le centre logiciel de votre organisation (ou python.org)"
    echo "     2. Cherchez « Python »"
    echo "     3. Cliquez « Installer »"
    echo "     4. Une fois fini, double-cliquez à nouveau sur ce fichier"
    echo ""
    echo "  Cette fenêtre va se fermer dans 30 secondes…"
    sleep 30
    exit 1
fi

# Vérifie que start.py est présent
if [ ! -f "start.py" ]; then
    echo "  ❌ Le fichier start.py est introuvable dans ce dossier."
    echo "     Assurez-vous que ce fichier .command est dans le même dossier que start.py."
    echo ""
    read -p "  Appuyez sur Entrée pour fermer…"
    exit 1
fi

echo "  ✅ Python détecté. Démarrage…"
echo ""
echo "  💡 Laissez cette fenêtre ouverte tant que vous utilisez l'outil."
echo "     Pour fermer l'outil : appuyez sur Ctrl+C ici."
echo ""

# Lance le launcher (check MAJ + start.py)
# NOTE : sur Mac, utilisez plutôt Démarrer.app pour un démarrage sans terminal.
# Ce .command reste comme backup si .app ne marche pas sur votre poste.
python3 launcher.py

# Si on arrive ici, le serveur s'est arrêté normalement
echo ""
echo "  Cette fenêtre va se fermer dans 5 secondes…"
sleep 5
