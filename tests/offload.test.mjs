/**
 * Stub offload and late-media repair tests.
 *
 *   node tests/offload.test.mjs
 */
import 'fake-indexeddb/auto';

import * as idb from '../background/idb.js';
import * as uploader from '../background/uploader.js';
import * as offload from '../background/offload.js';
import * as mediaRepair from '../background/mediaRepair.js';
import { resetFolderCache } from '../background/dropbox.js';
import { deriveKeys, decryptObject, dropboxContentHash } from '../background/crypto.js';
import { createPayloadHasher } from '../background/payloadHash.js';
import { DEFAULT_DROPBOX_APP_KEY } from '../background/config.js';
import { installLocalCodec } from './helpers/local-codec.mjs';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
await installLocalCodec();
const TOKEN = 'test-access-token';
const storage = {
  settings: null,
  dropboxAuth: null,
  installedAt: 0,
};

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

function fileResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
  };
}

globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/oauth2/token')) {
    return jsonResponse({ access_token: 'refreshed-token', expires_in: 14400 });
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
  if (String(url).endsWith('/files/download')) {
    const arg = JSON.parse(init.headers['dropbox-api-arg'] || '{}');
    const uploaded = [...uploads].reverse().find((item) => item.path === arg.path);
    if (!uploaded) return { ok: false, status: 409, headers: { get: () => null }, text: async () => 'not_found' };
    return fileResponse(uploaded.bytes);
  }
  return jsonResponse({});
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

const T = new Date(2026, 9, 17, 10, 0, 0).getTime();

const storeRecord = (msgId, extra = {}) => ({
  v: 1,
  msgId,
  chatId: '123@c.us',
  chatName: 'Chat',
  isGroup: false,
  direction: 'in',
  senderId: '123@c.us',
  senderName: 'Jane',
  text: extra.text || `hello ${msgId}`,
  ts: T,
  capturedAt: T + 100,
  type: extra.type || 'chat',
  source: 'store',
  ...extra,
});

function configure(overrides = {}) {
  storage.settings = {
    uploadEnabled: true,
    accountAlias: 'primary',
    dropboxAppKey: DEFAULT_DROPBOX_APP_KEY,
    archiveMode: 'encrypted',
    encryptionKey: KEY,
    encryptionKeyAcknowledged: true,
    offloadEnabled: true,
    offloadRetentionDays: 0,
    ...overrides,
  };
  storage.dropboxAuth = {
    accessToken: TOKEN,
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3600_000,
    accountId: 'dbid-test',
  };
}

async function reset() {
  await idb.clearAll();
  uploads = [];
  failUploads = false;
  resetFolderCache();
  configure();
}

// --- defaults -----------------------------------------------------------------
{
  storage.settings = undefined;
  const defaults = await uploader.getSettings();
  check('defaults: offload on', defaults.offloadEnabled === true, JSON.stringify(defaults));
  check('defaults: retention 1 day', defaults.offloadRetentionDays === 1, String(defaults.offloadRetentionDays));
}

await reset();

// --- text-only offload --------------------------------------------------------
{
  await idb.putRecords([storeRecord('S1')]);
  const stats = await uploader.runUpload();
  check('text: uploaded', stats.uploaded === 1, JSON.stringify(stats));

  const before = await idb.getMessage('S1');
  const keys = await deriveKeys(KEY);
  const hasher = createPayloadHasher(keys);
  check('text: local payload present before sweep', before && before.text === 'hello S1');
  const hash1 = await hasher(before);
  const hash2 = await hasher({ ...before, media: { status: 'stored', path: 'x' } });
  const hash3 = await hasher({ ...before, text: 'different' });
  check('hash: media does not change payload hash', hash1 === hash2);
  check('hash: text changes payload hash', hash1 !== hash3);

  const result = await offload.runOffloadSweep({ log: () => {} });
  check('text: offloaded', result.cleared === 1, JSON.stringify(result));

  const after = await idb.getMessage('S1');
  check('text: payload cleared', !!after && after.payloadCleared === true && !('text' in after), JSON.stringify(after));
  check('text: structural metadata kept', after && after.msgId === 'S1' && after.chatId === '123@c.us' && after.chatName === 'Chat');
  check('text: remote pointer kept', after && after.remote && after.remote.path);
  check('text: outbox entry removed', (await idb.listDoneOutbox(10)).length === 0);
  check('text: offloaded counter', (await idb.getMeta('offloadedCount')) === 1);
  check('text: export excludes stub', (await idb.getMessagesForExport()).length === 0);

  const redelivered = await idb.putRecords([storeRecord('S1')], { payloadHasher: hasher });
  check('text: same redelivery skipped', redelivered.skipped === 1, JSON.stringify(redelivered));
  check('text: same redelivery stays cleared', (await idb.getMessage('S1')).payloadCleared === true);

  const edited = await idb.putRecords([storeRecord('S1', { text: 'edited body' })]);
  check('text: edit restores payload', edited.updated === 1, JSON.stringify(edited));
  const restored = await idb.getMessage('S1');
  check('text: edit body restored', restored.text === 'edited body' && restored.payloadCleared === false, JSON.stringify(restored));
  check('text: edit re-enqueued', (await idb.getPendingCount()) === 1);
  await idb.setOutboxStatus(['S1'], 'done');
}

