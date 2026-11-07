/**
 * Dropbox uploader tests: encrypted parts/maps/index, outbox lifecycle,
 * backoff, unconfigured states. Stubbed fetch + chrome.storage.
 *
 *   node tests/uploader-dropbox.test.mjs
 */
import 'fake-indexeddb/auto';

import * as idb from '../background/idb.js';
import * as uploader from '../background/uploader.js';
import { resetFolderCache } from '../background/dropbox.js';
import { deriveKeys, decryptObject, dropboxContentHash } from '../background/crypto.js';
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
let folderCalls = [];
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

globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/oauth2/token')) {
    return jsonResponse({ access_token: 'refreshed-token', expires_in: 14400 });
  }
  if (String(url).endsWith('/files/create_folder_v2')) {
    folderCalls.push(JSON.parse(init.body || '{}').path);
    return jsonResponse({});
  }
  if (String(url).endsWith('/files/upload')) {
    if (failUploads) {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom', json: async () => ({}) };
    }
    const arg = JSON.parse(init.headers['dropbox-api-arg']);
    uploads.push({ path: arg.path, bytes: init.body, contentType: init.headers['content-type'] });
    const contentHash = await dropboxContentHash(init.body);
    return jsonResponse({
      size: init.body.byteLength,
      content_hash: contentHash,
      rev: `rev-${uploads.length}`,
      path_display: arg.path,
    });
  }
  if (String(url).endsWith('/files/get_metadata')) {
    const arg = JSON.parse(init.body || '{}');
    const uploaded = uploads.find((item) => item.path === arg.path);
    if (!uploaded) return { ok: false, status: 409, headers: { get: () => null }, text: async () => 'not_found', json: async () => ({}) };
    const contentHash = await dropboxContentHash(uploaded.bytes);
    return jsonResponse({
      size: uploaded.bytes.byteLength,
      content_hash: contentHash,
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

const T17 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const T17B = new Date(2026, 9, 17, 10, 5, 0).getTime();

const storeRecord = (msgId, chatId, ts, extra = {}) => ({
  v: 1,
  msgId,
  chatId,
  chatName: extra.chatName || 'Chat',
  chatPhone: extra.chatPhone || null,
  chatPushname: extra.chatPushname || null,
  isGroup: chatId.endsWith('@g.us'),
  direction: 'in',
  senderId: chatId,
  senderName: 'Jane',
  text: 'hello ' + msgId,
  ts,
  capturedAt: ts + 100,
  type: 'chat',
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
    ...overrides,
  };
  storage.dropboxAuth = {
    accessToken: TOKEN,
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3600_000,
    accountName: 'Test Account',
  };
}

async function reset() {
  await idb.clearAll();
  uploads = [];
  folderCalls = [];
  failUploads = false;
  resetFolderCache();
  configure();
}

await reset();

// --- unconfigured --------------------------------------------------------------
{
  configure({ encryptionKey: '' });
  const skipped = await uploader.runUpload();
  check('missing key -> skipped unconfigured', skipped.skipped === 'unconfigured', JSON.stringify(skipped));

  configure({ encryptionKey: 'not-a-valid-key' });
  const invalid = await uploader.runUpload();
  check('invalid key -> error', /invalid encryption key/.test(String(invalid.error)), String(invalid.error));
  await reset();
}

// --- happy path ----------------------------------------------------------------
{
  await idb.putRecords([
    storeRecord('A1', '123@c.us', T17, { chatName: 'Anna Schmidt', chatPhone: '49171234567', chatPushname: 'Anna' }),
    storeRecord('A2', '123@c.us', T17B, { chatName: 'Anna Schmidt' }),
    storeRecord('G1', '999@g.us', T17, { chatName: 'Family Group' }),
  ]);

  const stats = await uploader.runUpload();
  check('happy: uploaded 3', stats.uploaded === 3, JSON.stringify(stats));
  check('happy: no error', stats.error === null, String(stats.error));
  check('happy: format uploaded', stats.formatUploaded === true);
  check('happy: 2 chat maps uploaded', stats.chatMapsUploaded === 2, String(stats.chatMapsUploaded));
  check('happy: index uploaded', stats.chatIndexUploaded === true);
  check('happy: outbox drained', (await idb.getPendingCount()) === 0);

  const paths = uploads.map((item) => item.path);
  check('happy: format path', paths.includes('/account=primary/_format.json'));
  check('happy: index path', paths.includes('/account=primary/_chats/index.enc'));
  check('happy: two chat maps', paths.filter((p) => p.includes('/_chats/') && !p.endsWith('index.enc')).length === 2);

  const partUploads = uploads.filter((item) => item.path.includes('/chat='));
  check('happy: two part objects', partUploads.length === 2, String(partUploads.length));
  check(
    'happy: part path format',
    partUploads.every((item) => /\/account=primary\/chat=[0-9a-f]{16}\/dt=2026-10-17\/part-\d+-\d+-\d+\.enc$/.test(item.path)),
    partUploads.map((item) => item.path).join(' , ')
  );

  const keys = await deriveKeys(KEY);
  const { chatHash } = await import('../background/crypto.js');
  const expectedHash = await chatHash(keys, '123@c.us');
  check('happy: keyed chat hash in path', partUploads.some((item) => item.path.includes(`chat=${expectedHash}`)), expectedHash);

  const annaPart = partUploads.find((item) => item.path.includes(`chat=${expectedHash}`));
  const plaintext = await decryptObject(keys, annaPart.bytes);
  const lines = plaintext.trim().split('\n').map((line) => JSON.parse(line));
  check('happy: part decrypts to both records', lines.map((r) => r.msgId).sort().join(',') === 'A1,A2', lines.map((r) => r.msgId).join(','));

  const indexUpload = uploads.find((item) => item.path.endsWith('_chats/index.enc'));
  const indexDoc = JSON.parse(await decryptObject(keys, indexUpload.bytes));
  check('happy: index decrypts with chat names', indexDoc.chats.map((c) => c.chatName).sort().join(',') === 'Anna Schmidt,Family Group');
  check('happy: index carries phone', indexDoc.chats.find((c) => c.chatId === '123@c.us').chatPhone === '49171234567');

  const formatUpload = uploads.find((item) => item.path.endsWith('_format.json'));
  const formatDoc = JSON.parse(new TextDecoder().decode(formatUpload.bytes));
  check('happy: format file plaintext metadata', formatDoc.encryption === 'aes-256-gcm' && formatDoc.chatHash === 'hmac-sha256-16');
  check(
    'happy: part content type',
    partUploads.every((item) => item.contentType === 'application/octet-stream')
  );
  check(
    'happy: format content type',
    formatUpload.contentType === 'application/octet-stream',
    String(formatUpload.contentType)
  );

  // rerun does not re-upload anything or overwrite the last real upload
  const lastBeforeRerun = await idb.getMeta('lastUpload');
  uploads = [];
  const rerun = await uploader.runUpload();
  const lastAfterRerun = await idb.getMeta('lastUpload');
  check('happy: rerun is a no-op', rerun.uploaded === 0 && uploads.length === 0, JSON.stringify({ rerun, uploads: uploads.length }));
  check(
    'happy: rerun keeps last upload summary',
    lastAfterRerun &&
      lastBeforeRerun &&
      lastAfterRerun.at === lastBeforeRerun.at &&
      lastAfterRerun.uploaded === lastBeforeRerun.uploaded,
    JSON.stringify({ before: lastBeforeRerun, after: lastAfterRerun })
  );

  const manualRerun = await uploader.runUpload({ manual: true });
  const lastAfterManualRerun = await idb.getMeta('lastUpload');
  check(
    'happy: manual no-op keeps last upload summary',
    manualRerun.uploaded === 0 &&
      lastAfterManualRerun &&
      lastAfterManualRerun.at === lastBeforeRerun.at &&
      lastAfterManualRerun.uploaded === lastBeforeRerun.uploaded,
    JSON.stringify({ before: lastBeforeRerun, after: lastAfterManualRerun })
  );

  // a re-delivered identical record (new capturedAt) must not cause a re-upload
  await idb.putRecords([
    storeRecord('A1', '123@c.us', T17, {
      chatName: 'Anna Schmidt',
      chatPhone: '49171234567',
      chatPushname: 'Anna',
      capturedAt: Date.now(),
    }),
  ]);
  uploads = [];
  const afterDup = await uploader.runUpload();
  check(
    'happy: duplicate redelivery does not re-upload',
    afterDup.uploaded === 0 && uploads.length === 0,
    JSON.stringify({ afterDup, uploads: uploads.length })
  );
}

// --- backend switch: done records are re-enqueued -------------------------------
{
  await idb.clearAll();
  uploads = [];
  failUploads = false;
  resetFolderCache();
  configure();
  await idb.putRecords([storeRecord('B1', '123@c.us', T17), storeRecord('B2', '123@c.us', T17B)]);
  await idb.setOutboxStatus(['B1', 'B2'], 'done');

  const stats = await uploader.runUpload();
  check('switch: previously-done records re-uploaded', stats.uploaded === 2, JSON.stringify(stats));
  check('switch: outbox drained', (await idb.getPendingCount()) === 0);
}

// --- upload failure and backoff --------------------------------------------------
{
  await idb.clearAll();
  uploads = [];
  failUploads = false;
  resetFolderCache();
  configure();
  await idb.putRecords([storeRecord('R1', '123@c.us', T17)]);

  failUploads = true;
  const failureLogs = [];
  const failed = await uploader.runUpload({
    manual: true,
    log: (level, message) => failureLogs.push({ level, message }),
  });
  failUploads = false;
  check('retry: failure reported', failed.uploaded === 0 && /500/.test(String(failed.error)), String(failed.error));
  check(
    'retry: failure written to activity log',
    failureLogs.some((entry) => entry.level === 'error' && /Messages part 1\/1/.test(entry.message)),
    failureLogs.map((entry) => entry.message).join(' | ')
  );
  check('retry: still pending', (await idb.getPendingCount()) === 1);
  const entry = (await idb.listPendingOutbox())[0];
  check('retry: attempts incremented', entry && entry.attempts === 1, JSON.stringify(entry && { attempts: entry.attempts }));
  check('retry: backoff scheduled', entry && entry.nextAttemptAt > Date.now(), String(entry && entry.nextAttemptAt));

  await idb.setOutboxStatus(['R1'], 'pending', { nextAttemptAt: 0 });
  const recovered = await uploader.runUpload();
  check('retry: succeeds after backoff', recovered.uploaded === 1 && (await idb.getPendingCount()) === 0, JSON.stringify(recovered));
}

// --- progress log ----------------------------------------------------------------
{
  await idb.clearAll();
  uploads = [];
  failUploads = false;
  resetFolderCache();
  configure();
  await idb.putRecords([storeRecord('L1', '123@c.us', T17), storeRecord('L2', '123@c.us', T17B)]);

  const logs = [];
  const stats = await uploader.runUpload({
    manual: true,
    log: (level, message) => logs.push({ level, message }),
  });
  check('log: upload started', logs.some((entry) => /Upload started/.test(entry.message)), String(logs.length));
  check(
    'log: message part progress',
    logs.some((entry) => /Messages part 1\/1: uploading 2 message\(s\)/.test(entry.message)),
    logs.map((entry) => entry.message).join(' | ')
  );
  check('log: two messages uploaded', stats.uploaded === 2, JSON.stringify(stats));
  check(
    'log: finish summary',
    logs.some((entry) => entry.level === 'success' && /^Upload finished/.test(entry.message)),
    logs.map((entry) => entry.message).join(' | ')
  );
}

console.log(failures === 0 ? '\nALL DROPBOX UPLOADER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
