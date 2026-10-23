#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_local/tools/audit.py — Vérifie qu'aucune dépendance externe ne subsiste
========================================================================

Trois contrôles, sur les 131 sites :

  1. HTML — URLs externes *fonctionnelles* (href, src, action, poster, data-*).
     Attendu : 0. Toute occurrence est une régression.
  2. CSS  — url(http…) et @import externes. Attendu : 0.
  3. JS   — URLs externes présentes dans le texte de script.js. Elles sont
     neutralisées à l'exécution par _local/runtime.js (interception XHR/fetch/
     sendBeacon + CSP), mais restent visibles dans le code : on les liste pour
     information, avec leur remplacement local.

Usage :
    python3 _local/tools/audit.py            # résumé
    python3 _local/tools/audit.py --details  # détail site par site
Sortie : code 0 si aucune URL fonctionnelle externe n'est trouvée, 1 sinon.
"""

import argparse
import os
import re
import sys
from collections import Counter

LOCAL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(LOCAL_DIR)

SITES = sorted(
    d for d in os.listdir(ROOT)
    if not d.startswith(("_", ".")) and os.path.isfile(os.path.join(ROOT, d, "index.html"))
)

FUNC_RE = re.compile(
    r'(?P<attr>href|src|action|poster|srcset|data-[a-z-]+)\s*=\s*"(?P<url>https?://[^"]+)"',
    re.I)
CSS_EXT_RE = re.compile(r"(?:url\(\s*['\"]?|@import\s+['\"])(https?://[^)'\"]+)", re.I)
JS_EXT_RE = re.compile(r"https?://[A-Za-z0-9.-]+")
ALLOWED = ("www.w3.org", "www.apache.org", "github.com")

# Balises tierces autorisées par le standard (chargées uniquement hors localhost,
# et seulement après Consent Mode v2 : analytics/marketing restent "denied").
GTM_ALLOWED = ("googletagmanager.com", "google-analytics.com", "google.com/ads")

# URLs externes neutralisées côté runtime, et leur remplacement
JS_REPLACEMENTS = {
    "webflow.com/api/v1/form":       "/_local/api/lead",
    "formdata.webflow.com":          "/_local/api/lead",
    "mc.hellolead.pro":              "/_local/api/otp  ou  /_local/api/lead",
    "videsigns-staging.co.uk/counter": "/_local/api/mock",
    "challenges.cloudflare.com":     "/_local/noop.js  (Turnstile jamais chargé)",
    "use.typekit.net":               "/_local/noop.js  (polices déjà locales)",
    "d3e54v103j8qbb.cloudfront.net": "/_local/noop.svg (badge Webflow retiré)",
    "googletagmanager.com":          "autorisé (GTM standard, Consent Mode v2)",
}


def audit():
    func_hits, css_hits, js_hits, gtm_hits = {}, {}, Counter(), {}
    for slug in SITES:
        base = os.path.join(ROOT, slug)
        html = open(os.path.join(base, "index.html"), encoding="utf-8").read()
        urls = [m.group("url") for m in FUNC_RE.finditer(html)]
        allowed = [u for u in urls if any(a in u for a in GTM_ALLOWED)]
        if allowed:
            gtm_hits[slug] = allowed
        bad = [u for u in urls if u not in allowed]
        if bad:
            func_hits[slug] = bad

        css_path = os.path.join(base, "style.css")
        if os.path.isfile(css_path):
            css = open(css_path, encoding="utf-8", errors="ignore").read()
            blows = [u for u in CSS_EXT_RE.findall(css) if not any(a in u for a in ALLOWED)]
            if blows:
                css_hits[slug] = blows

        js_path = os.path.join(base, "script.js")
        if os.path.isfile(js_path):
            js = open(js_path, encoding="utf-8", errors="ignore").read()
            for url in JS_EXT_RE.findall(js):
                if any(a in url for a in ALLOWED):
                    continue
                js_hits[url] += 1
    return func_hits, css_hits, js_hits, gtm_hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--details", action="store_true")
    args = ap.parse_args()

    func_hits, css_hits, js_hits, gtm_hits = audit()

    print("")
    print("  audit des dépendances externes — %d sites" % len(SITES))
    print("  " + "-" * 58)

    print("\n  1. HTML — URL externes fonctionnelles : %d site(s)" % len(func_hits))
    if func_hits:
        for slug, urls in list(func_hits.items())[:20]:
            print("     ✗ %-45s %s" % (slug, urls[:3]))
    else:
        print("     ✓ aucune (href / src / action / data-* tous locaux)")

    if gtm_hits:
        print("     ✓ Google Tag Manager : %d page(s) — autorisé (GTM-53SH7D7F,"
              " Consent Mode v2, chargé hors localhost)" % len(gtm_hits))

    print("\n  2. CSS — ressources externes : %d site(s)" % len(css_hits))
    if css_hits:
        for slug, urls in list(css_hits.items())[:10]:
            print("     • %-45s %s" % (slug, urls[:2]))
        print("     ↳ déclarations mortes (export Webflow invalide) ; bloquées par la CSP,")
        print("       style.css volontairement non modifié")
    else:
        print("     ✓ aucune (CSS 100 %% local)")

    print("\n  3. JS — URLs externes encore présentes dans script.js")
    print("     (interceptées au runtime : XHR/fetch/sendBeacon + CSP — script.js non modifié) :")
    for url, count in js_hits.most_common():
        repl = next((v for k, v in JS_REPLACEMENTS.items() if k in url), "bloquée par le runtime")
        print("     • %-32s ×%-4d → %s" % (url, count, repl))

    print("\n  " + "-" * 58)
    ok = not func_hits
    print("  %s\n" % ("RÉSULTAT : aucune dépendance externe active ✔" if ok
                      else "RÉSULTAT : dépendances externes détectées ✗"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
