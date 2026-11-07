/**
 * WAiDrop - Dropbox uploader (v4)
 *
 * Drains the IndexedDB outbox into an encrypted Dropbox archive:
 *
 *   .enc objects using AES-256-GCM, keyed HMAC paths
 *
 * Layout:
 *   /account=<alias>/_format.json
 *   /account=<alias>/_chats/index.enc
 *   /account=<alias>/_chats/<chatHash>.enc
 *   /account=<alias>/chat=<chatHash>/dt=YYYY-MM-DD/part-<firstTs>-<lastTs>-<seq>.enc
 *
 * All uploads are encrypted and use the configured account alias.
 */
import {
  listPendingOutbox,
  listPendingMedia,
  getMessagesByIds,
  getMessage,
  markOutboxDone,
  setOutboxStatus,
  setMediaStatus,
  getChats,
  updateChat,
  getMeta,
  setMeta,
  getPendingCount,
  hasClearedPayloads,
  reenqueueDoneForUpload,
} from './idb.js';
import {
  deriveKeys,
  isValidMasterKey,
  dropboxContentHash,
  keyFingerprint,
} from './crypto.js';
import {
  normalizeArchiveMode,
  isEncryptedMode,
  objectExtension,
  chatObjectExtension,
  mediaObjectExtension,
  chatHashForMode,
  mediaHashForMode,
  encodeObject,
  encodeMedia,
} from './archiveCodec.js';
import { DEFAULT_ACCOUNT_ALIAS, DEFAULT_DROPBOX_APP_KEY } from './config.js';
import { createPayloadHasher } from './payloadHash.js';
import { getInstalledAt } from './installInfo.js';
import { isPreInstallMessage, PRE_INSTALL_REASON } from './archivePolicy.js';
import {
  ensureAccessToken,
  ensureFolder,
  uploadFile,
  testConnection,
  getAuth,
} from './dropbox.js';

const DEFAULT_SETTINGS = {
  uploadEnabled: false,
  accountAlias: DEFAULT_ACCOUNT_ALIAS,
  dropboxAppKey: DEFAULT_DROPBOX_APP_KEY,
  archiveMode: 'encrypted',
  encryptionKey: '',
  encryptionKeyAcknowledged: false,
  syncPreInstallMessages: false,
  offloadEnabled: true,
  offloadRetentionDays: 1,
};

const MAX_PER_OBJECT = 200;
const MAX_ATTEMPT_DELAY_MS = 15 * 60 * 1000;
const MAX_MEDIA_PER_RUN = 25;
const MAX_MEDIA_BYTES_PER_RUN = 100 * 1024 * 1024;
export const FORMAT_VERSION = 4;

export function formatBody(mode) {
  const encrypted = isEncryptedMode(mode);
  return JSON.stringify({
    format: FORMAT_VERSION,
    layout: 'waidrop',
    mode: encrypted ? 'encrypted' : 'plaintext',
    encryption: encrypted ? 'aes-256-gcm' : 'none',
    ...(encrypted ? { keyDerivation: 'hkdf-sha256' } : { objectEncoding: 'utf-8' }),
    chatHash: encrypted ? 'hmac-sha256-16' : 'sha256-16',
    media: {
      layout: 'waidrop-media-v1',
      encryption: encrypted ? 'aes-256-gcm' : 'none',
      ...(encrypted ? { keyDerivation: 'hkdf-sha256' } : {}),
      hash: encrypted ? 'hmac-sha256-32' : 'sha256-32',
    },
  });
}

export function resolveArchiveMode() {
  return 'encrypted';
}

export function resolveAccountAlias(settings) {
  const alias = settings && typeof settings.accountAlias === 'string' ? settings.accountAlias.trim() : '';
  return alias || DEFAULT_ACCOUNT_ALIAS;
}

let running = false;

