/**
 * Stealth invariants: private bridge, forgery resistance, passive media
 * guarantees and background-side hashing/dimensions in one place.
 *
 *   node tests/stealth.test.mjs
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { installWindowPostMessage } from './helpers/fake-message-channel.mjs';
import { TEST_BRIDGE_KEY, startMainHook } from './helpers/main-hook-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mediaSettingsSrc = readFileSync(path.join(root, 'utils', 'mediaSettings.js'), 'utf8');
const parserSrc = readFileSync(path.join(root, 'utils', 'messageParser.js'), 'utf8');
const contentSrc = readFileSync(path.join(root, 'content', 'content.js'), 'utf8');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- page-side stealth invariants -------------------------------------------
const listeners = {};
const msgCollection = {
  on(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
  },
  off(event, cb) {
    listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
  },
};
const chats = {
  '123@c.us': { id: { _serialized: '123@c.us' }, name: 'Stealth Chat' },
};
const chatCollection = {
  get: (id) => chats[id] || null,
  getModelsArray: () => Object.values(chats),
};
const contactCollection = { get: () => null };

let lruCalls = 0;
let lruDelay = 0;
let downloads = 0;

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://web.whatsapp.com/',
  runScripts: 'outside-only',
});
const { window } = dom;
Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
const postCalls = installWindowPostMessage(window);

const sent = [];
const mediaRelay = [];
window.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage(message, callback) {
      sent.push(message);
      if (message && message.type === 'BRIDGE_INIT') {
        if (callback) callback({ status: 'ok', bridgeKey: TEST_BRIDGE_KEY });
        return;
      }
      if (callback) callback({ status: 'stored', stats: {} });
    },
    connect() {
      return {
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
        postMessage(message) {
          mediaRelay.push(message);
        },
      };
    },
  },
  storage: {
    local: {
      get: async () => ({
        settings: {},
      }),
    },
    onChanged: { addListener() {} },
  },
};

const modules = {
  WAWebCollections: { Msg: msgCollection, Chat: chatCollection, Contact: contactCollection },
  WAWebMediaInMemoryBlobCache: { InMemoryMediaBlobCache: { get: () => null } },
  WAWebMediaStore: {
    LruMediaStore: {
      get: async () => {
        lruCalls++;
        if (lruDelay) await sleep(lruDelay);
        return null;
      },
    },
  },
};
window.require = (name) => modules[name];
window.__WAIDROP_EXPOSE_TEST_API__ = true;

const emit = (event, message) => (listeners[event] || []).forEach((cb) => cb(message));

startMainHook(window);
window.eval(mediaSettingsSrc);
window.eval(parserSrc);
window.eval(contentSrc);
await sleep(180);

const api = window.__waArchiveMain;
check('private bridge connected', api && api.getBridgeMode() === 'port', api && api.getBridgeMode());
check('passive config applied over the port', api && api.state.mediaConfig.enabled === true && api.state.mediaConfig.activeFetch === false);

postCalls.length = 0;
emit('add', {
  id: { id: 'STEALTH-TEXT', fromMe: false, remote: { _serialized: '123@c.us' } },
  t: Math.floor(Date.now() / 1000),
  type: 'chat',
  body: 'stealth text',
});
await sleep(250);
const batches = sent.filter((message) => message.type === 'MESSAGE_BATCH');
const records = batches.flatMap((batch) => batch.records || []);
check('store record reaches the background', records.some((record) => record.msgId === 'STEALTH-TEXT'));
check('store record uses the private port', postCalls.length === 0, `${postCalls.length} postMessage call(s)`);

window.postMessage({ source: 'waidrop-config', media: { activeFetch: true } }, '*');
await sleep(50);
check('page-forged config cannot enable active fetch', api.state.mediaConfig.activeFetch === false);

window.postMessage(
  {
    source: 'waidrop-main',
    kind: 'message',
    payload: { v: 1, msgId: 'STEALTH-FORGED', chatId: '123@c.us', direction: 'in', text: 'forged', type: 'chat', source: 'store' },
  },
  '*'
);
await sleep(150);
const forged = sent
  .filter((message) => message.type === 'MESSAGE_BATCH')
  .flatMap((batch) => batch.records || [])
  .find((record) => record.msgId === 'STEALTH-FORGED');
check('page-forged record is ignored', !forged);

emit('add', {
  id: { id: 'STEALTH-FETCHING', fromMe: false, remote: { _serialized: '123@c.us' } },
  t: Math.floor(Date.now() / 1000),
  type: 'image',
  body: 'caption',
  size: 26,
  mediaData: { mediaStage: 'FETCHING', size: 26, mediaBlob: null },
  mediaObject: { filehash: 'stealth-fetching' },
  downloadMedia: async () => {
    downloads++;
  },
});
await sleep(250);
check('passive FETCHING makes no download', downloads === 0, String(downloads));
check('passive FETCHING does not read the LRU store', lruCalls === 0, String(lruCalls));
check(
  'passive FETCHING records not_downloaded',
  sent.some((message) => message.type === 'MEDIA_STATUS' && message.msgId === 'STEALTH-FETCHING' && message.status === 'not_downloaded')
);
check('passive FETCHING relays no media bytes', mediaRelay.length === 0, JSON.stringify(mediaRelay.map((message) => message.type)));

api.setMediaConfig({ activeFetch: true });
lruDelay = 150;
emit('add', {
  id: { id: 'STEALTH-SWITCH', fromMe: false, remote: { _serialized: '123@c.us' } },
  t: Math.floor(Date.now() / 1000),
  type: 'image',
  body: 'switch',
  size: 26,
  mediaData: { mediaStage: 'RESOLVED', size: 26, mediaBlob: null },
  mediaObject: { filehash: 'stealth-switch' },
  downloadMedia: async () => {
    downloads++;
  },
});
await sleep(50);
api.setMediaConfig({ activeFetch: false });
await sleep(300);
check('active -> passive switch cancels the queued download', downloads === 0, String(downloads));
check(
  'active -> passive switch records not_downloaded',
  sent.some((message) => message.type === 'MEDIA_STATUS' && message.msgId === 'STEALTH-SWITCH' && message.status === 'not_downloaded')
);
lruDelay = 0;

api.stop();
dom.window.close();

// --- background-side hashing/dimensions ------------------------------------
const storage = {
  settings: { encryptionKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', uploadEnabled: false },
  dropboxAuth: null,
  installedAt: 0,
};
globalThis.chrome = {
  storage: {
    local: {
      async get(keysToGet) {
        const out = {};
        for (const key of keysToGet) if (key in storage) out[key] = storage[key];
        return out;
      },
      async set(values) {
        Object.assign(storage, values);
      },
      async remove(keysToRemove) {
        for (const key of keysToRemove) delete storage[key];
      },
    },
  },
  runtime: {
    onMessage: { addListener() {} },
    onConnect: { addListener(fn) { globalThis.__stealthConnect = fn; } },
    onInstalled: { addListener() {} },
  },
  alarms: {
    get() {},
    create() {},
    onAlarm: { addListener() {} },
  },
};
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const idb = await import('../background/idb.js');
const { installLocalCodec } = await import('./helpers/local-codec.mjs');
await installLocalCodec();
await idb.clearAll();
await idb.putRecords([
  {
    v: 1,
    msgId: 'STEALTH-MEDIA',
    chatId: '123@c.us',
    chatName: 'Stealth Chat',
    isGroup: false,
    direction: 'in',
    senderName: 'Jane',
    text: 'media',
    ts: Date.now(),
    capturedAt: Date.now(),
    type: 'image',
    source: 'store',
  },
]);

await import('../background/background.js');
await sleep(100);
check('background media port registered', typeof globalThis.__stealthConnect === 'function');

const relayMessages = [];
const relayPort = {
  name: 'waidrop-media',
  onMessage: { addListener(fn) { relayMessages.push(fn); } },
  onDisconnect: { addListener() {} },
  postMessage(message) { this.acked = message; },
};
globalThis.__stealthConnect(relayPort);

const mediaBytes = new TextEncoder().encode('stealth-media-bytes');
const mediaSha = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', mediaBytes))]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');
const mediaBase64 = Buffer.from(mediaBytes).toString('base64');
const originalCreateImageBitmap = globalThis.createImageBitmap;
globalThis.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });

relayMessages[0]({
  type: 'MEDIA_BEGIN',
  id: 'stealth-session',
  msgId: 'STEALTH-MEDIA',
  chatId: '123@c.us',
  kind: 'image',
  mime: 'image/jpeg',
  ts: Date.now(),
  size: mediaBytes.length,
  totalChars: mediaBase64.length,
});
relayMessages[0]({ type: 'MEDIA_CHUNK', id: 'stealth-session', data: mediaBase64 });
relayMessages[0]({ type: 'MEDIA_END', id: 'stealth-session' });
await sleep(300);

const stored = await idb.getMedia('STEALTH-MEDIA');
check('background computes sha256', stored && stored.sha256 === mediaSha, stored && stored.sha256);
check(
  'background computes dimensions',
  stored && stored.width === 800 && stored.height === 600,
  JSON.stringify(stored && { width: stored.width, height: stored.height })
);
check('background acknowledges media', relayPort.acked && relayPort.acked.type === 'MEDIA_ACK' && relayPort.acked.ok === true);

if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
else globalThis.createImageBitmap = originalCreateImageBitmap;

console.log(failures === 0 ? '\nALL STEALTH CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
