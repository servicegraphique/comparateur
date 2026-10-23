# Analyse rapide du dépôt — comparateurpro

> Audit statique réalisé le 2026-10-23, avant toute modification.
> Périmètre : l'intégralité du dépôt (hors `.git`).

---

## 1. Vue d'ensemble

| Indicateur | Valeur |
|---|---|
| Dossiers de sites à la racine | **131** (chacun avec un `index.html`) |
| Fichiers versionnés | **7 488** |
| Poids des fichiers | **944 Mo** (dont `.git` : 158 Mo) |
| Poids des fichiers **uniques** (hash MD5) | **226 Mo** |
| Duplication | **≈ 76 %** du poids (≈ 718 Mo de copies) |
| Noms de fichiers distincts | 935 |
| Fichiers HTML uniques (hash) | **131 / 131** (aucune page strictement identique) |
| Feuilles de style uniques | 126 / 131 |
| Scripts uniques | **30 / 131** (le même bundle est recopié partout) |
| `.gitignore` / Git LFS | **aucun** |

### Répartition du poids

| Type | Poids |
|---|---|
| Images (`img/`) | 541,8 Mo |
| JavaScript | 186,5 Mo (moyenne **1,46 Mo / site**) |
| Polices | 140,8 Mo |
| Vidéos (4 sites seulement : canal, lexus-lbx-2, nissan-juke, volvo) | 52,8 Mo |
| CSS | 19,7 Mo (moyenne 154 Ko) |
| HTML | 2,3 Mo (moyenne 17 Ko, max 68 Ko) |

### Extensions

`svg 1871 · jpg 1770 · png 1653 · ttf 942 · webp 239 · avif 145 · md 133 · txt 132 · xml 131 · js 131 · html 131 · css 131 · otf 34 · woff2 19 · mp4 4 · webm 4`

---

## 2. Anatomie d'un site (le motif est strictement le même partout)

```
<slug>/
├── index.html          page unique, export Webflow "full page"
├── style.css           CSS Webflow aplati + polices locales
├── script.js           jQuery 3.5.1 + webflow.js + Formly + scripts métier  (~1,4 Mo)
├── img/                images de la page + images du template (webp/svg/avif…)
├── fonts/              polices locales (.ttf/.woff2)
├── videos/             seulement 4 sites
├── robots.txt / sitemap.xml
└── rapport-site.md     rapport de conversion généré par le pipeline
```

Documents d'accompagnement à la racine :

- `SYNTHESE.md` — bilan du batch **lp2site.py --all** : 131 pages converties, 0 échec, 991,8 Mo générés, domaine cible `https://{slug}.lp.comparateurpro.fr`. Classes d'origine : métier 54, typ 19, marque 22, thank-you 9, variante 27.
- `DIAGNOSTIC-SITES.md` — diagnostic du 2026-10-22 sur 12 sites (patch « Formly null », GTM, cookies, H1).
- `ordre-sites.txt` — l'ordre d'affichage/priorité des 131 sites.
- `tester-local.sh` / `.bat` — simple `python3 -m http.server 8080` à la racine.

Toutes les pages sont des **pages statiques autonomes** : aucun `node_modules`, aucun framework, aucun build, aucune dépendance à un backend local. C'est un bon point de départ.

---

## 3. Ce qui fonctionne déjà en local

Test réel effectué (serveur `python3 -m http.server`) :

- `index.html`, `style.css`, `img/favicon.png` → **HTTP 200**.
- **2 657 références locales** (`src`/`href`/`srcset`) vérifiées → **2 cassées seulement** :
  - `lexus-lbx-2` → `../images/conso-1_1conso-1.png`
  - `typ-categ` → `images/2-1_12-1.png`
- **0 référence CSS** (`url(...)`) cassée sur les 131 sites.
- **0 chemin absolu** de type `/img/...` : tout est relatif, donc servi depuis un sous-dossier sans casse.
- Ressources tierces de rendu non locales : **0** Typekit, **0** Google Fonts, **0** Turnstile dans le HTML → l'apparence s'affiche hors ligne (polices rapatriées).

Conclusion : **le rendu visuel marche déjà en local**. Ce sont les **comportements dynamiques** qui bloquent.

---

## 4. Les vrais points de blocage pour un test local complet

Par ordre d'impact.

### 4.1 Envoi des formulaires → API Webflow (bloquant)

Le `webflow.js` embarqué poste les formulaires vers :

```
https://webflow.com/api/v1/form/<data-wf-site>      → redirigé vers https://formdata.webflow.com/...
```

Référence : `assurance-tns/script.js:2281` (`ajaxComplete` écoute les URLs `webflow.com/api/v1/form/`), et le bundle Webflow à la ligne 51.
Conséquence : **hors hébergement Webflow, aucun lead n'est enregistré**. 110 sites sur 131 contiennent un `<form>` (les 21 autres sont des thank-you / pages vitrines). Les formulaires sont en `method="get"` + gestion JS : pas de fallback natif.

### 4.2 OTP SMS / vérification téléphone (bloquant)

```js
// assurance-tns/script.js:4127
let domaine = window.location.hostname.split('.');
let emetteur = domaine[1];                 // → undefined sur localhost
$.ajax({ url: "https://mc.hellolead.pro/api/axialys/envoi_code_verification.php", ... })
```

