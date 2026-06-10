#!/usr/bin/env python3
"""
Audit Accessibilité SharePoint — Launcher avec check de mise à jour
====================================================================
Lancé en premier par Démarrer.app (Mac) ou Démarrer.vbs (Windows).
Workflow :
  1. Lit la config (URL du audit-version.json)
  2. Compare avec APP_VERSION local
  3. Si MAJ dispo → dialog Tkinter native (Installer / Plus tard)
  4. Si « Installer » → download le ZIP, extrait par-dessus les fichiers
  5. Lance start.py (remplace le process via os.execv sur Unix, subprocess sur Windows)

Ce launcher n'a aucune fenêtre console (Mac : .app le cache, Windows : pythonw.exe).
Pour debug : un fichier launcher.log est écrit dans le dossier en cas d'erreur.
"""
import http.client
import io
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import zipfile
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).parent.resolve()
HTML_FILE = SCRIPT_DIR / "audit-accessibilite-sharepoint.html"
CONFIG_FILE = SCRIPT_DIR / "update-config.json"
LOG_FILE = SCRIPT_DIR / "launcher.log"
START_PY = SCRIPT_DIR / "start.py"

CHECK_TIMEOUT_S = 5
INSTALL_TIMEOUT_S = 120

# API GitHub Releases du repo public — la derniere release publiee EST la version de reference.
# update-config.json peut surcharger via {"updateUrl": "..."} (API compatible ou audit-version.json legacy).
DEFAULT_UPDATE_URL = "https://api.github.com/repos/Fijaos-Fif/Sharepoint-Accessibility-inspector/releases/latest"


# ─── Helpers ──────────────────────────────────────────────────────────────
def log(msg):
    """Append au launcher.log (utile en mode sans console)."""
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def read_local_version():
    """Parse APP_VERSION dans le HTML local."""
    try:
        html = HTML_FILE.read_text(encoding="utf-8")
        m = re.search(r'const\s+APP_VERSION\s*=\s*"([^"]+)"', html)
        if m:
            return m.group(1)
    except Exception as e:
        log(f"read_local_version error: {e}")
    return "unknown"


def read_config():
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"read_config error: {e}")
        return {}


def http_get(url, timeout):
    """GET HTTP(S) avec follow redirects. Retourne bytes."""
    current = url
    for _ in range(6):
        u = urlparse(current)
        port = u.port or (443 if u.scheme == "https" else 80)
        path = u.path + (("?" + u.query) if u.query else "")
        if u.scheme == "https":
            conn = http.client.HTTPSConnection(u.hostname, port, timeout=timeout)
        else:
            conn = http.client.HTTPConnection(u.hostname, port, timeout=timeout)
        try:
            conn.putrequest("GET", path, skip_accept_encoding=True)
            conn.putheader("User-Agent", "audit-launcher/1.0")
            conn.putheader("Accept", "*/*")
            conn.endheaders()
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308):
                loc = resp.getheader("Location")
                resp.read()
                if not loc:
                    raise RuntimeError(f"Redirect {resp.status} sans Location")
                if loc.startswith("/"):
                    loc = f"{u.scheme}://{u.hostname}{loc}"
                current = loc
                continue
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            return resp.read()
        finally:
            try:
                conn.close()
            except Exception:
                pass
    raise RuntimeError("Trop de redirects")


def compare_semver(a, b):
    """Returns > 0 si a > b. Tolère 1, 2, 3, 4 segments."""
    def parts(v):
        return [int(x) if x.isdigit() else 0 for x in str(v or "0").split(".")]
    pa, pb = parts(a), parts(b)
    for i in range(max(len(pa), len(pb))):
        ai = pa[i] if i < len(pa) else 0
        bi = pb[i] if i < len(pb) else 0
        if ai != bi:
            return ai - bi
    return 0


