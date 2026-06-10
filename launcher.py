#!/usr/bin/env python3
"""
Audit Accessibilité SharePoint — Launcher
=========================================
Lancé en premier par Démarrer.app (Mac) ou Démarrer.vbs (Windows).
Rôle unique : démarrer start.py (le serveur local).

Les mises à jour ne sont PLUS gérées ici (plus de dialog Tkinter au démarrage).
Elles se font entièrement depuis le navigateur : la page localhost et le panneau
injecté sur SharePoint proposent « Installer la mise à jour », qui passe par
start.py (/api/install-update) → téléchargement + extraction + redémarrage.

Ce launcher n'a aucune fenêtre console (Mac : .app le cache, Windows : pythonw.exe).
Pour debug : un fichier launcher.log est écrit dans le dossier en cas d'erreur.
"""
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
LOG_FILE = SCRIPT_DIR / "launcher.log"
START_PY = SCRIPT_DIR / "start.py"


def log(msg):
    """Append au launcher.log (utile en mode sans console)."""
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def show_error(msg):
    """Dialog d'erreur native (si Tkinter dispo), sinon log."""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("Audit Accessibilité", msg)
        root.destroy()
    except Exception:
        log(f"ERROR (no dialog): {msg}")


def launch_start_py():
    """Remplace ce process par start.py (Unix) ou le lance détaché (Windows)."""
    if not START_PY.exists():
        show_error("start.py introuvable. Réinstallez l'outil.")
        sys.exit(1)
    py = sys.executable
    if sys.platform == "win32":
        subprocess.Popen([py, str(START_PY)], cwd=str(SCRIPT_DIR))
        sys.exit(0)
    else:
        os.execv(py, [py, str(START_PY)])


def main():
    # Le flag --skip-check (envoyé par start.py au redémarrage post-install) reste accepté
    # pour compatibilité, mais n'a plus d'effet : on lance toujours directement start.py.
    try:
        launch_start_py()
    except Exception as e:
        log(f"main exception: {e}\n{traceback.format_exc()}")
        show_error(f"Erreur au démarrage : {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
