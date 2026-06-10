#!/usr/bin/env python3
"""
Audit Accessibilité SharePoint — Serveur local
================================================
Lance l'outil d'audit et fait proxy vers le service d'IA configuré
(ai-config.json) pour éviter les blocages CORS/WAF du navigateur.

Usage :
    python3 start.py

L'outil s'ouvre automatiquement dans votre navigateur.
Appuyez sur Ctrl+C pour arrêter le serveur.
"""

import http.client
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path
from urllib.parse import urlparse

PORT = 8080
HTML_FILE = "audit-accessibilite-sharepoint.html"

# Config IA persistée (baseUrl du endpoint chat completions + modèle).
# Fichier local par poste, jamais distribué dans les ZIP ni versionné.
AI_CONFIG_FILE = Path(__file__).parent.resolve() / "ai-config.json"

# Stockage en mémoire du dernier HTML capturé via le bookmarklet.
# Pas de persistance disque : reset au redémarrage du serveur, c'est volontaire (usage perso, pas de fuite).
import time as _time
LAST_HTML = {"html": None, "captured_at": None, "url": None}

# Config IA partagée : token en RAM uniquement (sécu), baseUrl + modèle persistés
# dans ai-config.json. Configurée par le standalone via POST /api/save-token,
# utilisée par le panneau injecté qui n'a pas accès au localStorage de localhost.
SAVED_TOKEN = {"token": "", "model": "", "url": ""}


def _load_ai_config():
    """Recharge baseUrl + modèle depuis ai-config.json (persistés entre redémarrages)."""
    try:
        d = json.loads(AI_CONFIG_FILE.read_text(encoding="utf-8"))
        SAVED_TOKEN["url"] = (d.get("baseUrl") or "").strip()
        SAVED_TOKEN["model"] = (d.get("model") or "").strip()
    except Exception:
        pass


def _api_target():
    """(host, port, path) du endpoint chat completions configuré, ou None."""
    if not SAVED_TOKEN["url"]:
        return None
    u = urlparse(SAVED_TOKEN["url"])
    if not u.hostname:
        return None
    return u.hostname, u.port or 443, u.path + (("?" + u.query) if u.query else "")


_load_ai_config()

# Couleurs terminal
G = "\033[92m"  # vert
B = "\033[94m"  # bleu
Y = "\033[93m"  # jaune
R = "\033[91m"  # rouge
D = "\033[0m"   # reset
BOLD = "\033[1m"


