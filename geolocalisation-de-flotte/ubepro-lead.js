/**
 * Ubepro — moteur de lead standard (v1)
 * -----------------------------------------------------------------------------
 * Portage du standard `recrutement_it_tech` sur les landing pages existantes.
 *
 * Ce script ne remplace PAS le formulaire de la page : il s'y branche.
 * Il assure :
 *   · la capture des paramètres de tracking (UTM, ltm, gclid…) ;
 *   · le formatage / la validation du téléphone et du code postal ;
 *   · la double transmission du lead (CRM Hellolead + Google Apps Script) ;
 *   · l'événement GTM `formulaire_lead` ;
 *   · l'affichage du succès natif (`.w-form-done`, `.form-success` ou
 *     `data-redirect`) ;
 *   · le respect du consentement (CMP `ubepro-consent.js`).
 *
 * Aucune dépendance (pas de jQuery). Le markup de chaque LP est lu tel quel :
 * tous ses champs spécifiques (question_1, reponse_2, solution…) sont transmis.
 *
 * Configuration (injectée dans la page, avant ce script) :
 *   window.UBEPRO_STANDARD = {
 *     formId, domaine, leadApiUrl, leadApiMode, googleScriptUrl, debug
 *   }
 */
(() => {
  'use strict';

  if (window.__UBEPRO_LEAD_ACTIVE__) return;
  window.__UBEPRO_LEAD_ACTIVE__ = true;

  /* ------------------------------------------------------------------ */
  /* Interception (enregistrée IMMÉDIATEMENT, avant tout autre script)    */
  /* ------------------------------------------------------------------ */
  // Les handlers réels sont définis plus bas : ces relais garantissent que
  // l'écoute est en place avant les scripts de la page (jQuery, Webflow,
  // Formly…) et qu'aucun d'eux ne peut s'intercaler devant nous.
  let submitHandler = null;
  let clickHandler = null;

  try {
    document.addEventListener('submit', (event) => { if (submitHandler) submitHandler(event); }, true);
    document.addEventListener('click', (event) => { if (clickHandler) clickHandler(event); }, true);
  } catch (_) { /* environnement sans DOM complet */ }

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */

  const CONFIG = Object.assign({
    formId: 'ADW_LP_DEFAULT',
    domaine: 'comparateurpro.fr',
    leadApiUrl: 'https://mc.hellolead.pro/mon_compte/api/webflow/get_information.php',
    leadApiMode: 'nocors',
    leadApiCredentials: 'omit',
    googleScriptUrl: 'https://script.google.com/macros/s/AKfycbwrbyCb9-cAmIRPGNvnb-aM-CkhQAerrkfP3_HSw-ewmThxsn4vbZt5daaq2aOnL01a1w/exec',
    crmStrictContract: false,
    debug: false,
    formatPhone: true,
    autoSuccess: true
  }, window.UBEPRO_STANDARD || {});

  const LEAD_API_URL = CONFIG.leadApiUrl;
  const LEAD_API_MODE = CONFIG.leadApiMode;
  const LEAD_API_CREDENTIALS = CONFIG.leadApiCredentials === 'include' ? 'include' : 'omit';
  const GOOGLE_SCRIPT_URL = CONFIG.googleScriptUrl;
  const DEFAULT_FORM_ID = CONFIG.formId;
  const DOMAINE = CONFIG.domaine;
  const CRM_STRICT = CONFIG.crmStrictContract === true;
  const DEBUG = CONFIG.debug === true;

  const TRACKING_STORAGE_KEY = 'ubepro_tracking_v1';
  const TRACKING_PAGE_KEY = 'ubepro_tracking_page_url_v1';
  const SHEET_TIMEOUT_MS = 15000;
  const CRM_TIMEOUT_MS = 5000;
  const SLOW_NOTICE_MS = 2500;

  const MESSAGE_SEND_FAILED = 'Votre demande n’a pas pu être envoyée. Vérifiez votre connexion puis réessayez.';

  // Formulaires gérés par une intégration dédiée : on ne touche pas.
  const SKIP_SELECTOR = '[data-api-endpoint]';
  // Formulaires non-lead (recherche interne) : jamais interceptés.
  const IGNORE_SELECTOR = '[role="search"], [data-search], form[action*="recherche"], form[action*="search"]';
  // Un formulaire de lead contient au minimum une coordonnée.
  const LEAD_FIELD_SELECTOR = 'input[type="email"], input[type="tel"], '
    + 'input[name*="mail" i], input[name*="telephone" i], input[name*="phone" i]';

  const MARKETING_KEYS = new Set(['gclid', 'msclkid', 'fbclid']);
  const TRACKING_KEYS = [
    { key: 'source', aliases: ['source', 'utm_source', 'ltm_source'] },
    { key: 'categorie', aliases: ['categorie', 'utm_category', 'ltm_category', 'category'] },
    { key: 'user', aliases: ['user', 'utm_user', 'ltm_user'] },
    { key: 'utm_source', aliases: ['utm_source', 'ltm_source', 'source'] },
    { key: 'utm_medium', aliases: ['utm_medium', 'medium'] },
    { key: 'utm_campaign', aliases: ['utm_campaign', 'campaign'] },
    { key: 'utm_content', aliases: ['utm_content', 'content'] },
    { key: 'utm_term', aliases: ['utm_term', 'term'] },
    { key: 'utm_id', aliases: ['utm_id', 'campaign_id'] },
    { key: 'utm_category', aliases: ['utm_category', 'ltm_category', 'categorie', 'category'] },
    { key: 'utm_user', aliases: ['utm_user', 'ltm_user', 'user'] },
    { key: 'ltm_source', aliases: ['ltm_source', 'utm_source', 'source'] },
    { key: 'ltm_category', aliases: ['ltm_category', 'utm_category', 'categorie', 'category'] },
    { key: 'ltm_typ', aliases: ['ltm_typ', 'utm_typ', 'typ'] },
    { key: 'ltm_user', aliases: ['ltm_user', 'utm_user', 'user'] },
    { key: 'gclid', aliases: ['gclid'] },
    { key: 'msclkid', aliases: ['msclkid'] },
    { key: 'fbclid', aliases: ['fbclid'] }
  ];

  /* ------------------------------------------------------------------ */
  /* Consentement                                                        */
  /* ------------------------------------------------------------------ */

  const getCookiePreferences = () => {
    if (window.__UBEPRO_COOKIE_PREFERENCES__) return window.__UBEPRO_COOKIE_PREFERENCES__;
    const prefix = 'user_cookie_preferences=';
    // `document.cookie` peut lever une exception (iframe sandbox, cookies
    // tiers bloqués). Ce n'est jamais une raison de désactiver le moteur.
    let cookies = '';
    try { cookies = document.cookie || ''; } catch (_) { return null; }
    for (const part of cookies.split(';')) {
      const item = part.trim();
      if (item.startsWith(prefix)) {
        try {
          return JSON.parse(decodeURIComponent(item.slice(prefix.length)));
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  };

  const analyticsGranted = () => Boolean(getCookiePreferences()?.analytics);
  const marketingGranted = () => Boolean(getCookiePreferences()?.marketing);
  const trackingGranted = () => analyticsGranted() || marketingGranted();

  /* ------------------------------------------------------------------ */
  /* Utilitaires                                                         */
  /* ------------------------------------------------------------------ */

  const safeText = (value, maxLength = 500) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.slice(0, maxLength);
  };

  const normalizePayloadValue = (value) => safeText(value, 500).replace(/[<>]/g, '');

  const debugLog = (...args) => { if (DEBUG) console.debug('[ubepro]', ...args); };

  /**
   * Diagnostic best-effort : en local (ou si CONFIG.debug), chaque événement
   * clé du moteur est renvoyé au serveur de test (`/_local/api/log`), ce qui
   * permet de savoir depuis le terminal ce qui s'est réellement passé dans le
   * navigateur — sans dépendre de la console.
   */
  const report = (step, details = {}) => {
    try {
      const local = window.__UBEPRO_LOCAL__ === true;
      if (!local && !DEBUG) return;
      const payload = JSON.stringify(Object.assign({
        kind: 'ubepro-lead',
        step,
        ts: new Date().toISOString(),
        url: window.location.href,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : ''
      }, details));
      const endpoint = '/_local/api/log';
      if (local && typeof navigator.sendBeacon === 'function'
          && navigator.sendBeacon(endpoint, new Blob([payload], { type: 'text/plain;charset=UTF-8' }))) {
        return;
      }
      if (local && typeof fetch === 'function') {
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: payload, keepalive: true })
          .catch(() => {});
      }
    } catch (_) { /* diagnostic jamais bloquant */ }
  };

  const generateId = () => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (_) { /* contexte non sécurisé */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = (Math.random() * 16) | 0;
      const value = char === 'x' ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  };

  /* ------------------------------------------------------------------ */
  /* Tracking                                                            */
  /* ------------------------------------------------------------------ */

  const getUrlParams = (href = window.location.href) => {
    const result = {};
    try {
      new URL(href, window.location.origin).searchParams.forEach((value, key) => {
        if (value) result[key] = value;
      });
    } catch (_) {
      const query = String(href).split('?')[1] || '';
      query.split('#')[0].split('&').forEach((part) => {
        if (!part) return;
        const [rawKey, rawValue = ''] = part.split('=');
        const key = decodeURIComponent(rawKey.replace(/\+/g, ' ')).trim();
        const value = decodeURIComponent(rawValue.replace(/\+/g, ' ')).trim();
        if (key && value) result[key] = value;
      });
    }
    return result;
  };

  const readStoredParams = () => {
    if (!trackingGranted()) return {};
    try {
      const raw = window.sessionStorage.getItem(TRACKING_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  };

  let trackingMemory = (() => { try { return readStoredParams(); } catch (_) { return {}; } })();
  let trackingPageUrl = (() => {
    if (analyticsGranted()) {
      try {
        const stored = window.sessionStorage.getItem(TRACKING_PAGE_KEY);
        if (stored) return stored;
      } catch (_) { /* sessionStorage indisponible */ }
    }
    return window.location.href;
  })();

  const storeParams = (params) => {
    trackingMemory = Object.assign({}, trackingMemory, params);
    if (!trackingGranted()) return Object.assign({}, trackingMemory);
    const toStore = Object.assign({}, trackingMemory);
    if (!marketingGranted()) MARKETING_KEYS.forEach((key) => { delete toStore[key]; });
    try {
      window.sessionStorage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(toStore));
    } catch (_) { /* mémoire seulement */ }
    return Object.assign({}, trackingMemory);
  };

  const captureTrackingParams = (href = window.location.href) => {
    const urlParams = getUrlParams(href);
    const relevant = {};
    TRACKING_KEYS.forEach(({ key, aliases }) => {
      const found = aliases.find((alias) => urlParams[alias]);
      if (found) relevant[key] = urlParams[found];
    });
    if (Object.keys(relevant).length) {
      storeParams(relevant);
      if (analyticsGranted()) {
        trackingPageUrl = safeText(href, 1000);
        try {
          window.sessionStorage.setItem(TRACKING_PAGE_KEY, trackingPageUrl);
        } catch (_) { /* mémoire seulement */ }
      }
    }
    return Object.assign({}, trackingMemory);
  };

  const getTrackingValues = () => {
    captureTrackingParams();
    const out = {};
    TRACKING_KEYS.forEach(({ key }) => { out[key] = normalizePayloadValue(trackingMemory[key]); });
    return out;
  };

  try { captureTrackingParams(); } catch (_) { /* tracking jamais bloquant */ }

  window.addEventListener('ubepro:cookie-preferences', () => {
    if (!trackingGranted()) {
      try {
        window.sessionStorage.removeItem(TRACKING_STORAGE_KEY);
        window.sessionStorage.removeItem(TRACKING_PAGE_KEY);
      } catch (_) {}
    } else {
      storeParams(trackingMemory);
    }
  });

  /* ------------------------------------------------------------------ */
  /* Téléphone / code postal                                             */
  /* ------------------------------------------------------------------ */

  const normalizePhone = (value) => {
    let text = String(value || '').replace(/[^\d+]/g, '');
    if (/^\+?00/.test(text)) text = `+${text.replace(/^\+?00/, '')}`;
    if (text.startsWith('+33')) text = `0${text.slice(3)}`;
    if (text.startsWith('33') && text.length === 11) text = `0${text.slice(2)}`;
    return text;
  };

  const validatePhone = (value) => {
    const normalized = normalizePhone(value);
    if (/^0[1-9]\d{8}$/.test(normalized)) return true;
    return /^\+[1-9]\d{7,14}$/.test(normalized);
  };

  const validatePostal = (value) => /^\d{5}$/.test(String(value || '').replace(/\s+/g, ''));

  const formatPhoneInput = (value) => {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 10);
    if (!digits.startsWith('0')) return value;
    const parts = [];
    for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
    return parts.join(' ');
  };

  /* ------------------------------------------------------------------ */
  /* Envois                                                              */
  /* ------------------------------------------------------------------ */

  const sendToCrm = async (crmData, formId, leadId) => {
    if (LEAD_API_MODE === 'off' || !LEAD_API_URL) return { target: 'crm', state: 'off' };
    const body = JSON.stringify({ payload: { formId, id: leadId, data: crmData } });

    if (LEAD_API_MODE === 'cors') {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), CRM_TIMEOUT_MS) : null;
      try {
        const response = await fetch(LEAD_API_URL, {
          method: 'POST',
          mode: 'cors',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body,
          credentials: LEAD_API_CREDENTIALS,
          signal: controller ? controller.signal : undefined
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let parsed = null;
        try { parsed = JSON.parse(await response.text()); } catch (_) { parsed = null; }
        if (!parsed || (parsed.status !== 'ok' && parsed.success !== true)) {
          throw new Error((parsed && parsed.message) || 'Réponse inattendue du CRM.');
        }
        return { target: 'crm', state: 'ok', response: parsed };
      } catch (crmError) {
        if (CRM_STRICT) throw crmError;
        console.warn('[ubepro] CRM cors en échec (non bloquant) :', crmError);
        return { target: 'crm', state: 'error', error: crmError };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    try {
      if (typeof navigator.sendBeacon === 'function'
          && navigator.sendBeacon(LEAD_API_URL, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) {
        return { target: 'crm', state: 'unverified', via: 'beacon' };
      }
    } catch (beaconError) {
      console.warn('[ubepro] sendBeacon CRM échoué, repli fetch :', beaconError);
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), CRM_TIMEOUT_MS) : null;
    try {
      await fetch(LEAD_API_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body,
        keepalive: true,
        credentials: LEAD_API_CREDENTIALS,
        signal: controller ? controller.signal : undefined
      });
      return { target: 'crm', state: 'unverified', via: 'fetch' };
    } catch (crmError) {
      console.error('[ubepro] CRM : fetch no-cors en échec :', crmError);
      return { target: 'crm', state: 'error', error: crmError };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const sendToGoogle = async (googleFormData) => {
    if (!GOOGLE_SCRIPT_URL) return { target: 'sheet', state: 'off' };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), SHEET_TIMEOUT_MS) : null;
    try {
      const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: googleFormData,
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      if (!parsed || (parsed.status !== 'ok' && parsed.success !== true)) {
        throw new Error((parsed && parsed.message) || 'Réponse inattendue du script Google.');
      }
      return { target: 'sheet', state: 'ok', response: parsed };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Adaptateur DOM                                                      */
  /* ------------------------------------------------------------------ */

  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // Le bloc d'échec Webflow (`.w-form-fail`) est un FRÈRE du <form>, dans
  // `.w-form` : il faut donc chercher aussi dans le conteneur, sinon aucun
  // message n'est jamais affiché et le clic reste sans explication.
  const findErrorSlot = (form) => {
    const wrapper = form.closest('.w-form') || form.parentElement;
    return form.querySelector('.form-error')
      || (wrapper && wrapper.querySelector('.w-form-fail'))
      || form.querySelector('[role="alert"]')
      || (wrapper && wrapper.querySelector('[role="alert"]'));
  };

  const showError = (form, message) => {
    const slot = findErrorSlot(form);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
      slot.style.removeProperty('display');
    }
    form.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
      field.removeAttribute('aria-invalid');
      field.classList.remove('is-invalid');
    });
    const invalid = form.querySelector('.is-invalid, [aria-invalid="true"]');
    (invalid || form).scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  };

  const clearError = (form) => {
    const slot = findErrorSlot(form);
    if (slot) { slot.hidden = true; slot.textContent = ''; }
  };

  const markInvalid = (form, field, message) => {
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.classList.add('is-invalid');
      try { field.focus({ preventScroll: false }); } catch (_) { field.focus(); }
    }
    showError(form, message);
  };

  /**
   * Résolution tolérante des noms de champs : les LP Webflow suffixent
   * parfois les inputs (`telephone-2`, `Email-2`, `Code-postal`). On ramène
   * ces variantes vers les clés canoniques du standard, sans jamais perdre
   * les champs propres à la page (question_1, reponse_3, solution…).
   */
  const FIELD_ALIASES = {
    nom: ['nom', 'lastname', 'nom de famille', 'nom complet'],
    prenom: ['prenom', 'firstname', 'prenom usuel'],
    mail: ['mail', 'email', 'e mail', 'email pro', 'courriel', 'adresse email'],
    telephone: ['telephone', 'tel', 'phone', 'mobile', 'numero de telephone'],
    societe: ['societe', 'entreprise', 'company', 'raison sociale', 'nom de l entreprise'],
    code_postal: ['code postal', 'postal code', 'cp', 'zip', 'code zip'],
    ville: ['ville', 'city', 'commune'],
    civilite: ['civilite', 'genre', 'sexe']
  };

  const ALIAS_LOOKUP = (() => {
    const map = new Map();
    Object.keys(FIELD_ALIASES).forEach((canonical) => {
      FIELD_ALIASES[canonical].forEach((alias) => map.set(alias, canonical));
    });
    return map;
  })();

  const normalizeFieldName = (key) => String(key)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const canonicalField = (key) => {
    const normalized = normalizeFieldName(key);
    if (ALIAS_LOOKUP.has(normalized)) return ALIAS_LOOKUP.get(normalized);
    const stripped = normalized.replace(/ \d+$/, '');          // suffixe Webflow `-2`
    if (stripped !== normalized && ALIAS_LOOKUP.has(stripped)) return ALIAS_LOOKUP.get(stripped);
    return null;
  };

  /**
   * Lit tous les champs du formulaire (y compris les questionnaires propres
   * à chaque LP) et normalise les coordonnées.
   */
  const buildPayloads = (form) => {
    const tracking = getTrackingValues();
    const raw = {};
    new FormData(form).forEach((value, key) => {
      if (key === 'website') return;                       // honeypot
      const text = typeof value === 'string' ? value : String(value);
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        raw[key] = `${raw[key]}, ${text}`;
      } else {
        raw[key] = text;
      }
    });

    // Variantes de noms (Webflow : `telephone-2`, `Email-2`, `Code-postal`…)
    // ramenées vers les clés canoniques, sans écraser un champ déjà renseigné.
    const fields = Object.assign({}, raw);
    Object.keys(raw).forEach((key) => {
      const canonical = canonicalField(key);
      if (!canonical || canonical === key) return;
      if (normalizePayloadValue(fields[canonical] || '')) return;
      fields[canonical] = raw[key];
    });

    const formId = normalizePayloadValue(fields.form_id || fields.formId || DEFAULT_FORM_ID) || DEFAULT_FORM_ID;
    const email = normalizePayloadValue(fields.mail || fields.email || fields.email_pro || '').toLowerCase();

    const coordonnees = {
      nom: normalizePayloadValue(fields.nom || ''),
      prenom: normalizePayloadValue(fields.prenom || ''),
      mail: email,
      email,
      telephone: normalizePhone(fields.telephone || ''),
      societe: normalizePayloadValue(fields.societe || ''),
      code_postal: normalizePayloadValue(fields.code_postal || '').replace(/\s+/g, ''),
      civilite: normalizePayloadValue(fields.civilite || ''),
      ville: normalizePayloadValue(fields.ville || '')
    };

    // Champs propres à la page (questionnaires Webflow, solution, enjeu…)
    const specific = {};
    const RESERVED_KEYS = new Set([
      'nom', 'prenom', 'mail', 'email', 'telephone', 'societe', 'code_postal',
      'civilite', 'ville', 'form_id', 'formId', 'website'
    ]);
    Object.keys(fields).forEach((key) => {
      if (RESERVED_KEYS.has(key) || canonicalField(key)) return;
      if (TRACKING_KEYS.some(({ key: k }) => k === key)) return;
      const value = normalizePayloadValue(fields[key]);
      if (value) specific[key] = value;
    });

    const crmData = Object.assign({}, coordonnees, specific, {
      source: tracking.source || formId,
      categorie: tracking.categorie || '',
      coordonnee: '1',
      rgpd_consent: 1,
      domaine: DOMAINE
    });

    if (marketingGranted()) {
      crmData.utm_source = tracking.utm_source || '';
      crmData.utm_medium = tracking.utm_medium || '';
      crmData.utm_campaign = tracking.utm_campaign || '';
      crmData.utm_term = tracking.utm_term || '';
      crmData.utm_content = tracking.utm_content || '';
      crmData.gclid = tracking.gclid || '';
      crmData.msclkid = tracking.msclkid || '';
      crmData.fbclid = tracking.fbclid || '';
    }

    const sheetData = Object.assign({}, coordonnees, specific, tracking, {
      form_id: formId,
      page_referrer: DOMAINE
    });

    return { crmData, sheetData, formId, firstName: coordonnees.prenom };
  };

  /** Affiche l'état de succès du formulaire, sans casser la mise en page. */
  const showSuccess = (form) => {
    const wrapper = form.closest('.w-form');
    const done = wrapper ? wrapper.querySelector(':scope > .w-form-done') : null;
    const successBox = form.querySelector('.form-success') || form.parentElement?.querySelector('.form-success');
    const redirect = form.getAttribute('data-redirect') || form.getAttribute('redirect');

    form.dispatchEvent(new CustomEvent('ubepro:lead-success', { bubbles: true }));

    if (redirect) {
      try {
        const target = new URL(redirect, window.location.href).href;
        if (!/^https?:/i.test(target) || target.startsWith(window.location.origin)
            || !/^(localhost|127\.0\.0\.1)/.test(window.location.hostname)) {
          window.setTimeout(() => { window.location.href = target; }, 400);
          return;
        }
      } catch (_) { /* URL invalide : on continue */ }
    }

    if (done) {
      done.hidden = false;
      done.style.removeProperty('display');
      form.style.display = 'none';
      if (wrapper) wrapper.querySelector(':scope > .w-form-fail')?.setAttribute('hidden', '');
      return;
    }

    if (successBox) {
      successBox.hidden = false;
      form.querySelectorAll('.form-step, fieldset[data-step]').forEach((step) => { step.hidden = true; });
      successBox.focus?.();
      return;
    }

    // Dernier recours : message discret, aucun impact sur le design existant.
    const banner = document.createElement('div');
    banner.className = 'ubp-inline-success';
    banner.setAttribute('role', 'status');
    banner.textContent = 'Merci, votre demande a bien été enregistrée.';
    form.parentElement?.insertBefore(banner, form);
    form.style.display = 'none';
  };

  const validateForm = (form) => {
    const phoneField = form.querySelector('input[name="telephone"], input[name="tel"]');
    const postalField = form.querySelector('input[name="code_postal"], input[name="cp"]');
    const emailField = form.querySelector('input[name="mail"], input[name="email"]');

    if (phoneField && phoneField.value.trim() && !validatePhone(phoneField.value)) {
      markInvalid(form, phoneField, 'Veuillez renseigner un numéro de téléphone valide (10 chiffres).');
      return false;
    }
    if (postalField && postalField.value.trim() && !validatePostal(postalField.value)) {
      markInvalid(form, postalField, 'Veuillez renseigner un code postal à 5 chiffres.');
      return false;
    }
    if (emailField && emailField.value.trim()
        && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailField.value.trim())) {
      markInvalid(form, emailField, 'Veuillez renseigner une adresse email valide.');
      return false;
    }

    // Reste-t-il un champ requis vide sur une étape réellement affichée ?
    // (les champs des étapes masquées ou des branches non parcourues sont ignorés)
    const blocking = firstBlockingField(form);
    if (blocking) {
      markInvalid(form, blocking, 'Merci de compléter ce champ avant de valider.');
      return false;
    }

    return true;
  };

  /* ------------------------------------------------------------------ */
  /* Soumission                                                          */
  /* ------------------------------------------------------------------ */

  const submitting = new WeakMap();

  /** Vrai si le formulaire collecte au moins une coordonnée (lead). */
  const isLeadForm = (form) => !!form.querySelector(LEAD_FIELD_SELECTOR);

  /**
   * Vrai si le champ appartient à une étape réellement affichée.
   * Les formulaires multi-étapes (Formly/Webflow) laissent dans le DOM des
   * champs `required` appartenant à des étapes masquées ou à des branches
   * conditionnelles jamais parcourues : ils ne doivent jamais bloquer l'envoi.
   */
  const isActiveField = (field) => {
    if (!field || field.disabled) return false;
    if (field.type === 'hidden') return false;
    let node = field;
    while (node && node.nodeType === 1) {
      if (node.hasAttribute('hidden')) return false;
      if (node.getAttribute && /display\s*:\s*none/i.test(node.getAttribute('style') || '')) return false;
      node = node.parentElement;
    }
    try {
      const style = window.getComputedStyle(field);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    } catch (_) { /* getComputedStyle indisponible */ }
    return !!(field.offsetWidth || field.offsetHeight || field.getClientRects().length);
  };

  /** Premier champ requis invalide, en ignorant les étapes masquées. */
  const firstBlockingField = (form) => {
    const candidates = [...form.querySelectorAll('input, select, textarea')]
      .filter((field) => !field.disabled && field.willValidate !== false);
    const active = candidates.filter((field) => isActiveField(field));

    // Aucun champ affiché = étape de confirmation, ou moteur exécuté hors
    // navigateur (tests). Dans le premier cas il ne faut surtout rien bloquer ;
    // dans le second on retombe sur tous les champs pour rester testable.
    const layoutAvailable = !!(document.body
      && (document.body.offsetWidth || document.body.offsetHeight || document.body.getClientRects().length));
    const pool = active.length ? active : (layoutAvailable ? [] : candidates);
    return pool.find((field) => typeof field.checkValidity === 'function' && !field.checkValidity()) || null;
  };

  /** Vrai si le formulaire contient au moins une valeur soumise exploitable. */
  const hasUsableData = (form) => {
    try {
      const data = new FormData(form);
      for (const value of data.values()) {
        if (typeof value === 'string' && value.trim() !== '') return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  };

  const handleSubmit = async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches(SKIP_SELECTOR)) return;               // intégration dédiée
    if (form.matches(IGNORE_SELECTOR)) return;             // recherche / non-lead
    if (!isLeadForm(form) && !hasUsableData(form)) return; // formulaire vide non-lead

    // IMPORTANT — on prend la main AVANT toute vérification de validité.
    // Certaines pages embarquent un handler maison très silencieux
    // (ex. `$('.form-ass').submit(e => e.preventDefault())`) : s'il s'exécute,
    // le clic sur « Valider » ne produit plus rien du tout. En bloquant la
    // propagation immédiatement, aucun autre handler ne peut avaler l'envoi.
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    clickGuard.delete(form);                               // un vrai submit a eu lieu

    if (submitting.get(form)) return;                      // double clic

    report('submit-intercepte', {
      form: form.id || form.getAttribute('name') || '(sans id)',
      origine: event.__fromClickGuard ? 'filet-clic' : 'evenement-submit',
      champs: form.querySelectorAll('input, select, textarea').length
    });

    clearError(form);

    if (!validateForm(form)) {
      report('validation-refusee', { form: form.id || '(sans id)' });
      return;
    }

    const honeypot = form.querySelector('input[name="website"]');
    if (honeypot && honeypot.value.trim() !== '') {
      // Robot : on simule un succès sans rien transmettre.
      showSuccess(form);
      return;
    }

    submitting.set(form, true);
    const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
    const originalLabel = submitButton ? (submitButton.innerHTML || submitButton.value) : '';
    if (submitButton) {
      submitButton.disabled = true;
      if (submitButton.tagName === 'INPUT') submitButton.value = 'Envoi en cours...';
      else submitButton.textContent = 'Envoi en cours...';
    }

    const { crmData, sheetData, formId, firstName } = buildPayloads(form);
    const leadId = generateId();

    const googleFormData = new URLSearchParams();
    Object.entries(sheetData).forEach(([key, value]) => {
      if (value !== undefined && value !== null) googleFormData.set(key, String(value));
    });
    googleFormData.set('form_id', formId);
    googleFormData.set('id_lead', leadId);
    googleFormData.set('page_url', safeText(trackingPageUrl, 1000));
    googleFormData.set('user_agent', safeText(navigator.userAgent, 300));
    googleFormData.set('langue', safeText(navigator.language || '', 20));

    debugLog('Données CRM :', crmData);
    debugLog('Données Sheet :', Object.fromEntries(googleFormData.entries()));

    const slowTimer = setTimeout(() => {
      if (submitting.get(form)) showError(form, 'Transmission en cours, merci de patienter...');
    }, SLOW_NOTICE_MS);

    try {
      const results = await Promise.allSettled([
        sendToGoogle(googleFormData),
        sendToCrm(crmData, formId, leadId)
      ]);
      clearTimeout(slowTimer);

      const [sheetRes, crmRes] = results;
      window.ubeproLead.lastResults = { sheet: sheetRes, crm: crmRes };
      report('envoi-termine', {
        form: form.id || '(sans id)',
        sheet: sheetRes.status === 'fulfilled' ? (sheetRes.value && sheetRes.value.state) : 'rejected',
        crm: crmRes.status === 'fulfilled' ? (crmRes.value && crmRes.value.state) : 'rejected'
      });
      debugLog('Résultats :', { sheet: sheetRes, crm: crmRes });

      if (sheetRes.status === 'rejected') {
        throw sheetRes.reason || new Error('Erreur lors de l’enregistrement Sheet');
      }

      try {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
          event: 'formulaire_lead',
          form_id: formId,
          profil: crmData.solution || crmData.profil || crmData.reponse_1 || '',
          lead_id: leadId,
          telephone_valide: true
        });
      } catch (gtmError) {
        debugLog('dataLayer non bloquant :', gtmError);
      }

      showSuccess(form);
    } catch (sendError) {
      clearTimeout(slowTimer);
      console.error('[ubepro] Échec de l’envoi :', sendError);
      if (submitButton) {
        submitButton.disabled = false;
        if (submitButton.tagName === 'INPUT') submitButton.value = originalLabel;
        else submitButton.innerHTML = originalLabel;
      }
      showError(form, MESSAGE_SEND_FAILED);
    } finally {
      setTimeout(() => { submitting.set(form, false); }, 800);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Filet de sécurité : clic sans effet                                 */
  /* ------------------------------------------------------------------ */

  // Certaines pages interceptent le clic sur « Valider » et ne soumettent
  // jamais (ou le navigateur refuse la soumission à cause d'un champ requis
  // invisible). On surveille le clic : si aucun `submit` n'a suivi, on prend
  // le relais nous-mêmes après un court délai.
  const clickGuard = new WeakMap();

  const handleSubmitClick = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const control = target.closest(
      'input[type="submit"], button[type="submit"], [data-form="submit-btn"], [data-form="next-btn"][data-submit-show]'
    );
    if (!control) return;

    const form = control.form || (typeof control.closest === 'function' ? control.closest('form') : null);
    if (!form || form.matches(SKIP_SELECTOR) || !isLeadForm(form)) return;

    const token = {};
    clickGuard.set(form, token);

    window.setTimeout(() => {
      // Un `submit` a bien eu lieu entre-temps : rien à faire.
      if (clickGuard.get(form) !== token) return;
      if (submitting.get(form)) return;
      clickGuard.delete(form);

      report('clic-sans-soumission', {
        form: form.id || form.getAttribute('name') || '(sans id)',
        bouton: (control.value || control.textContent || '').trim().slice(0, 40)
      });

      // On rejoue le parcours de soumission du moteur.
      handleSubmit({
        target: form,
        preventDefault() {},
        stopImmediatePropagation() {},
        stopPropagation() {},
        __fromClickGuard: true
      });
    }, 350);
  };

  /* ------------------------------------------------------------------ */
  /* Champs cachés de tracking                                           */
  /* ------------------------------------------------------------------ */

  const ensureTrackingFields = (form) => {
    const values = getTrackingValues();
    Object.entries(values).forEach(([name, value]) => {
      const existing = form.querySelector(`input[name="${name}"]`);
      if (existing) {
        if (!existing.value) existing.value = value;
        return;
      }
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = name;
      field.value = value;
      form.appendChild(field);
    });
  };

  /* ------------------------------------------------------------------ */
  /* Démarrage                                                           */
  /* ------------------------------------------------------------------ */

  const init = () => {
    // 1. On branche les relais (déjà en place depuis le chargement du script).
    submitHandler = handleSubmit;
    clickHandler = handleSubmitClick;

    // 2. Préparation ensuite, formulaire par formulaire, sans risque.
    let forms = [];
    try { forms = [...document.querySelectorAll('form')]; } catch (_) { forms = []; }
    forms.forEach((form) => {
      try {
        if (form.matches(SKIP_SELECTOR)) return;
        prepareForm(form);
      } catch (error) {
        // Une page au markup exotique ne doit jamais empêcher le moteur de
        // fonctionner : on continue avec le formulaire suivant.
        report('init-form-error', { error: String(error && error.message || error) });
      }
    });

    debugLog('moteur de lead prêt', CONFIG);
    report('moteur-pret', { formulaires: forms.length });
  };

  const prepareForm = (form) => {
      // Le navigateur ne doit plus bloquer le clic sur « Valider » à cause
      // d'un champ `required` invisible (branche conditionnelle, étape masquée) :
      // c'est le moteur qui valide, et il ne regarde que les champs affichés.
      try { form.noValidate = true; } catch (_) {}

      ensureTrackingFields(form);

      const phoneField = form.querySelector('input[name="telephone"], input[name="tel"]');
      if (CONFIG.formatPhone && phoneField && !phoneField.dataset.inputmask
          && !/mask/i.test(phoneField.className) && !/_/.test(phoneField.value)) {
        phoneField.addEventListener('input', (event) => {
          const target = event.target;
          if (/_/.test(target.value)) return;            // saisie masquée (Inputmask)
          const formatted = formatPhoneInput(target.value);
          if (formatted !== target.value) target.value = formatted;
        });
      }

      const postalField = form.querySelector('input[name="code_postal"], input[name="cp"]');
      if (postalField) {
        postalField.addEventListener('input', (event) => {
          const clean = event.target.value.replace(/\D/g, '').slice(0, 5);
          if (clean !== event.target.value) event.target.value = clean;
        });
      }

      // Remise à zéro après succès (bouton fourni par la page ou généré).
      form.addEventListener('ubepro:lead-success', () => {
        form.dispatchEvent(new CustomEvent('ubepro:reset', { bubbles: true }));
      });
  };

  window.ubeproLead = {
    version: '2026-10-23-standard1',
    config: {
      formId: DEFAULT_FORM_ID,
      domaine: DOMAINE,
      leadApiUrl: LEAD_API_URL,
      leadApiMode: LEAD_API_MODE,
      googleScriptUrl: GOOGLE_SCRIPT_URL
    },
    preview: () => {
      const form = document.querySelector('form:not([data-api-endpoint])');
      if (!form) return null;
      const { crmData, sheetData, formId } = buildPayloads(form);
      return {
        crm: { payload: { formId, id: '(généré à la soumission)', data: crmData } },
        sheet: sheetData
      };
    },
    send: (form) => handleSubmit({
      target: form,
      preventDefault() {},
      stopImmediatePropagation() {}
    }),
    lastResults: null,
    tracking: getTrackingValues,
    isVisible,
    version: '2026-10-23-robuste3',
    /** Diagnostic : à taper dans la console du navigateur. */
    diagnose: () => {
      const forms = [...document.querySelectorAll('form')];
      return {
        version: '2026-10-23-robuste3',
        local: window.__UBEPRO_LOCAL__ === true,
        formId: DEFAULT_FORM_ID,
        forms: forms.map((form) => {
          const fields = [...form.querySelectorAll('input, select, textarea')];
          return {
            id: form.id || form.getAttribute('name') || '(sans id)',
            lead: isLeadForm(form),
            ignore: form.matches(SKIP_SELECTOR) || form.matches(IGNORE_SELECTOR),
            noValidate: form.noValidate,
            champs: fields.length,
            champsVisibles: fields.filter(isActiveField).length,
            clientValidity: typeof form.checkValidity === 'function' ? form.checkValidity() : null,
            champsBloquantsVisibles: fields.filter((f) => isActiveField(f) && !f.checkValidity())
              .map((f) => f.name || f.id || f.type).slice(0, 8)
          };
        })
      };
    }
  };

  // Branchement immédiat : l'écoute reste active même si `init` est retardé
  // ou interrompu par une erreur.
  submitHandler = handleSubmit;
  clickHandler = handleSubmitClick;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
