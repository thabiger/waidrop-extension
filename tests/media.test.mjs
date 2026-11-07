/**
 * Full-resolution media pipeline: crypto vector, MAIN-world capture, IDB
 * metadata merging and encrypted Dropbox upload.
 *
 *   node tests/media.test.mjs
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { startMainHook } from './helpers/main-hook-loader.mjs';
import { DEFAULT_DROPBOX_APP_KEY } from '../background/config.js';
import { installLocalCodec } from './helpers/local-codec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
await installLocalCodec();
const MEDIA_PATH = 'chat=8e59af6366e6c4aa/dt=2026-10-17/media-00112233445566778899aabbccddeeff.enc';
const MEDIA_NONCE = Uint8Array.from({ length: 12 }, (_, i) => i);
const MEDIA_PLAINTEXT = new TextEncoder().encode('hello media');
const EXPECTED_MEDIA_ENVELOPE =
  '57414d5201000102030405060708090a0b6b80213e9b6eb042879d701327849c3fb0940883987c5986dfa8a5';
const EXPECTED_MEDIA_HASH = 'b9b8b4fb8d6daf44d4cd9d39853e9ade';

const cryptoMod = await import('../background/crypto.js');
const keys = await cryptoMod.deriveKeys(KEY);

check('media hash known answer', (await cryptoMod.mediaHash(keys, 'ACE81BE4695181CE094591658F7D7844')) === EXPECTED_MEDIA_HASH);
check(
  'media envelope known answer',
  Buffer.from(await cryptoMod.encryptMedia(keys, MEDIA_PATH, MEDIA_PLAINTEXT, { nonce: MEDIA_NONCE })).toString('hex') ===
    EXPECTED_MEDIA_ENVELOPE
);
const mediaEnvelope = await cryptoMod.encryptMedia(keys, MEDIA_PATH, MEDIA_PLAINTEXT, { nonce: MEDIA_NONCE });
check(
  'media roundtrip',
  Buffer.from(await cryptoMod.decryptMedia(keys, MEDIA_PATH, mediaEnvelope)).toString('utf8') === 'hello media'
);
check('media path is bound by AAD', await (async () => {
  try {
    await cryptoMod.decryptMedia(keys, MEDIA_PATH + '.x', mediaEnvelope);
    return false;
  } catch (e) {
    return true;
  }
})());

// --- MAIN-world capture -----------------------------------------------------
function makeWindow(options = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
  });
  const posted = [];
  dom.window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'waidrop-main') posted.push(event.data);
  });
  const listeners = {};
  const mediaBytes = new TextEncoder().encode('full-resolution-image-bytes');
  const fakeBlob = {
    type: 'image/jpeg',
    size: mediaBytes.length,
    arrayBuffer: async () => mediaBytes.buffer.slice(0),
    forceToBlob: () => fakeBlob,
  };
  const state = { downloaded: 0, blobReady: false, lruCalls: 0, requireCalls: {} };
  const Msg = {
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    off(event, cb) {
      listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
    },
  };
  const collections = {
    Msg,
    Chat: { get: () => ({ name: 'Test Chat' }), getModelsArray: () => [] },
    Contact: { get: () => null },
  };
  Object.defineProperty(dom.window, 'crypto', { value: webcrypto, configurable: true });
  dom.window.require = (name) => {
    state.requireCalls[name] = (state.requireCalls[name] || 0) + 1;
    if (name === 'WAWebCollections') return collections;
    if (name === 'WAWebMediaInMemoryBlobCache') {
      return { InMemoryMediaBlobCache: { get: () => (state.blobReady ? fakeBlob : null) } };
    }
    if (name === 'WAWebMediaStore' && options.lru) {
      return {
        LruMediaStore: {
          get: async () => {
            state.lruCalls++;
            if (options.lruDelay) await sleep(options.lruDelay);
            return options.lruBytes === false ? null : mediaBytes.buffer.slice(0);
          },
        },
      };
    }
    return undefined;
  };
  dom.window.__WAIDROP_EXPOSE_TEST_API__ = true;
  // Plain jsdom: the hook takes the legacy postMessage transport.
  startMainHook(dom.window);
  if (!options.unconfigured) dom.window.__waArchiveMain.setMediaConfig({ enabled: true });
  const emit = (event, message) => (listeners[event] || []).forEach((cb) => cb(message));
  return { dom, posted, emit, state, mediaBytes };
}

function imageMessage(overrides = {}) {
  return {
    id: { id: 'IMG-1', fromMe: false, remote: { _serialized: '123@c.us' } },
    t: Math.floor(Date.now() / 1000),
    type: 'image',
    body: 'caption',
    size: 26,
    mediaData: { mediaStage: 'RESOLVED', size: 26, mediaBlob: null },
    mediaObject: { filehash: 'file-hash' },
    downloadMedia: async () => {},
    ...overrides,
  };
}

{
  const { dom, posted, emit, state, mediaBytes } = makeWindow();
  await sleep(40);
  const msg = imageMessage({
    downloadMedia: async () => {
      state.downloaded++;
      state.blobReady = true;
    },
  });
  emit('add', msg);
  await sleep(300);
  check('passive: no download on add', state.downloaded === 0, String(state.downloaded));
  check('passive: media not posted without cache', !posted.some((item) => item.kind === 'media'));
  const deferred = posted.find((item) => item.kind === 'media-status');
  check('passive: not_downloaded status', deferred && deferred.payload.status === 'not_downloaded', JSON.stringify(deferred && deferred.payload));

  state.blobReady = true;
  emit('change:mediaStage', msg);
  await sleep(400);
  const media = posted.find((item) => item.kind === 'media');
  check('passive: change event captures cached media', !!media, JSON.stringify(posted.map((item) => item.kind)));
  check('passive: still no download', state.downloaded === 0, String(state.downloaded));
  check('passive: msgId/mime/size', media && media.payload.msgId === 'IMG-1' && media.payload.mime === 'image/jpeg', JSON.stringify(media && media.payload));
  check('passive: bytes retained', media && media.payload.bytes.byteLength === mediaBytes.length, media && String(media.payload.bytes.byteLength));
  check('passive: hash deferred to background', media && media.payload.sha256 === undefined, media && String(media.payload.sha256));
  check(
    'passive: dimensions deferred to background',
    media && media.payload.width === undefined && media.payload.height === undefined,
    media && JSON.stringify({ width: media.payload.width, height: media.payload.height })
  );
  check(
    'passive: media module required once',
    state.requireCalls['WAWebMediaInMemoryBlobCache'] === 1,
    JSON.stringify(state.requireCalls)
  );
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

{
  const { dom, posted, emit, state } = makeWindow();
  await sleep(40);
  dom.window.__waArchiveMain.setMediaConfig({ activeFetch: true });
  const msg = imageMessage({
    id: { id: 'IMG-ACTIVE', fromMe: false, remote: { _serialized: '123@c.us' } },
    downloadMedia: async () => {
      state.downloaded++;
      state.blobReady = true;
    },
  });
  emit('add', msg);
  await sleep(500);
  check('active: download called once', state.downloaded === 1, String(state.downloaded));
  const media = posted.find((item) => item.kind === 'media');
  check('active: media posted', !!media && media.payload.msgId === 'IMG-ACTIVE', JSON.stringify(media && media.payload));
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

{
  const { dom, posted, emit, state } = makeWindow({ lru: true, lruDelay: 200, lruBytes: false });
  await sleep(40);
  dom.window.__waArchiveMain.setMediaConfig({ activeFetch: true });
  const msg = imageMessage({
    id: { id: 'IMG-SWITCH', fromMe: false, remote: { _serialized: '123@c.us' } },
    mediaObject: { filehash: 'switch-hash' },
    downloadMedia: async () => {
      state.downloaded++;
      state.blobReady = true;
    },
  });
  emit('add', msg);
  await sleep(60);
  dom.window.__waArchiveMain.setMediaConfig({ activeFetch: false });
  await sleep(500);
  check('active->passive: no download after mode switch', state.downloaded === 0, String(state.downloaded));
  check(
    'active->passive: marked not_downloaded',
    posted.some((item) => item.kind === 'media-status' && item.payload.status === 'not_downloaded'),
    JSON.stringify(posted.filter((item) => item.kind === 'media-status').map((item) => item.payload))
  );
  check('active->passive: LRU read once', state.lruCalls === 1, String(state.lruCalls));
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

{
  const { dom, posted, emit, state } = makeWindow({ lru: true });
  await sleep(40);
  const msg = imageMessage({
    id: { id: 'IMG-LRU', fromMe: false, remote: { _serialized: '123@c.us' } },
    downloadMedia: async () => {
      state.downloaded++;
    },
  });
  emit('add', msg);
  await sleep(400);
  const media = posted.find((item) => item.kind === 'media');
  check('passive: LRU cache captured', !!media && media.payload.msgId === 'IMG-LRU', JSON.stringify(media && media.payload));
  check('passive: LRU capture made no download', state.downloaded === 0, String(state.downloaded));
  check('passive: LRU cache read once', state.lruCalls === 1, String(state.lruCalls));
  check('passive: LRU module required once', state.requireCalls['WAWebMediaStore'] === 1, JSON.stringify(state.requireCalls));
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

{
  const { dom, posted, emit, state } = makeWindow({ lru: true });
  await sleep(40);
  const msg = imageMessage({
    id: { id: 'IMG-FETCHING', fromMe: false, remote: { _serialized: '123@c.us' } },
    mediaData: { mediaStage: 'FETCHING', size: 26, mediaBlob: null },
    mediaObject: { filehash: 'fetching-hash' },
    downloadMedia: async () => {
      state.downloaded++;
      state.blobReady = true;
    },
  });
  emit('add', msg);
  await sleep(250);
  check('passive: FETCHING stage does not read LRU', state.lruCalls === 0, String(state.lruCalls));
  check(
    'passive: FETCHING stage does not require media store',
    !state.requireCalls['WAWebMediaStore'],
    JSON.stringify(state.requireCalls)
  );
  check('passive: FETCHING stage makes no download', state.downloaded === 0, String(state.downloaded));
  check(
    'passive: FETCHING stage marks not_downloaded',
    posted.some((item) => item.kind === 'media-status' && item.payload.status === 'not_downloaded'),
    JSON.stringify(posted.filter((item) => item.kind === 'media-status').map((item) => item.payload))
  );
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

{
  const { dom, posted, emit } = makeWindow();
  await sleep(40);
  const msg = imageMessage({ id: { id: 'IMG-VO', fromMe: false, remote: { _serialized: '123@c.us' } }, isViewOnce: true });
  emit('add', msg);
  await sleep(150);
  const status = posted.find((item) => item.kind === 'media-status');
  check('main: view-once skipped by default', status && status.payload.status === 'view_once', JSON.stringify(status && status.payload));
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

{
  const { dom, posted, emit } = makeWindow();
  await sleep(40);
  dom.window.__waArchiveMain.setMediaConfig({ enabled: false });
  emit('add', imageMessage({ id: { id: 'IMG-OFF', fromMe: false, remote: { _serialized: '123@c.us' } } }));
  await sleep(150);
  check('main: capture disabled', !posted.some((item) => item.kind === 'media' || item.kind === 'media-status'));
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

{
  const { dom, posted, emit, state } = makeWindow({ unconfigured: true });
  await sleep(40);
  check('main: media starts disabled before config', dom.window.__waArchiveMain.state.mediaConfig.enabled === false);
  emit(
    'add',
    imageMessage({
      id: { id: 'IMG-UNCONFIGURED', fromMe: false, remote: { _serialized: '123@c.us' } },
      downloadMedia: async () => {
        state.downloaded++;
      },
    })
  );
  await sleep(150);
  check('main: unconfigured media is not captured', !posted.some((item) => item.kind === 'media' || item.kind === 'media-status'));
  check('main: unconfigured media is not downloaded', state.downloaded === 0, String(state.downloaded));
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

// --- IDB + encrypted upload --------------------------------------------------
const idb = await import('../background/idb.js');
const uploader = await import('../background/uploader.js');
const dropbox = await import('../background/dropbox.js');

const storage = {
  settings: null,
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
};

let uploads = [];
function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/oauth2/token')) return jsonResponse({ access_token: 'refreshed', expires_in: 14400 });
  if (String(url).endsWith('/files/create_folder_v2')) return jsonResponse({});
  if (String(url).endsWith('/files/upload')) {
    const arg = JSON.parse(init.headers['dropbox-api-arg']);
    uploads.push({
      path: arg.path,
      bytes: init.body,
      contentType: init.headers['content-type'],
    });
    return jsonResponse({
      size: init.body.byteLength,
      content_hash: await cryptoMod.dropboxContentHash(init.body),
      rev: `rev-${uploads.length}`,
      path_display: arg.path,
    });
  }
  return jsonResponse({});
};

await idb.clearAll();
storage.settings = {
  uploadEnabled: true,
  accountAlias: 'primary',
  dropboxAppKey: DEFAULT_DROPBOX_APP_KEY,
  archiveMode: 'encrypted',
  encryptionKey: KEY,
  encryptionKeyAcknowledged: true,
};
storage.dropboxAuth = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiresAt: Date.now() + 3600_000,
  accountName: 'Test',
};
dropbox.resetFolderCache();

const T = new Date(2026, 9, 17, 10, 0, 0).getTime();
const mediaBytes = new TextEncoder().encode('full-resolution-image-bytes');
const sha256 = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', mediaBytes))]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

await idb.putRecords([
  {
    v: 1,
    msgId: 'IMG-1',
    chatId: '123@c.us',
    chatName: 'Chat',
    isGroup: false,
    direction: 'in',
    senderName: 'Jane',
    text: 'caption',
    ts: T,
    capturedAt: T + 100,
    type: 'image',
    source: 'store',
  },
]);
await idb.putMedia({
  msgId: 'IMG-1',
  chatId: '123@c.us',
  ts: T,
  kind: 'image',
  mime: 'image/jpeg',
  bytes: mediaBytes.buffer.slice(0),
  byteLength: mediaBytes.length,
  sha256,
  status: 'pending',
});

let record = (await idb.getMessagesByIds(['IMG-1']))[0];
check('idb: media attached to record', record && record.media && record.media.status === 'pending', JSON.stringify(record && record.media));

const stats = await uploader.runUpload();
check('upload: media uploaded', stats.mediaUploaded === 1, JSON.stringify(stats));
check('upload: no error', !stats.error, String(stats.error));
const mediaUpload = uploads.find((item) => item.path.includes('/media-'));
check('upload: media object path', mediaUpload && /\/account=primary\/chat=[0-9a-f]{16}\/dt=2026-10-17\/media-[0-9a-f]{32}\.enc$/.test(mediaUpload.path), mediaUpload && mediaUpload.path);
const relative = mediaUpload ? mediaUpload.path.replace(/^\/account=primary\//, '') : '';
const decrypted = mediaUpload ? await cryptoMod.decryptMedia(keys, relative, mediaUpload.bytes) : null;
check('upload: media decrypts', decrypted && Buffer.from(decrypted).toString('utf8') === 'full-resolution-image-bytes');

record = (await idb.getMessagesByIds(['IMG-1']))[0];
const storedMedia = await idb.getMedia('IMG-1');
check('upload: record media marked stored', record && record.media && record.media.status === 'stored' && !!record.media.path, JSON.stringify(record && record.media));
check('upload: local bytes cleared', storedMedia && storedMedia.bytes === null);

const partUpload = uploads.find((item) => item.path.includes('/part-'));
const partText = partUpload ? await cryptoMod.decryptObject(keys, partUpload.bytes) : '';
check('upload: part carries stored media metadata', partText.includes('"status":"stored"'), partText.slice(0, 200));

{
  const { dom, posted, emit, state } = makeWindow();
  await sleep(40);
  dom.window.__waArchiveMain.setMediaConfig({ activeFetch: true });
  const msg = imageMessage({
    id: { id: 'IMG-OLD', fromMe: false, remote: { _serialized: '123@c.us' } },
    t: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
    downloadMedia: async () => {
      state.downloaded++;
      state.blobReady = true;
    },
  });
  emit('add', msg);
  await sleep(300);
  const status = posted.find((item) => item.kind === 'media-status');
  check('active: old media not auto-downloaded', state.downloaded === 0, String(state.downloaded));
  check('active: old media marked not_downloaded', status && status.payload.status === 'not_downloaded', JSON.stringify(status && status.payload));
  dom.window.__waArchiveMain.stop();
  dom.window.close();
}

// --- media store status ranking ------------------------------------------------
{
  await idb.clearAll();
  const bytes = new TextEncoder().encode('cached').buffer;
  await idb.putMedia({ msgId: 'MR-1', chatId: '123@c.us', status: 'pending', bytes, byteLength: 6 });
  await idb.putMedia({ msgId: 'MR-1', status: 'not_downloaded', byteLength: 0 });
  let entry = await idb.getMedia('MR-1');
  check('media store: not_downloaded cannot replace pending', entry && entry.status === 'pending' && entry.bytes, JSON.stringify(entry && { status: entry.status, hasBytes: !!entry.bytes }));

  await idb.setMediaStatus('MR-1', 'not_downloaded');
  entry = await idb.getMedia('MR-1');
  check('media store: setMediaStatus cannot downgrade pending', entry && entry.status === 'pending', JSON.stringify(entry && entry.status));
  await idb.clearAll();
}

// --- not_downloaded ranking ---------------------------------------------------
{
  await idb.clearAll();
  const base = {
    v: 1,
    msgId: 'ND-1',
    chatId: '123@c.us',
    chatName: 'Chat',
    isGroup: false,
    direction: 'in',
    senderName: 'Jane',
    text: 'pending media',
    ts: T,
    capturedAt: T,
    type: 'image',
    source: 'store',
  };
  await idb.putRecords([{ ...base, media: { status: 'not_downloaded', kind: 'image', capturedAt: T + 300 } }]);
  let rec = (await idb.getMessagesByIds(['ND-1']))[0];
  check('idb: not_downloaded status stored', rec && rec.media && rec.media.status === 'not_downloaded', JSON.stringify(rec && rec.media));

  await idb.putRecords([
    { ...base, media: { status: 'stored', kind: 'image', path: 'chat=0000000000000000/dt=2026-10-17/media-00000000000000000000000000000000.enc', capturedAt: T + 100 } },
  ]);
  rec = (await idb.getMessagesByIds(['ND-1']))[0];
  check('idb: stored beats newer not_downloaded', rec && rec.media && rec.media.status === 'stored', JSON.stringify(rec && rec.media));

  await idb.putRecords([{ ...base, media: { status: 'not_downloaded', kind: 'image', capturedAt: T + 500 } }]);
  rec = (await idb.getMessagesByIds(['ND-1']))[0];
  check('idb: not_downloaded cannot downgrade stored', rec && rec.media && rec.media.status === 'stored', JSON.stringify(rec && rec.media));
  await idb.clearAll();
}

// --- media port relay -------------------------------------------------------
{
  const connectListeners = [];
  globalThis.chrome.runtime = {
    onMessage: { addListener() {} },
    onConnect: { addListener(fn) { connectListeners.push(fn); } },
  };
  await import('../background/background.js');
  await sleep(100);
  check('relay: media port listener registered', connectListeners.length === 1, String(connectListeners.length));

  await idb.putRecords([
    {
      v: 1,
      msgId: 'RELAY-1',
      chatId: '123@c.us',
      chatName: 'Chat',
      isGroup: false,
      direction: 'in',
      senderName: 'Jane',
      text: 'relay',
      ts: T,
      capturedAt: T + 200,
      type: 'image',
      source: 'store',
    },
  ]);

  const messages = [];
  const disconnect = [];
  const port = {
    name: 'waidrop-media',
    onMessage: { addListener(fn) { messages.push(fn); } },
    onDisconnect: { addListener(fn) { disconnect.push(fn); } },
    postMessage(message) { this.acked = message; },
  };
  connectListeners[0](port);

  const relayBytes = new TextEncoder().encode('relayed-media');
  const relaySha = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', relayBytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const relayBase64 = Buffer.from(relayBytes).toString('base64');
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 640, height: 480, close() {} });
  messages[0]({
    type: 'MEDIA_BEGIN',
    id: 'relay-session',
    msgId: 'RELAY-1',
    chatId: '123@c.us',
    kind: 'image',
    mime: 'image/jpeg',
    ts: T,
    size: relayBytes.length,
    totalChars: relayBase64.length,
  });
  messages[0]({ type: 'MEDIA_CHUNK', id: 'relay-session', data: relayBase64 });
  messages[0]({ type: 'MEDIA_END', id: 'relay-session' });
  await sleep(300);
  const relayed = await idb.getMedia('RELAY-1');
  check('relay: media stored', !!relayed && relayed.byteLength === relayBytes.length, JSON.stringify(relayed && { status: relayed.status, size: relayed.byteLength }));
  check('relay: background computes sha256', relayed && relayed.sha256 === relaySha, relayed && relayed.sha256);
  check(
    'relay: background computes dimensions',
    relayed && relayed.width === 640 && relayed.height === 480,
    JSON.stringify(relayed && { width: relayed.width, height: relayed.height })
  );
  check('relay: ack sent', port.acked && port.acked.type === 'MEDIA_ACK' && port.acked.ok === true, JSON.stringify(port.acked));
  const relayRecord = (await idb.getMessagesByIds(['RELAY-1']))[0];
  check('relay: record metadata attached', relayRecord && relayRecord.media && relayRecord.media.status === 'pending', JSON.stringify(relayRecord && relayRecord.media));
  if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
  else globalThis.createImageBitmap = originalCreateImageBitmap;
}

console.log(failures === 0 ? '\nALL MEDIA CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
