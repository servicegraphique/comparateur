#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_local/tools/localize.py — Suppression des dépendances externes des LP
=====================================================================

Réécrit les `index.html` des 131 sites pour qu'aucune ressource distante ne
soit appelée, sans toucher au design, au CSS, ni au script.js (qui est laissé
strictement intact — voir la note en fin de fichier).

Ce qui est retiré / remplacé :

    Google Tag Manager (script + noscript/iframe)     -> supprimé, dataLayer gardé
    <link rel="prefetch" href="https://…">            -> supprimé
    <link rel="canonical" href="https://…">           -> /<slug>/
    <a href="https://…">                              -> page locale ou /_local/*
    <iframe src="https://…">                          -> page locale ou /_local/*
    data-redirect="https://…"                         -> chemin local
    toute autre URL absolue dans un attribut          -> page locale d'information
    + injection de /_local/runtime.js avant </body>

Utilisation :

    python3 _local/tools/localize.py --dry-run     # aperçu, aucune écriture
    python3 _local/tools/localize.py --apply       # applique (idempotent)
"""

import argparse
import json
import os
import re
import sys
import urllib.parse

LOCAL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(LOCAL_DIR)
MARKER = "<!-- _local:runtime -->"
CSP_MARKER = "<!-- _local:csp -->"
CSP_POLICY = (
    "default-src 'self' data: blob:; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "media-src 'self' data: blob:; "
    "connect-src 'self'; "
    "frame-src 'self'; "
    "form-action 'self'; "
    "base-uri 'self'"
)
CSP_TAG = (CSP_MARKER + '\n  <meta http-equiv="Content-Security-Policy" content="'
           + CSP_POLICY + '">')
RUNTIME_TAG = MARKER + '\n  <script src="/_local/runtime.js"></script>'

SITES = sorted(
    name for name in os.listdir(ROOT)
    if not name.startswith(("_", "."))
    and os.path.isfile(os.path.join(ROOT, name, "index.html"))
)
SITES_SET = set(SITES)

EXTERNAL_PAGE = "/_local/external.html?to="
CONTACT_PAGE = "/_local/contact.html"
VIDEO_PAGE = "/_local/embed-video.html"

LEGAL_PAGES = {
    "mentions-legales": "/mentions-legales/",
    "politique-de-confidentialite-donnees-personnelles":
        "/politique-de-confidentialite-donnees-personnelles/",
}

# Statistiques de conversion
STATS = {
    "canonical": 0, "gtm": 0, "prefetch": 0, "anchor": 0,
    "iframe": 0, "data_redirect": 0, "other": 0, "runtime": 0, "csp": 0, "broken": 0,
}


# --------------------------------------------------------------------------- #
# Résolution d'une URL externe vers une ressource locale
# --------------------------------------------------------------------------- #
def resolve(url):
    """Retourne un chemin local (str), ou None si rien ne correspond."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    path = urllib.parse.unquote(u.path or "/")
    segs = [s for s in path.split("/") if s]

    # 0. endpoints applicatifs (leads / SMS) -> API locale
    if host.endswith("hellolead.pro") or host == "script.google.com":
        if "envoi_code_verification" in path:
            return "/_local/api/otp"
        if "get_information" in path or "webflow" in path or host == "script.google.com":
            return "/_local/api/lead"

    # 1. <slug>.lp.comparateurpro.fr  ->  /<slug>/  (ou /<chemin> si ressource)
    m = re.match(r"^(.+)\.lp\.comparateurpro\.fr$", host)
    if m:
        slug = m.group(1)
        if segs:
            return "/" + "/".join(segs)
        return "/%s/" % slug if slug in SITES_SET else None

    # 2. domaines "comparateurpro" (www, devis, www.ubepro.com…)
    if host.endswith("comparateurpro.fr") or host.endswith("ubepro.com"):
        joined = "-".join(segs)
        if joined and joined in SITES_SET:
            return "/%s/" % joined
        if segs and segs[-1] in SITES_SET:
            return "/%s/" % segs[-1]
        if not segs:
            return "/"
        return None

    # 3. pages légales rapatriées
    if segs:
        last = segs[-1]
        if last in LEGAL_PAGES:
            return LEGAL_PAGES[last]

    # 4. contact / actualités / divers
    if host.endswith("hellolead.pro") and "contact" in path:
        return CONTACT_PAGE

    # 5. vidéos
    if host.endswith("youtube.com") or host.endswith("youtu.be") or host.endswith("youtube-nocookie.com"):
        return VIDEO_PAGE

    return None


def resolve_video(url, slug):
    """uploads-ssl.webflow.com/.../fichier.mp4 -> videos/fichier.mp4 (si présent)."""
    raw = urllib.parse.unquote(url)
    name = raw.split("/")[-1].replace("~", "-")
    candidate = os.path.join(ROOT, slug, "videos", name)
    if os.path.isfile(candidate):
        return "videos/" + name
    return None


def resolve_data_attr(attr, url, slug):
    """Attributs data-* porteurs d'endpoints externes (Formly, vidéos)."""
    attr = attr.lower()
    if attr == "data-sms-endpoint":
        return "/_local/api/otp"
    if attr == "data-google-script-url":
        return "/_local/api/sheet"
    if attr in ("data-api-url", "data-endpoint", "data-lead-endpoint"):
        return "/_local/api/lead"
    if attr == "data-video-urls":
        parts = [p for p in url.split(",") if p]
        out = []
        for part in parts:
            out.append(resolve_video(part, slug) or fallback(part))
        return ",".join(out)
    return resolve(url) or fallback(url)


def fallback(url):
    return EXTERNAL_PAGE + urllib.parse.quote(url, safe="")


# --------------------------------------------------------------------------- #
# Transformations HTML
# --------------------------------------------------------------------------- #
GTM_SCRIPT_RE = re.compile(
    r"\s*<script[^>]*>(?:(?!</script>).)*?googletagmanager[^<]*?(?:(?!</script>).)*?</script>",
    re.S | re.I)
GTM_SRC_SCRIPT_RE = re.compile(r'\s*<script[^>]+src="[^"]*googletagmanager[^"]*"[^>]*>\s*</script>', re.I)
GTM_COMMENT_RE = re.compile(r"\s*<!--\s*/?\s*(?:End\s+)?Google Tag Manager\s*-->", re.I)
GTM_NOSCRIPT_RE = re.compile(r"\s*<noscript[^>]*>(?:(?!</noscript>).)*googletagmanager(?:(?!</noscript>).)*</noscript>", re.S | re.I)
GTM_IFRAME_RE = re.compile(r'\s*<iframe[^>]+src="[^"]*googletagmanager[^"]*"[^>]*>\s*</iframe>', re.I)