- Sur `localhost` → `emetteur = undefined` → l'API refuse.
- Sur `127.0.0.1` → `emetteur = "0"` → faux émetteur.
- Le mécanisme dépend donc du **sous-domaine** (`<emetteur>.lp.comparateurpro.fr`).
- 260 occurrences de cet endpoint (2 par site) dans le dépôt.

### 4.3 Redirections construites à partir du domaine racine

```js
'redirect': window.location.protocol + '//' + window.location.hostname + '/' + valeur
```

Présent 130 fois. En local servi depuis un sous-dossier (`/mon-slug/`), la redirection `utm_typ` renvoie vers `http://localhost:8080/<valeur>` → **404**. À généraliser en chemin relatif.

### 4.4 Liens inter-sites en dur

- **131 liens** vers `https://{slug}.lp.comparateurpro.fr` (un par page, ex. `canonical` + liens croisés).
- **9 liens** vers `https://www.comparateurpro.fr`.
- **35 pages** embarquent une `<iframe>` externe (`www.ubepro.com/...`, plus les iframes GTM `ns.html`).

Sans fichier `hosts` ou réécriture d'URL, ces liens sortent du local.

### 4.5 Dépendances analytics / marketing tierces

- **GTM** : 34 pages seulement (27 × `GTM-53SH7D7F`, 33 × `GTM-WMVZJKS` cumulés) ; 97 pages sans GTM.
- `mc.hellolead.pro` (OTP + `get_information.php`), `www.hellolead.pro` (mentions légales, contact).
- **Beacon** `https://videsigns-staging.co.uk/counter` (Formly) — 132 occurrences.
- Formly (`videsigns`, code **obfusqué**) : multistep, `formlyLastStep`, `resetFormly`, `formly-support`… présent dans les 131 `script.js`, soit ~1,4 Mo de bundle quasi identique recopié 131 fois.
- `formdata.webflow.com`, `d3e54v103j8qbb.cloudfront.net` (badge Webflow), `use.typekit.net` (dans le JS).

### 4.6 Qualité / SEO (non bloquant, mais à traiter avant mise en ligne)

| Constat | Volume |
|---|---|
| `lang="en"` sur des pages françaises | **130 / 131** (1 seule en `fr`) |
| Pages sans aucun `<h1>` | **122 / 131** |
| Pages avec plusieurs `<h1>` (jusqu'à **9** : `assurance-tns`) | 9 |
| GTM absent | 97 / 131 |
| Bandeau cookies réel détecté | très minoritaire |
| `2 @font-face` cassées par site retirées lors de la conversion (repli système) | 130 × 2 |
| `meta description` générée automatiquement, à relire | 131 |

### 4.7 Images « présentes mais seulement citées par le CSS »

**3 839 fichiers, 476 Mo** ne sont référencés que dans `style.css` (reliques du template Webflow : photos Unsplash, illustrations d'états vides, etc.). Ce n'est pas forcément du mort — certaines classes sont utilisées — mais c'est le **gisement n°1 d'allègement** après déduplication. Top : `fiat-pro` 10,2 Mo, `solutions-cles` 8,7 Mo, `mitsubishi-fuso` 8,0 Mo.

### 4.8 Poids et versionnement

- `.git` = 158 Mo sans LFS ; 944 Mo de fichiers pour 226 Mo de contenu réel.
- Chaque site embarque sa copie de `script.js` (1,4 Mo) et des ~40 mêmes images → tout correctif doit être appliqué **131 fois** (c'est déjà ce que fait le pipeline, mais c'est fragile).
- Aucun `.gitignore` : attention aux artefacts à venir.

---

## 5. Synthèse en une phrase

> Le dépôt est un **export Webflow massif, déjà « dé-webflowisé » au niveau des assets** (CSS, polices, images, vidéos locales) : le rendu s'affiche donc correctement en local via un simple serveur statique. Ce qui ne marche pas localement, ce sont les **trois dépendances serveur** : l'**envoi des formulaires vers l'API Webflow**, l'**OTP SMS via `mc.hellolead.pro`** (qui dépend du sous-domaine) et les **redirections/liens construits sur `*.lp.comparateurpro.fr`**.

---

## 6. Ordre de travail proposé pour la suite

1. **Serveur local multi-sites** : un serveur qui route `http://<slug>.localhost:PORT/` (ou `/<slug>/`) vers le bon dossier, pour retrouver la logique de sous-domaine sur laquelle repose le JS.
2. **Couche de configuration locale** : externaliser dans un `config.js` (ou variables d'env injectées) les 4 points durs — endpoint formulaire, endpoint OTP, émetteur, base des redirections.
3. **Backend local de test** : un petit service (Node/PHP/Python) qui imite `webflow.com/api/v1/form/<site-id>` + `envoi_code_verification.php` (code OTP fixe, ex. `123456`) et logge les leads en JSON pour vérifier le parcours complet.
4. **Réécriture d'URL** : rendre relatifs les 131 `canonical`/liens croisés + la redirection `utm_typ`, avec un mapping slug → URL locale.
5. **QA fonctionnelle** : parcours des 110 formulaires (multistep, champs obligatoires, retour arrière), OTP, redirection thank-you, déclenchement `dataLayer`.
6. **Nettoyage optionnel** : déduplication des assets (lien symbolique ou dossier `_shared/`), purge des images CSS-only, correction `lang`/`h1`, poids du bundle JS.

---

_Document généré par analyse statique du dépôt ; aucune modification de code n'a été effectuée._