# ─── Check de mise à jour ─────────────────────────────────────────────────
def check_for_update(config):
    """Retourne dict {remote, local, changelog, downloadUrl} ou None."""
    url = (config.get("updateUrl") or "").strip() or DEFAULT_UPDATE_URL
    try:
        raw = http_get(url, CHECK_TIMEOUT_S)
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        log(f"check failed: {e}")
        return None
    # Normalise le format GitHub Releases (tag_name/body/assets) → {version, changelog, downloadUrl}
    if data.get("tag_name"):
        assets = data.get("assets") or []
        zips = [a for a in assets if str(a.get("name", "")).lower().endswith(".zip")]
        data = {
            "version": str(data["tag_name"]).lstrip("v"),
            "changelog": data.get("body") or "",
            "downloadUrl": zips[0].get("browser_download_url", "") if zips else "",
        }
    remote = data.get("version", "")
    if not remote:
        return None
    local = read_local_version()
    if compare_semver(remote, local) > 0:
        return {
            "remote": remote,
            "local": local,
            "changelog": data.get("changelog", ""),
            "downloadUrl": data.get("downloadUrl", ""),
        }
    return None


# ─── Dialog Tkinter native ────────────────────────────────────────────────
def show_update_dialog(info):
    """Affiche une dialog native cross-platform. Retourne True si l'agent veut installer."""
    try:
        import tkinter as tk
        from tkinter import font as tkfont
    except ImportError:
        log("Tkinter indisponible, skip dialog")
        return False

    result = {"install": False}
    root = tk.Tk()
    root.title("Audit Accessibilité — Mise à jour")
    try:
        root.tk.call("tk", "scaling", 1.2)
    except Exception:
        pass

    # Tente une largeur raisonnable cross-platform
    w, h = 560, 480
    root.geometry(f"{w}x{h}")
    root.resizable(False, False)

    # Header bleu
    header = tk.Frame(root, bg="#3B7CEB", padx=22, pady=18)
    header.pack(fill="x")
    tk.Label(header, text="🚀  Nouvelle version disponible",
             font=("Helvetica", 16, "bold"), bg="#3B7CEB", fg="white").pack(anchor="w")
    tk.Label(header,
             text=f"Vous utilisez la v{info['local']}  ›  v{info['remote']} est disponible",
             font=("Helvetica", 12), bg="#3B7CEB", fg="white").pack(anchor="w", pady=(4, 0))

    # Changelog
    body = tk.Frame(root, padx=22, pady=14)
    body.pack(fill="both", expand=True)
    tk.Label(body, text="Changements :", font=("Helvetica", 11, "bold")).pack(anchor="w")

    text_frame = tk.Frame(body)
    text_frame.pack(fill="both", expand=True, pady=(8, 0))
    scrollbar = tk.Scrollbar(text_frame)
    scrollbar.pack(side="right", fill="y")
    text = tk.Text(text_frame, wrap="word", height=14, yscrollcommand=scrollbar.set,
                   font=("Helvetica", 11), padx=10, pady=8, borderwidth=1, relief="solid",
                   background="#F7F5F1")
    text.pack(side="left", fill="both", expand=True)
    text.insert("1.0", info.get("changelog", "(Pas de changelog)"))
    text.config(state="disabled")
    scrollbar.config(command=text.yview)

    # Boutons
    btn_frame = tk.Frame(root, padx=22, pady=14)
    btn_frame.pack(fill="x")

    def on_install():
        result["install"] = True
        root.destroy()

    def on_later():
        result["install"] = False
        root.destroy()

    later = tk.Button(btn_frame, text="Plus tard", command=on_later,
                     font=("Helvetica", 11), padx=18, pady=8, relief="flat",
                     cursor="hand2", background="#EFEDE7")
    later.pack(side="right", padx=(8, 0))
    install = tk.Button(btn_frame, text="⚡ Installer maintenant", command=on_install,
                       font=("Helvetica", 11, "bold"), padx=18, pady=8, relief="flat",
                       cursor="hand2", background="#3B7CEB", fg="white",
                       activebackground="#2E63C0", activeforeground="white")
    install.pack(side="right")

    # Centre la fenêtre
    root.update_idletasks()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"+{(sw-w)//2}+{(sh-h)//3}")

    root.protocol("WM_DELETE_WINDOW", on_later)
    root.lift()
    root.attributes("-topmost", True)
    root.after(100, lambda: root.attributes("-topmost", False))
    root.mainloop()
    return result["install"]