PREFETCH_RE = re.compile(r'\s*<link[^>]+rel="prefetch"[^>]*>', re.I)
CANONICAL_RE = re.compile(r'(<link[^>]+rel="canonical"[^>]+href=")([^"]+)(")', re.I)

ATTR_URL_RE = re.compile(r'(?P<attr>href|src|action|data-redirect|redirect|poster)="(?P<url>https?://[^"]+)"', re.I)
DATA_URL_RE = re.compile(r'(?P<attr>data-[a-z-]+)="(?P<url>https?://[^"]+)"', re.I)
CSS_URL_RE = re.compile(r'url\(\s*["\']?(https?://[^)"\']+)', re.I)
META_URL_RE = re.compile(r'(<meta[^>]+content=")(https?://[^"]+)(")', re.I)


def transform_html(html, slug, report):
    # --- Google Tag Manager -------------------------------------------------
    # Les pages déjà passées par `_standard/tools/apply-standard.py` gèrent GTM
    # elles-mêmes (chargement conditionné au mode local + Consent Mode v2) :
    # on ne retire rien sur ces pages.
    if "ubepro:head" not in html:
        before = len(GTM_COMMENT_RE.findall(html)) + len(GTM_SCRIPT_RE.findall(html))
        if GTM_SCRIPT_RE.search(html) or GTM_SRC_SCRIPT_RE.search(html):
            report["gtm"] += 1
        html = GTM_NOSCRIPT_RE.sub("", html)
        html = GTM_IFRAME_RE.sub("", html)
        html = GTM_SRC_SCRIPT_RE.sub("", html)
        html = GTM_SCRIPT_RE.sub("", html)
        html = GTM_COMMENT_RE.sub("", html)

    # --- prefetch (aucun intérêt en local) ----------------------------------
    if PREFETCH_RE.search(html):
        report["prefetch"] += len(PREFETCH_RE.findall(html))
        html = PREFETCH_RE.sub("", html)

    # --- canonical ----------------------------------------------------------
    def _canonical(m):
        if "ubepro:head" in html:
            return m.group(0)          # canonical géré par le standard
        url = m.group(2)
        if not url.lower().startswith(("http://", "https://")):
            return m.group(0)
        report["canonical"] += 1
        return m.group(1) + "/%s/" % slug + m.group(3)
    html = CANONICAL_RE.sub(_canonical, html)

    # --- attributs href / src / action / data-redirect ----------------------
    def _attr(m):
        attr, url = m.group("attr"), m.group("url")
        # La balise <noscript> GTM du standard reste intacte (production).
        if "googletagmanager.com" in url:
            return m.group(0)
        local = resolve(url)
        if local is None:
            local = fallback(url)
        if attr.lower() == "data-redirect":
            report["data_redirect"] += 1
        elif attr.lower() == "src":
            report["iframe"] += 1
        elif attr.lower() == "href":
            report["anchor"] += 1
        else:
            report["other"] += 1
        return '%s="%s"' % (attr, local)
    html = ATTR_URL_RE.sub(_attr, html)

    # --- attributs data-* porteurs d'URL (Formly, vidéos Webflow) ----------
    def _data(m):
        attr, url = m.group("attr"), m.group("url")
        report["other"] += 1
        return '%s="%s"' % (attr, resolve_data_attr(attr, url, slug))
    html = DATA_URL_RE.sub(_data, html)

    # --- métadonnées (og:url, og:image…) ------------------------------------
    def _meta(m):
        url = m.group(2)
        local = resolve(url)
        report["other"] += 1
        return m.group(1) + (local or fallback(url)) + m.group(3)
    html = META_URL_RE.sub(_meta, html)

    # --- url() externes en style inline (aucun attendu) ---------------------
    html = CSS_URL_RE.sub(lambda m: "url(%s)" % (resolve(m.group(1)) or "/_local/noop.svg"), html)

    # --- images locales manquantes (export Webflow cassé) -------------------
    def _img(m):
        raw = m.group(2)
        if raw.startswith(("http://", "https://", "data:", "//", "/_local/")):
            return m.group(0)
        target = os.path.normpath(os.path.join(ROOT, slug, urllib.parse.unquote(raw.split("?")[0])))
        if not os.path.isfile(target):
            report["other"] += 1
            report.setdefault("broken", 0)
            report["broken"] = report.get("broken", 0) + 1
            return '%s="/_local/noop.svg"' % m.group(1)
        return m.group(0)
    html = re.sub(r'(<img[^>]+src)="([^"]+)"', _img, html, flags=re.I)

    # --- verrou réseau : CSP locale (bloque tout domaine externe) -----------
    if CSP_MARKER not in html:
        tag = CSP_TAG
        charset = re.search(r"<meta[^>]+charset=[^>]*>", html, re.I)
        if charset:
            html = html[:charset.end()] + "\n  " + tag + html[charset.end():]
        else:
            html = re.sub(r"(<head[^>]*>)", r"\1\n  " + tag.replace("\\", "\\\\"),
                          html, count=1, flags=re.I)
        report["csp"] = 1

    # --- injection du runtime ----------------------------------------------
    if MARKER not in html:
        if "</body>" in html:
            html = html.replace("</body>", "  " + RUNTIME_TAG + "\n</body>", 1)
        else:
            html += RUNTIME_TAG
        report["runtime"] += 1

    return html


