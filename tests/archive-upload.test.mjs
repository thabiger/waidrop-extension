/**
 * Unlimited encrypted archive: all chats, no daily quota, opt-in pre-install
 * history and encrypted offload.
 */
import 'fake-indexeddb/auto';

import * as idb from '../background/idb.js';
import * as uploader from '../background/uploader.js';
import * as offload from '../background/offload.js';
import { resetFolderCache } from '../background/dropbox.js';
import { dropboxContentHash } from '../background/crypto.js';
import { DEFAULT_DROPBOX_APP_KEY } from '../background/config.js';
import { PRE_INSTALL_REASON } from '../background/archivePolicy.js';
import { installLocalCodec } from './helpers/local-codec.mjs';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
await installLocalCodec(KEY);

const storage = {
  settings: null,
  dropboxAuth: null,
  installedAt: 0,
};
let uploads = [];
let failUploads = false;

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

globalThis.chrome = {
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
};

globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/oauth2/token')) {
    return jsonResponse({ access_token: 'refreshed', expires_in: 14400 });
  }
  if (String(url).endsWith('/files/create_folder_v2')) return jsonResponse({});
  if (String(url).endsWith('/files/upload')) {
    if (failUploads) {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom', json: async () => ({}) };
    }
    const arg = JSON.parse(init.headers['dropbox-api-arg']);
    const contentHash = await dropboxContentHash(init.body);
    uploads.push({ path: arg.path, bytes: init.body, contentHash });
    return jsonResponse({
      size: init.body.byteLength,
      content_hash: contentHash,
      rev: `rev-${uploads.length}`,
      path_display: arg.path,
    });
  }
  if (String(url).endsWith('/files/get_metadata')) {
    const arg = JSON.parse(init.body || '{}');
    const uploaded = [...uploads].reverse().find((item) => item.path === arg.path);
    if (!uploaded) {
      return { ok: false, status: 409, headers: { get: () => null }, text: async () => 'not_found', json: async () => ({}) };
    }
    return jsonResponse({
      size: uploaded.bytes.byteLength,
      content_hash: uploaded.contentHash,
      rev: 'rev',
      path_display: arg.path,
    });
  }
  return jsonResponse({});
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

const T = new Date(2026, 9, 17, 10, 0, 0).getTime();
const record = (msgId, chatId, ts = T, extra = {}) => ({
  v: 1,
  msgId,
  chatId,
  chatName: extra.chatName || (chatId.endsWith('@g.us') ? 'Group' : 'Direct'),
  isGroup: chatId.endsWith('@g.us'),
  direction: 'in',
  senderId: chatId,
  senderName: 'Jane',
  text: extra.text || `hello ${msgId}`,
  ts,
  capturedAt: ts + 100,
  type: extra.type || 'chat',
  source: 'store',
  ...extra,
});

function configure(overrides = {}) {
  storage.settings = {
    uploadEnabled: true,
    accountAlias: 'custom-account',
    dropboxAppKey: DEFAULT_DROPBOX_APP_KEY,
    archiveMode: 'plaintext',
    encryptionKey: KEY,
    encryptionKeyAcknowledged: true,
    syncPreInstallMessages: false,
    offloadEnabled: true,
    offloadRetentionDays: 0,
    ...overrides,
  };
  storage.dropboxAuth = {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3600_000,
    accountId: 'dbid-unlimited',
    accountName: 'Unlimited Account',
  };
  storage.installedAt = 0;
}

async function reset() {
  await idb.clearAll();
  uploads = [];
  failUploads = false;
  resetFolderCache();
  configure();
}

async function rawStore(storeName, key) {
  const db = await idb.getDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

await reset();

// --- all chats, custom alias, local encryption ------------------------------
{
  await idb.putRecords([
    record('G1', '999@g.us', T, { chatName: 'Family Group', chatPhone: '49170000000' }),
    record('G2', '999@g.us', T + 1000),
    record('D1', '123@c.us', T, { chatName: 'Anna' }),
  ]);
  const stats = await uploader.runUpload();
  check('upload: all chats uploaded', stats.uploaded === 3 && !stats.error, JSON.stringify(stats));
  check('upload: direct chat is no longer blocked', (await idb.getOutboxEntry('D1')).status === 'done');
  check(
    'upload: paths use the configured alias',
    uploads.some((item) => /^\/account=custom-account\/chat=.*\/part-.*\.enc$/.test(item.path)),
    uploads.map((item) => item.path).join(' , ')
  );
  check('upload: format is encrypted', (await idb.getMeta('dropboxFormatUploaded')).mode === 'encrypted');

  const raw = await rawStore('messages', 'G1');
  const rawChat = await rawStore('chats', '999@g.us');
  check('local: raw message has no plaintext text', raw && raw.text === undefined, JSON.stringify(raw && Object.keys(raw)));
  check('local: raw message has encrypted payload', raw && typeof raw.payloadEnc === 'string');
  check('local: raw chat has no plaintext name', rawChat && rawChat.chatName === undefined && typeof rawChat.chatEnc === 'string');
  const opened = await idb.getMessage('G1');
  check('local: decrypted message text', opened && opened.text === 'hello G1' && opened.chatName === 'Family Group');

  const cleared = await offload.runOffloadSweep({ log: () => {} });
  check('offload: encrypted offload works', cleared.cleared === 3, JSON.stringify(cleared));
  const stub = await idb.getMessage('G1');
  check('offload: stub keeps metadata', stub && stub.payloadCleared === true && stub.remote);
}

// --- no daily quota ---------------------------------------------------------
{
  await reset();
  const records = Array.from({ length: 260 }, (_, index) => record(`Q${index}`, '999@g.us', T + index));
  await idb.putRecords(records);
  const stats = await uploader.runUpload();
  check('quota: no daily upload cap', stats.uploaded === 260, JSON.stringify(stats));
  check('quota: outbox drained', (await idb.getPendingCount()) === 0, String(await idb.getPendingCount()));
  check('quota: no quota state stored', storage.uploadQuota === undefined);
}

// --- pre-install history is opt-in ------------------------------------------
{
  await reset();
  const installedAt = T + 2 * 60 * 60 * 1000;
  storage.installedAt = installedAt;
  await idb.putRecords([
    record('OLD', '999@g.us', T, { chatName: 'Old Group' }),
    record('NEW', '999@g.us', installedAt + 60 * 60 * 1000, { chatName: 'Old Group' }),
  ]);

  const first = await uploader.runUpload();
  check('install: default uploads only post-install', first.uploaded === 1, JSON.stringify(first));
  check('install: old message blocked', (await idb.getOutboxEntry('OLD')).status === 'blocked');
  check(
    'install: blocked reason',
    (await idb.getOutboxEntry('OLD')).reason === PRE_INSTALL_REASON,
    (await idb.getOutboxEntry('OLD')).reason
  );

  storage.settings.syncPreInstallMessages = true;
  await idb.requeueBlockedOutbox(PRE_INSTALL_REASON);
  const second = await uploader.runUpload();
  check('install: full-history option syncs old messages', second.uploaded === 1, JSON.stringify(second));
  check('install: no blocked messages left', (await idb.countBlockedOutbox(PRE_INSTALL_REASON)) === 0);
}

console.log(failures === 0 ? '\nALL ARCHIVE UPLOAD CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
