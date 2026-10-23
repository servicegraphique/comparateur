#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_standard/tools/apply-standard.py — Applique le standard Ubepro aux LP
=====================================================================

Porte le standard `recrutement_it_tech` (moteur de lead, CMP RGPD, Consent Mode
v2, GTM, SEO/GEO) sur les landing pages du dépôt.

    python3 _standard/tools/apply-standard.py --dry-run     # aperçu
    python3 _standard/tools/apply-standard.py --apply       # applique

Périmètre : les pages qui contiennent un formulaire (`<form`), conformément au
choix retenu. Les mentions légales, politiques de confidentialité et pages de
remerciement ne sont pas modifiées.

Ce qui est appliqué à chaque page :

    1. `ubepro-lead.js`   + config JSON injectée   (moteur de lead standard)
    2. `ubepro-consent.js` + `ubepro-ui.css`       (CMP RGPD, isolée `.ubp-`)
    3. Consent Mode v2 + GTM `GTM-53SH7D7F` chargé seulement hors localhost
    4. JSON-LD `@graph` (Organization, WebSite, WebPage, BreadcrumbList, Service)
    5. CSP adaptée aux hôtes du standard (GTM, CRM, Apps Script)
    6. `robots.txt` (bots IA), `sitemap.xml`, `llms.txt`