class AuditHandler(http.server.SimpleHTTPRequestHandler):
    """Sert le HTML + proxy vers le service d'IA configuré."""

    def do_GET(self):
        # Endpoint pour récupérer le dernier HTML capturé via bookmarklet
        if self.path == "/api/last-html":
            return self._serve_last_html()
        # Bundle d'injection in-page (code audit + UI overlays) servi au bookmarklet
        if self.path == "/api/audit-injector.js":
            return self._serve_audit_injector()
        # Le panneau injecté demande si un token IA est dispo en RAM
        if self.path == "/api/has-token":
            return self._has_token()
        # Version locale (lue depuis APP_VERSION du HTML) — utilisée par le polling après auto-update
        if self.path == "/api/version":
            return self._serve_version()
        # Proxy le fetch d'un audit-version.json (typiquement hébergé sur SP) pour éviter CORS
        if self.path.startswith("/api/check-update"):
            return self._check_update()
        # Liste des modèles IA du service configuré (proxy + même contrainte WAF)
        if self.path == "/api/models":
            return self._list_models()
        # Page d'accueil → audit
        if self.path == "/" or self.path == "/index.html" or self.path.startswith("/?"):
            self.path = f"/{HTML_FILE}" + (self.path[1:] if self.path.startswith("/?") else "")
        return super().do_GET()

    def end_headers(self):
        # Anti-cache pour HTML / JS / JSON servis dynamiquement :
        # garantit que les agents voient TOUJOURS la dernière version du HTML après une MAJ
        # (sinon le navigateur peut afficher un fichier cached et faire croire que rien n'a changé).
        p = (self.path or "").split("?")[0].lower()
        if p.endswith(".html") or p.endswith(".js") or p == "/" or p == "/index.html":
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def _check_update(self):
        """Proxy le fetch d'un audit-version.json.
        Utilisé pour contourner CORS quand l'URL pointe vers SharePoint depuis localhost.
        Ne tente PAS d'envoyer les cookies SSO de l'utilisateur — l'URL doit donc être
        soit publique, soit un lien de partage anonyme SP (qui contient un token signé)."""
        from urllib.parse import urlparse, parse_qs
        try:
            qs = parse_qs(urlparse(self.path).query)
            target = (qs.get("url") or [""])[0]
            if not target.startswith("http"):
                self.send_response(400)
                self._cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "URL invalide ou non absolue"}).encode())
                return
            u = urlparse(target)
            port = u.port or (443 if u.scheme == "https" else 80)
            path = u.path + (("?" + u.query) if u.query else "")
            if u.scheme == "https":
                conn = http.client.HTTPSConnection(u.hostname, port, timeout=10)
            else:
                conn = http.client.HTTPConnection(u.hostname, port, timeout=10)
            conn.putrequest("GET", path, skip_accept_encoding=True)
            conn.putheader("User-Agent", "audit-update-check/1.0")
            conn.putheader("Accept", "application/json,*/*;q=0.8")
            conn.endheaders()
            resp = conn.getresponse()
            # SP renvoie souvent un redirect → on suit 1 niveau
            if resp.status in (301, 302, 303, 307, 308):
                loc = resp.getheader("Location") or ""
                resp.read()  # vide le socket
                conn.close()
                if loc.startswith("http"):
                    u2 = urlparse(loc)
                    port2 = u2.port or (443 if u2.scheme == "https" else 80)
                    path2 = u2.path + (("?" + u2.query) if u2.query else "")
                    conn = http.client.HTTPSConnection(u2.hostname, port2, timeout=10) if u2.scheme == "https" else http.client.HTTPConnection(u2.hostname, port2, timeout=10)
                    conn.putrequest("GET", path2, skip_accept_encoding=True)
                    conn.putheader("User-Agent", "audit-update-check/1.0")
                    conn.putheader("Accept", "application/json,*/*;q=0.8")
                    conn.endheaders()
                    resp = conn.getresponse()
            data = resp.read()
            status = resp.status
            try:
                conn.close()
            except Exception:
                pass
            self.send_response(status)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            try:
                self.send_response(502)
                self._cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)[:200]}).encode())
            except Exception:
                pass

    def _has_token(self):
        """Vérifie si un token IA est configuré (utilisé par le panneau injecté)."""
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"hasToken": bool(SAVED_TOKEN["token"])}).encode())

    def _list_models(self):
        """Proxy GET vers le endpoint /models du service IA configuré (dérivé de la baseUrl
        en remplaçant /chat/completions par /models — convention OpenAI-compatible).
        Même contrainte WAF que _proxy_api : headers minimaux, User-Agent: curl/8.7.1.
        Utilise l'Authorization client si fourni, sinon le token RAM enregistré via /api/save-token."""
        target = _api_target()
        if not target:
            self._json_error(503, "Service IA non configuré — ouvrez ⚙️ Paramètres pour renseigner l'URL")
            return
        host, port, path = target
        import re as _re
        models_path = _re.sub(r"/chat/completions/?$", "/models", path)
        auth = self.headers.get("Authorization", "")
        if not auth and SAVED_TOKEN["token"]:
            auth = "Bearer " + SAVED_TOKEN["token"]
        if not auth:
            self.send_response(401)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Token IA requis pour charger la liste"}).encode())
            return
        conn = None
        try:
            conn = http.client.HTTPSConnection(host, port, timeout=15)
            conn.putrequest("GET", models_path, skip_accept_encoding=True)
            conn.putheader("accept", "application/json")
            conn.putheader("Authorization", auth)
            conn.putheader("User-Agent", "curl/8.7.1")
            conn.endheaders()
            resp = conn.getresponse()
            data = resp.read()
            status = resp.status
            self.send_response(status)
            self._cors_headers()
            self.send_header("Content-Type", resp.getheader("Content-Type") or "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            try:
                self.send_response(502)
                self._cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)[:200]}).encode())
            except Exception:
                pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def _serve_version(self):
        """Retourne la version locale en parsant APP_VERSION dans le HTML.
        Utilisé par le client après auto-install pour détecter la fin du redémarrage."""
        import re as _re
        v = "unknown"
        try:
            html = Path(HTML_FILE).read_text(encoding="utf-8")
            m = _re.search(r'const\s+APP_VERSION\s*=\s*"([^"]+)"', html)
            if m:
                v = m.group(1)
        except Exception:
            pass
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps({"version": v}).encode())

    def _serve_audit_injector(self):
        """Assemble et serve un bundle JS = code audit extrait du HTML + UI injecteur.
        Le bookmarklet fetch ce bundle et l'eval dans le contexte SharePoint.
        IMPORTANT — on extrait UNIQUEMENT les fonctions audit pures (qui ne dépendent pas du DOM
        de la page audit). Les handlers UI (`$('#html-input').addEventListener`, getCfg, openSettings...)
        sont exclus car ils planteraient sur la page SP où ces éléments n'existent pas."""
        import re
        try:
            html_path = Path(HTML_FILE)
            ui_path = Path("audit-injector-ui.js")
            if not html_path.exists() or not ui_path.exists():
                self.send_response(500)
                self._cors_headers()
                self.send_header("Content-Type", "application/javascript")
                self.end_headers()
                self.wfile.write(b"throw new Error('Fichiers source introuvables sur le serveur');")
                return
            html_text = html_path.read_text(encoding="utf-8")
            # Extrait le contenu du dernier <script>...</script> applicatif
            m = re.search(r"<script>([\s\S]*?)</script>\s*</body>", html_text)
            full_js = m.group(1) if m else ""
            # On extrait UNIQUEMENT les fonctions audit pures (avant le bloc "// UI" qui contient
            # les event listeners DOM dépendants des éléments de la page audit).
            # Début : constantes audit (SEV, WCAG_C, etc.) qui sont définies tout en haut du script
            # Fin : juste avant le commentaire "// UI" ou "// Exports"
            const_block_match = re.search(r"const SEV=\{[\s\S]*?const GENERIC=\[[^\]]+\];", full_js)
            const_block = const_block_match.group(0) if const_block_match else ""
            # Fin de la section audit = avant "// UI"
            ui_marker = full_js.find("// UI\n")
            if ui_marker == -1:
                ui_marker = full_js.find("\n// Exports")
            # Début de la section audit = "// ═══ SHAREPOINT SCOPING ═══" ou "const SP_CANVAS_SEL"
            audit_start = full_js.find("// ═══ SHAREPOINT SCOPING ═══")
            if audit_start == -1:
                audit_start = full_js.find("const SP_CANVAS_SEL")
            audit_end = ui_marker if ui_marker != -1 else len(full_js)
            # renderRecommendation est définie quelque part dans le bloc — incluse via la slice
            audit_body = full_js[audit_start:audit_end] if audit_start != -1 else ""
            ui_text = ui_path.read_text(encoding="utf-8")
            bundle = (
                "// === AUDIT-CORE (fonctions pures extraites du HTML d'audit) ===\n"
                "(function(){\n"
                "  // Constantes audit (sévérités, WCAG, rôles ARIA, liens génériques)\n"
                + const_block + "\n\n"
                "  // Fonctions audit (scoping, getContext, runAudit, renderRecommendation, etc.)\n"
                + audit_body + "\n"
                "  // Expose au monde global pour que audit-injector-ui.js puisse l'utiliser.\n"
                "  // Inclut aiReformulate pour le bouton « Suggestions IA » dans le panneau injecté.\n"
                "  window.__AUDIT_CORE__={runAudit:runAudit,SEV:SEV,SEV_COL:SEV_COL,WCAG_C:WCAG_C,renderRecommendation:renderRecommendation,aiReformulate:aiReformulate,buildAIPrompt:buildAIPrompt,parseAIOptions:parseAIOptions,aiDetectMode:aiDetectMode,aiUILabels:aiUILabels,aiPromptDefaults:aiPromptDefaults,retagDOMFromIssues:retagDOMFromIssues};\n"
                "})();\n\n"
                "// === AUDIT-INJECTOR-UI (overlay in-page sur SharePoint) ===\n"
                + ui_text
            )
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(bundle.encode("utf-8"))
        except Exception as e:
            print(f"  {R}✗{D}  Erreur audit-injector : {e}")
            self.send_response(500)
            self._cors_headers()
            self.send_header("Content-Type", "application/javascript")
            self.end_headers()
            self.wfile.write(f"throw new Error('{e}');".encode())

    def do_POST(self):
        if self.path == "/api/proxy":
            self._proxy_api()
        elif self.path == "/api/audit-html":
            self._receive_html()
        elif self.path == "/api/audit-html-form":
            self._receive_html_form()
        elif self.path == "/api/save-token":
            self._save_token()
        elif self.path == "/api/install-update":
            self._install_update()
        else:
            self.send_error(404)

    def _install_update(self):
        """Reçoit {downloadUrl} → télécharge le ZIP → extrait par-dessus les fichiers de l'outil
        → crée un sentinel .relaunch → exit. Le wrapper (.command/.bat) détecte le sentinel et relance.
        Le client polle /api/version pour détecter la fin du redémarrage et reload la page."""
        import io as _io
        import zipfile as _zf
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 8192:
                self._json_error(413, "Payload trop gros")
                return
            body = self.rfile.read(length).decode("utf-8", errors="replace") if length else "{}"
            data = json.loads(body) if body else {}
            url = (data.get("downloadUrl") or "").strip()
            if not url.startswith("http"):
                self._json_error(400, "downloadUrl absente ou invalide")
                return
            print(f"  {B}⟶{D}  Téléchargement de la mise à jour : {url[:120]}")
            # Download (suit redirects)
            zip_bytes = self._download_follow(url, max_redirects=5)
            print(f"  {G}✓{D}  ZIP reçu : {len(zip_bytes)} octets")
            # Vérifie c'est bien un ZIP avec l'outil
            try:
                zf = _zf.ZipFile(_io.BytesIO(zip_bytes))
                names = zf.namelist()
            except _zf.BadZipFile:
                self._json_error(400, "Le fichier téléchargé n'est pas un ZIP valide")
                return
            if not any(n.endswith("audit-accessibilite-sharepoint.html") for n in names) or not any(n.endswith("start.py") for n in names):
                self._json_error(400, "Le ZIP ne contient pas l'outil attendu (audit-accessibilite-sharepoint.html + start.py)")
                return
            # Détecte le dossier racine commun (ex: "Audit-accessibilité-SharePoint/")
            real_files = [n for n in names if not n.endswith("/")]
            import posixpath as _pp
            try:
                common = _pp.commonpath(real_files)
            except Exception:
                common = ""
            prefix = (common + "/") if common and not common.endswith("/") else common
            script_dir = Path(__file__).parent.resolve()
            # Extraction sécurisée
            for member in zf.infolist():
                fn = member.filename
                if not fn or fn.endswith("/"):
                    continue
                # Strip le préfixe commun
                rel = fn[len(prefix):] if prefix and fn.startswith(prefix) else fn
                if not rel:
                    continue
                target = (script_dir / rel).resolve()
                # Anti path-traversal
                if not str(target).startswith(str(script_dir) + os.sep) and target != script_dir:
                    print(f"  {Y}!{D}  Skip path suspicieux : {rel}")
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as dst:
                    dst.write(src.read())
                # Préserve l'exécutable pour les wrappers
                if str(target).endswith(".command") or str(target).endswith(".sh"):
                    try:
                        os.chmod(target, 0o755)
                    except Exception:
                        pass
            zf.close()
            print(f"  {G}✓{D}  Mise à jour installée. Relance imminente…")
            # Réponse OK AVANT le exit
            payload = json.dumps({"ok": True, "willRestart": True}).encode()
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            try:
                self.wfile.flush()
            except Exception:
                pass
            # Spawn launcher.py (détaché) puis exit ce process pour libérer le port 8080.
            # Le launcher saute le check de MAJ (déjà fait) et exec start.py → nouvelle version
            # se bind sur 8080. Le browser polle /api/version pour détecter et reload.
            launcher = script_dir / "launcher.py"
            def _restart_soon():
                import time as _t
                _t.sleep(0.8)
                try:
                    py = sys.executable
                    if sys.platform == "win32":
                        # Détacher pour survivre à l'exit du parent
                        try:
                            subprocess.Popen(
                                [py, str(launcher), "--skip-check"],
                                cwd=str(script_dir),
                                creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
                                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                            )
                        except Exception:
                            subprocess.Popen([py, str(launcher), "--skip-check"], cwd=str(script_dir))
                    else:
                        subprocess.Popen(
                            [py, str(launcher), "--skip-check"],
                            cwd=str(script_dir),
                            start_new_session=True,
                        )
                except Exception as e:
                    print(f"  {R}✗{D}  Impossible de spawner launcher : {e}")
                os._exit(0)
            threading.Thread(target=_restart_soon, daemon=True).start()
        except Exception as e:
            print(f"  {R}✗{D}  Échec install-update : {e}")
            self._json_error(500, str(e)[:300])

    def _download_follow(self, url, max_redirects=5):
        """Fetch HTTP(S), suit les redirects, retourne les bytes. Lève en cas d'erreur."""
        from urllib.parse import urlparse as _up
        current = url
        for _ in range(max_redirects + 1):
            u = _up(current)
            port = u.port or (443 if u.scheme == "https" else 80)
            path = u.path + (("?" + u.query) if u.query else "")
            if u.scheme == "https":
                conn = http.client.HTTPSConnection(u.hostname, port, timeout=60)
            else:
                conn = http.client.HTTPConnection(u.hostname, port, timeout=60)
            try:
                conn.putrequest("GET", path, skip_accept_encoding=True)
                conn.putheader("User-Agent", "audit-update/1.0")
                conn.putheader("Accept", "*/*")
                conn.endheaders()
                resp = conn.getresponse()
                if resp.status in (301, 302, 303, 307, 308):
                    loc = resp.getheader("Location")
                    resp.read()
                    if not loc:
                        raise RuntimeError(f"Redirect {resp.status} sans Location")
                    # Résout les redirects relatifs
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

    def _json_error(self, status, msg):
        payload = json.dumps({"error": msg}).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def _save_token(self):
        """Reçoit le token IA depuis le standalone et le garde en RAM.
        Permet au panneau injecté (sur sharepoint.com, pas de localStorage local) d'utiliser
        l'IA via le proxy sans avoir à le re-saisir."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 4096:
                self.send_error(413, "Payload trop gros pour un token")
                return
            body = self.rfile.read(length).decode("utf-8", errors="replace")
            data = json.loads(body) if body else {}
            tok = (data.get("token") or "").strip()
            model = (data.get("model") or "").strip()
            ai_url = (data.get("url") or "").strip()
            SAVED_TOKEN["token"] = tok
            if model:
                SAVED_TOKEN["model"] = model
            if ai_url:
                SAVED_TOKEN["url"] = ai_url
            # Persiste baseUrl + modèle (PAS le token) pour les prochains démarrages
            try:
                AI_CONFIG_FILE.write_text(json.dumps({"baseUrl": SAVED_TOKEN["url"], "model": SAVED_TOKEN["model"]}, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                pass
            print(f"  {G}✓{D}  Config IA enregistrée (clé {'présente' if tok else 'vidée'}, URL {'présente' if SAVED_TOKEN['url'] else 'absente'})")
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "hasToken": bool(tok)}).encode())
        except Exception as e:
            self.send_response(500)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _receive_html_form(self):
        """Variante du capture HTML mais via une form submission (pas un fetch).
        Sert de fallback quand SharePoint a un CSP `connect-src` strict qui bloque le fetch
        cross-origin vers localhost. La form submission est régie par `form-action` (rarement
        restreint), donc passe.
        Le body est x-www-form-urlencoded avec champs `html` + `source`.
        Réponse : 303 redirect vers /?fresh=1 — le navigateur ouvre l'audit dans le tab cible."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 30 * 1024 * 1024:  # 30 MB urlencoded ≈ 10 MB de HTML, marge
                self.send_error(413, "HTML trop volumineux")
                return
            from urllib.parse import parse_qs
            body = self.rfile.read(length).decode("utf-8", errors="replace")
            params = parse_qs(body, keep_blank_values=True, max_num_fields=10)
            html = (params.get("html") or [""])[0]
            src_url = (params.get("source") or [""])[0]
            if not html:
                self.send_error(400, "Champ 'html' manquant")
                return
            LAST_HTML["html"] = html
            LAST_HTML["captured_at"] = _time.time()
            LAST_HTML["url"] = src_url
            print(f"  {G}✓{D}  HTML capturé (form) : {len(html)} octets{f' depuis {src_url[:80]}' if src_url else ''}")
            # 303 = See Other → le navigateur fait un GET sur Location, garde le tab cible
            self.send_response(303)
            self.send_header("Location", "/?fresh=1")
            self._cors_headers()
            self.end_headers()
        except Exception as e:
            print(f"  {R}✗{D}  Erreur capture form : {e}")
            self.send_error(500, str(e))

    def _receive_html(self):
        """Reçoit le HTML capturé par le bookmarklet et le stocke en mémoire."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 20 * 1024 * 1024:  # 20 MB max — une page SharePoint typique fait 1-3 MB
                self.send_response(413)
                self._cors_headers()
                self.end_headers()
                self.wfile.write(b'{"error":"HTML trop volumineux (>20MB)"}')
                return
            body = self.rfile.read(length)
            html = body.decode("utf-8", errors="replace")
            src_url = self.headers.get("X-Source-URL", "")
            LAST_HTML["html"] = html
            LAST_HTML["captured_at"] = _time.time()
            LAST_HTML["url"] = src_url
            print(f"  {G}✓{D}  HTML capturé : {len(html)} octets{f' depuis {src_url[:80]}' if src_url else ''}")
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "size": len(html)}).encode())
        except Exception as e:
            print(f"  {R}✗{D}  Erreur capture HTML : {e}")
            self.send_response(500)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _serve_last_html(self):
        """Renvoie le dernier HTML capturé en JSON (avec timestamp + URL source)."""
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if LAST_HTML["html"] is None:
            self.wfile.write(json.dumps({"html": None, "captured_at": None}).encode())
        else:
            payload = json.dumps({
                "html": LAST_HTML["html"],
                "captured_at": LAST_HTML["captured_at"],
                "url": LAST_HTML["url"],
                "size": len(LAST_HTML["html"]),
            })
            self.wfile.write(payload.encode())

    def _cors_headers(self):
        """Headers CORS communs aux endpoints qui répondent au bookmarklet/page audit.
        Le `Access-Control-Allow-Private-Network` est crucial : depuis Chrome ~121, les pages
        publiques HTTPS (*.sharepoint.com) qui appellent localhost doivent recevoir ce
        header dans le preflight OPTIONS, sinon Chrome bloque avec un 'Failed to fetch'
        opaque (Private Network Access protection)."""
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Source-URL")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _proxy_api(self):
        conn = None
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            auth = self.headers.get("Authorization", "")
            # Fallback : si pas d'Authorization fourni (= appel depuis le panneau injecté qui
            # n'a pas accès au localStorage), utilise le token RAM enregistré par le standalone.
            if not auth and SAVED_TOKEN["token"]:
                auth = "Bearer " + SAVED_TOKEN["token"]

            # IMPORTANT — certains WAF d'entreprise (ex. F5 ASM) matchent la signature HTTP :
            # la requête sur le wire DOIT être identique à celle-ci :
            #
            #   curl -X POST https://…/chat/completions \
            #     -H 'accept: */*' \
            #     -H 'Authorization: Bearer ...' \
            #     -H 'Content-Type: application/json' \
            #     -d '{...}'
            #
            # On utilise http.client + putrequest(skip_accept_encoding=True) pour empêcher Python
            # d'injecter un `Accept-Encoding: identity` automatique. `requests`/`urllib3` ajoutent
            # aussi Connection, User-Agent python-urllib3, etc. — toutes des empreintes que le WAF
            # matche. Ici on envoie EXACTEMENT : Host (auto), accept, Authorization, Content-Type,
            # User-Agent curl/8.7.1, Content-Length (auto). Rien de plus, rien de moins.
            headers = [
                ("accept", "*/*"),
                ("Authorization", auth),
                ("Content-Type", "application/json"),
                ("User-Agent", "curl/8.7.1"),
                ("Content-Length", str(len(body))),
            ]

            target = _api_target()
            if not target:
                self._json_error(503, "Service IA non configuré — ouvrez ⚙️ Paramètres pour renseigner l'URL et la clé API")
                return
            host, port, path = target
            conn = http.client.HTTPSConnection(host, port, timeout=120)
            conn.putrequest("POST", path, skip_accept_encoding=True)
            for k, v in headers:
                conn.putheader(k, v)
            conn.endheaders(body)
            resp = conn.getresponse()
            status = resp.status
            ct = resp.getheader("Content-Type") or "application/json"
            data = resp.read()

            if status >= 400:
                preview = data[:300].decode("utf-8", errors="replace").replace("\n", " ")
                print(f"  {R}✗{D}  API HTTP {status} : {preview}")

            self.send_response(status)
            self.send_header("Content-Type", ct)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)

        except socket.timeout:
            self.send_response(504)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": "Timeout après 120s",
                "detail": "L'API n'a pas répondu à temps."
            }).encode())

        except (socket.gaierror, ConnectionError, OSError) as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": "Impossible de joindre l'API gateway",
                "detail": str(e)[:300]
            }).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": str(e)
            }).encode())

        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def do_OPTIONS(self):
        """Gérer les preflight CORS pour tous les endpoints (proxy IA + capture HTML).
        IMPORTANT — X-Source-URL doit être listé dans Allow-Headers, sinon Chrome bloque
        le preflight et renvoie un 'Failed to fetch' opaque côté bookmarklet."""
        self.send_response(204)
        self._cors_headers()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def log_message(self, format, *args):
        """Log propre."""
        msg = format % args
        if "/api/proxy" in msg:
            print(f"  {B}⟶{D}  Proxy API : {msg}")
        elif "200" in msg or "304" in msg:
            pass  # Silencer les requêtes statiques OK
        elif "404" in msg or "500" in msg:
            print(f"  {R}✗{D}  {msg}")


def main():
    # Se placer dans le dossier du script
    script_dir = Path(__file__).parent.resolve()
    os.chdir(script_dir)

    # Vérifier que le HTML existe
    if not Path(HTML_FILE).exists():
        print(f"\n  {R}✗{D}  Fichier {BOLD}{HTML_FILE}{D} introuvable dans {script_dir}")
        print(f"  {Y}→{D}  Placez {HTML_FILE} dans le même dossier que start.py\n")
        sys.exit(1)

    url = f"http://localhost:{PORT}"
    ai_target = SAVED_TOKEN["url"] or "non configuré (ouvrez ⚙️ Paramètres)"

    print(f"""
  {BOLD}╔══════════════════════════════════════════════╗
  ║     ♿  Audit Accessibilité SharePoint       ║
  ╚══════════════════════════════════════════════╝{D}

  {G}✓{D}  Serveur démarré sur {BOLD}{url}{D}
  {G}✓{D}  Proxy IA → {BOLD}{ai_target}{D}
  {Y}⚡{D} Ctrl+C pour arrêter

