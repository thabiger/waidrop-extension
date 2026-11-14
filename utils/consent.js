/**
 * First-run consent gate.
 *
 * Chrome Web Store user-data policy: the prominent disclosure and consent must
 * happen in the product UI before the extension handles user data. This module
 * is loaded by the content script, the popup and the service worker.
 */
(function (root) {
  'use strict';

  const CONSENT_VERSION = 1;
  const STORAGE_KEY = 'waidropConsent';
  const ACCEPT_MESSAGE = 'WA_CONSENT_ACCEPTED';

  let waiters = null;

  async function getConsent() {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEY]);
      return result && result[STORAGE_KEY] ? result[STORAGE_KEY] : null;
    } catch (e) {
      return null;
    }
  }

  async function hasConsent() {
    const consent = await getConsent();
    return !!consent && consent.version === CONSENT_VERSION;
  }

  async function acceptConsent() {
    const value = { version: CONSENT_VERSION, acceptedAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEY]: value });
    return value;
  }

  function notifyAccepted() {
    if (!waiters) return;
    const pending = waiters;
    waiters = null;
    for (const resolve of pending) resolve(true);
  }

  function addWaiter(resolve) {
    waiters = waiters || new Set();
    waiters.add(resolve);
  }

  /**
   * Resolves immediately when this browser profile has already accepted the
   * current consent version. Otherwise waits for the service worker's
   * WA_CONSENT_ACCEPTED broadcast, re-checking storage to close the race
   * between the first check and listener registration.
   */
  async function waitForConsent() {
    if (await hasConsent()) return true;

    return new Promise((resolve) => {
      addWaiter(resolve);
      try {
        chrome.runtime.onMessage.addListener((message) => {
          if (message && message.type === ACCEPT_MESSAGE) notifyAccepted();
        });
      } catch (e) {
        /* runtime messaging unavailable */
      }
      hasConsent().then((granted) => {
        if (granted) notifyAccepted();
      });
    });
  }

  root.WAConsent = {
    CONSENT_VERSION,
    STORAGE_KEY,
    ACCEPT_MESSAGE,
    getConsent,
    hasConsent,
    acceptConsent,
    waitForConsent,
    notifyAccepted,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
