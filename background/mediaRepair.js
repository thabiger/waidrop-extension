import {
  listRepairs,
  getMessage,
  getOutboxEntry,
  getMediaMeta,
  mediaMeta,
  putRestoredRecord,
  setOutboxStatus,
  deleteOutboxEntry,
} from './idb.js';
import { getSettings, resolveAccountAlias } from './uploader.js';
import { deriveKeys, keyFingerprint } from './crypto.js';
import { getAuth } from './dropbox.js';
import { downloadPartRecords } from './archiveReader.js';
import { logActivity } from './activityLog.js';

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function backoffMs(attempts) {
  return Math.min(15000 * Math.pow(2, Math.max(0, attempts - 1)), 15 * 60 * 1000);
}

async function stillRepair(msgId) {
  const entry = await getOutboxEntry(msgId);
  if (!entry || entry.status !== 'repair') return false;
  const message = await getMessage(msgId);
  return !!message && message.payloadCleared === true;
}

export async function runMediaRepair(options = {}) {
  const log = typeof options.log === 'function' ? options.log : logActivity;
  const settings = await getSettings();
  if (!settings.uploadEnabled) {
    return { skipped: 'unconfigured', repaired: 0 };
  }

  const mode = 'encrypted';
  settings.accountAlias = resolveAccountAlias(settings);
  if (!settings.encryptionKey) {
    return { skipped: 'unconfigured', repaired: 0 };
  }

  let auth;
  try {
    auth = await getAuth();
    if (!auth || !auth.refreshToken) return { skipped: 'dropbox-not-connected', repaired: 0 };
  } catch (e) {
    return { skipped: 'dropbox-not-connected', repaired: 0 };
  }

  let keys = null;
  if (mode === 'encrypted') {
    try {
      keys = await deriveKeys(settings.encryptionKey);
    } catch (e) {
      return { skipped: 'invalid-key', repaired: 0, error: messageOf(e) };
    }
  }

  const keyFp = mode === 'encrypted' ? await keyFingerprint(settings.encryptionKey) : null;
  const repairs = await listRepairs(200);
  const now = Date.now();
  const groups = new Map();

  for (const repair of repairs) {
    if (repair.nextAttemptAt && repair.nextAttemptAt > now) continue;
    const message = await getMessage(repair.msgId);
    if (!message || !message.payloadCleared || !message.remote || !message.remote.path) {
      await deleteOutboxEntry(repair.msgId);
      continue;
    }
    if (message.remote.archiveMode && message.remote.archiveMode !== mode) {
      log('warn', `Media repair paused: archive mode changed for ${repair.msgId}.`);
      continue;
    }
    if (mode === 'encrypted' && message.remote.keyFingerprint && message.remote.keyFingerprint !== keyFp) {
      log('warn', `Media repair paused: key changed for ${repair.msgId}.`);
      continue;
    }
    if (message.remote.accountAlias && message.remote.accountAlias !== settings.accountAlias) {
      log('warn', `Media repair paused: account changed for ${repair.msgId}.`);
      continue;
    }
    if (message.remote.dropboxAccountId && auth.accountId && message.remote.dropboxAccountId !== auth.accountId) {
      log('warn', `Media repair paused: Dropbox account changed for ${repair.msgId}.`);
      continue;
    }
    if (!groups.has(message.remote.path)) groups.set(message.remote.path, []);
    groups.get(message.remote.path).push({ repair, message });
  }

  let repaired = 0;
  let failed = 0;

  for (const [path, items] of groups) {
    let records;
    try {
      records = await downloadPartRecords(settings, keys, path, mode);
    } catch (e) {
      const reason = messageOf(e);
      for (const { repair } of items) {
        if (!(await stillRepair(repair.msgId))) continue;
        const attempts = (repair.attempts || 0) + 1;
        await setOutboxStatus([repair.msgId], 'repair', {
          attempts,
          nextAttemptAt: Date.now() + backoffMs(attempts),
          lastError: reason,
        });
        failed++;
      }
      log('error', `Media repair failed for ${path}: ${reason}`);
      continue;
    }

    const byId = new Map(records.map((record) => [record.msgId, record]));
    for (const { repair, message } of items) {
      try {
        if (!(await stillRepair(repair.msgId))) continue;
        const remote = byId.get(repair.msgId);
        if (!remote) throw new Error('message not found in remote part');
        const media = await getMediaMeta(repair.msgId);
        if (!media || media.status !== 'stored') throw new Error('media is not stored yet');
        const restored = {
          ...remote,
          chatId: message.chatId || remote.chatId,
          chatName: message.chatName || remote.chatName,
          isGroup: message.isGroup ?? remote.isGroup,
          direction: message.direction || remote.direction,
          capturedAt: Date.now(),
          media: mediaMeta(media),
        };
        await putRestoredRecord(restored);
        repaired++;
      } catch (e) {
        if (!(await stillRepair(repair.msgId))) continue;
        const attempts = (repair.attempts || 0) + 1;
        await setOutboxStatus([repair.msgId], 'repair', {
          attempts,
          nextAttemptAt: Date.now() + backoffMs(attempts),
          lastError: messageOf(e),
        });
        failed++;
      }
    }
  }

  if (repaired) log('success', `Media repair: restored ${repaired} message(s).`);
  return { repaired, failed };
}