`style.css` de chaque site n'est jamais touché.
"""

import argparse
import json
import os
import re
import shutil
import sys
import urllib.parse

LOCAL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(LOCAL_DIR)
SRC = os.path.join(ROOT, "_standard")

HEAD_MARK = "<!-- ubepro:head -->"
HEAD_END = "<!-- /ubepro:head -->"
BODY_MARK = "<!-- ubepro:body -->"
BODY_END = "<!-- /ubepro:body -->"
GTM_ID = "GTM-53SH7D7F"
ORG = {
    "name": "Ubepro",
    "legalName": "Hellodevis SAS",
    "street": "5 avenue de la République",
    "postal": "75011",
    "city": "Paris",
    "country": "FR",
}

CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com "
    "https://www.google-analytics.com https://www.googleadservices.com https://googleads.g.doubleclick.net; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob: https://www.googletagmanager.com https://www.google-analytics.com "
    "https://stats.g.doubleclick.net https://www.google.com https://www.google.fr; "
    "font-src 'self' data:; "
    "media-src 'self' data: blob:; "
    "connect-src 'self' https://mc.hellolead.pro https://script.google.com https://script.googleusercontent.com "
    "https://www.googletagmanager.com https://www.google-analytics.com "
    "https://analytics.google.com https://region1.google-analytics.com "
    "https://stats.g.doubleclick.net https://googleads.g.doubleclick.net; "
    "frame-src 'self' https://www.googletagmanager.com https://www.youtube.com https://www.youtube-nocookie.com; "
    "form-action 'self'; base-uri 'self'"
)

CONSENT_DEFAULT = """<script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('consent', 'default', {
      'ad_storage': 'denied',
      'analytics_storage': 'denied',
      'ad_user_data': 'denied',
      'ad_personalization': 'denied',
      'security_storage': 'granted',
      'wait_for_update': 500
    });
  </script>"""

LOCAL_FLAG = """<script>
    // Détection du mode local : aucun script tiers n'est chargé hors production.
    // Hôtes de test : localhost, sous-domaines .local, sandbox de prévisualisation
    // (e2b.app, arena.site) et tout hôte non-production explicitement marqué.
    window.__UBEPRO_LOCAL__ = /^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|::1|\\[::1\\])$/i.test(location.hostname)
      || /\\.(localhost|local|test|e2b\\.app|arena\\.site)$/i.test(location.hostname)
      || /^sbx-/i.test(location.hostname)
      || /[?&]ubepro_local=1\\b/.test(location.search);
  </script>"""

GTM_SNIPPET = """<script>
    if (!window.__UBEPRO_LOCAL__) {
      (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
      new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
      j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
      'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
      })(window,document,'script','dataLayer','%s');
    }
  </script>""" % GTM_ID

GTM_NOSCRIPT = """<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=%s"
    height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>""" % GTM_ID

FORM_ID_BASE = "ADW_LP_"

# Empreinte des fichiers du socle : ajoutée en query string sur les balises
# injectées, pour qu'un navigateur ne puisse jamais servir une version périmée.
def asset_version():
    import hashlib
    digest = hashlib.md5()
    for name in ("ubepro-lead.js", "ubepro-consent.js", "ubepro-ui.css"):
        path = os.path.join(SRC, name)
        if os.path.isfile(path):
            with open(path, "rb") as fh:
                digest.update(fh.read())
    return digest.hexdigest()[:8]


ASSET_V = asset_version()


# --------------------------------------------------------------------------- #
# Découverte des sites
# --------------------------------------------------------------------------- #
def discover():
    sites = []
    for name in sorted(os.listdir(ROOT)):
        folder = os.path.join(ROOT, name)
        if name.startswith(("_", ".")) or not os.path.isdir(folder):
            continue
        index = os.path.join(folder, "index.html")
        if not os.path.isfile(index):
            continue
        html = read(index)
        if "<form" not in html:
            continue                      # périmètre : pages avec formulaire
        sites.append(name)
    return sites


def read(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        return fh.read()


def write(path, content):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


# --------------------------------------------------------------------------- #
# Métadonnées d'une page
# --------------------------------------------------------------------------- #
def meta_of(html):
    def grab(pattern, default=""):
        match = re.search(pattern, html, re.I | re.S)
        return re.sub(r"\s+", " ", match.group(1)).strip() if match else default

    title = grab(r"<title[^>]*>(.*?)</title>")
    description = grab(r'<meta[^>]+name="description"[^>]+content="([^"]*)"')
    h1 = grab(r"<h1[^>]*>(.*?)</h1>")
    lang = grab(r'<html[^>]+lang="([^"]*)"', "fr")
    h1 = re.sub(r"<[^>]+>", "", h1)
    return {
        "title": re.sub(r"<[^>]+>", "", title),
        "description": description,
        "h1": re.sub(r"\s+", " ", h1).strip(),
        "lang": "fr" if lang.lower().startswith("fr") else lang,
    }


def faq_pairs(html):
    """Extrait les paires Q/R des <details><summary>…</summary><p>…</p></details>."""
    pairs = []
    for block in re.findall(r"<details[^>]*>(.*?)</details>", html, re.I | re.S):
        q = re.search(r"<summary[^>]*>(.*?)</summary>", block, re.I | re.S)
        answers = re.findall(r"<p[^>]*>(.*?)</p>", block, re.I | re.S)
        if not q or not answers:
            continue
        clean = lambda t: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", t)).strip()
        question, answer = clean(q.group(1)), clean(" ".join(answers))
        if question and answer and len(answer) > 30:
            pairs.append((question, answer))
    return pairs[:10]


def jsonld(meta, cfg, html):
    base = cfg["base_url"]
    url = cfg["canonical"]
    name = meta["title"] or cfg["slug"]
    desc = meta["description"] or meta["h1"] or name

    graph = [
        {
            "@type": "Organization",
            "@id": f"{base}/#organization",
            "name": ORG["name"],
            "legalName": ORG["legalName"],
            "url": base,
            "address": {
                "@type": "PostalAddress",
                "streetAddress": ORG["street"],
                "addressLocality": ORG["city"],
                "postalCode": ORG["postal"],
                "addressCountry": ORG["country"],
            },
        },
        {
            "@type": "WebSite",
            "@id": f"{base}/#website",
            "url": base,
            "name": ORG["name"],
            "publisher": {"@id": f"{base}/#organization"},
            "inLanguage": "fr-FR",
        },
        {
            "@type": "WebPage",
            "@id": f"{url}#webpage",
            "url": url,
            "name": name,
            "description": desc,
            "isPartOf": {"@id": f"{base}/#website"},
            "about": {"@id": f"{base}/#organization"},
            "inLanguage": "fr-FR",
        },
        {
            "@type": "BreadcrumbList",
            "@id": f"{url}#breadcrumb",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Accueil", "item": f"{base}/"},
                {"@type": "ListItem", "position": 2, "name": meta["h1"] or name, "item": url},
            ],
        },
        {
            "@type": "Service",
            "@id": f"{url}#service",
            "name": meta["h1"] or name,
            "description": desc,
            "provider": {"@id": f"{base}/#organization"},
            "areaServed": {"@type": "Country", "name": "France"},
            "url": url,
            "serviceType": meta["h1"] or name,
        },
    ]

    pairs = faq_pairs(html)
    if pairs:
        graph.append({
            "@type": "FAQPage",
            "@id": f"{url}#faq",
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": q,
                    "acceptedAnswer": {"@type": "Answer", "text": a},
                }
                for q, a in pairs
            ],
        })

    payload = {"@context": "https://schema.org", "@graph": graph}
    return ('<script type="application/ld+json">\n'
            + json.dumps(payload, ensure_ascii=False, indent=2)
            + "\n  </script>")


def head_block(meta, cfg, html):
    return "\n  ".join([
        HEAD_MARK,
        LOCAL_FLAG,
        CONSENT_DEFAULT,
        GTM_SNIPPET,
        f'<meta http-equiv="Content-Security-Policy" content="{CSP}">',
        jsonld(meta, cfg, html),
        '<link rel="stylesheet" href="ubepro-ui.css?v=%s">' % ASSET_V,
        HEAD_END,
    ])


def body_block(cfg):
    config = {
        "formId": cfg["formId"],
        "domaine": cfg["domaine"],
        "leadApiUrl": cfg["leadApiUrl"],
        "leadApiMode": "nocors",
        "googleScriptUrl": cfg["googleScriptUrl"],
        "privacyUrl": cfg["privacyUrl"],
        "legalUrl": cfg["legalUrl"],
    }
    return "\n  ".join([
        BODY_MARK,
        f"<script>window.UBEPRO_STANDARD = {json.dumps(config, ensure_ascii=False)};</script>",
        GTM_NOSCRIPT,
        '<script src="ubepro-consent.js?v=%s" defer></script>' % ASSET_V,
        '<script src="ubepro-lead.js?v=%s" defer></script>' % ASSET_V,
        BODY_END,
    ])


# --------------------------------------------------------------------------- #
# Injection
# --------------------------------------------------------------------------- #
def strip_previous(html):
    """Retire une injection précédente, sans jamais toucher au contenu de la page.

    Les blocs sont délimités par des marqueurs de début ET de fin. Si le
    marqueur de fin manque (injection d'une version antérieure), on se rabat
    sur la dernière balise connue du bloc — jamais au-delà de `</head>`.
    """
    # Blocs marqués (forme normale) — on retire aussi l'indentation laissée
    # par l'insertion, pour que deux passages produisent un fichier identique.
    html = re.sub(r"\n[ \t]*" + re.escape(HEAD_MARK) + r".*?" + re.escape(HEAD_END) + r"[ \t]*",
                  "", html, flags=re.S)
    html = re.sub(r"\n[ \t]*" + re.escape(BODY_MARK) + r".*?" + re.escape(BODY_END) + r"[ \t]*",
                  "", html, flags=re.S)

    # Blocs d'une version antérieure, sans marqueur de fin : on s'arrête sur la
    # dernière balise injectée, jamais sur `</head>`.
    html = re.sub(re.escape(HEAD_MARK) + r".*?<link rel=\"stylesheet\" href=\"ubepro-ui\.css(\?[^\"]*)?\">", "", html, flags=re.S)
    html = re.sub(re.escape(BODY_MARK) + r".*?<script src=\"ubepro-lead\.js(\?[^\"]*)?\" defer></script>", "", html, flags=re.S)

    # Résidus éventuels (marqueur seul, orphelin)
    for marker in (HEAD_MARK, HEAD_END, BODY_MARK, BODY_END):
        html = html.replace(marker, "")

    # Ancienne CSP posée par _local/tools/localize.py
    html = re.sub(r'\n?\s*<!-- _local:csp -->\s*\n?\s*<meta http-equiv="Content-Security-Policy"[^>]*>', "", html)

    # GTM historique de la page (le standard le réinjecte, conditionné au mode local)
    html = re.sub(r"\n?\s*<!--\s*/?\s*(?:End\s+)?Google Tag Manager\s*-->\s*\n?", "\n", html, flags=re.I)
    html = re.sub(r'\s*<script[^>]*>(?:(?!</script>).)*?googletagmanager\.com/gtm\.js(?:(?!</script>).)*?</script>',
                  "", html, flags=re.S)
    html = re.sub(r'\s*<script[^>]+src="[^"]*googletagmanager[^"]*"[^>]*>\s*</script>', "", html)
    html = re.sub(r'\s*<noscript[^>]*>(?:(?!</noscript>).)*googletagmanager(?:(?!</noscript>).)*</noscript>', "", html,
                  flags=re.S)
    html = re.sub(r'\s*<iframe[^>]+src="[^"]*googletagmanager[^"]*"[^>]*>\s*</iframe>', "", html)
    return html


CRITICAL_PATTERNS = (
    ("<title", "<title"),
    ("viewport", 'name="viewport"'),
    ("feuille de style", 'href="style.css"'),
)


class StandardError(RuntimeError):
    pass


def _fingerprint(html):
    """Empreinte du contenu de la page, injections retirées et blancs normalisés."""
    stripped = strip_previous(html)
    stripped = re.sub(r'(<html[^>]*\blang=")[^"]*(")', r"\1fr\2", stripped, count=1, flags=re.I)
    return re.sub(r"\s+", " ", stripped).strip()


def assert_no_content_lost(slug, original, candidate):
    """Garde-fou : l'injection ne doit retirer AUCUN contenu de la page."""
    for label, pattern in CRITICAL_PATTERNS:
        if pattern in original and pattern not in candidate:
            raise StandardError(f"{slug} : {label} perdue ({pattern})")

    if _fingerprint(original) != _fingerprint(candidate):
        raise StandardError(f"{slug} : le contenu de la page serait modifié hors blocs standard")


def apply_page(slug, html, cfg):
    original = html
    html = strip_previous(html)
    meta = meta_of(html)
    # Standard : pages françaises déclarées comme telles (aucun impact visuel).
    html = re.sub(r'(<html[^>]*\blang=")[^"]*(")', r"\1fr\2", html, count=1, flags=re.I)
    meta["lang"] = "fr"

    head = head_block(meta, cfg, html)
    charset = re.search(r"<meta[^>]+charset=[^>]*>", html, re.I)
    if charset:
        html = html[:charset.end()] + "\n  " + head + html[charset.end():]
    else:
        html = re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + "\n  " + head, html, count=1, flags=re.I)

    body = body_block(cfg)
    if "</body>" in html:
        html = html.replace("</body>", "  " + body + "\n</body>", 1)
    else:
        html += "\n" + body

    assert_no_content_lost(slug, original, html)
    return html, meta