// --- offload with not_downloaded media ---------------------------------------
{
  await reset();
  await idb.putRecords([
    storeRecord('M1', {
      type: 'image',
      media: {
        status: 'not_downloaded',
        kind: 'image',
        mime: 'image/jpeg',
        size: null,
        sha256: null,
        path: null,
        capturedAt: T + 200,
      },
    }),
  ]);
  const up = await uploader.runUpload();
  check('media: message uploaded', up.uploaded === 1, JSON.stringify(up));

  const result = await offload.runOffloadSweep({ log: () => {} });
  check('media: offloaded without downloading media', result.cleared === 1, JSON.stringify(result));
  const stub = await idb.getMessage('M1');
  check('media: awaiting media', stub.awaitingMedia === true && stub.payloadCleared === true, JSON.stringify(stub));
  check('media: no text kept', !('text' in stub));

  const mediaPath = 'chat=fab73f1a7a927254/dt=2026-10-17/media-test.enc';
  await idb.putMedia({
    msgId: 'M1',
    chatId: '123@c.us',
    kind: 'image',
    mime: 'image/jpeg',
    ts: T,
    bytes: new Uint8Array([1, 2, 3]).buffer,
    byteLength: 3,
    status: 'stored',
    path: mediaPath,
    capturedAt: T + 300,
  });
  check('media: repair queued', (await idb.getRepairCount()) === 1);
  const repaired = await mediaRepair.runMediaRepair({ log: () => {} });
  check('media: repair restored', repaired.repaired === 1, JSON.stringify(repaired));
  const restored = await idb.getMessage('M1');
  check(
    'media: restored record has payload + media',
    restored.text === 'hello M1' && restored.media && restored.media.status === 'stored' && restored.payloadCleared === false,
    JSON.stringify(restored)
  );
  check('media: repair enqueued upload', (await idb.getPendingCount()) === 1);

  const up2 = await uploader.runUpload();
  check('media: repaired record uploaded', up2.uploaded === 1, JSON.stringify(up2));
  const keys = await deriveKeys(KEY);
  const lastPart = [...uploads].reverse().find((item) => item.path.includes('/chat='));
  const plaintext = await decryptObject(keys, lastPart.bytes);
  const lines = plaintext.trim().split('\n').map((line) => JSON.parse(line));
  check('media: remote record references media', lines.some((line) => line.msgId === 'M1' && line.media && line.media.status === 'stored'), JSON.stringify(lines));
}

// --- stale index blocks offload ----------------------------------------------
{
  await reset();
  await idb.putRecords([storeRecord('I1')]);
  await uploader.runUpload();
  await idb.setMeta('dropboxChatIndexUploaded', {
    backend: 'dropbox',
    account: 'primary',
    fingerprint: 'stale',
  });
  const result = await offload.runOffloadSweep({ log: () => {} });
  check('stale index: no clear', result.cleared === 0, JSON.stringify(result));
  check('stale index: payload kept', (await idb.getMessage('I1')).payloadCleared !== true);
}

// --- key mismatch blocks offload ---------------------------------------------
{
  await reset();
  await idb.putRecords([storeRecord('K1')]);
  await uploader.runUpload();
  const entry = (await idb.listDoneOutbox(10))[0];
  await idb.setOutboxStatus(['K1'], 'done', { keyFingerprint: 'different' });
  const result = await offload.runOffloadSweep({ log: () => {} });
  check('key mismatch: no clear', result.cleared === 0, JSON.stringify(result));
}

// --- clearAll resets counters and stubs --------------------------------------
{
  await reset();
  await idb.putRecords([storeRecord('C1')]);
  await uploader.runUpload();
  await offload.runOffloadSweep({ log: () => {} });
  await idb.clearAll();
  check('clearAll: no messages', (await idb.countMessages()) === 0);
  check('clearAll: counter reset', (await idb.getMeta('offloadedCount')) === null);
  check('clearAll: no repairs', (await idb.getRepairCount()) === 0);
}

console.log(failures === 0 ? '\nALL OFFLOAD CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
