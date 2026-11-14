/**
 * Popup UI without plans: donation link, all controls enabled and persisted.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { DEFAULT_DROPBOX_APP_KEY } from '../background/config.js';
import * as idb from '../background/idb.js';
import { installLocalCodec } from './helpers/local-codec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'popup', 'popup.html'), 'utf8');
const buildFlagsSrc = readFileSync(path.join(root, 'utils', 'buildFlags.js'), 'utf8');
const consentSrc = readFileSync(path.join(root, 'utils', 'consent.js'), 'utf8');
const mediaSettingsSrc = readFileSync(path.join(root, 'utils', 'mediaSettings.js'), 'utf8');

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const dom = new JSDOM(html, { url: 'chrome-extension://test/popup/popup.html', runScripts: 'outside-only' });
const { window } = dom;
window.eval(buildFlagsSrc);
window.eval(mediaSettingsSrc);
window.eval(consentSrc);

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
window.chrome = globalThis.chrome;

// Seed a record whose fields are attacker-controlled (a remote contact chooses
// chat/sender names and message text) before the popup renders.
const hostileRecord = {
  v: 1,
  msgId: 'XSS-1',
  chatId: '123@c.us',
  chatName: '<img src=x onerror="window.__pwned=1">',
  senderName: '<script>window.__pwned=2</script>',
  text: '<svg onload="window.__pwned=3"></svg>',
  ts: Date.now(),
  capturedAt: Date.now(),
  direction: 'in',
  type: 'chat',
  source: 'store',
  isGroup: false,
};
await installLocalCodec();
await idb.putRecords([hostileRecord]);

await import('../popup/popup.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(300);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const el = (id) => window.document.getElementById(id);

check('consent: panel shown before acceptance', el('consentPanel').hidden === false);
check('consent: app hidden before acceptance', el('appContent').hidden === true);
check('consent: accept disabled initially', el('consentAcceptBtn').disabled === true);
check(
  'consent: personal build says media is off by default',
  /off by default/.test(el('consentMediaPolicy').textContent),
  el('consentMediaPolicy').textContent
);

el('consentCheckbox').checked = true;
el('consentCheckbox').dispatchEvent(new window.Event('change'));
check('consent: accept enabled after checkbox', el('consentAcceptBtn').disabled === false);
el('consentAcceptBtn').click();
await sleep(300);
check(
  'consent: current version stored',
  !!storage.waidropConsent && storage.waidropConsent.version === 1,
  JSON.stringify(storage.waidropConsent)
);
check('consent: panel hidden after acceptance', el('consentPanel').hidden === true);
check('consent: app visible after acceptance', el('appContent').hidden === false);

check('donation: button exists', !!el('donateBtn'));
check(
  'donation: says donations do not unlock features',
  /do not unlock features/.test(el('supportCard').textContent)
);
check(
  'donation: links to Buy Me a Coffee',
  el('donateBtn').getAttribute('href') === 'https://buymeacoffee.com/tomaszhabiq',
  el('donateBtn').getAttribute('href')
);
check('donation: opens in a new tab', el('donateBtn').getAttribute('target') === '_blank');
check('donation: uses noopener', /noopener/.test(el('donateBtn').getAttribute('rel') || ''));

const footerLinks = [...window.document.querySelectorAll('.support-line a')].map((a) => a.getAttribute('href'));
check('footer: privacy uses canonical URL', footerLinks.includes('https://waidrop.tnkrd.com/privacy'));
check('footer: terms uses canonical URL', footerLinks.includes('https://waidrop.tnkrd.com/terms'));
check('footer: support uses canonical URL', footerLinks.includes('https://waidrop.tnkrd.com/support'));
check('footer: keeps support email', footerLinks.includes('mailto:waidrop@tnkrd.com'));

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

const messagesList = el('messagesList');
const renderedSender = messagesList.querySelector('.message-sender');
const renderedBody = messagesList.querySelector('.message-body');
const renderedSub = messagesList.querySelector('.message-sub');
check(
  'xss: hostile record rendered',
  messagesList.querySelectorAll('.message-item').length === 1,
  String(messagesList.querySelectorAll('.message-item').length)
);
check(
  'xss: chat name rendered as text',
  !!renderedSender && renderedSender.textContent === hostileRecord.chatName,
  renderedSender && renderedSender.textContent
);
check(
  'xss: sender name rendered as text',
  !!renderedSub && renderedSub.textContent === `${hostileRecord.senderName}:`,
  renderedSub && renderedSub.textContent
);
check(
  'xss: message body rendered as text',
  !!renderedBody && renderedBody.textContent === hostileRecord.text,
  renderedBody && renderedBody.textContent
);
check(
  'xss: no elements injected from record fields',
  messagesList.querySelector('img,svg,script,iframe,object,embed') === null
);
check('xss: payload handlers never executed', window.__pwned === undefined, String(window.__pwned));

el('setAccount').value = 'second-account';
el('saveSettingsBtn').click();
await sleep(150);
check('settings: saved', storage.settings != null);
check('settings: custom alias saved', storage.settings.accountAlias === 'second-account', String(storage.settings.accountAlias));
check('settings: pre-install preference saved', storage.settings.syncPreInstallMessages === true);
check('settings: media mode saved', storage.settings.mediaMode === 'active', String(storage.settings.mediaMode));

console.log(failures === 0 ? '\nALL POPUP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
