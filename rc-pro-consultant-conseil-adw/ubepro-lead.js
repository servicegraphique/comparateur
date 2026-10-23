/**
 * Ubepro — moteur de formulaire de lead (v1)
 * -----------------------------------------------------------------------------
 * Portage de `lead.js` (recrutement_it_tech) adapté aux landing pages existantes :
 *
 *   - aucun ID en dur : intercepte tous les `<form>` de la page (sauf ceux
 *     marqués `data-api-endpoint` ou `data-ubp-skip`, déjà gérés ailleurs) ;
 *   - collecte **tous** les champs du formulaire (`FormData`), pas seulement
 *     un jeu fixe : les questions métier propres à chaque LP (assurance, TNS,
 *     auto, énergie, titres-restaurant…) sont intégralement transmises au CRM
 *     et au Google Sheet ;
 *   - respecte l'UX d'origine : états `.w-form-done` / `.w-form-fail` Webflow,
 *     ou `.form-success` / `.form-error`, ou redirection (`data-redirect`) ;
 *   - conserve les fonctionnalités de `recrutement_it_tech` :
 *       • capture & persistance UTM / gclid / msclkid / fbclid / ltm_* sous
 *         contrôle du consentement (`window.__UBEPRO_COOKIE_PREFERENCES__`),
 *       • validation téléphone FR/intl + code postal + email,
 *       • formatage téléphone à la saisie (`06 12 34 56 78`),
 *       • honeypot `website` + anti-double-soumission,
 *       • double envoi parallèle Google Apps Script (cors) + CRM HelloLead
 *         (`sendBeacon` puis `fetch no-cors`, ou `cors` en local),
 *       • push `dataLayer` (`event: 'formulaire_lead'`).
 *
 * Configuration par page (optionnelle, définie avant ce script) :
 *   window.UBEPRO_STANDARD = {
 *     formId:          'Assurance TNS',
 *     domaine:         'assurance-tns.lp.comparateurpro.fr',
 *     leadApiUrl:      'https://mc.hellolead.pro/mon_compte/api/webflow/get_information.php',
 *     leadApiMode:     'no-cors', // ou 'cors' (utilisé par le serveur local)
 *     googleScriptUrl: 'https://script.google.com/macros/s/.../exec',
 *     debug:           false
 *   };
 */