# --------------------------------------------------------------------------- #
# Fichiers SEO / GEO
# --------------------------------------------------------------------------- #
def robots_txt(cfg):
    return f"""# robots.txt — {cfg['slug']}
# URL canonique : {cfg['canonical']}

User-agent: *
Allow: /

# Moteurs IA & agents conversationnels (GEO)
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

Sitemap: {cfg['base_url']}/{cfg['slug']}/sitemap.xml
"""


def sitemap_xml(cfg, meta):
    image = ""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"{image}>
  <url>
    <loc>{cfg['canonical']}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
</urlset>
"""


def llms_txt(cfg, meta, html):
    headings = [re.sub(r"<[^>]+>", "", h).strip()
                for h in re.findall(r"<h2[^>]*>(.*?)</h2>", html, re.I | re.S)]
    headings = [re.sub(r"\s+", " ", h) for h in headings if h][:12]
    faq = faq_pairs(html)
    lines = [
        f"# {meta['title'] or cfg['slug']}",
        "",
        f"> {meta['description'] or meta['h1']}",
        f"> URL canonique : {cfg['canonical']}",
        f"> Éditeur : {ORG['legalName']} (marque {ORG['name']}) — {ORG['city']}, France.",
        "",
        "## En bref",
        "",
    ]
    if meta["h1"]:
        lines.append(f"- {meta['h1']}")
    lines.append("- Formulaire de demande en ligne, réponse sous 24 h ouvrées.")
    lines.append("- Traitement conforme RGPD (Google Consent Mode v2 + CMP intégrée).")
    lines.append("")
    if headings:
        lines += ["## Sections de la page", ""]
        lines += [f"- {h}" for h in headings]
        lines.append("")
    if faq:
        lines += ["## Questions fréquentes", ""]
        for q, a in faq:
            lines += [f"### {q}", "", a, ""]
    lines += [
        "## Éditeur",
        "",
        f"- {ORG['name']} — {ORG['legalName']}, {ORG['street']}, {ORG['postal']} {ORG['city']}.",
        f"- Contact : {cfg['canonical']}",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def build_config(slug):
    base = "https://www.comparateurpro.fr"
    return {
        "slug": slug,
        "formId": FORM_ID_BASE + re.sub(r"[^A-Z0-9]+", "_", slug.upper()).strip("_"),
        "domaine": "comparateurpro.fr",
        "leadApiUrl": "https://mc.hellolead.pro/mon_compte/api/webflow/get_information.php",
        "googleScriptUrl": "https://script.google.com/macros/s/AKfycbwrbyCb9-cAmIRPGNvnb-aM-CkhQAerrkfP3_HSw-ewmThxsn4vbZt5daaq2aOnL01a1w/exec",
        "base_url": base,
        "canonical": f"{base}/{slug}/",
        "privacyUrl": "/politique-de-confidentialite-donnees-personnelles/",
        "legalUrl": "/mentions-legales/",
    }


def main():
    ap = argparse.ArgumentParser(description="Applique le standard Ubepro aux LP")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", nargs="*", help="limiter à certains slugs")
    args = ap.parse_args()
    apply = args.apply and not args.dry_run

    sites = discover()
    if args.only:
        sites = [s for s in sites if s in args.only]

    report = {}
    for slug in sites:
        cfg = build_config(slug)
        index = os.path.join(ROOT, slug, "index.html")
        html = read(index)
        try:
            new_html, meta = apply_page(slug, html, cfg)
        except StandardError as exc:
            report[slug] = {"formId": cfg["formId"], "error": str(exc), "html_changed": False}
            print("  ✘ %s" % exc, file=sys.stderr)
            continue
        report[slug] = {"formId": cfg["formId"], "html_changed": new_html != html}

        if apply:
            write(index, new_html)
            for name in ("ubepro-lead.js", "ubepro-consent.js", "ubepro-ui.css"):
                shutil.copyfile(os.path.join(SRC, name), os.path.join(ROOT, slug, name))
            write(os.path.join(ROOT, slug, "robots.txt"), robots_txt(cfg))
            write(os.path.join(ROOT, slug, "sitemap.xml"), sitemap_xml(cfg, meta))
            write(os.path.join(ROOT, slug, "llms.txt"), llms_txt(cfg, meta, new_html))

    changed = sum(1 for v in report.values() if v["html_changed"])
    failed = [k for k, v in report.items() if v.get("error")]
    print("")
    print("  standard Ubepro — %s" % ("APPLIQUÉ" if apply else "APERÇU (aucune écriture)"))
    print("  " + "-" * 58)
    print("  Pages avec formulaire     : %d" % len(sites))
    print("  Pages modifiées           : %d" % changed)
    if failed:
        print("  Pages EN ÉCHEC (non écrites) : %d" % len(failed))
    for name, label in (
        ("ubepro-lead.js", "moteur de lead"),
        ("ubepro-consent.js", "CMP RGPD"),
        ("ubepro-ui.css", "UI isolée"),
    ):
        print("  %-25s : %s" % (label, "copié" if apply else "sera copié"))

    if apply:
        out = os.path.join(SRC, "sites.json")
        write(out, json.dumps({s: build_config(s) for s in sites}, ensure_ascii=False, indent=1))
        print("\n  Configuration écrite : _standard/sites.json")
    print("")


if __name__ == "__main__":
    main()