export async function getSettings() {
  let stored = {};
  try {
    const result = await chrome.storage.local.get(['settings']);
    stored = result.settings || {};
  } catch (e) {
    /* defaults */
  }
  if (Object.prototype.hasOwnProperty.call(stored, 'dropboxAppSecret')) {
    delete stored.dropboxAppSecret;
    try {
      await chrome.storage.local.set({ settings: stored });
    } catch (e) {
      /* best-effort cleanup of the retired credential */
    }
  }
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  for (const key of ['accountAlias', 'encryptionKey']) {
    if (typeof settings[key] === 'string') settings[key] = settings[key].trim();
  }
  // The app key is fixed by the build; stored custom keys are ignored.
  settings.dropboxAppKey = DEFAULT_DROPBOX_APP_KEY;
  if (!settings.accountAlias) settings.accountAlias = DEFAULT_ACCOUNT_ALIAS;
  settings.archiveMode = 'encrypted';
  return settings;
}

export function partitionDate(ts) {
  const d = new Date(typeof ts === 'number' ? ts : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function backoffMs(attempts) {
  return Math.min(15000 * Math.pow(2, Math.max(0, attempts - 1)), MAX_ATTEMPT_DELAY_MS);
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function verifyUploadedObject(meta, bytes, path) {
  if (!meta || typeof meta !== 'object') throw new Error(`upload verification failed (${path}): no metadata`);
  const expectedSize = bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : 0;
  if (typeof meta.size === 'number' && meta.size !== expectedSize) {
    throw new Error(`upload verification failed (${path}): size ${meta.size} != ${expectedSize}`);
  }
  if (!meta.content_hash) throw new Error(`upload verification failed (${path}): missing content hash`);
  const expectedHash = await dropboxContentHash(bytes);
  if (meta.content_hash !== expectedHash) {
    throw new Error(`upload verification failed (${path}): content hash mismatch`);
  }
  if (meta.path_display && meta.path_display !== path) {
    throw new Error(`upload verification failed (${path}): path mismatch ${meta.path_display}`);
  }
  return meta;
}

export async function mediaObjectPath(keys, settings, entry, mode = 'encrypted') {
  if (!entry || !entry.msgId || !entry.chatId) throw new Error('media has no chat id');
  const chat = await chatHashForMode(mode, keys, entry.chatId);
  const date = partitionDate(entry.ts || entry.capturedAt || Date.now());
  const hash = await mediaHashForMode(mode, keys, entry.msgId);
  const relative = `chat=${chat}/dt=${date}/media-${hash}${mediaObjectExtension(mode)}`;
  return {
    relative,
    absolute: `/account=${settings.accountAlias}/${relative}`,
  };
}

export function chatIndexFingerprint(chats) {
  return JSON.stringify(
    (chats || [])
      .map((chat) => [
        chat.chatId,
        chat.chatName,
        chat.chatPhone || null,
        chat.chatPushname || null,
        !!chat.isGroup,
        chat.firstSeen ?? null,
        chat.lastSeen ?? null,
      ])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
}

export function isChatMapCurrent(chat, mode = 'encrypted') {
  if (!chat) return false;
  return !!(
    chat.mapUploadedAt &&
    chat.mapUploadedBackend === 'dropbox' &&
    (chat.mapUploadedMode || 'encrypted') === normalizeArchiveMode(mode) &&
    chat.mapUploadedName === chat.chatName &&
    chat.mapUploadedGroup === !!chat.isGroup &&
    (chat.mapUploadedPhone || null) === (chat.chatPhone || null) &&
    (chat.mapUploadedPushname || null) === (chat.chatPushname || null)
  );
}

export async function isFormatCurrent(settings, mode = 'encrypted') {
  const flag = await getMeta('dropboxFormatUploaded');
  return !!(
    flag &&
    flag.account === settings.accountAlias &&
    flag.formatVersion === FORMAT_VERSION &&
    (flag.mode || 'encrypted') === normalizeArchiveMode(mode)
  );
}

export async function isChatIndexCurrent(settings, mode = 'encrypted') {
  const chats = await getChats();
  const flag = await getMeta('dropboxChatIndexUploaded');
  return !!(
    flag &&
    flag.backend === 'dropbox' &&
    flag.account === settings.accountAlias &&
    (flag.mode || 'encrypted') === normalizeArchiveMode(mode) &&
    flag.fingerprint === chatIndexFingerprint(chats)
  );
}

async function uploadPendingMedia(settings, keys, mode, options = {}) {
  const log = options.log || (() => {});
  const entries = await listPendingMedia(MAX_MEDIA_PER_RUN * 4);

  const now = Date.now();
  const due = entries.filter((entry) => !entry.nextAttemptAt || entry.nextAttemptAt <= now);
  const total = Math.min(due.length, MAX_MEDIA_PER_RUN);
  let uploaded = 0;
  let bytes = 0;
  let failed = 0;
  let firstError = null;

  for (const entry of entries) {
    if (uploaded >= MAX_MEDIA_PER_RUN) break;
    if (entry.nextAttemptAt && entry.nextAttemptAt > now) continue;
    if (entry.bytes && bytes + (entry.bytes.byteLength || entry.byteLength || 0) > MAX_MEDIA_BYTES_PER_RUN) break;

    const kind = entry.kind || 'media';
    const size = entry.bytes ? entry.bytes.byteLength || 0 : entry.byteLength || 0;
    const position = uploaded + failed + 1;
    log('info', `Media ${position}/${total}: uploading ${kind} (${formatBytes(size)})...`);

    try {
      if (!entry.bytes || !entry.bytes.byteLength) throw new Error('media bytes missing');
      const record = await getMessage(entry.msgId);
      if (!record) throw new Error('message record is missing');
      const target = await mediaObjectPath(keys, settings, entry, mode);
      const encoded = await encodeMedia(mode, keys, target.relative, new Uint8Array(entry.bytes));
      await ensureFolder(settings, target.absolute.slice(0, target.absolute.lastIndexOf('/')));
      const meta = await uploadFile(settings, target.absolute, encoded);
      await verifyUploadedObject(meta, encoded, target.absolute);
      await setMediaStatus(entry.msgId, 'stored', {
        path: target.relative,
        archiveMode: mode,
        uploadedAt: Date.now(),
        bytes: null,
        lastError: null,
        remoteRev: meta.rev || null,
        remoteContentHash: meta.content_hash || null,
        remoteSize: meta.size || null,
      });
      log('success', `Media ${position}/${total}: ${kind} uploaded.`);
      uploaded++;
      bytes += entry.bytes.byteLength || 0;
    } catch (e) {
      const message = messageOf(e);
      if (!firstError) firstError = message;
      log('error', `Media ${position}/${total}: ${kind} failed — ${message}`);
      failed++;
      if (message === 'message record is missing') {
        await setMediaStatus(entry.msgId, 'failed', { lastError: message });
      } else {
        const attempts = (entry.attempts || 0) + 1;
        await setMediaStatus(entry.msgId, 'pending', {
          attempts,
          nextAttemptAt: Date.now() + backoffMs(attempts),
          lastError: message,
        });
      }
    }
  }

  return { uploaded, failed, bytes, error: firstError };
}

async function pendingCountSafe() {
  try {
    return await getPendingCount();
  } catch (e) {
    return null;
  }
}

async function finish(startedAt, result, log, options = {}) {
  const summary = { at: Date.now(), tookMs: Date.now() - startedAt, pending: await pendingCountSafe(), ...result };
  const didSomething =
    summary.uploaded ||
    summary.mediaUploaded ||
    summary.formatUploaded ||
    summary.chatMapsUploaded ||
    summary.chatIndexUploaded;
  // Keep the previous summary when an automatic check found nothing to do;
  // otherwise every alarm tick would replace real upload counts with zeroes.
  if (didSomething || summary.error) await setMeta('lastUpload', summary);
  if (typeof log === 'function' && (options.manual || summary.error || didSomething)) {
    const parts = [];
    if (summary.uploaded) parts.push(`${summary.uploaded} message(s)`);
    if (summary.mediaUploaded) parts.push(`${summary.mediaUploaded} media item(s)`);
    if (summary.chatMapsUploaded) parts.push(`${summary.chatMapsUploaded} chat metadata`);
    if (summary.formatUploaded) parts.push('format marker');
    if (summary.chatIndexUploaded) parts.push('chat index');
    if (!parts.length) parts.push('nothing new');
    const level = summary.error ? 'error' : summary.pending ? 'warn' : 'success';
    let message = `Upload ${summary.error ? 'finished with errors' : 'finished'} in ${summary.tookMs} ms: ${parts.join(', ')}`;
    if (summary.pending != null) message += `; ${summary.pending} pending`;
    if (summary.error) message += ` — ${summary.error}`;
    log(level, message);
  }
  return summary;
}

async function ensureFormat(settings, mode) {
  const flag = await getMeta('dropboxFormatUploaded');
  if (
    flag &&
    flag.account === settings.accountAlias &&
    flag.formatVersion === FORMAT_VERSION &&
    (flag.mode || 'encrypted') === normalizeArchiveMode(mode)
  ) {
    return false;
  }
  const path = `/account=${settings.accountAlias}/_format.json`;
  const bytes = new TextEncoder().encode(formatBody(mode));
  await ensureFolder(settings, `/account=${settings.accountAlias}`);
  const meta = await uploadFile(settings, path, bytes);
  await verifyUploadedObject(meta, bytes, path);
  await setMeta('dropboxFormatUploaded', {
    account: settings.accountAlias,
    formatVersion: FORMAT_VERSION,
    mode: normalizeArchiveMode(mode),
    at: Date.now(),
    contentHash: meta.content_hash || null,
    size: meta.size || null,
  });
  return true;
}

async function uploadChangedChatMaps(settings, keys, mode, options = {}) {
  const log = options.log || (() => {});
  const chats = await getChats();
  const changed = chats.filter((chat) => !isChatMapCurrent(chat, mode));
  if (!changed.length) return { count: 0, failedChatIds: [] };

  log('info', `Chat metadata: uploading ${changed.length} changed chat(s)...`);
  let count = 0;
  const failedChatIds = [];
  for (const chat of changed) {
    try {
      const hash = await chatHashForMode(mode, keys, chat.chatId);
      const body = JSON.stringify({
        chatId: chat.chatId,
        chatName: chat.chatName,
        chatPhone: chat.chatPhone || null,
        chatPushname: chat.chatPushname || null,
        isGroup: !!chat.isGroup,
        firstSeen: chat.firstSeen,
        lastSeen: chat.lastSeen,
      });
      const encoded = await encodeObject(mode, keys, body);
      const path = `/account=${settings.accountAlias}/_chats/${hash}${chatObjectExtension(mode)}`;
      await ensureFolder(settings, `/account=${settings.accountAlias}/_chats`);
      const meta = await uploadFile(settings, path, encoded);
      await verifyUploadedObject(meta, encoded, path);
      await updateChat(chat.chatId, {
        mapUploadedAt: Date.now(),
        mapUploadedName: chat.chatName,
        mapUploadedGroup: !!chat.isGroup,
        mapUploadedPhone: chat.chatPhone || null,
        mapUploadedPushname: chat.chatPushname || null,
        mapUploadedBackend: 'dropbox',
        mapUploadedMode: normalizeArchiveMode(mode),
        mapUploadedContentHash: meta.content_hash || null,
        mapUploadedSize: meta.size || null,
      });
      count++;
    } catch (e) {
      failedChatIds.push(chat.chatId);
      log('error', `Chat metadata: ${chat.chatId || 'unknown chat'} failed — ${messageOf(e)}`);
    }
  }
  log('success', `Chat metadata: ${count} chat(s) uploaded.`);
  return { count, failedChatIds };
}

async function ensureChatIndex(settings, keys, mode) {
  const chats = await getChats();
  if (!chats.length) return false;
  const fingerprint = chatIndexFingerprint(chats);
  const flag = await getMeta('dropboxChatIndexUploaded');
  if (
    flag &&
    flag.backend === 'dropbox' &&
    flag.account === settings.accountAlias &&
    (flag.mode || 'encrypted') === normalizeArchiveMode(mode) &&
    flag.fingerprint === fingerprint
  ) {
    return false;
  }

  const entries = [];
  for (const chat of chats) {
    entries.push({
      hash: await chatHashForMode(mode, keys, chat.chatId),
      chatId: chat.chatId,
      chatName: chat.chatName,
      chatPhone: chat.chatPhone || null,
      chatPushname: chat.chatPushname || null,
      isGroup: !!chat.isGroup,
      firstSeen: chat.firstSeen,
      lastSeen: chat.lastSeen,
    });
  }
  entries.sort((a, b) => (a.chatName || '').localeCompare(b.chatName || ''));

  const body = JSON.stringify({ generatedAt: new Date().toISOString(), mode: normalizeArchiveMode(mode), chats: entries });
  const encoded = await encodeObject(mode, keys, body);
  const path = `/account=${settings.accountAlias}/_chats/index${chatObjectExtension(mode)}`;
  await ensureFolder(settings, `/account=${settings.accountAlias}/_chats`);
  const meta = await uploadFile(settings, path, encoded);
  await verifyUploadedObject(meta, encoded, path);
  await setMeta('dropboxChatIndexUploaded', {
    at: Date.now(),
    count: entries.length,
    fingerprint,
    account: settings.accountAlias,
    backend: 'dropbox',
    mode: normalizeArchiveMode(mode),
    contentHash: meta.content_hash || null,
    size: meta.size || null,
  });
  return true;
}

export async function runUpload(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const manual = options.manual === true;
  if (running) {
    if (manual) log('warn', 'Upload skipped: another upload is already running.');
    return { skipped: 'already-running' };
  }
  running = true;
  const startedAt = Date.now();
  try {
    const settings = await getSettings();
    if (!settings.uploadEnabled) {
      if (manual) log('info', 'Upload skipped: uploads are disabled.');
      return { skipped: 'disabled' };
    }
    settings.accountAlias = resolveAccountAlias(settings);
    const mode = 'encrypted';

    if (manual) {
      const pending = await pendingCountSafe();
      log('info', `Upload started${pending == null ? '' : ` (${pending} message(s) pending)`}.`);
    }

    if (!settings.encryptionKey) {
      if (manual) log('warn', 'Upload skipped: the encrypted archive is missing its key.');
      return { skipped: 'unconfigured' };
    }
    if (settings.encryptionKeyAcknowledged !== true) {
      if (manual) log('warn', 'Upload skipped: confirm that you saved the encryption key first.');
      return { skipped: 'key-not-acknowledged' };
    }
    let keys;
    try {
      keys = await deriveKeys(settings.encryptionKey);
    } catch (e) {
      return await finish(
        startedAt,
        { uploaded: 0, error: `invalid encryption key: ${messageOf(e)}` },
        log,
        { manual }
      );
    }

    try {
      await ensureAccessToken(settings);
    } catch (e) {
      return await finish(startedAt, { uploaded: 0, error: `dropbox: ${messageOf(e)}` }, log, { manual });
    }

    const auth = await getAuth();
    const keyFp = mode === 'encrypted' ? await keyFingerprint(settings.encryptionKey) : null;
    const formatFlag = await getMeta('dropboxFormatUploaded');
    const formatMode = formatFlag ? normalizeArchiveMode(formatFlag.mode || 'encrypted') : null;
    const startingFreshEncrypted =
      mode === 'encrypted' &&
      formatMode === 'plaintext' &&
      formatFlag.account !== settings.accountAlias;
    const previousAlias = formatFlag ? formatFlag.account : settings.accountAlias;
    const previousMode = formatMode || mode;
    const offloadKey = await getMeta('offloadKeyFingerprint');
    const offloadAccount = await getMeta('offloadAccountId');
    const offloadMode = await getMeta('offloadArchiveMode');
    const keyChanged = mode === 'encrypted' && offloadKey && offloadKey !== keyFp;
    const accountChanged = offloadAccount && auth && auth.accountId && offloadAccount !== auth.accountId;
    const modeChanged = offloadMode && offloadMode !== mode;
    if (
      !startingFreshEncrypted &&
      (keyChanged || accountChanged || modeChanged) &&
      (await hasClearedPayloads({ accountAlias: previousAlias, archiveMode: previousMode }))
    ) {
      return await finish(
        startedAt,
        {
          uploaded: 0,
          error: 'offloaded messages must be restored before changing the encryption key, archive mode or Dropbox account',
        },
        log,
        { manual }
      );
    }

    if (formatFlag && formatFlag.account === settings.accountAlias && formatMode !== mode) {
      return await finish(
        startedAt,
        {
          uploaded: 0,
          error:
            'this Dropbox archive uses a retired unencrypted format; clear the app folder or use a new account alias',
        },
        log,
        { manual }
      );
    }
    if (!formatFlag || formatFlag.account !== settings.accountAlias) {
      if (
        !startingFreshEncrypted &&
        (await hasClearedPayloads({ accountAlias: previousAlias, archiveMode: previousMode }))
      ) {
        return await finish(
          startedAt,
          {
            uploaded: 0,
            error: 'offloaded messages must be restored before switching archive destination',
          },
          log,
          { manual }
        );
      }
      if (!startingFreshEncrypted) {
        const requeued = await reenqueueDoneForUpload('dropbox-init');
        if (requeued) console.log('[WAiDrop] re-enqueued', requeued, 'record(s) for Dropbox');
      }
    }

    let firstError = null;
    let formatUploaded = false;
    let chatMapsUploaded = 0;
    let chatIndexUploaded = false;
    let mediaUploaded = 0;
    let mediaFailed = 0;

    try {
      const media = await uploadPendingMedia(settings, keys, mode, { log });
      mediaUploaded = media.uploaded;
      mediaFailed = media.failed;
      if (media.error && !firstError) firstError = media.error;
    } catch (e) {
      const message = messageOf(e);
      if (!firstError) firstError = message;
      log('error', `Media upload failed — ${message}`);
    }

    try {
      formatUploaded = await ensureFormat(settings, mode);
      if (formatUploaded) log('success', 'Archive format marker uploaded.');
    } catch (e) {
      const message = messageOf(e);
      if (!firstError) firstError = message;
      log('error', `Archive format marker failed — ${message}`);
    }
    try {
      const maps = await uploadChangedChatMaps(settings, keys, mode, { log });
      chatMapsUploaded = maps.count;
    } catch (e) {
      const message = messageOf(e);
      if (!firstError) firstError = message;
      log('error', `Chat metadata upload failed — ${message}`);
    }
    try {
      chatIndexUploaded = await ensureChatIndex(settings, keys, mode);
      if (chatIndexUploaded) log('success', 'Chat index uploaded.');
    } catch (e) {
      const message = messageOf(e);
      if (!firstError) firstError = message;
      log('error', `Chat index upload failed — ${message}`);
    }

    const now = Date.now();
    const pendingEntries = (await listPendingOutbox(500)).filter(
      (entry) => !entry.nextAttemptAt || entry.nextAttemptAt <= now
    );
    if (!pendingEntries.length) {
      return await finish(
        startedAt,
        {
          uploaded: 0,
          mediaUploaded,
          mediaFailed,
          error: firstError,
          formatUploaded,
          chatMapsUploaded,
          chatIndexUploaded,
        },
        log,
        { manual }
      );
    }

    const attemptsById = new Map(pendingEntries.map((entry) => [entry.msgId, entry.attempts || 0]));
    const allRecords = await getMessagesByIds(pendingEntries.map((entry) => entry.msgId));
    let records = allRecords.filter((record) => !record.payloadCleared);
    if (records.length !== allRecords.length) {
      log('warn', `Skipped ${allRecords.length - records.length} offloaded message(s) with no payload.`);
    }
    const installedAt = await getInstalledAt();
    if (settings.syncPreInstallMessages !== true) {
      const preInstallIds = records
        .filter((record) => isPreInstallMessage(record, installedAt))
        .map((record) => record.msgId);
      if (preInstallIds.length) {
        await setOutboxStatus(preInstallIds, 'blocked', {
          reason: PRE_INSTALL_REASON,
          blockedFromStatus: 'pending',
        });
        log('info', `Skipped ${preInstallIds.length} pre-install message(s); enable full-history sync to upload them.`);
        records = records.filter((record) => !isPreInstallMessage(record, installedAt));
      }
    }

    if (!records.length) {
      return await finish(
        startedAt,
        {
          uploaded: 0,
          mediaUploaded,
          mediaFailed,
          error: firstError,
          formatUploaded,
          chatMapsUploaded,
          chatIndexUploaded,
        },
        log,
        { manual }
      );
    }

    const hashCache = new Map();
    const hashOf = async (text) => {
      if (!hashCache.has(text)) hashCache.set(text, await chatHashForMode(mode, keys, text));
      return hashCache.get(text);
    };
    const payloadHasher = createPayloadHasher(keys, mode);
    const payloadHashes = new Map();
    for (const record of records) {
      payloadHashes.set(record.msgId, await payloadHasher(record));
    }

    const groups = new Map();
    for (const record of records) {
      const chatText = record.chatId || `name:${record.chatName || 'unknown'}`;
      const hash = await hashOf(chatText);
      const dt = partitionDate(record.sortTs || record.ts || record.capturedAt || now);
      const groupKey = `${hash}|${dt}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { hash, dt, items: [] });
      groups.get(groupKey).items.push(record);
    }

    const plans = [];
    for (const group of groups.values()) {
      group.items.sort((a, b) => (a.sortTs || 0) - (b.sortTs || 0));
      for (let i = 0; i < group.items.length; i += MAX_PER_OBJECT) {
        const chunk = group.items.slice(i, i + MAX_PER_OBJECT);
        const firstTs = chunk[0].sortTs || chunk[0].ts || chunk[0].capturedAt || startedAt;
        const last = chunk[chunk.length - 1];
        const lastTs = last.sortTs || last.ts || last.capturedAt || firstTs;
        const seq = Math.floor(i / MAX_PER_OBJECT);
        plans.push({
          path: `/account=${settings.accountAlias}/chat=${group.hash}/dt=${group.dt}/part-${firstTs}-${lastTs}-${seq}${objectExtension(mode)}`,
          body:
            chunk
              .map((record) => {
                const { isGroupKey, ...archived } = record;
                return JSON.stringify(archived);
              })
              .join('\n') + '\n',
          msgIds: chunk.map((record) => record.msgId),
        });
      }
    }

    if (plans.length) {
      log('info', `Messages: ${records.length} message(s) in ${plans.length} part(s) to upload.`);
    }

    let uploadedCount = 0;
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      log(
        'info',
        `Messages part ${i + 1}/${plans.length}: uploading ${plan.msgIds.length} message(s)...`
      );
      try {
        const encoded = await encodeObject(mode, keys, plan.body);
        await ensureFolder(settings, plan.path.slice(0, plan.path.lastIndexOf('/')));
        const meta = await uploadFile(settings, plan.path, encoded);
        await verifyUploadedObject(meta, encoded, plan.path);
        const verifiedAt = Date.now();
        await markOutboxDone(
          plan.msgIds.map((msgId) => ({ msgId, payloadHash: payloadHashes.get(msgId) || null })),
          {
            uploadedAt: verifiedAt,
            lastPath: plan.path,
            verifiedAt,
            remotePath: plan.path,
            remoteRev: meta.rev || null,
            remoteContentHash: meta.content_hash || null,
            remoteSize: meta.size || null,
            accountAlias: settings.accountAlias,
            dropboxAccountId: auth ? auth.accountId || null : null,
            archiveMode: mode,
            keyFingerprint: keyFp,
          }
        );
        uploadedCount += plan.msgIds.length;
        log('success', `Messages part ${i + 1}/${plans.length}: uploaded.`);
      } catch (e) {
        const message = messageOf(e);
        if (!firstError) firstError = message;
        log('error', `Messages part ${i + 1}/${plans.length}: failed — ${message}`);
        for (const msgId of plan.msgIds) {
          const nextAttempts = (attemptsById.get(msgId) || 0) + 1;
          await setOutboxStatus([msgId], 'pending', {
            attempts: nextAttempts,
            nextAttemptAt: Date.now() + backoffMs(nextAttempts),
            lastError: message,
          });
        }
      }
    }

    return await finish(
      startedAt,
      {
        uploaded: uploadedCount,
        mediaUploaded,
        mediaFailed,
        error: firstError,
        formatUploaded,
        chatMapsUploaded,
        chatIndexUploaded,
      },
      log,
      { manual }
    );
  } catch (e) {
    const message = messageOf(e);
    log('error', `Upload failed — ${message}`);
    await setMeta('lastUpload', { at: Date.now(), uploaded: 0, pending: await pendingCountSafe(), error: message });
    return { uploaded: 0, error: message };
  } finally {
    running = false;
  }
}

export async function probeConnection() {
  const settings = await getSettings();
  try {
    const info = await testConnection(settings);
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}
