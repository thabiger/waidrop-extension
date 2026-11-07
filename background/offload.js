import {
  listDoneOutbox,
  getMessage,
  getMediaMeta,
  getChat,
  getMeta,
  setMeta,
  clearMessagePayloads,
} from './idb.js';
import {
  getSettings,
  isFormatCurrent,
  isChatIndexCurrent,
  isChatMapCurrent,
  resolveAccountAlias,
} from './uploader.js';
import { deriveKeys, keyFingerprint } from './crypto.js';
import { chatHashForMode, chatObjectExtension } from './archiveCodec.js';
import { createPayloadHasher } from './payloadHash.js';
import { getAuth, getMetadata } from './dropbox.js';
import { logActivity } from './activityLog.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

async function loadRemoteMetadata(settings, paths, log) {
  const cache = new Map();
  for (const path of [...new Set(paths.filter(Boolean))]) {
    try {
      cache.set(path, await getMetadata(settings, path));
    } catch (e) {
      cache.set(path, null);
      log('warn', `Offload remote check failed for ${path}: ${messageOf(e)}`);
    }
  }
  return cache;
}

function metadataMatches(meta, expectedHash, expectedSize) {
  if (!meta) return false;
  if (expectedSize != null && typeof meta.size === 'number' && meta.size !== expectedSize) return false;
  if (expectedHash && meta.content_hash && meta.content_hash !== expectedHash) return false;
  return true;
}

