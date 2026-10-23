#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_local/server.py — Serveur de test local des LP ComparateurPro
==============================================================

Aucune dépendance (bibliothèque standard uniquement).

    python3 _local/server.py                 # http://localhost:8080
    python3 _local/server.py --port 9000
    python3 _local/server.py --host 127.0.0.1

Il sert les 131 sites du dépôt et fournit les remplaçants locaux des services
externes supprimés :

    POST /_local/api/lead     remplace  https://webflow.com/api/v1/form/<id>
    POST /_local/api/otp      remplace  https://mc.hellolead.pro/api/axialys/…
    POST /_local/api/log      journal des événements (dataLayer, OTP, …)
    GET  /_local/api/leads    liste des leads capturés (JSON)
    GET  /_local/leads        visualiseur HTML des leads
    POST /_local/api/mock     absorbe toute requête externe résiduelle
    GET  /_local/api/health   test de disponibilité

Deux modes d'accès aux sites :

  * par chemin (fonctionne partout, y compris derrière un proxy) :
        http://localhost:8080/<slug>/
  * par sous-domaine (retrouve la logique d'origine du JS) :
        http://<slug>.localhost:8080/

Les leads sont écrits dans `_local/leads/leads.jsonl` (1 ligne JSON par lead).
"""

import argparse
import json
import os
import re
import socket
import sys
import time
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------- #
# Chemins
# --------------------------------------------------------------------------- #
LOCAL_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(LOCAL_DIR)
LEADS_FILE = os.path.join(LOCAL_DIR, "leads", "leads.jsonl")
SHEETS_FILE = os.path.join(LOCAL_DIR, "leads", "sheets.jsonl")
EVENTS_FILE = os.path.join(LOCAL_DIR, "logs", "events.jsonl")
OTP_CODE = "123456"
OTP_STATE = {}          # telephone -> code envoyé
LOCK = __import__("threading").Lock()

SITE_DOMAINS = (".localhost", ".test", ".lvh.me", ".localtest.me")


def list_sites():
    out = []
    for name in sorted(os.listdir(ROOT)):
        folder = os.path.join(ROOT, name)
        if name.startswith(("_", ".")) or not os.path.isdir(folder):
            continue
        if os.path.isfile(os.path.join(folder, "index.html")):
            out.append(name)
    return out


SITES = list_sites()
SITES_SET = set(SITES)


def ensure_file(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8"):
            pass


def append_jsonl(path, payload):
    ensure_file(path)
    with LOCK:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def read_jsonl(path, limit=500):
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.readlines()[-limit:]
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


# --------------------------------------------------------------------------- #
# Handler
# --------------------------------------------------------------------------- #
class LocalHandler(SimpleHTTPRequestHandler):
    server_version = "ComparateurProLocal/1.0"

    # ---------------------------------------------------------------- routing
    def _host_label(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        for suffix in SITE_DOMAINS:
            if host.endswith(suffix):
                label = host[: -len(suffix)]
                if label and "." not in label and label in SITES_SET:
                    return label
        return None

    def _resolve_path(self):
        """Traduit l'URL demandée en chemin de fichier relatif au dépôt."""
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path or "/")
        self._slug = self._host_label()

        # Outillage local : toujours servi depuis /_local/
        if path.startswith("/_local") or path.startswith("/local-tools"):
            if path in ("/_local", "/local-tools"):
                path = "/_local/"
            return path

        if self._slug:
            # Mode sous-domaine : le site courant est monté à la racine.
            first = path.strip("/").split("/")[0]
            if first in SITES_SET:
                return path
            return "/" + self._slug + (path if path.startswith("/") else "/" + path)

        # Mode chemin
        first = path.strip("/").split("/")[0]
        if first in SITES_SET:
            return path
        return path

    def translate_path(self, path):
        return super().translate_path(self._resolve_path())

    # ------------------------------------------------------------------ utils
    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return b""
        return self.rfile.read(length)

    def _parse_body(self):
        raw = self._read_body()
        ctype = (self.headers.get("Content-Type") or "").lower()
        text = raw.decode("utf-8", "replace").strip()
        # JSON, même envoyé en text/plain (navigator.sendBeacon)
        if ("application/json" in ctype) or (text[:1] in ("{", "[") and "=" not in text[:20]):
            try:
                parsed = json.loads(text or "{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                parsed = {}
            # enveloppe {payload: {formId, id, data}} (intégration ubepro)
            if isinstance(parsed, dict) and isinstance(parsed.get("payload"), dict):
                env = parsed["payload"]
                data = dict(env.get("data") or {})
                data["__envelope"] = {"formId": env.get("formId"), "id": env.get("id")}
                return data
            return parsed
        # multipart/form-data
        if "multipart/form-data" in ctype:
            import email.parser
            import email.policy
            header = "Content-Type: " + self.headers.get("Content-Type") + "\r\nMIME-Version: 1.0\r\n\r\n"
            msg = email.parser.BytesParser(policy=email.policy.default).parsebytes(
                header.encode("latin-1") + raw)
            data = {}
            if msg.is_multipart():
                for part in msg.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    if not name:
                        continue
                    payload = part.get_payload(decode=True)
                    if payload is None:
                        continue
                    data[name] = payload.decode("utf-8", "replace")
            return data
        # x-www-form-urlencoded
        parsed = urllib.parse.parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
        out = {}
        for key, values in parsed.items():
            out[key] = values if len(values) > 1 else values[0]
        return out

    def log_message(self, fmt, *args):  # sortie compacte
        sys.stderr.write("  %s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ------------------------------------------------------------------- API
    def _handle_api(self, method):
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith("/_local/api/"):
            return False

        endpoint = path[len("/_local/api/"):].strip("/")

        if endpoint == "health":
            self._send_json({"ok": True, "sites": len(SITES), "otpCode": OTP_CODE,
                             "leads": len(read_jsonl(LEADS_FILE, 100000)),
                             "sheets": len(read_jsonl(SHEETS_FILE, 100000))})
            return True

        if endpoint == "sites":
            self._send_json({"sites": SITES})
            return True

        if endpoint == "leads" and method == "GET":
            self._send_json({"leads": read_jsonl(LEADS_FILE)[::-1]})
            return True

        if endpoint == "events" and method == "GET":
            self._send_json({"events": read_jsonl(EVENTS_FILE, 300)[::-1]})
            return True

        if endpoint.startswith("counter"):
            self.send_response(204)
            self.end_headers()
            return True

        if endpoint.startswith("mock"):
            self._send_json({})
            return True

        if method != "POST":
            self._send_json({"success": False, "message": "Méthode non autorisée"}, 405)
            return True

        data = self._parse_body()

        if endpoint.startswith("lead"):
            record = {
                "id": "lead-%d" % int(time.time() * 1000),
                "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "site": (data.get("__meta") or {}).get("slug") or self._host_label() or "-",
                "page": (data.get("__meta") or {}).get("page") or self.headers.get("Referer", ""),
                "form": (data.get("__meta") or {}).get("form") or "",
                "remote": self.client_address[0],
                "fields": data,
            }
            append_jsonl(LEADS_FILE, record)
            print("  ✔ lead capturé  site=%-40s champs=%s"
                  % (record["site"], len(data)), file=sys.stderr)
            self._send_json({"success": True, "status": "ok", "id": record["id"]})
            return True

        if endpoint.startswith("sheet"):
            # Remplace Google Apps Script : le standard attend {"status":"ok"}.
            record = {
                "id": (data.get("id_lead") if isinstance(data, dict) else None)
                      or "sheet-%d" % int(time.time() * 1000),
                "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "site": (data.get("ltm_source") if isinstance(data, dict) else None)
                        or self._host_label() or "-",
                "page": data.get("page_url") if isinstance(data, dict) else "",
                "fields": data,
            }
            append_jsonl(SHEETS_FILE, record)
            print("  ✔ lead (sheet)  site=%-30s champs=%s"
                  % (record["site"], len(data) if isinstance(data, dict) else 0), file=sys.stderr)
            self._send_json({"status": "ok", "id": record["id"]})
            return True

        if endpoint.startswith("otp"):
            action = str(data.get("action") or "envoyer_code")
            phone = re.sub(r"\D", "", str(data.get("telephone") or ""))
            emetteur = data.get("emetteur") or self._host_label() or ""
            if action == "verifier_code":
                expected = OTP_STATE.get(phone, OTP_CODE)
                ok = str(data.get("code") or "").strip() == expected
                response = {
                    "success": ok,
                    "message": "Numéro validé (mode local)." if ok
                    else "Code incorrect. En local, le code est %s." % expected,
                }
            else:
                OTP_STATE[phone] = OTP_CODE
                response = {"success": True,
                            "message": "Code envoyé (mode local : %s)." % OTP_CODE}
            append_jsonl(EVENTS_FILE, {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "kind": "otp",
                "action": action, "telephone": phone, "emetteur": emetteur,
                "success": response["success"],
            })
            print("  ✔ OTP %-14s tel=%s success=%s"
                  % (action, phone or "-", response["success"]), file=sys.stderr)
            self._send_json(response)
            return True

        if endpoint.startswith("log"):
            data.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S"))
            append_jsonl(EVENTS_FILE, data)
            self._send_json({"ok": True})
            return True

        self._send_json({"success": False, "message": "Endpoint inconnu"}, 404)
        return True

    # --------------------------------------------------------------- verbes
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/_local/leads", "/_local/leads/"):
            self.path = "/_local/leads.html"
        elif path in ("/", "") and not self._host_label():
            self.path = "/_local/index.html"
        if self._handle_api("GET"):
            return
        super().do_GET()

    def do_HEAD(self):
        if self._handle_api("GET"):
            return
        super().do_HEAD()

    def do_POST(self):
        if self._handle_api("POST"):
            return
        self._send_json({"success": False, "message": "POST non supporté ici"}, 405)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def end_headers(self):
        # En local, jamais de cache : une page modifiée doit être visible
        # immédiatement, sans rechargement forcé.
        path = urllib.parse.urlsplit(self.path).path.lower()
        if path.endswith((".html", ".js", ".mjs", ".css", ".json")) or path.endswith("/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    # MIME : évite les téléchargements intempestifs
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map, **{
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webp": "image/webp",
        ".avif": "image/avif",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".otf": "font/otf",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".svg": "image/svg+xml",
    })


# --------------------------------------------------------------------------- #
# Lancement
# --------------------------------------------------------------------------- #
def local_ip():
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    parser = argparse.ArgumentParser(description="Serveur de test local des LP")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    ensure_file(LEADS_FILE)
    ensure_file(SHEETS_FILE)
    ensure_file(EVENTS_FILE)

    handler = partial(LocalHandler, directory=ROOT)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)

    print("")
    print("  comparateurpro — serveur local")
    print("  " + "-" * 58)
    print("  Sites servis      : %d" % len(SITES))
    print("  Index des sites   : http://localhost:%d/" % args.port)
    print("  Exemple           : http://localhost:%d/assurance-tns/" % args.port)
    print("  Sous-domaine      : http://assurance-tns.localhost:%d/" % args.port)
    print("  Leads capturés    : http://localhost:%d/_local/leads" % args.port)
    print("  Code SMS local    : %s" % OTP_CODE)
    print("  Réseau            : http://%s:%d/" % (local_ip(), args.port))
    print("  " + "-" * 58)
    print("  Ctrl+C pour arrêter")
    print("")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Arrêt.\n")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
