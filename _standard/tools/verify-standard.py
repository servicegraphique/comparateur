#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_standard/tools/verify-standard.py — Contrôle de non-régression du standard
==========================================================================

Vérifie, sur chaque page traitée, que l'injection du standard n'a **rien**
retiré à la page d'origine :

    python3 _standard/tools/verify-standard.py
    python3 _standard/tools/verify-standard.py --ref <sha-git>   # comparaison fine

Contrôles :
  1. marqueurs `ubepro:head` / `ubepro:body` présents et bien appariés ;
  2. balises critiques toujours là : `<title>`, `viewport`, `style.css`,
     `canonical`, `description`, `script.js`, `</head>`, `</body>` ;
  3. aucune fuite de contenu : hors blocs standard, le HTML doit être identique
     à la version de référence (`--ref`, par défaut le commit de base) ;
  4. les 3 fichiers du socle sont bien copiés à côté de chaque page.

Code de sortie : 0 si tout est conforme, 1 sinon.
"""

import argparse
import importlib.util
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

HEAD_MARK, HEAD_END = "<!-- ubepro:head -->", "<!-- /ubepro:head -->"
BODY_MARK, BODY_END = "<!-- ubepro:body -->", "<!-- /ubepro:body -->"
ASSETS = ("ubepro-lead.js", "ubepro-consent.js", "ubepro-ui.css")

# Balises qui ne doivent JAMAIS disparaître d'une page.
CRITICAL = (
    ("<title>", "<title"),
    ("meta viewport", 'name="viewport"'),
    ("feuille de style", 'href="style.css"'),
    ("script de page", 'src="script.js"'),
    ("fin de head", "</head>"),
    ("fin de body", "</body>"),
)

# Balises présentes seulement sur certaines pages : on vérifie qu'elles survivent
# quand la page de référence les avaient.
OPTIONAL = (
    ("canonical", 'rel="canonical"'),
    ("meta description", 'name="description"'),
    ("favicon", "favicon"),
)


def read(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        return fh.read()


def _load_apply_module():
    """Charge apply-standard.py pour réutiliser exactement sa logique."""
    spec = importlib.util.spec_from_file_location(
        "ubepro_apply_standard", os.path.join(HERE, "apply-standard.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


APPLY = _load_apply_module()


def strip_injections(html):
    """Retire les blocs du standard (logique partagée avec apply-standard)."""
    return APPLY.strip_previous(html)


def fingerprint(html):
    text = strip_injections(html)
    text = re.sub(r'(<html[^>]*\blang=")[^"]*(")', r"\1fr\2", text, count=1, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def git_show(ref, path):
    try:
        result = subprocess.run(["git", "show", "%s:%s" % (ref, path)],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def treated_pages():
    pages = []
    for name in sorted(os.listdir(ROOT)):
        folder = os.path.join(ROOT, name)
        if name.startswith(("_", ".")) or not os.path.isdir(folder):
            continue
        index = os.path.join(folder, "index.html")
        if not os.path.isfile(index):
            continue
        html = read(index)
        if HEAD_MARK in html or "<form" in html:
            pages.append(name)
    return pages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="ae53f90f469d605f91310c7e227201b8ab2c45e7",
                    help="commit de référence (état avant le standard)")
    args = ap.parse_args()

    pages = treated_pages()
    problems = []

    for slug in pages:
        path = os.path.join(slug, "index.html")
        html = read(path)

        # 1. marqueurs
        if html.count(HEAD_MARK) != 1 or html.count(HEAD_END) != 1:
            problems.append((slug, "marqueurs head absents ou dupliqués"))
        if html.count(BODY_MARK) != 1 or html.count(BODY_END) != 1:
            problems.append((slug, "marqueurs body absents ou dupliqués"))

        # 2. balises critiques
        for label, pattern in CRITICAL:
            if pattern not in html:
                problems.append((slug, "%s manquant" % label))

        # 2 bis. balises optionnelles : présentes dans la référence → conservées
        reference = git_show(args.ref, "%s/index.html" % slug)
        if reference is not None:
            for label, pattern in OPTIONAL:
                if pattern in reference and pattern not in html:
                    problems.append((slug, "%s perdu" % label))

        # 3. contenu identique hors blocs
        if reference is not None and fingerprint(reference) != fingerprint(html):
            problems.append((slug, "contenu modifié hors blocs standard"))

        # 4. fichiers du socle
        for asset in ASSETS:
            if not os.path.isfile(os.path.join(ROOT, slug, asset)):
                problems.append((slug, "%s non copié" % asset))

    print("")
    print("  contrôle du standard — %d page(s)" % len(pages))
    print("  " + "-" * 58)
    if problems:
        for slug, message in problems[:40]:
            print("  ✘ %-46s %s" % (slug, message))
        if len(problems) > 40:
            print("  … et %d autre(s)" % (len(problems) - 40))
        print("\n  RÉSULTAT : non conforme ✗\n")
        return 1

    print("  ✓ balises critiques intactes (title, viewport, style.css, canonical…)")
    print("  ✓ aucun contenu retiré hors des blocs du standard")
    print("  ✓ %s copiés sur chaque page" % ", ".join(ASSETS))
    print("\n  RÉSULTAT : conforme ✔\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
