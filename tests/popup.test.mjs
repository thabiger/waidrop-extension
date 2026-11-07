/**
 * Popup UI without plans: donation link, all controls enabled and persisted.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { DEFAULT_DROPBOX_APP_KEY } from '../background/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'popup', 'popup.html'), 'utf8');
const mediaSettingsSrc = readFileSync(path.join(root, 'utils', 'mediaSettings.js'), 'utf8');

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const dom = new JSDOM(html, { url: 'chrome-extension://test/popup/popup.html', runScripts: 'outside-only' });
const { window } = dom;
window.eval(mediaSettingsSrc);

const storage = {
  settings: {
    uploadEnabled: true,
    accountAlias: 'custom-account',
    dropboxAppKey: DEFAULT_DROPBOX_APP_KEY,
    archiveMode: 'encrypted',
    encryptionKey: KEY,
    encryptionKeyAcknowledged: true,
    syncPreInstallMessages: true,
    mediaMode: 'active',
    mediaCaptureEnabled: true,
    mediaActiveFetchEnabled: true,
    offloadEnabled: true,
    offloadRetentionDays: 1,
  },
  dropboxAuth: { accessToken: 'token', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000, accountId: 'dbid' },
};

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage() {
      return Promise.resolve({ status: 'ok' });
    },
    onMessage: {
      addListener() {},
    },
  },
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const key of keys) if (key in storage) out[key] = storage[key];
        return out;
      },
      async set(values) {
        Object.assign(storage, values);
      },
      async remove(keys) {
        for (const key of keys) delete storage[key];
      },
    },
  },
  identity: {
    getRedirectURL: () => 'https://test.chromiumapp.org/',
  },
};

await import('../popup/popup.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(300);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const el = (id) => window.document.getElementById(id);

check('donation: button exists', !!el('donateBtn'));
check(
  'donation: links to Buy Me a Coffee',
  el('donateBtn').getAttribute('href') === 'https://buymeacoffee.com/tomaszhabiq',
  el('donateBtn').getAttribute('href')
);
check('donation: opens in a new tab', el('donateBtn').getAttribute('target') === '_blank');
check('donation: uses noopener', /noopener/.test(el('donateBtn').getAttribute('rel') || ''));
check('plans: no upgrade control', el('upgradeBtn') === null);
check('plans: no purchase controls', el('managePurchaseBtn') === null && el('refreshLicenseBtn') === null);
check('plans: no plan card', el('planCard') === null);
check('plans: no quota UI', el('syncQuota') === null && el('planQuotaNotice') === null);

check('settings: account alias enabled', el('setAccount').disabled === false);
check('settings: account alias loaded', el('setAccount').value === 'custom-account', el('setAccount').value);
check('settings: pre-install sync enabled', el('setSyncPreInstall').disabled === false);
check('settings: pre-install sync loaded', el('setSyncPreInstall').checked === true);
check('settings: passive option enabled', window.document.querySelector('input[name="mediaMode"][value="passive"]').disabled === false);
check('settings: active option enabled', window.document.querySelector('input[name="mediaMode"][value="active"]').disabled === false);
check('settings: active mode selected', window.document.querySelector('input[name="mediaMode"][value="active"]').checked === true);
check('settings: media advanced enabled', el('setMediaViewOnce').disabled === false);

el('setAccount').value = 'second-account';
el('saveSettingsBtn').click();
await sleep(150);
check('settings: saved', storage.settings != null);
check('settings: custom alias saved', storage.settings.accountAlias === 'second-account', String(storage.settings.accountAlias));
check('settings: pre-install preference saved', storage.settings.syncPreInstallMessages === true);
check('settings: media mode saved', storage.settings.mediaMode === 'active', String(storage.settings.mediaMode));

console.log(failures === 0 ? '\nALL POPUP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
