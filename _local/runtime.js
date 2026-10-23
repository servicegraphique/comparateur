/* =============================================================================
 * _local/runtime.js — Runtime de test local pour les LP ComparateurPro
 * -----------------------------------------------------------------------------
 * Objectif : rendre CHAQUE site autonome en local, sans aucune requête externe.
 *
 * Ce fichier est injecté dans chaque page (avant </body>, en `defer`) APRÈS
 * script.js. Il ne touche ni au HTML métier, ni au CSS, ni au design : il ne
 * fait que remplacer les comportements qui dépendaient d'un serveur distant.
 *
 * Ce qu'il fait :
 *   1. Neutralise toute requête sortante (XHR, fetch, sendBeacon, balises
 *      injectées) : rien ne quitte la machine.
 *   2. Re-implemente l'envoi de formulaire (Webflow -> API locale
 *      /_local/api/lead, avec repli localStorage si aucun serveur local).
 *   3. Re-implemente la vérification SMS (code local fixe : 123456).
 *   4. Re-localise les liens / redirections externes restants.
 *   5. Trace les événements dataLayer dans la console.
 *
 * Aucune dépendance. Aucun build. Compatible :
 *   - `_local/server.py`                 (recommandé : API + journal des leads)
 *   - `python3 -m http.server 8080`      (repli : tout fonctionne en mémoire)
 * ========================================================================== */