def show_error(msg):
    """Dialog d'erreur native."""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("Audit Accessibilité", msg)
        root.destroy()
    except Exception:
        log(f"ERROR (no dialog): {msg}")


def show_info(msg):
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo("Audit Accessibilité", msg)
        root.destroy()
    except Exception:
        log(f"INFO (no dialog): {msg}")


# ─── Installation de la maj ───────────────────────────────────────────────
def _do_install(info, status):
    """Travail bloquant (download/backup/extract/rollback). AUCUN appel Tk ici —
    tourne dans un thread de fond. `status(msg)` poste un libellé vers l'UI.
    Lève en cas d'échec (après rollback)."""
    status(f"Téléchargement de la v{info['remote']}…")
    log(f"downloading {info['downloadUrl']}")
    zip_bytes = http_get(info["downloadUrl"], INSTALL_TIMEOUT_S)
    log(f"downloaded {len(zip_bytes)} bytes")

    status("Vérification du ZIP…")
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    names = [n for n in zf.namelist() if not n.endswith("/")]
    if not any(n.endswith("audit-accessibilite-sharepoint.html") for n in names):
        raise RuntimeError("Le ZIP ne contient pas l'outil attendu")
    if not any(n.endswith("start.py") for n in names):
        raise RuntimeError("Le ZIP ne contient pas start.py")

    import posixpath
    try:
        common = posixpath.commonpath(names)
    except Exception:
        common = ""
    prefix = (common + "/") if common and not common.endswith("/") else common

    backup = SCRIPT_DIR / ".backup"
    try:
        status("Sauvegarde de la version actuelle…")
        if backup.exists():
            shutil.rmtree(backup)
        backup.mkdir()
        for f in SCRIPT_DIR.iterdir():
            if f.name in (".backup", ".update-cache", "tests", "update-config.json",
                          "ai-config.json", "release-config.local", "launcher.log"):
                continue
            if f.is_file():
                shutil.copy2(f, backup / f.name)
            elif f.is_dir() and f.name == "Démarrer.app":
                shutil.copytree(f, backup / f.name)

        status("Installation des nouveaux fichiers…")
        for member in zf.infolist():
            fn = member.filename
            if not fn or fn.endswith("/"):
                continue
            # ZIP sans flag UTF-8 (ex. créé par l'ancien `zip` CLI) : Python a décodé les
            # noms accentués en cp437 → on les remet en UTF-8 (sinon « Démarrer » → « D├⌐marrer »).
            if not (member.flag_bits & 0x800):
                try:
                    fn = fn.encode("cp437").decode("utf-8")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            rel = fn[len(prefix):] if prefix and fn.startswith(prefix) else fn
            if not rel:
                continue
            target = (SCRIPT_DIR / rel).resolve()
            # Anti path-traversal
            if not str(target).startswith(str(SCRIPT_DIR) + os.sep) and target != SCRIPT_DIR:
                log(f"skip suspicious path: {rel}")
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, open(target, "wb") as dst:
                dst.write(src.read())
            # Préserve exec sur les wrappers
            if str(target).endswith(".command") or str(target).endswith(".sh") or \
               "/MacOS/" in str(target) or target.name == "Démarrer":
                try:
                    os.chmod(target, 0o755)
                except Exception:
                    pass
        zf.close()
        log(f"install OK: v{info['remote']}")
    except Exception:
        # Rollback depuis le backup (pure FS, pas de Tk)
        if backup.exists():
            log("rolling back from backup")
            for f in backup.iterdir():
                target = SCRIPT_DIR / f.name
                if f.is_file():
                    shutil.copy2(f, target)
                elif f.is_dir():
                    if target.exists():
                        shutil.rmtree(target)
                    shutil.copytree(f, target)
        raise