(() => {
  'use strict';

  if (window.__UBEPRO_LEAD_ACTIVE__) return;
  window.__UBEPRO_LEAD_ACTIVE__ = true;

  // Relais posés IMMÉDIATEMENT en phase de capture : même si la suite de
  // l'initialisation rencontre un imprévu, Webflow / le navigateur ne peuvent
  // plus jamais recharger la page en GET ou avaler le clic en silence.
  let submitHandler = null;
  let clickHandler = null;
  document.addEventListener('submit', (event) => {
    if (typeof submitHandler === 'function') submitHandler(event);
  }, true);
  document.addEventListener('click', (event) => {
    if (typeof clickHandler === 'function') clickHandler(event);
  }, false);

  const CONFIG = Object.assign({
    formId: '',
    domaine: '',
    leadApiUrl: 'https://mc.hellolead.pro/mon_compte/api/webflow/get_information.php',
    leadApiMode: 'no-cors',
    leadApiCredentials: 'omit',
    crmStrict: false,
    googleScriptUrl: 'https://script.google.com/macros/s/AKfycbwrbyCb9-cAmIRPGNvnb-aM-CkhQAerrkfP3_HSw-ewmThxsn4vbZt5daaq2aOnL01a1w/exec',
    formatPhone: true,
    debug: false
  }, window.UBEPRO_STANDARD || {}, window.UBEPRO_CONFIG || {});

  const deriveSlug = () => {
    const parts = (window.location.pathname || '/').split('/').filter(Boolean);
    return parts[0] || document.title || 'landing-page';
  };

  const DEFAULT_FORM_ID = String(CONFIG.formId || deriveSlug()).trim();
  const DOMAINE = String(CONFIG.domaine || window.location.hostname || '').trim();
  const LEAD_API_URL = String(CONFIG.leadApiUrl || '').trim();
  const LEAD_API_MODE = String(CONFIG.leadApiMode || 'no-cors').trim().toLowerCase();
  const LEAD_API_CREDENTIALS = String(CONFIG.leadApiCredentials || 'omit').trim();
  const CRM_STRICT = Boolean(CONFIG.crmStrict);
  const GOOGLE_SCRIPT_URL = String(CONFIG.googleScriptUrl || '').trim();
  const DEBUG = Boolean(CONFIG.debug);

  const TRACKING_STORAGE_KEY = 'ubepro_tracking_v1';
  const TRACKING_PAGE_KEY = 'ubepro_tracking_page_url_v1';
  const SLOW_NOTICE_MS = 4000;
  const SHEET_TIMEOUT_MS = 12000;
  const CRM_TIMEOUT_MS = 8000;
  const MESSAGE_SEND_FAILED = "Une erreur est survenue lors de l'envoi. Merci de vérifier votre connexion et de réessayer.";

  // Formulaires explicitement exclus du moteur (modale cookies, recherche, etc.).
  const SKIP_SELECTOR = '[data-api-endpoint], [data-ubp-skip], #ubp-cookie-preferences-form, #content-cookie-modal form';
  const IGNORE_SELECTOR = '[role="search"], .w-commerce-commerceaddtocartform, #content-cookie-modal form';
  // Un formulaire est considéré comme un formulaire de lead / qualification s'il
  // contient au moins un champ de coordonnée ou de questionnaire métier.
  const LEAD_FIELD_SELECTOR = [
    'input[type="email"]',
    'input[type="tel"]',
    'input[name*="mail" i]',
    'input[name*="telephone" i]',
    'input[name*="phone" i]',
    'input[name^="reponse_" i]',
    'input[name^="question_" i]',
    'input[name="consentement" i]',
    'input[name="coordonnee" i]',
    '#nm',
    '#em',
    '#tl'
  ].join(', ');

  const SUBMIT_CONTROL_SELECTOR = [
    'input[type="submit"]:not([data-form="back-btn"])',
    'button[type="submit"]:not([data-form="back-btn"])',
    '[data-form="submit-btn"]',
    '[data-form="Submit-btn"]',
    '[data-form="next-btn"][data-submit-show]',
    '#sb-btn'
  ].join(', ');

  const TRACKING_KEYS = [
    { key: 'source', aliases: ['ltm_source', 'source'] },
    { key: 'categorie', aliases: ['ltm_category', 'ltm_categorie', 'categorie', 'category'] },
    { key: 'ltm_typ', aliases: ['ltm_typ', 'utm_typ', 'typ'] },
    { key: 'utm_source', aliases: ['utm_source'] },
    { key: 'utm_medium', aliases: ['utm_medium'] },
    { key: 'utm_campaign', aliases: ['utm_campaign'] },
    { key: 'utm_term', aliases: ['utm_term'] },
    { key: 'utm_content', aliases: ['utm_content'] },
    { key: 'gclid', aliases: ['gclid'] },
    { key: 'msclkid', aliases: ['msclkid'] },
    { key: 'fbclid', aliases: ['fbclid'] }
  ];
  const MARKETING_KEYS = new Set(['gclid', 'msclkid', 'fbclid']);

  /* ------------------------------------------------------------------ */
  /* Utilitaires                                                         */
  /* ------------------------------------------------------------------ */

  const getConsentPreferences = () => {
    const prefs = window.__UBEPRO_COOKIE_PREFERENCES__;
    if (!prefs || typeof prefs !== 'object') {
      return { essential: true, analytics: false, marketing: false };
    }
    return {
      essential: true,
      analytics: prefs.analytics === true,
      marketing: prefs.marketing === true
    };
  };

  const analyticsGranted = () => getConsentPreferences().analytics;
  const marketingGranted = () => getConsentPreferences().marketing;
  const trackingGranted = () => analyticsGranted() || marketingGranted();

  const safeText = (value, maxLength = 500) => {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, maxLength);
  };

  const neutralizeFormula = (value) => {
    const text = safeText(value);
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
  };

  const normalizePayloadValue = (value, maxLength = 500) => neutralizeFormula(safeText(value, maxLength));

  const debugLog = (...args) => { if (DEBUG) console.info('[ubepro]', ...args); };

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

  const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  // Le bloc d'échec Webflow (`.w-form-fail`) est un FRÈRE du <form>, dans
  // `.w-form` : il faut donc chercher aussi dans le conteneur, sinon aucun
  // message n'est jamais affiché et le clic reste sans explication.
  const findErrorSlot = (form) => {
    const wrapper = form.closest('.w-form') || form.parentElement;
    return form.querySelector('.form-error')
      || (wrapper && wrapper.querySelector(':scope > .w-form-fail'))
      || (wrapper && wrapper.querySelector('.w-form-fail'))
      || form.querySelector('[role="alert"]')
      || (wrapper && wrapper.querySelector('[role="alert"]'));
  };

  const showError = (form, message) => {
    const slot = findErrorSlot(form);
    if (slot) {
      const inner = slot.querySelector('div') || slot;
      inner.textContent = message;
      slot.hidden = false;
      slot.removeAttribute('hidden');
      slot.style.display = 'block';
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
    if (slot) {
      slot.hidden = true;
      slot.style.display = 'none';
    }
  };

  const markInvalid = (form, field, message) => {
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.classList.add('is-invalid');
      try { field.focus({ preventScroll: false }); } catch (_) { try { field.focus(); } catch (_) {} }
    }
    showError(form, message);
  };

  /**
   * Résolution tolérante des noms de champs : les LP Webflow suffixent
   * parfois les inputs (`telephone-2`, `Email-2`, `Code-postal`, `pr-nom-2`,
   * `T-l-phone`, `Civilit`). On ramène ces variantes vers les clés canoniques
   * du standard, sans jamais perdre les champs propres à la page.
   */
  const FIELD_ALIASES = {
    nom: ['nom', 'lastname', 'nom de famille', 'nom complet', 'nm', 'fullname'],
    prenom: ['prenom', 'pr nom', 'firstname', 'prenom usuel'],
    mail: ['mail', 'email', 'e mail', 'email pro', 'courriel', 'adresse email', 'em'],
    telephone: ['telephone', 't l phone', 'tel', 'phone', 'mobile', 'numero de telephone', 'tl'],
    societe: ['societe', 'nom de la societe', 'entreprise', 'company', 'raison sociale', 'nom de l entreprise'],
    code_postal: ['code postal', 'postal code', 'cp', 'zip', 'code zip'],
    ville: ['ville', 'city', 'commune'],
    civilite: ['civilite', 'civilit', 'genre', 'sexe', 'm']
  };

  const ALIAS_LOOKUP = (() => {
    const map = new Map();
    Object.keys(FIELD_ALIASES).forEach((canonical) => {
      FIELD_ALIASES[canonical].forEach((alias) => map.set(alias, canonical));
    });
    return map;
  })();

  const normalizeFieldName = (key) => String(key || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const canonicalField = (key, fieldEl = null) => {
    const normalized = normalizeFieldName(key);
    if (ALIAS_LOOKUP.has(normalized)) return ALIAS_LOOKUP.get(normalized);
    const stripped = normalized.replace(/ \d+$/, '');          // suffixe Webflow `-2`
    if (stripped !== normalized && ALIAS_LOOKUP.has(stripped)) return ALIAS_LOOKUP.get(stripped);
    if (fieldEl && /^field( \d+)?$/.test(normalized)) {
      const hint = normalizeFieldName(
        fieldEl.getAttribute('placeholder') || fieldEl.getAttribute('data-name') || ''
      );
      if (ALIAS_LOOKUP.has(hint)) return ALIAS_LOOKUP.get(hint);
    }
    return null;
  };

  const findFieldByCanonical = (form, targetCanonical) => {
    const inputs = [...form.querySelectorAll('input:not([type="hidden"]), select, textarea')];
    const matching = inputs.filter((el) => {
      const key = el.name || el.id || '';
      return canonicalField(key, el) === targetCanonical;
    });
    return matching.find((el) => isActiveField(el)) || matching[0] || null;
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
        if (text && !raw[key].split(', ').includes(text)) {
          raw[key] = raw[key] ? `${raw[key]}, ${text}` : text;
        }
      } else {
        raw[key] = text;
      }
    });

    // Certains formulaires personnalisés ont des inputs avec id mais sans name,
    // ou des champs Webflow génériques (`field-3` avec placeholder "Code Postal").
    form.querySelectorAll('input, select, textarea').forEach((el) => {
      if (el.disabled || el.type === 'submit' || el.type === 'button') return;
      const key = el.name || el.id;
      if (!key || key === 'website') return;
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) return;
      if (!raw[key] && el.value) raw[key] = el.value;
      const canon = canonicalField(key, el);
      if (canon && !raw[canon] && el.value) {
        raw[canon] = el.value;
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

    const isSecondaryForm = String(fields.coordonnee || '').trim() === '0';
    const readFallback = (k) => {
      if (!isSecondaryForm) return '';
      try { return window.localStorage.getItem(k) || ''; } catch (_) { return ''; }
    };

    const formId = normalizePayloadValue(fields.form_id || fields.formId || DEFAULT_FORM_ID) || DEFAULT_FORM_ID;
    const email = normalizePayloadValue(
      fields.mail || fields.email || fields.email_pro || readFallback('mail') || ''
    ).toLowerCase();

    const coordonnees = {
      nom: normalizePayloadValue(fields.nom || readFallback('nom') || ''),
      prenom: normalizePayloadValue(fields.prenom || readFallback('prenom') || ''),
      mail: email,
      email,
      telephone: normalizePhone(fields.telephone || readFallback('telephone') || ''),
      societe: normalizePayloadValue(fields.societe || readFallback('societe') || ''),
      code_postal: normalizePayloadValue(fields.code_postal || readFallback('code_postal') || '').replace(/\s+/g, ''),
      civilite: normalizePayloadValue(fields.civilite || readFallback('civilite') || ''),
      ville: normalizePayloadValue(fields.ville || readFallback('ville') || '')
    };

    // Sauvegarde dans localStorage pour les éventuelles pages de qualification v2 / TYP.
    if (!isSecondaryForm) {
      try {
        Object.entries(coordonnees).forEach(([k, val]) => {
          if (val) window.localStorage.setItem(k, val);
        });
      } catch (_) {}
    }

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
      if (value !== '') specific[key] = value;
    });

    const resolvedSource = tracking.source || specific.source || formId;
    const resolvedCategory = tracking.categorie || specific.categorie || '';

    const crmData = Object.assign({}, coordonnees, specific, {
      source: resolvedSource,
      categorie: resolvedCategory,
      ltm_source: tracking.source || '',
      ltm_category: tracking.categorie || '',
      ltm_typ: tracking.ltm_typ || '',
      utm_source: tracking.utm_source || '',
      utm_medium: tracking.utm_medium || '',
      utm_campaign: tracking.utm_campaign || '',
      utm_term: tracking.utm_term || '',
      utm_content: tracking.utm_content || '',
      coordonnee: specific.coordonnee || '1',
      rgpd_consent: 1,
      domaine: DOMAINE
    });

    if (marketingGranted()) {
      crmData.gclid = tracking.gclid || '';
      crmData.msclkid = tracking.msclkid || '';
      crmData.fbclid = tracking.fbclid || '';
    }

    const sheetData = Object.assign({}, coordonnees, specific, tracking, {
      source: resolvedSource,
      categorie: resolvedCategory,
      ltm_source: tracking.source || '',
      ltm_category: tracking.categorie || '',
      form_id: formId,
      page_referrer: DOMAINE
    });

    return { crmData, sheetData, formId, firstName: coordonnees.prenom };
  };

  /** Affiche l'état de succès du formulaire, sans casser la mise en page. */
  const showSuccess = (form) => {
    const wrapper = form.closest('.w-form');
    const done = wrapper ? (wrapper.querySelector(':scope > .w-form-done') || wrapper.querySelector('.w-form-done')) : null;
    const fail = wrapper ? (wrapper.querySelector(':scope > .w-form-fail') || wrapper.querySelector('.w-form-fail')) : null;
    const successBox = form.querySelector('.form-success, #formSuccess')
      || form.parentElement?.querySelector('.form-success, #formSuccess, #s4');
    const ltmTyp = getUrlParams().ltm_typ || getUrlParams().utm_typ || '';
    const redirectAttr = form.getAttribute('data-redirect') || form.getAttribute('redirect');
    const redirect = redirectAttr || (ltmTyp ? `/${String(ltmTyp).replace(/^\/+/, '')}` : '');

    if (fail) {
      fail.hidden = true;
      fail.setAttribute('hidden', '');
      fail.style.display = 'none';
    }

    form.dispatchEvent(new CustomEvent('ubepro:lead-success', { bubbles: true }));

    if (done) {
      done.hidden = false;
      done.removeAttribute('hidden');
      done.style.display = 'block';
      form.style.display = 'none';
    } else if (successBox) {
      successBox.hidden = false;
      successBox.removeAttribute('hidden');
      successBox.classList.remove('hidden');
      successBox.style.display = 'block';
      if (successBox.id === 's4' || successBox.id === 'formSuccess') {
        form.style.display = 'none';
      } else {
        form.querySelectorAll('.form-step, fieldset[data-step]').forEach((step) => { step.hidden = true; });
      }
      successBox.focus?.();
    } else {
      // Dernier recours : message discret, aucun impact sur le design existant.
      const banner = document.createElement('div');
      banner.className = 'ubp-inline-success';
      banner.setAttribute('role', 'status');
      banner.textContent = 'Merci, votre demande a bien été enregistrée.';
      form.parentElement?.insertBefore(banner, form);
      form.style.display = 'none';
    }

    if (redirect) {
      try {
        const target = new URL(redirect, window.location.href).href;
        if (!/^https?:/i.test(target) || target.startsWith(window.location.origin)
            || !/^(localhost|127\.0\.0\.1)/.test(window.location.hostname)) {
          window.setTimeout(() => { window.location.href = target; }, 400);
        }
      } catch (_) { /* URL invalide : on continue */ }
    }
  };

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
      if (node.classList && (
        node.classList.contains('d-none') ||
        node.classList.contains('w-condition-invisible') ||
        node.classList.contains('hidden') ||
        (node.classList.contains('lp-step') && !node.classList.contains('active'))
      )) {
        return false;
      }
      if (node.getAttribute && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style') || '')) {
        return false;
      }
      node = node.parentElement;
    }
    try {
      const style = window.getComputedStyle(field);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    } catch (_) { /* getComputedStyle indisponible */ }
    return !!(field.offsetWidth || field.offsetHeight || field.getClientRects().length);
  };

  const isFieldInvalid = (field, form) => {
    if (!field || field.disabled) return false;
    // Groupe multi-checkbox Formly (`data-checkbox="1"`) : valide dès qu'au moins N cases sont cochées.
    if (field.type === 'checkbox') {
      const groupBox = field.closest('[data-checkbox]');
      if (groupBox) {
        const minCount = Math.max(1, parseInt(groupBox.getAttribute('data-checkbox') || '1', 10) || 1);
        const checkedCount = groupBox.querySelectorAll('input[type="checkbox"]:checked').length;
        return checkedCount < minCount;
      }
      return field.required && !field.checked;
    }
    if (field.type === 'radio') {
      if (!field.required) return false;
      if (field.name) {
        const group = [...form.querySelectorAll('input[type="radio"]')].filter((r) => r.name === field.name);
        return !group.some((r) => r.checked);
      }
      return !field.checked;
    }
    if (field.required && !String(field.value || '').trim()) {
      return true;
    }
    if (typeof field.checkValidity === 'function' && !field.checkValidity()) {
      return true;
    }
    return false;
  };

  /** Premier champ requis invalide, en ignorant les étapes masquées. */
  const firstBlockingField = (form) => {
    const candidates = [...form.querySelectorAll('input, select, textarea')]
      .filter((field) => !field.disabled && field.type !== 'hidden' && field.type !== 'submit' && field.type !== 'button');
    const active = candidates.filter((field) => isActiveField(field));

    const layoutAvailable = !!(document.body
      && (document.body.offsetWidth || document.body.offsetHeight || document.body.getClientRects().length));
    const pool = active.length ? active : (layoutAvailable ? [] : candidates);
    return pool.find((field) => isFieldInvalid(field, form)) || null;
  };

  const hasUserEnteredValue = (form) => {
    const inputs = [...form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea')];
    return inputs.some((el) => {
      if (el.type === 'radio' || el.type === 'checkbox') return el.checked;
      return String(el.value || '').trim() !== '';
    });
  };

  const validateForm = (form) => {
    // Reste-t-il un champ requis vide sur l'étape active ?
    const blocking = firstBlockingField(form);
    if (blocking) {
      markInvalid(form, blocking, 'Merci de compléter ce champ avant de valider.');
      return false;
    }

    if (!hasUserEnteredValue(form)) {
      const firstInput = form.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');
      markInvalid(form, firstInput, 'Merci de compléter ce champ avant de valider.');
      return false;
    }

    const phoneField = findFieldByCanonical(form, 'telephone');
    const postalField = findFieldByCanonical(form, 'code_postal');
    const emailField = findFieldByCanonical(form, 'mail');

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

    const telVerifie = form.querySelector('input[name="telephone_verifie"]');
    if (telVerifie && telVerifie.value === 'non') {
      const smsCodeInput = form.querySelector('.sms-code, #smsCode');
      markInvalid(form, smsCodeInput || phoneField, 'Veuillez vérifier votre numéro par SMS avant de valider.');
      return false;
    }

    return true;
  };

  /* ------------------------------------------------------------------ */
  /* Soumission                                                          */
  /* ------------------------------------------------------------------ */

  const submitting = new WeakMap();

  /** Vrai si le formulaire est un formulaire de lead ou de qualification. */
  const isLeadForm = (form) => {
    if (!form || !(form instanceof HTMLFormElement)) return false;
    if (form.matches(SKIP_SELECTOR) || form.matches(IGNORE_SELECTOR)) return false;
    if (form.getAttribute('data-form') === 'multistep') return true;
    if (form.id === 'f-lead' || form.id === 'leadForm') return true;
    return !!form.querySelector(LEAD_FIELD_SELECTOR);
  };

  /** Vrai si le formulaire contient au moins une valeur soumise exploitable. */
  const hasUsableData = (form) => {
    try {
      const data = new FormData(form);
      for (const value of data.values()) {
        if (typeof value === 'string' && value.trim() !== '') return true;
      }
      return hasUserEnteredValue(form);
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
    event.preventDefault?.();
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
    const submitButton = form.querySelector(SUBMIT_CONTROL_SELECTOR);
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

  const clickGuard = new WeakMap();

  const handleSubmitClick = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const control = target.closest(SUBMIT_CONTROL_SELECTOR);
    if (!control) return;
    if (control.getAttribute('data-form') === 'back-btn') return;

    const form = control.form || (typeof control.closest === 'function' ? control.closest('form') : null);
    if (!form || form.matches(SKIP_SELECTOR) || form.matches(IGNORE_SELECTOR)) return;
    if (!isLeadForm(form) && !hasUsableData(form)) return;

    // Si c'est un bouton `next-btn` sur un formulaire multi-étapes et qu'il
    // n'est pas également `submit-btn`, ne déclencher que si on est sur la dernière étape.
    if (control.getAttribute('data-form') === 'next-btn' && !control.hasAttribute('data-submit-show')) {
      const steps = [...form.querySelectorAll('[data-form="step"]')];
      if (steps.length > 1) return;
    }

    const token = {};
    clickGuard.set(form, token);

    window.setTimeout(() => {
      if (clickGuard.get(form) !== token) return;
      if (submitting.get(form)) return;
      clickGuard.delete(form);

      report('clic-sans-soumission', {
        form: form.id || form.getAttribute('name') || '(sans id)',
        bouton: (control.value || control.textContent || '').trim().slice(0, 40)
      });

      handleSubmit({
        target: form,
        preventDefault() {},
        stopImmediatePropagation() {},
        stopPropagation() {},
        __fromClickGuard: true
      });
    }, 250);
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
  /* Neutralisation du gestionnaire Webflow .w-form & jQuery .submit()   */
  /* ------------------------------------------------------------------ */

  const bindJQueryBridge = () => {
    const jq = window.jQuery || window.$;
    if (!jq || !jq.fn || !jq.fn.on) return;
    try {
      jq(document).off('submit', '.w-form form');
      jq(document).off('submit.ubepro', 'form');
      jq(document).on('submit.ubepro', 'form', function (jqEvent) {
        const form = this;
        if (!(form instanceof HTMLFormElement)) return;
        if (form.matches(SKIP_SELECTOR) || form.matches(IGNORE_SELECTOR)) return;
        if (!isLeadForm(form) && !hasUsableData(form)) return;
        jqEvent.preventDefault();
        jqEvent.stopImmediatePropagation();
        jqEvent.stopPropagation();
        handleSubmit({
          target: form,
          preventDefault() {},
          stopImmediatePropagation() {},
          stopPropagation() {}
        });
        return false;
      });
    } catch (_) {}
  };

  /* ------------------------------------------------------------------ */
  /* Démarrage                                                           */
  /* ------------------------------------------------------------------ */

  const prepareForm = (form) => {
    try { form.noValidate = true; } catch (_) {}

    // Assure qu'aucun message d'erreur Webflow `.w-form-fail` n'est affiché prématurément.
    clearError(form);

    // Intercepte `form.submit()` natif au cas où un script tiers l'appelle directement.
    if (!form.__ubeproSubmitWrapped) {
      form.__ubeproSubmitWrapped = true;
      form.submit = function () {
        handleSubmit({
          target: form,
          preventDefault() {},
          stopImmediatePropagation() {},
          stopPropagation() {}
        });
      };
    }

    ensureTrackingFields(form);

    const phoneField = findFieldByCanonical(form, 'telephone');
    if (CONFIG.formatPhone && phoneField && !phoneField.dataset.inputmask
        && !/mask/i.test(phoneField.className) && !/_/.test(phoneField.value)) {
      phoneField.addEventListener('input', (event) => {
        const target = event.target;
        if (/_/.test(target.value)) return;
        const formatted = formatPhoneInput(target.value);
        if (formatted !== target.value) target.value = formatted;
      });
    }

    const postalField = findFieldByCanonical(form, 'code_postal');
    if (postalField) {
      postalField.addEventListener('input', (event) => {
        const clean = event.target.value.replace(/\D/g, '').slice(0, 5);
        if (clean !== event.target.value) event.target.value = clean;
      });
    }

    form.addEventListener('ubepro:lead-success', () => {
      form.dispatchEvent(new CustomEvent('ubepro:reset', { bubbles: true }));
    });
  };

  const init = () => {
    submitHandler = handleSubmit;
    clickHandler = handleSubmitClick;

    bindJQueryBridge();
    window.addEventListener('load', () => {
      bindJQueryBridge();
      window.setTimeout(bindJQueryBridge, 50);
    }, { once: true });

    let forms = [];
    try { forms = [...document.querySelectorAll('form')]; } catch (_) { forms = []; }
    forms.forEach((form) => {
      try {
        if (form.matches(SKIP_SELECTOR) || form.matches(IGNORE_SELECTOR)) return;
        prepareForm(form);
      } catch (error) {
        report('init-form-error', { error: String((error && error.message) || error) });
      }
    });

    debugLog('moteur de lead prêt', CONFIG);
    report('moteur-pret', { formulaires: forms.length });
  };

  window.ubeproLead = {
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
      stopImmediatePropagation() {},
      stopPropagation() {}
    }),
    lastResults: null,
    tracking: getTrackingValues,
    isVisible,
    version: '2026-10-23-robuste4',
    diagnose: () => {
      const forms = [...document.querySelectorAll('form')];
      return {
        version: '2026-10-23-robuste4',
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
            champsBloquantsVisibles: fields.filter((f) => isActiveField(f) && isFieldInvalid(f, form))
              .map((f) => f.name || f.id || f.type).slice(0, 8)
          };
        })
      };
    }
  };

  submitHandler = handleSubmit;
  clickHandler = handleSubmitClick;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
