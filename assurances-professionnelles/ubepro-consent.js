/**
 * Ubepro — consentement cookies & Google Consent Mode v2 (v1)
 * -----------------------------------------------------------------------------
 * Portage de `cookie-consent.js` (recrutement_it_tech) pour les landing pages
 * existantes. La bannière et la modale sont créées par ce script (aucun markup
 * à ajouter dans les pages, donc aucun risque de casser le design).
 * Les styles sont isolés dans `ubepro-ui.css`, préfixés `.ubp-`.
 *
 * Contrat :
 *   window.__UBEPRO_COOKIE_PREFERENCES__  → préférences courantes
 *   cookie `user_cookie_preferences`      → JSON, 180 jours, SameSite=Lax
 *   événements `ubepro:cookie-preferences` / `ubepro:consent-changed`
 *   dataLayer `cookie_preferences_updated`
 *   gtag('consent','update', …)
 */
(() => {
  'use strict';

  if (window.__UBEPRO_CONSENT_ACTIVE__) return;
  window.__UBEPRO_CONSENT_ACTIVE__ = true;

  const COOKIE_NAME = 'user_cookie_preferences';
  const COOKIE_EXPIRATION_DAYS = 180;
  const TRACKING_STORAGE_KEY = 'ubepro_tracking_v1';
  const TRACKING_PAGE_KEY = 'ubepro_tracking_page_url_v1';
  const MARKETING_TRACKING_KEYS = new Set(['gclid', 'msclkid', 'fbclid']);
  const DEFAULT_PREFERENCES = Object.freeze({ essential: true, analytics: false, marketing: false });

  const CONFIG = Object.assign({
    privacyUrl: '/politique-de-confidentialite-donnees-personnelles/',
    legalUrl: '/mentions-legales/'
  }, window.UBEPRO_STANDARD || {});

  /* ---------------------------------------------------------------- */
  /* Cookie                                                            */
  /* ---------------------------------------------------------------- */

  const normalizePreferences = (value) => ({
    essential: true,
    analytics: value?.analytics === true,
    marketing: value?.marketing === true
  });

  const getBrowserCookie = (name) => {
    const prefix = `${name}=`;
    for (const part of document.cookie.split(';')) {
      const item = part.trim();
      if (item.startsWith(prefix)) {
        const value = item.slice(prefix.length);
        try { return decodeURIComponent(value); } catch (_) { return value; }
      }
    }
    return null;
  };

  const deleteBrowserCookie = (name) => {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  };

  const readStoredPreferences = () => {
    const stored = getBrowserCookie(COOKIE_NAME);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('Format de préférences invalide');
      }
      return normalizePreferences(parsed);
    } catch (_) {
      deleteBrowserCookie(COOKIE_NAME);
      return null;
    }
  };

  const setBrowserCookie = (name, value, days) => {
    const maxAge = Math.max(0, Math.floor(days * 24 * 60 * 60));
    const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}`
      + `; Expires=${expires}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
  };

  /* ---------------------------------------------------------------- */
  /* Consent Mode                                                      */
  /* ---------------------------------------------------------------- */

  const consentModeUpdate = (preferences) => {
    const marketing = preferences.marketing ? 'granted' : 'denied';
    const analytics = preferences.analytics ? 'granted' : 'denied';
    const update = {
      ad_storage: marketing,
      ad_user_data: marketing,
      ad_personalization: marketing,
      analytics_storage: analytics
    };
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', update);
    } else {
      window.dataLayer.push(['consent', 'update', update]);
    }
  };

  const pruneOptionalTrackingStorage = (preferences) => {
    try {
      if (!preferences.analytics && !preferences.marketing) {
        window.sessionStorage.removeItem(TRACKING_STORAGE_KEY);
        window.sessionStorage.removeItem(TRACKING_PAGE_KEY);
        return;
      }
      const stored = window.sessionStorage.getItem(TRACKING_STORAGE_KEY);
      if (stored) {
        const values = JSON.parse(stored);
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          window.sessionStorage.removeItem(TRACKING_STORAGE_KEY);
        } else {
          for (const key of Object.keys(values)) {
            const allowed = MARKETING_TRACKING_KEYS.has(key)
              ? preferences.marketing
              : preferences.analytics;
            if (!allowed) delete values[key];
          }
          if (Object.keys(values).length) {
            window.sessionStorage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(values));
          } else {
            window.sessionStorage.removeItem(TRACKING_STORAGE_KEY);
          }
        }
      }
      if (!preferences.analytics) window.sessionStorage.removeItem(TRACKING_PAGE_KEY);
    } catch (_) { /* stockage indisponible */ }
  };

  /* ---------------------------------------------------------------- */
  /* Markup (créé à la volée, aucun impact sur le HTML existant)       */
  /* ---------------------------------------------------------------- */

  const BANNER_HTML = `
<div class="ubp-cookie-banner" id="ubp-content-cookie" hidden>
  <section class="ubp-cookie-banner__inner" role="region"
           aria-labelledby="ubp-cookie-banner-title" aria-describedby="ubp-cookie-banner-description">
    <div class="ubp-cookie-banner__copy">
      <p class="ubp-cookie-eyebrow">Vos préférences de confidentialité</p>
      <h2 id="ubp-cookie-banner-title">Votre choix concernant les cookies.</h2>
      <p id="ubp-cookie-banner-description">Les cookies essentiels assurent le bon fonctionnement du
        formulaire. Les mesures d'audience et le suivi marketing sont facultatifs et ne sont activés
        qu'avec votre consentement explicite.</p>
      <a href="${CONFIG.privacyUrl}" target="_blank" rel="noopener noreferrer">Lire notre politique de confidentialité ↗</a>
    </div>
    <div class="ubp-cookie-banner__actions" aria-label="Choisir les cookies">
      <button class="ubp-cookie-button ubp-cookie-button--primary" id="ubp-accept-all-banner-btn" type="button">Tout accepter</button>
      <button class="ubp-cookie-button ubp-cookie-button--secondary" id="ubp-manage-preferences-banner-btn" type="button">Personnaliser</button>
      <button class="ubp-cookie-button ubp-cookie-button--secondary" id="ubp-continue-without-accepting-btn" type="button">Continuer sans accepter</button>
    </div>
  </section>
</div>`;

  const MODAL_HTML = `
<div class="ubp-cookie-modal" id="ubp-content-cookie-modal" hidden>
  <section class="ubp-cookie-modal__panel" role="dialog" aria-modal="true"
           aria-labelledby="ubp-cookie-modal-title" aria-describedby="ubp-cookie-modal-description" tabindex="-1">
    <header class="ubp-cookie-modal__header">
      <div>
        <p class="ubp-cookie-eyebrow">Gestion détaillée</p>
        <h2 id="ubp-cookie-modal-title">Paramétrer vos cookies</h2>
      </div>
      <button class="ubp-cookie-modal__close" id="ubp-modal-close-btn" type="button" aria-label="Fermer la fenêtre de préférences">✕</button>
    </header>
    <p class="ubp-cookie-modal__intro" id="ubp-cookie-modal-description">Chaque catégorie est indépendante.
      Les cookies essentiels garantissent la sécurité et la soumission du formulaire et restent actifs.</p>

    <div class="ubp-cookie-category">
      <div class="ubp-cookie-category__text">
        <h3>Cookies essentiels</h3>
        <p>Mémorisation de vos préférences et protection contre les envois abusifs de formulaire.</p>
      </div>
      <div class="ubp-cookie-category__control">
        <input type="checkbox" id="ubp-essentials-toggle" checked disabled>
        <label for="ubp-essentials-toggle" class="ubp-sr-only">Cookies essentiels — toujours actifs</label>
      </div>
    </div>

    <div class="ubp-cookie-category">
      <div class="ubp-cookie-category__text">
        <h3>Mesure d'audience</h3>
        <p>Statistiques anonymes d'utilisation pour améliorer l'expérience de navigation.</p>
      </div>
      <div class="ubp-cookie-category__control">
        <input type="checkbox" id="ubp-analytics-toggle">
        <label for="ubp-analytics-toggle" class="ubp-sr-only">Activer la mesure d'audience</label>
      </div>
    </div>

    <div class="ubp-cookie-category">
      <div class="ubp-cookie-category__text">
        <h3>Marketing</h3>
        <p>Mesure de l'efficacité de nos campagnes de communication ciblées.</p>
      </div>
      <div class="ubp-cookie-category__control">
        <input type="checkbox" id="ubp-marketing-toggle">
        <label for="ubp-marketing-toggle" class="ubp-sr-only">Activer le marketing</label>
      </div>
    </div>

    <div class="ubp-cookie-modal__actions">
      <button class="ubp-cookie-button ubp-cookie-button--primary" id="ubp-save-preferences-modal-btn" type="button">Enregistrer mes choix</button>
      <button class="ubp-cookie-button ubp-cookie-button--secondary" id="ubp-accept-all-modal-btn" type="button">Tout accepter</button>
      <button class="ubp-cookie-button ubp-cookie-button--secondary" id="ubp-refuse-all-modal-btn" type="button">Tout refuser</button>
    </div>
    <p class="ubp-cookie-modal__note">Votre sélection est conservée pendant six mois et reste modifiable
      à tout moment depuis le lien « Gérer les cookies » en pied de page.</p>
  </section>
</div>`;

  let elements = {};
  let returnFocusTo = null;

  const mount = () => {
    const holder = document.createElement('div');
    holder.innerHTML = BANNER_HTML + MODAL_HTML;
    document.body.append(...holder.children);

    elements = {
      cookieBanner: document.getElementById('ubp-content-cookie'),
      cookieModal: document.getElementById('ubp-content-cookie-modal'),
      acceptAllBannerBtn: document.getElementById('ubp-accept-all-banner-btn'),
      managePreferencesBannerBtn: document.getElementById('ubp-manage-preferences-banner-btn'),
      continueWithoutAcceptingBtn: document.getElementById('ubp-continue-without-accepting-btn'),
      savePreferencesModalBtn: document.getElementById('ubp-save-preferences-modal-btn'),
      acceptAllModalBtn: document.getElementById('ubp-accept-all-modal-btn'),
      refuseAllModalBtn: document.getElementById('ubp-refuse-all-modal-btn'),
      modalCloseBtn: document.getElementById('ubp-modal-close-btn'),
      analyticsToggle: document.getElementById('ubp-analytics-toggle'),
      marketingToggle: document.getElementById('ubp-marketing-toggle'),
      essentialToggle: document.getElementById('ubp-essentials-toggle')
    };
    elements.modalPanel = elements.cookieModal?.querySelector('.ubp-cookie-modal__panel');
  };

  const hideBannerAndModal = () => {
    if (elements.cookieBanner) elements.cookieBanner.hidden = true;
    if (elements.cookieModal) elements.cookieModal.hidden = true;
    document.body.classList.remove('ubp-cookie-modal-open');
  };

  const showBanner = () => { if (elements.cookieBanner) elements.cookieBanner.hidden = false; };

  const applyPreferencesToUI = (preferences) => {
    if (elements.analyticsToggle) elements.analyticsToggle.checked = preferences.analytics;
    if (elements.marketingToggle) elements.marketingToggle.checked = preferences.marketing;
    if (elements.essentialToggle) {
      elements.essentialToggle.checked = true;
      elements.essentialToggle.disabled = true;
    }
  };

  const showModal = (opener) => {
    if (!elements.cookieModal) return;
    returnFocusTo = opener || document.activeElement;
    applyPreferencesToUI(readStoredPreferences() || DEFAULT_PREFERENCES);
    if (elements.cookieBanner) elements.cookieBanner.hidden = true;
    elements.cookieModal.hidden = false;
    document.body.classList.add('ubp-cookie-modal-open');
    elements.modalPanel?.focus({ preventScroll: true });
  };

  const closeModal = () => {
    if (!elements.cookieModal) return;
    elements.cookieModal.hidden = true;
    document.body.classList.remove('ubp-cookie-modal-open');
    if (!readStoredPreferences()) {
      showBanner();
      elements.managePreferencesBannerBtn?.focus({ preventScroll: true });
    } else if (returnFocusTo?.isConnected) {
      returnFocusTo.focus({ preventScroll: true });
    }
  };

  const savePreferences = (value) => {
    const preferences = normalizePreferences(value);
    setBrowserCookie(COOKIE_NAME, preferences, COOKIE_EXPIRATION_DAYS);
    window.__UBEPRO_COOKIE_PREFERENCES__ = preferences;
    pruneOptionalTrackingStorage(preferences);

    consentModeUpdate(preferences);
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'cookie_preferences_updated',
      consent_analytics: preferences.analytics,
      consent_marketing: preferences.marketing
    });

    try {
      window.dispatchEvent(new CustomEvent('ubepro:cookie-preferences', { detail: preferences }));
      document.dispatchEvent(new CustomEvent('ubepro:consent-changed', { detail: preferences }));
    } catch (_) {}

    hideBannerAndModal();
  };

  /* ---------------------------------------------------------------- */
  /* Initialisation                                                    */
  /* ---------------------------------------------------------------- */

  const init = () => {
    if (document.getElementById('ubp-content-cookie')) return;  // déjà monté
    mount();

    const savedPreferences = readStoredPreferences();
    window.__UBEPRO_COOKIE_PREFERENCES__ = savedPreferences || DEFAULT_PREFERENCES;
    applyPreferencesToUI(window.__UBEPRO_COOKIE_PREFERENCES__);
    pruneOptionalTrackingStorage(window.__UBEPRO_COOKIE_PREFERENCES__);

    consentModeUpdate(window.__UBEPRO_COOKIE_PREFERENCES__);
    if (savedPreferences) hideBannerAndModal();
    else showBanner();

    const acceptAll = () => savePreferences({ essential: true, analytics: true, marketing: true });
    const refuseOptional = () => savePreferences(DEFAULT_PREFERENCES);

    elements.acceptAllBannerBtn?.addEventListener('click', acceptAll);
    elements.acceptAllModalBtn?.addEventListener('click', acceptAll);
    elements.continueWithoutAcceptingBtn?.addEventListener('click', refuseOptional);
    elements.refuseAllModalBtn?.addEventListener('click', refuseOptional);
    elements.managePreferencesBannerBtn?.addEventListener('click', (event) => showModal(event.currentTarget));
    elements.savePreferencesModalBtn?.addEventListener('click', () => {
      savePreferences({
        essential: true,
        analytics: elements.analyticsToggle?.checked === true,
        marketing: elements.marketingToggle?.checked === true
      });
    });
    elements.modalCloseBtn?.addEventListener('click', closeModal);

    document.addEventListener('keydown', (event) => {
      if (!elements.cookieModal || elements.cookieModal.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== 'Tab' || !elements.modalPanel) return;
      const focusable = [...elements.modalPanel.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )].filter((element) => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    // Lien « Gérer les cookies » : n'importe quel élément portant
    // #open-cookie-preferences-btn, [data-cookie-manage] ou .btn-cookie-link.
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest(
        '#open-cookie-preferences-btn, [data-cookie-manage], .btn-cookie-link, [data-ubp-cookie-manage]'
      );
      if (!trigger) return;
      event.preventDefault();
      showModal(trigger);
    });

    window.ubeproConsent = {
      version: '2026-10-23-standard1',
      open: () => showModal(document.activeElement),
      get: () => readStoredPreferences(),
      set: (value) => savePreferences(value),
      reset: () => {
        deleteBrowserCookie(COOKIE_NAME);
        window.location.reload();
      }
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