(function () {
  "use strict";

  if (window.__LOCAL_RUNTIME__) return;
  window.__LOCAL_RUNTIME__ = true;

  /* ---------------------------------------------------------------- config */
  var SCRIPT_EL = document.currentScript;
  var LOCAL_DIR = SCRIPT_EL && SCRIPT_EL.src
    ? SCRIPT_EL.src.replace(/runtime\.js(?:[?#].*)?$/, "")
    : "/_local/";

  var OTP_CODE = "123456";                 // code SMS simulé en local
  var LEAD_ENDPOINT = LOCAL_DIR + "api/lead";
  var OTP_ENDPOINT = LOCAL_DIR + "api/otp";
  var LOG_ENDPOINT = LOCAL_DIR + "api/log";
  var FAKE_REDIRECT_PAGE = LOCAL_DIR + "external.html";

  function detectSlug() {
    var parts = location.pathname.split("/").filter(Boolean);
    if (parts.length && parts[0].charAt(0) !== "_" && /^[A-Za-z0-9][\w.-]*$/.test(parts[0])) {
      return parts[0];
    }
    var host = location.hostname.split(".");
    if (host.length > 1 && host[0] !== "www" && host[0] !== "localhost" && !/^\d+$/.test(host[0])) {
      return host[0];
    }
    return "local";
  }

  /* ------------------------------------------------------------------ mode test réel
     ?ubepro_prod=1  → les endpoints de LEAD ne sont plus redirigés vers le mock :
     le navigateur envoie réellement au CRM Hellolead et à Google Apps Script.
     Tout le reste (GTM, pubs, traceurs) reste neutralisé.
     Le drapeau est mémorisé en sessionStorage car le paramètre disparaît au
     premier changement de page. */
  var PROD_MODE = (function () {
    try {
      var m = /[?&]ubepro_prod=([^&]*)/.exec(location.search);
      if (m) {
        if (m[1] === "0") { sessionStorage.removeItem("ubepro_prod"); return false; }
        sessionStorage.setItem("ubepro_prod", "1");
        return true;
      }
      return sessionStorage.getItem("ubepro_prod") === "1";
    } catch (e) { return false; }
  })();

  function isLeadEndpoint(url) {
    var u;
    try { u = new URL(url); } catch (e) { return false; }
    return /hellolead\.pro$/i.test(u.hostname)
      || (u.hostname === "script.google.com")
      || (/(^|\.)webflow\.com$/i.test(u.hostname) && /\/api\/v1\/form\//i.test(u.pathname))
      || /formdata\.webflow\.com$/i.test(u.hostname);
  }

  var SLUG = detectSlug();
  var API_OK = false;          // passe à true si le serveur local répond
  var leads = [];

  window.__LOCAL__ = {
    slug: SLUG,
    dir: LOCAL_DIR,
    prodMode: PROD_MODE,
    otpCode: OTP_CODE,
    get leads() { return leads; },
    available: function () { return API_OK; }
  };

  /* ------------------------------------------------------------------ utils */
  function log() {
    var args = Array.prototype.slice.call(arguments);
    try { console.log.apply(console, ["[local:" + SLUG + "]"].concat(args)); } catch (e) {}
  }

  function isExternal(url) {
    return /^https?:\/\//i.test(url) && url.indexOf(location.origin) !== 0;
  }

  function absolute(url) {
    try { return new URL(url, location.href).href; } catch (e) { return url; }
  }

  /* Mapping d'une URL externe connue vers un chemin local.
     (Les pages sont déjà réécrites à la conversion ; ceci est le filet de
     sécurité pour tout ce qui serait injecté dynamiquement.) */
  var HOST_ALIASES = {
    "www.hellolead.pro/mentions-legales": "/mentions-legales/",
    "www.hellolead.pro/politique-de-confidentialite-donnees-personnelles":
      "/politique-de-confidentialite-donnees-personnelles/",
    "www.ubepro.fr/mentions-legales": "/mentions-legales/",
    "www.ubepro.fr/politique-de-confidentialite-donnees-personnelles":
      "/politique-de-confidentialite-donnees-personnelles/"
  };

  function toLocal(url) {
    if (!url || !isExternal(url)) return null;
    // Mode test réel : les envois de lead partent vers la production.
    if (PROD_MODE && isLeadEndpoint(url)) return null;
    var u;
    try { u = new URL(url); } catch (e) { return null; }

    // endpoints applicatifs
    if (/hellolead\.pro$/i.test(u.hostname) || u.hostname === "script.google.com") {
      if (/envoi_code_verification/i.test(u.pathname)) return LOCAL_DIR + "api/otp";
      if (u.hostname === "script.google.com") return LOCAL_DIR + "api/sheet";
      if (/get_information|webflow/i.test(u.pathname)) return LOCAL_DIR + "api/lead";
    }
    // API de formulaires Webflow -> API locale
    if (/(^|\.)webflow\.com$/i.test(u.hostname) && /\/api\/v1\/form\//i.test(u.pathname)) {
      return LOCAL_DIR + "api/lead";
    }
    // ressources d'une LP : https://<slug>.lp…/img/x.jpg -> /img/x.jpg
    var lpHit = /^(.+)\.lp\.comparateurpro\.fr$/i.exec(u.hostname);
    if (lpHit && u.pathname && u.pathname !== "/") return u.pathname;

    var key = u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "");
    var hostKey = u.host + u.pathname.replace(/\/+$/, "");
    if (HOST_ALIASES[hostKey]) return HOST_ALIASES[hostKey];
    if (HOST_ALIASES[key]) return HOST_ALIASES[key];

    // https://<slug>.lp.comparateurpro.fr/  ->  /<slug>/
    var lp = /^(.+)\.lp\.comparateurpro\.fr$/i.exec(u.hostname);
    if (lp) return "/" + lp[1] + "/";

    // https://www.comparateurpro.fr/a/b  ->  /a-b/
    if (/comparateurpro\.fr$/i.test(u.hostname)) {
      var segs = u.pathname.split("/").filter(Boolean);
      if (segs.length) return "/" + segs.join("-") + "/";
      return "/" + SLUG + "/";
    }
    return null;
  }

  function externalPage(url) {
    return FAKE_REDIRECT_PAGE + "?to=" + encodeURIComponent(url);
  }

  /* ------------------------------------------------- réseau : garde-fou total */
  var XHR_OPEN = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof url === "string" && isExternal(absolute(url))) {
      var target = toLocal(url);
      log("requête externe bloquée →", url, target ? ("réécrite vers " + target) : "(ignorée)");
      if (!target) {
        // Requête purement externe (analytics, beacon…) : on la court-circuite.
        args[1] = LOCAL_DIR + "api/mock?ref=" + encodeURIComponent(url);
      } else {
        args[1] = target;
      }
    }
    return XHR_OPEN.apply(this, args);
  };

  if (window.fetch) {
    var NATIVE_FETCH = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url && isExternal(absolute(url))) {
        var repl = toLocal(url) || (LOCAL_DIR + "api/mock?ref=" + encodeURIComponent(url));
        log("fetch externe bloqué →", url, "→", repl);
        input = repl;
      }
      return NATIVE_FETCH.call(this, input, init);
    };
  }

  if (navigator.sendBeacon) {
    var NATIVE_BEACON = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (isExternal(absolute(url))) {
        var target = toLocal(url);
        if (target) {
          log("beacon externe redirigé →", url, "→", target);
          return NATIVE_BEACON(target, data);
        }
        log("beacon externe bloqué →", url);
        return true;
      }
      return NATIVE_BEACON(url, data);
    };
  }

  /* Toute balise injectée pointant vers l'extérieur est neutralisée. */
  function guardNode(node) {
    if (!node || node.nodeType !== 1) return;
    var tag = node.tagName;
    if (tag === "SCRIPT" || tag === "LINK" || tag === "IMG" || tag === "IFRAME" || tag === "SOURCE") {
      var url = node.getAttribute("src") || node.getAttribute("href");
      if (url && isExternal(absolute(url))) {
        if (tag === "SCRIPT" || tag === "IFRAME" || tag === "LINK") {
          log("balise externe supprimée :", tag, url);
          if (node.parentNode) node.parentNode.removeChild(node);
          return;
        }
        node.setAttribute("src", LOCAL_DIR + "noop.svg");
        log("image externe neutralisée :", url);
      }
    }
    // badge Webflow (widget tiers flottant)
    if (node.classList && node.classList.contains("w-webflow-badge")) {
      if (node.parentNode) node.parentNode.removeChild(node);
    }
  }

  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes || [], function (n) {
          guardNode(n);
          if (n && n.querySelectorAll) {
            Array.prototype.forEach.call(
              n.querySelectorAll("script,link,img,iframe,source,.w-webflow-badge"), guardNode);
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* --------------------------------------------------------- API locale / log */
  function postJSON(url, payload) {
    if (!window.fetch) return Promise.reject(new Error("no fetch"));
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json().catch(function () { return {}; });
    });
  }

  function logEvent(kind, payload) {
    payload = payload || {};
    payload.kind = kind;
    payload.slug = SLUG;
    payload.page = location.pathname;
    payload.ts = new Date().toISOString();
    postJSON(LOG_ENDPOINT, payload).catch(function () { /* serveur absent : sans effet */ });
  }

  /* ------------------------------------------------------ formulaire (lead) */
  function formToObject(form) {
    var out = {};
    var fd = new FormData(form);
    fd.forEach(function (value, key) {
      if (key === "__local_extra") return;
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        if (!Array.isArray(out[key])) out[key] = [out[key]];
        out[key].push(value);
      } else {
        out[key] = value;
      }
    });
    return out;
  }

  function submitLocal(form, $) {
    var $form = $(form);
    var $wrap = $form.closest(".w-form");
    var $btn = $form.find(':input[type="submit"]');
    var wait = $btn.attr("data-wait");
    var oldLabel = $btn.val();

    if (form.__localSubmitting) return;
    form.__localSubmitting = true;
    if ($btn.length) {
      $btn.prop("disabled", true);
      if (wait) $btn.val(wait);
    }

    var payload = formToObject(form);
    payload.__meta = {
      slug: SLUG,
      page: location.pathname,
      form: $form.attr("name") || $form.attr("data-name") || "",
      ts: new Date().toISOString(),
      referrer: document.referrer || ""
    };

    function done(ok, extra) {
      form.__localSubmitting = false;
      if ($btn.length) { $btn.prop("disabled", false); if (oldLabel) $btn.val(oldLabel); }
      $wrap.find("> .w-form-fail").toggle(!ok);
      if (!ok) { log("envoi du lead en échec", extra); return; }

      var redirect = $form.attr("data-redirect") || $form.attr("redirect");
      if (redirect) {
        var target = toLocal(redirect) || redirect;
        log("lead enregistré → redirection", target);
        setTimeout(function () { location.href = target; }, 400);
        return;
      }
      if (!$wrap.length) {
        // Certaines pages (steppers sur-mesure) n'ont pas de bloc .w-form :
        // on n'efface rien pour ne pas casser la mise en page.
        log("lead enregistré (local) — pas de bloc de confirmation sur cette page");
        return;
      }
      $wrap.find("> .w-form-done").show();
      $form.hide();
      log("lead enregistré (local)");
    }

    postJSON(LEAD_ENDPOINT, payload)
      .then(function (res) {
        leads.push({ payload: payload, response: res });
        API_OK = true;
        done(true);
      })
      .catch(function (err) {
        // Aucun serveur local : on conserve le lead dans le navigateur.
        API_OK = false;
        try {
          var store = JSON.parse(localStorage.getItem("__local_leads") || "[]");
          store.push({ payload: payload, ts: new Date().toISOString() });
          localStorage.setItem("__local_leads", JSON.stringify(store));
        } catch (e) {}
        log("serveur local absent — lead stocké dans localStorage __local_leads", err && err.message);
        // On affiche tout de même le succès : le parcours doit rester testable.
        done(true);
      });
  }

  /* ------------------------------------------------------- OTP / SMS simulé */
  function localOtp(opts, $) {
    var data = opts.data || {};
    var action = data.action || "envoyer_code";
    var phone = data.telephone || "";
    var key = "local_otp_" + phone;
    var response;

    if (action === "verifier_code") {
      var expected = sessionStorage.getItem(key) || OTP_CODE;
      var ok = String(data.code) === expected;
      response = ok
        ? { success: true, message: "Numéro validé (mode local)." }
        : { success: false, message: "Code incorrect. En local, le code est " + OTP_CODE + "." };
    } else {
      sessionStorage.setItem(key, OTP_CODE);
      response = { success: true, message: "Code envoyé (mode local : " + OTP_CODE + ")." };
    }

    log("OTP " + action, { telephone: phone, emetteur: data.emetteur, success: response.success });
    logEvent("otp", { action: action, telephone: phone, success: response.success });

    var jq = {
      done: function () { return jq; },
      fail: function () { return jq; },
      always: function () { return jq; },
      then: function () { return jq; },
      status: 200, statusText: "success", readyState: 4,
      responseText: JSON.stringify(response), responseJSON: response
    };
    setTimeout(function () {
      if (typeof opts.success === "function") opts.success(response, "success", jq);
      if (typeof opts.complete === "function") opts.complete(jq, "success");
      try { $(document).trigger("ajaxComplete", [jq, opts]); } catch (e) {}
    }, 120);
    return jq;
  }

  /* --------------------------------------------------------- mise en place JS */
  function install($) {
    /* 1. Formulaire : on remplace le handler Webflow (qui visait son API). */
    try { $(document).off("submit", ".w-form form"); } catch (e) {}

    $(document).on("submit", "form", function (ev) {
      var form = this;
      // Le moteur de lead standard gère lui-même l'envoi (et ses appels sont
      // redirigés vers l'API locale par les intercepteurs ci-dessus).
      if (window.__UBEPRO_LEAD_ACTIVE__) return;
      // Les intégrations Formly sur-mesure envoient déjà vers data-api-endpoint,
      // lui-même redirigé vers l'API locale : on ne double pas l'envoi.
      if (form.hasAttribute("data-api-endpoint")) return;
      ev.preventDefault();
      // Les handlers spécifiques (form-redirect, form-ass…) ont déjà tourné.
      submitLocal(form, $);
    });

    /* 2. OTP : on intercepte les appels $.ajax vers l'ancienne API SMS. */
    var realAjax = $.ajax;
    $.ajax = function (opts) {
      var url = typeof opts === "string" ? opts : (opts && opts.url) || "";
      if (typeof url === "string" && /envoi_code_verification\.php/i.test(url)) {
        return localOtp(typeof opts === "string" ? {} : opts, $);
      }
      return realAjax.apply(this, arguments);
    };

    /* 3. Liens restants vers l'extérieur -> page locale d'information. */
    function fixLinks(root) {
      $(root || document).find("a[href]").each(function () {
        var href = this.getAttribute("href");
        if (!href) return;
        if (/^(mailto:|tel:|#|javascript:)/i.test(href)) return;
        if (!isExternal(absolute(href))) return;
        var target = toLocal(href) || externalPage(href);
        this.setAttribute("href", target);
        this.setAttribute("data-local-external", "1");
        this.setAttribute("target", "_blank");
        this.setAttribute("rel", "noopener");
      });
      // iframes externes résiduelles
      $(root || document).find("iframe[src]").each(function () {
        var src = this.getAttribute("src");
        if (!src || /googletagmanager/.test(src)) { this.remove(); return; }
        if (isExternal(absolute(src))) {
          this.setAttribute("src", toLocal(src) || FAKE_REDIRECT_PAGE + "?to=" + encodeURIComponent(src));
        }
      });
    }
    fixLinks(document);

    /* 4. dataLayer : on garde la file, on la trace en console. */
    window.dataLayer = window.dataLayer || [];
    var nativePush = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function () {
      Array.prototype.forEach.call(arguments, function (arg) {
        if (arg && arg.event) log("dataLayer ←", arg.event, arg);
      });
      logEvent("datalayer", { args: Array.prototype.slice.call(arguments) });
      return nativePush.apply(window.dataLayer, arguments);
    };

    log("runtime actif — site " + SLUG + " — OTP local " + OTP_CODE
        + (PROD_MODE ? " — ⚠ MODE TEST RÉEL : les leads partent vers la PRODUCTION" : ""));
  }

  /* Démarrage : après script.js (defer) et après le ready de Webflow/Formly. */
  function boot() {
    var $ = window.jQuery;
    if (!$) { log("jQuery absent : mode dégradé"); return; }
    $(function () { install($); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