export async function runOffloadSweep(options = {}) {
  const log = typeof options.log === 'function' ? options.log : logActivity;
  const settings = await getSettings();
  if (!settings.offloadEnabled) return { skipped: 'disabled', cleared: 0 };
  if (!settings.uploadEnabled) return { skipped: 'uploads-disabled', cleared: 0 };

  const mode = 'encrypted';
  settings.accountAlias = resolveAccountAlias(settings);
  if (!settings.encryptionKey) {
    return { skipped: 'unconfigured', cleared: 0 };
  }

  let auth;
  try {
    auth = await getAuth();
    if (!auth || !auth.refreshToken) return { skipped: 'dropbox-not-connected', cleared: 0 };
  } catch (e) {
    return { skipped: 'dropbox-not-connected', cleared: 0 };
  }

  try {
    if (!(await isFormatCurrent(settings, mode))) return { skipped: 'format-stale', cleared: 0 };
    if (!(await isChatIndexCurrent(settings, mode))) {
      return { skipped: 'index-stale', cleared: 0 };
    }
  } catch (e) {
    return { skipped: 'archive-state-unavailable', error: messageOf(e), cleared: 0 };
  }

  let keys = null;
  if (mode === 'encrypted') {
    try {
      keys = await deriveKeys(settings.encryptionKey);
    } catch (e) {
      return { skipped: 'invalid-key', error: messageOf(e), cleared: 0 };
    }
  }

  const keyFp = mode === 'encrypted' ? await keyFingerprint(settings.encryptionKey) : null;
  const payloadHasher = createPayloadHasher(keys, mode);
  const retentionDays = Math.max(0, Number(settings.offloadRetentionDays) || 0);
  const cutoff = Date.now() - retentionDays * DAY_MS;
  const entries = await listDoneOutbox(4000);
  const candidates = [];

  for (const entry of entries) {
    if (!entry || typeof entry.verifiedAt !== 'number' || entry.verifiedAt > cutoff) continue;
    if (entry.accountAlias !== settings.accountAlias) continue;
    if (entry.archiveMode && entry.archiveMode !== mode) continue;
    if (entry.dropboxAccountId && auth.accountId && entry.dropboxAccountId !== auth.accountId) continue;
    if (mode === 'encrypted' && entry.keyFingerprint && entry.keyFingerprint !== keyFp) continue;
    if (!entry.remotePath) continue;

    const message = await getMessage(entry.msgId);
    if (!message || message.payloadCleared) continue;
    if (!message.chatId) continue;

    const chat = await getChat(message.chatId);
    if (!chat || !isChatMapCurrent(chat, mode)) continue;

    const currentHash = await payloadHasher(message);
    if (!entry.payloadHash || entry.payloadHash !== currentHash) continue;

    const media = await getMediaMeta(entry.msgId);
    const mediaStatus = media ? media.status : message.media && message.media.status;
    const mediaPath = (media && media.path) || (message.media && message.media.path);
    if (mediaStatus === 'stored' && !mediaPath) continue;
    const awaitingMedia = mediaStatus === 'pending' || mediaStatus === 'not_downloaded';

    const chatHashValue = await chatHashForMode(mode, keys, message.chatId);
    const chatExtension = chatObjectExtension(mode);
    const paths = [
      entry.remotePath,
      `/account=${settings.accountAlias}/_format.json`,
      `/account=${settings.accountAlias}/_chats/index${chatExtension}`,
      `/account=${settings.accountAlias}/_chats/${chatHashValue}${chatExtension}`,
    ];
    if (mediaStatus === 'stored' && mediaPath) {
      paths.push(`/account=${settings.accountAlias}/${mediaPath}`);
    }
    candidates.push({
      entry,
      message,
      media,
      mediaPath,
      mediaStatus,
      awaitingMedia,
      paths,
    });
  }

  if (!candidates.length) {
    await setMeta('lastOffloadSweep', { at: Date.now(), cleared: 0 });
    return { cleared: 0, scanned: entries.length };
  }

  const remote = await loadRemoteMetadata(settings, candidates.flatMap((item) => item.paths), log);
  const ready = [];
  for (const item of candidates) {
    const partMeta = remote.get(item.entry.remotePath);
    if (!metadataMatches(partMeta, item.entry.remoteContentHash, item.entry.remoteSize)) continue;
    const chatHashValue = await chatHashForMode(mode, keys, item.message.chatId);
    const chatExtension = chatObjectExtension(mode);
    const mapMeta = remote.get(`/account=${settings.accountAlias}/_chats/${chatHashValue}${chatExtension}`);
    if (!mapMeta) continue;
    if (!remote.get(`/account=${settings.accountAlias}/_format.json`)) continue;
    if (!remote.get(`/account=${settings.accountAlias}/_chats/index${chatExtension}`)) continue;
    if (item.mediaStatus === 'stored' && item.mediaPath) {
      if (!remote.get(`/account=${settings.accountAlias}/${item.mediaPath}`)) continue;
    }
    ready.push({
      msgId: item.message.msgId,
      payloadHash: item.entry.payloadHash,
      awaitingMedia: item.awaitingMedia,
      remote: {
        path: item.entry.remotePath,
        rev: item.entry.remoteRev || null,
        contentHash: item.entry.remoteContentHash || null,
        size: item.entry.remoteSize || null,
        accountAlias: item.entry.accountAlias || settings.accountAlias,
        dropboxAccountId: item.entry.dropboxAccountId || (auth && auth.accountId) || null,
        archiveMode: mode,
        keyFingerprint: keyFp,
        verifiedAt: item.entry.verifiedAt,
      },
    });
  }

  if (!ready.length) {
    await setMeta('lastOffloadSweep', { at: Date.now(), cleared: 0 });
    return { cleared: 0, scanned: entries.length };
  }

  const result = await clearMessagePayloads(ready);
  await setMeta('lastOffloadSweep', { at: Date.now(), cleared: result.cleared, bytes: result.bytes });
  await setMeta('offloadKeyFingerprint', keyFp);
  await setMeta('offloadAccountId', (auth && auth.accountId) || null);
  await setMeta('offloadArchiveMode', mode);
  if (result.cleared) {
    log('success', `Offload: cleared ${result.cleared} message payload(s); ${ready.filter((item) => item.awaitingMedia).length} awaiting media.`);
  }
  return { ...result, scanned: entries.length };
}