LEFT_EXTERNAL_RE = re.compile(r'https?://(?!www\.w3\.org)[A-Za-z0-9.-]+')
ALLOWED_HOSTS = ("www.w3.org",)


def leftover_externals(html):
    found = {}
    for m in LEFT_EXTERNAL_RE.finditer(html):
        url = m.group(0)
        if any(h in url for h in ALLOWED_HOSTS):
            continue
        found[url] = found.get(url, 0) + 1
    return found


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="écrit les fichiers")
    ap.add_argument("--dry-run", action="store_true", help="aperçu (défaut)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    apply = args.apply and not args.dry_run

    changed = 0
    per_site = {}
    leftovers = {}

    for slug in SITES:
        path = os.path.join(ROOT, slug, "index.html")
        with open(path, "r", encoding="utf-8") as fh:
            original = fh.read()
        report = {k: 0 for k in STATS}
        updated = transform_html(original, slug, report)
        per_site[slug] = report
        rest = leftover_externals(updated)
        if rest:
            leftovers[slug] = rest
        if updated != original:
            changed += 1
            if apply:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(updated)

    totals = {}
    for rep in per_site.values():
        for key, val in rep.items():
            totals[key] = totals.get(key, 0) + val

    print("")
    print("  localisation des LP — %s" % ("APPLIQUÉ" if apply else "APERÇU (aucune écriture)"))
    print("  " + "-" * 56)
    print("  Sites traités            : %d" % len(SITES))
    print("  Sites modifiés           : %d" % changed)
    for key, label in (("canonical", "canonical réécrits"),
                       ("gtm", "GTM retirés"),
                       ("prefetch", "prefetch retirés"),
                       ("anchor", "liens <a> réécrits"),
                       ("iframe", "iframes <src> réécrites"),
                       ("data_redirect", "data-redirect réécrits"),
                       ("other", "autres attributs/meta"),
                       ("runtime", "runtime injecté"),
                       ("csp", "CSP locale posée"),
                       ("broken", "images locales manquantes")):
        print("  %-24s : %d" % (label, totals.get(key, 0)))

    if leftovers:
        print("\n  URL externes restantes dans le HTML (%d site(s)) :" % len(leftovers))
        for slug, urls in list(leftovers.items())[:10]:
            print("   - %s : %s" % (slug, ", ".join(list(urls)[:4])))
    else:
        print("\n  Aucune URL externe restante dans les index.html ✔")

    out = os.path.join(LOCAL_DIR, "report-localize.json")
    if apply:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump({"sites": per_site, "totals": totals,
                       "leftovers": leftovers}, fh, ensure_ascii=False, indent=1)
        print("\n  Rapport écrit : _local/report-localize.json")
    print("")


if __name__ == "__main__":
    main()