""")

    # Ouvrir le navigateur automatiquement
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    # ThreadingHTTPServer : sert plusieurs requêtes en parallèle (Chrome ouvre ~6 connexions
    # par défaut, sinon elles font la queue → page lente).
    # Bind dual-stack IPv4+IPv6 sur loopback : Chrome essaie ::1 en premier, on évite le timeout
    # de fallback IPv4. On reste loopback-only pour pas exposer au réseau.
    class LocalDualStackServer(http.server.ThreadingHTTPServer):
        address_family = socket.AF_INET6
        daemon_threads = True
        def server_bind(self):
            # Active le dual-stack : socket IPv6 accepte aussi IPv4-mapped (::ffff:127.0.0.1)
            try:
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            except Exception:
                pass
            super().server_bind()

    # Cas du redémarrage post-installation : l'ancien process peut tenir encore le port
    # quelques instants. On attend qu'il l'ait VRAIMENT libéré avant de binder — sinon les
    # deux processes se partagent un socket bancal et le nouveau reset toutes les connexions.
    def _port_busy():
        for host in ("::1", "127.0.0.1"):
            try:
                with socket.create_connection((host, PORT), timeout=0.4):
                    return True
            except OSError:
                pass
        return False

    waited = 0.0
    while _port_busy() and waited < 12.0:
        _time.sleep(0.3)
        waited += 0.3

    # Bind avec quelques tentatives (le prédécesseur peut finir de libérer le port à l'instant).
    server = None
    for attempt in range(20):  # ~6s max
        try:
            # Bind sur ::1 (loopback IPv6) avec dual-stack pour accepter aussi 127.0.0.1
            server = LocalDualStackServer(("::1", PORT), AuditHandler)
            break
        except OSError:
            try:
                # Fallback IPv4 pur si IPv6 indisponible
                server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), AuditHandler)
                break
            except OSError:
                _time.sleep(0.3)
    if server is None:
        print(f"\n  {R}✗{D}  Le port {PORT} reste occupé. Fermez l'autre fenêtre de l'outil puis relancez.\n")
        sys.exit(1)

    try:
        with server:
            server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n  {Y}■{D}  Serveur arrêté.\n")


if __name__ == "__main__":
    main()