def install_update(info):
    """Télécharge + installe la MAJ. La fenêtre de progression tourne sur le thread
    principal (mainloop), le travail bloquant dans un thread de fond — sinon, sur macOS,
    la fenêtre s'affiche vide (le contenu n'est jamais peint pendant le blocage)."""
    q = queue.Queue()
    state = {"error": None, "done": False, "rolled_back": False}

    def worker():
        try:
            _do_install(info, lambda m: q.put(("status", m)))
        except Exception as e:
            state["error"] = e
            state["rolled_back"] = (SCRIPT_DIR / ".backup").exists()
            log(f"install failed: {e}\n{traceback.format_exc()}")
        finally:
            state["done"] = True
            q.put(("done", None))

    try:
        import tkinter as tk
    except ImportError:
        # Pas de Tk : on installe quand même, sans UI
        log("Tkinter indisponible, install sans fenêtre de progression")
        worker()
        if state["error"]:
            return False
        return True

    root = tk.Tk()
    root.title("Audit Accessibilité")
    root.geometry("440x130")
    root.resizable(False, False)
    root.configure(bg="#FFFFFF")
    frame = tk.Frame(root, padx=24, pady=24, bg="#FFFFFF")
    frame.pack(fill="both", expand=True)
    label = tk.Label(frame, text=f"Téléchargement de la v{info['remote']}…",
                     font=("Helvetica", 12), bg="#FFFFFF", fg="#1F1E1B", anchor="w", justify="left")
    label.pack(anchor="w", fill="x")
    sub = tk.Label(frame, text="Veuillez patienter…", font=("Helvetica", 10),
                   bg="#FFFFFF", fg="#666666", anchor="w")
    sub.pack(anchor="w", pady=(10, 0))

    root.update_idletasks()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"+{(sw-440)//2}+{(sh-130)//3}")
    root.lift()
    root.attributes("-topmost", True)
    root.after(150, lambda: root.attributes("-topmost", False))

    def poll():
        try:
            while True:
                kind, payload = q.get_nowait()
                if kind == "status":
                    label.config(text=payload)
                elif kind == "done":
                    root.destroy()
                    return
        except queue.Empty:
            pass
        root.after(80, poll)

    threading.Thread(target=worker, daemon=True).start()
    root.after(80, poll)
    root.mainloop()

    # Fenêtre fermée → on affiche le verdict final (sur le thread principal)
    if state["error"]:
        e = state["error"]
        if state["rolled_back"]:
            show_error(f"Échec de l'installation : {e}\n\nL'ancienne version a été restaurée.")
        else:
            show_error(f"Échec de l'installation : {e}\n\nL'ancienne version est conservée.")
        return False
    show_info(f"Mise à jour v{info['remote']} installée avec succès.\n\nL'outil va démarrer dans la nouvelle version.")
    return True


# ─── Lance start.py ───────────────────────────────────────────────────────
def launch_start_py():
    """Remplace ce process par start.py."""
    if not START_PY.exists():
        show_error("start.py introuvable. Réinstallez l'outil.")
        sys.exit(1)
    py = sys.executable
    if sys.platform == "win32":
        # Windows : Popen + exit (pas de execv vrai)
        subprocess.Popen([py, str(START_PY)], cwd=str(SCRIPT_DIR))
        sys.exit(0)
    else:
        # Unix : execv remplace le process en place
        os.execv(py, [py, str(START_PY)])


# ─── Main ─────────────────────────────────────────────────────────────────
def main():
    try:
        # --skip-check : relance post-install via start.py → on saute le check (déjà fait)
        # pour éviter une boucle si le audit-version.json est mal configuré.
        skip_check = "--skip-check" in sys.argv
        if not skip_check:
            config = read_config()
            info = check_for_update(config)
            if info:
                log(f"update available: v{info['local']} -> v{info['remote']}")
                if show_update_dialog(info):
                    install_update(info)
                else:
                    log("user chose 'later'")
        else:
            log("launched with --skip-check (post-install relaunch)")
        launch_start_py()
    except Exception as e:
        log(f"main exception: {e}\n{traceback.format_exc()}")
        show_error(f"Erreur au démarrage : {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
