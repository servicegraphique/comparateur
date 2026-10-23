# Test local des LP — dépendances externes supprimées

> Objectif : faire tourner les **131 landing pages** en local, avec des
> fonctionnalités **réellement utilisables**, sans aucune requête vers
> l'extérieur — **sans toucher au design ni au CSS**.

---

## 1. Démarrage rapide

```bash
python3 _local/server.py            # http://localhost:8080
# ou
./tester-local.sh                   # idem
```

| URL | Contenu |
|---|---|
| `http://localhost:8080/` | index des 131 sites (recherche) |
| `http://localhost:8080/<slug>/` | une landing page |
| `http://<slug>.localhost:8080/` | même page en mode sous-domaine (logique d'origine) |
| `http://localhost:8080/_local/leads` | leads capturés |
| `http://localhost:8080/_local/api/health` | état du serveur |

**Code SMS en local : `123456`** (n'importe quel numéro de test).

Les pages fonctionnent aussi avec un simple serveur statique
(`python3 -m http.server 8080` à la racine) : les formulaires s'affichent
alors comme validés et les leads sont stockés dans le `localStorage`
(clé `__local_leads`) au lieu d'être écrits sur disque.

---

## 2. Ce qui a été supprimé

| Dépendance externe | Volume | Traitement |
|---|---|---|
| `googletagmanager.com` (GTM) | 34 pages | scripts + `noscript/iframe` retirés ; le `dataLayer` et le `gtag('consent')` inline sont conservés et journalisés en console |
| `webflow.com/api/v1/form/<site>` + `formdata.webflow.com` | toutes les pages | remplacés par `/_local/api/lead` |
| `mc.hellolead.pro/.../envoi_code_verification.php` | 260 appels | remplacé par le simulateur OTP local (code `123456`) |
| `mc.hellolead.pro/.../get_information.php` | 1 page | remplacé par `/_local/api/lead` |
| `script.google.com/macros/...` (Apps Script) | 1 page | remplacé par `/_local/api/lead` |
| `use.typekit.net` | webfont loader | neutralisé (les polices sont déjà locales) |
| `challenges.cloudflare.com` (Turnstile) | module Webflow | jamais chargé (aucune page n'a de `data-turnstile-sitekey`) |
| `d3e54v103j8qbb.cloudfront.net` (badge Webflow) | toutes les pages | badge retiré du DOM |
| `videsigns-staging.co.uk/counter` | 132 | neutralisé (`/_local/api/mock`) |
| `fonts.googleapis.com` | injecté à l'exécution par le webfont loader | bloqué par le garde-fou réseau + CSP |
| `youtube.com/embed` | 1 page | remplacé par `/_local/embed-video.html` (même bloc, même format) |
| `cdn.prod.website-files.com` (image de fond CSS) | 2 pages | déclaration CSS déjà invalide (export cassé) ; bloquée par la CSP, **`style.css` non modifié** |
| liens `hellolead.pro`, `edenred.fr`, `ubepro.fr`, `nissan.fr`, `cnil.fr`… | 286 | pages légales locales quand elles existent, sinon `/_local/external.html` |
| `data-redirect="https://www.comparateurpro.fr/…"` | 17 | convertis en chemins locaux (`/edenred-typ/`, `/mercedes-vous-remercie/`…) |
| `data-video-urls="https://uploads-ssl.webflow.com/…"` | 4 pages | remplacés par les vidéos déjà présentes dans `videos/` |
| `canonical`, `og:image`, `prefetch` | 131 / 151 | rendus locaux ou retirés |

---

## 3. Ce qui a été ajouté pour que les fonctionnalités marchent

### `_local/runtime.js` — injecté dans les 131 pages

Chargé avant `</body>`, il rétablit les comportements perdus :

1. **Formulaires** — le handler Webflow d'origine (qui visait son API) est
   retiré et remplacé : chaque soumission est envoyée à `/_local/api/lead`,
   puis l'interface native est rejouée (`.w-form-done` / `.w-form-fail`,
   bouton désactivé + `data-wait`, `data-redirect`).
2. **SMS** — les appels `$.ajax` vers l'ancienne API sont interceptés :
   envoi simulé, code `123456`, validation et messages d'erreur locaux.
3. **Garde-fou réseau** — `XMLHttpRequest`, `fetch`, `sendBeacon` et toute
   balise injectée vers un domaine externe sont réécrits vers un mock local
   (ou supprimés). Rien ne sort de la machine.
4. **Liens & iframes** — toute URL externe résiduelle est renvoyée vers la
   page locale correspondante.
5. **`dataLayer`** — conservé et tracé (console + `_local/api/log`).

### `_local/server.py` — serveur de test (Python standard, zéro dépendance)

- sert les 131 sites, en mode **chemin** (`/<slug>/`) ou **sous-domaine**
  (`<slug>.localhost`) ;
- `POST /_local/api/lead` → écrit `_local/leads/leads.jsonl` (1 lead/ligne) ;
- `POST /_local/api/sheet` → simule Google Apps Script, répond `{"status":"ok"}`
  et écrit `_local/leads/sheets.jsonl` (le standard envoie **deux fois** : CRM + Sheet) ;
- `POST /_local/api/otp` → simulateur SMS (état par numéro) ;
- `POST /_local/api/log` → journal des événements ;
- `GET /_local/api/leads` + `/_local/leads` → consultation des leads.

### `_standard/` — standard de production (moteur de lead + CMP + SEO)

Depuis la mise au niveau `recrutement_it_tech`, **110 pages** (toutes celles qui
portent un formulaire) reçoivent une couche applicative autonome, sans toucher
au design :

| Fichier (copié dans chaque site) | Rôle |
|---|---|
| `ubepro-lead.js` | moteur de lead : validation tél/CP, double envoi **CRM + Sheet**, `dataLayer` `formulaire_lead` |
| `ubepro-consent.js` | CMP RGPD (bannière + modale), cookie 180 j, Consent Mode v2 |
| `ubepro-ui.css` | styles de la CMP, **préfixés `.ubp-`** (aucun impact sur `style.css`) |
| `robots.txt`, `sitemap.xml`, `llms.txt` | SEO/GEO par site |

Les pages sans formulaire (mentions légales, politique de confidentialité,
pages de remerciement) ne sont **pas** modifiées. Voir `_standard/README.md`.

En local, le runtime redirige les deux endpoints de production vers
`/_local/api/lead` et `/_local/api/sheet` : le parcours complet (validation,
double envoi, événement GTM) est testable hors ligne.

### Mode « test réel » : envoyer de vrais leads au CRM

Par défaut, le runtime redirige les envois vers le mock local. Pour un test
bout en bout **réel** (CRM Hellolead + Google Sheet de production), ajouter le
paramètre :

```
http://localhost:8080/<slug>/?ubepro_prod=1
```

Le drapeau est mémorisé en `sessionStorage` (le paramètre disparaît au premier
changement de page). Pour revenir au mock : `?ubepro_prod=0`.

Ce que le mode change — et **uniquement** cela :

| | Mode normal | `?ubepro_prod=1` |
|---|---|---|
| CRM `mc.hellolead.pro` | mock `/_local/api/lead` | **production, écriture réelle** |
| Google Apps Script | mock `/_local/api/sheet` | **production, écriture réelle** |
| GTM / pubs / traceurs | neutralisés | neutralisés (inchangé) |
| OTP | simulé (`123456`) | inchangé |

⚠️ Un lead envoyé en mode réel **pollue le CRM de production**. Utiliser des
coordonnées de test identifiables (`Test`, prénom `Arena`, `test.arena@example.com`).
Le runtime l'annonce dans la console :
`runtime actif — … — ⚠ MODE TEST RÉEL : les leads partent vers la PRODUCTION`.

### CSP locale sur chaque page

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; …">
```

Filet de sécurité **au niveau navigateur** : même un script tiers qui tenterait
une requête distante est bloqué avant le départ. C'est ce qui protège des
injections dynamiques (webfont loader, badge, pixels).

---

## 4. Ce qui n'a **pas** été modifié

- **`style.css`** : aucune ligne touchée, sur aucun site.
- **Le HTML de contenu** : aucune classe, aucun texte, aucune structure
  modifiée — seules des balises `<script>`, `<link>`, `<iframe>` externes,
  des attributs d'URL et l'ajout du runtime/CSP ont changé.
- **`script.js`** : laissé strictement intact (voir plus bas).
- Images, polices, vidéos : inchangées.

### Pourquoi `script.js` n'est pas édité

Il pèse **1,4 Mo × 131 = 186 Mo**. Le réécrire pour y remplacer 6 URLs
coûterait 186 Mo de diff sans gain fonctionnel : le runtime intercepte les
appels **au niveau réseau**, ce qui couvre aussi les URLs construites
dynamiquement. Vérification statique : `python3 _local/tools/audit.py`.

---

## 5. Vérifier / refaire

```bash
python3 _local/tools/audit.py              # 0 URL externe fonctionnelle ?
python3 _local/tools/localize.py --dry-run # aperçu des réécritures
python3 _local/tools/localize.py --apply   # (ré)applique, idempotent
```

`localize.py` est **idempotent** : relançable après un nouvel export Webflow.

---

## 6. Parcours de test conseillé

1. `http://localhost:8080/` → choisir un site (ex. `assurance-tns`).
2. Remplir le formulaire multi-étapes jusqu'au bout.
   - Téléphone : `0612345678`, cliquer « Vérifier » → **code `123456`**.
3. Valider → le bloc de confirmation s'affiche (ou redirection locale).
4. `http://localhost:8080/_local/leads` → le lead apparaît avec
   ses 40+ champs.
5. Console navigateur : tous les événements sont préfixés `[local:<slug>]`.

---

## 7. Limites connues

- `assurance-estheticiennes-institut-beaute` embarque une intégration
  Formly sur-mesure (pont `postMessage` vers `comparateurpro.fr`) ; ses
  endpoints sont locaux, mais son parcours doit être validé à la main.
- La vidéo YouTube est remplacée par un bloc d'information (pas de lecteur).
- Les mentions d'URL externes dans le **texte** des pages légales
  (`cnil.fr`, `bloctel.gouv.fr`…) restent affichées : ce sont des citations,
  pas des dépendances. Leurs liens pointent vers `/_local/external.html`.
- Le mode sous-domaine (`<slug>.localhost`) nécessite que la résolution
  `*.localhost` fonctionne (cas sur macOS/Linux/Chrome) ; sinon utiliser le
  mode chemin.
