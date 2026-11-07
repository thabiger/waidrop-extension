/**
 * WAiDrop - IndexedDB archive layer (v2)
 *
 * Extension-origin database `waidrop`, the durable local archive and the
 * queues that the encrypted Dropbox uploader drains:
 *   messages  keyPath msgId   - full records (schema v1), immutable except
 *                               DOM -> store upgrade; indexes by_sortTs, by_chat
 *   outbox    keyPath msgId   - {status: pending|inflight|done, attempts, ...};
 *                               absence of a done entry would be ambiguous, so
 *                               entries are kept and marked done
 *   media     keyPath msgId   - full-resolution bytes + upload metadata;
 *                               index by_status
 *   chats     keyPath chatId  - {chatName, isGroup, firstSeen, lastSeen}
 *   meta      keyPath key     - schema, lastSync, migration flags
 *
 * Sensitive message, chat and media payloads are sealed by the local codec
 * before they reach IndexedDB. Routing metadata stays plaintext for indexes and
 * queue maintenance. ES module, usable from the service worker and popup;
 * tests run it against fake-indexeddb.
 */
import { isPreInstallMessage } from './archivePolicy.js';

const DB_NAME = 'waidrop';
const DB_VERSION = 3;

let dbPromise = null;
let localCodec = null;

export function setLocalCodec(codec) {
  localCodec = codec || null;
}

export function getLocalCodec() {
  return localCodec;
}

function requireLocalCodec() {
  if (!localCodec) throw new Error('local-encryption-key-required');
  return localCodec;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      const backfillGroupKeys = (store) => {
        if (!store || typeof store.openCursor !== 'function') return;
        store.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const value = cursor.value;
          if (value && value.isGroupKey == null) {
            cursor.update({ ...value, isGroupKey: value.isGroup === true ? 1 : 0 });
          }
          cursor.continue();
        };
      };
      if (!db.objectStoreNames.contains('messages')) {
        const messages = db.createObjectStore('messages', { keyPath: 'msgId' });
        messages.createIndex('by_sortTs', 'sortTs');
        messages.createIndex('by_chat', 'chatId');
        messages.createIndex('by_isGroup', 'isGroupKey');
      } else {
        const messages = tx.objectStore('messages');
        if (!messages.indexNames.contains('by_isGroup')) messages.createIndex('by_isGroup', 'isGroupKey');
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'msgId' });
        outbox.createIndex('by_status', 'status');
      }
      if (!db.objectStoreNames.contains('chats')) {
        const chats = db.createObjectStore('chats', { keyPath: 'chatId' });
        chats.createIndex('by_isGroup', 'isGroupKey');
      } else {
        const chats = tx.objectStore('chats');
        if (!chats.indexNames.contains('by_isGroup')) chats.createIndex('by_isGroup', 'isGroupKey');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('media')) {
        const media = db.createObjectStore('media', { keyPath: 'msgId' });
        media.createIndex('by_status', 'status');
      }
      if (db.objectStoreNames.contains('messages')) backfillGroupKeys(tx.objectStore('messages'));
      if (db.objectStoreNames.contains('chats')) backfillGroupKeys(tx.objectStore('chats'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function normalize(record, now) {
  const sortTs =
    typeof record.ts === 'number' ? record.ts : typeof record.capturedAt === 'number' ? record.capturedAt : now;
  const isGroup = record.isGroup === true || /@g\.us$/i.test(String(record.chatId || ''));
  return { ...record, isGroup, isGroupKey: isGroup ? 1 : 0, sortTs };
}

// Capture-time and transient fields say nothing about the message content.
// Re-delivered duplicates must not look like edits, otherwise every page load
// re-enqueues already-uploaded messages and the uploader re-uploads them.
const VOLATILE_FIELDS = new Set([
  'capturedAt',
  'sortTs',
  'error',
  'payloadEnc',
  'payloadEncVersion',
  'chatEnc',
  'chatEncVersion',
  'bytes',
  'bytesEnc',
  'bytesEncVersion',
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined && !VOLATILE_FIELDS.has(key))
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function contentSignature(value) {
  return stableStringify(value);
}

const NAME_FIELDS = ['chatName', 'chatPhone', 'chatPushname', 'senderName', 'senderPushname', 'senderPhone'];
const isBlank = (value) => value == null || value === '' || value === 'unknown';

const MEDIA_RANK = {
  stored: 5,
  pending: 4,
  failed: 3,
  unavailable: 2,
  not_downloaded: 1,
  view_once: 1,
  skipped: 1,
  too_large: 1,
  blocked: 1,
};

const CLEARED_FIELDS = [
  'text',
  'tsRaw',
  'msgKey',
  'senderId',
  'senderName',
  'senderPushname',
  'senderPhone',
  'chatPhone',
  'chatPushname',
  'error',
];

const VERIFICATION_FIELDS = [
  'verifiedAt',
  'remotePath',
  'remoteRev',
  'remoteContentHash',
  'remoteSize',
  'accountAlias',
  'dropboxAccountId',
  'keyFingerprint',
  'payloadHash',
  'lastPath',
];

function pendingOutboxEntry(entry, msgId, reason, now) {
  const next = { ...(entry || {}), msgId, status: 'pending', attempts: 0, reason, enqueuedAt: now };
  for (const field of VERIFICATION_FIELDS) delete next[field];
  return next;
}

export function mediaMeta(entry) {
  if (!entry) return null;
  const meta = {
    status: entry.status || 'pending',
    kind: entry.kind || null,
    mime: entry.mime || null,
    size: typeof entry.byteLength === 'number' ? entry.byteLength : null,
    width: entry.width || null,
    height: entry.height || null,
    sha256: entry.sha256 || null,
    path: entry.path || null,
    capturedAt: entry.capturedAt || null,
  };
  if (entry.lastError) meta.error = entry.lastError;
  return meta;
}

function mergeMedia(existing, incoming) {
  if (!existing) return incoming || null;
  if (!incoming) return existing;
  const existingRank = MEDIA_RANK[existing.status] || 0;
  const incomingRank = MEDIA_RANK[incoming.status] || 0;
  if (incomingRank > existingRank) return { ...existing, ...incoming };
  if (incomingRank < existingRank) return existing;
  return (incoming.capturedAt || 0) >= (existing.capturedAt || 0) ? { ...existing, ...incoming } : existing;
}

/**
 * Merge a duplicate record onto the stored one without ever losing names:
 * - store payload upgrades a DOM record, but real DOM names survive blank
 *   store names
 * - a DOM recapture never downgrades a store record's payload
 * - name fields prefer whichever side has a real value (incoming wins when
 *   both are real, so renames propagate)
 */
function mergeRecords(existing, incoming) {
  if (existing.source === 'store' && incoming.source === 'dom') {
    const merged = { ...existing };
    for (const field of NAME_FIELDS) {
      if (isBlank(merged[field]) && !isBlank(incoming[field])) merged[field] = incoming[field];
    }
    return merged;
  }
  const merged = { ...existing, ...incoming };
  for (const field of NAME_FIELDS) {
    merged[field] = !isBlank(incoming[field]) ? incoming[field] : existing[field];
  }
  if (isBlank(incoming.text) && !isBlank(existing.text)) merged.text = existing.text;
  merged.media = mergeMedia(existing.media, incoming.media);
  if (!merged.media) delete merged.media;
  return merged;
}

/**
 * Insert-or-merge a batch of records in one transaction.
 * - new msgId: insert + enqueue in outbox (pending)
 * - duplicate: merge (names never downgrade; store upgrades DOM; edits/renames
 *   win); if the outbox entry is already done, re-enqueue the corrected record
 * - no-op duplicates: skipped
 * Returns { inserted, upgraded, updated, skipped }.
 */
export async function putRecords(records, options = {}) {
  const db = await getDb();
  const now = Date.now();
  const payloadHasher = typeof options.payloadHasher === 'function' ? options.payloadHasher : null;
  const normalized = (records || [])
    .filter((record) => record && record.msgId)
    .map((record) => normalize(record, now));
  if (!normalized.length) return { inserted: 0, upgraded: 0, updated: 0, skipped: 0 };
  const codec = requireLocalCodec();

  const readTx = db.transaction(['messages', 'outbox', 'chats', 'media', 'meta'], 'readonly');
  const messagesStore = readTx.objectStore('messages');
  const outboxStore = readTx.objectStore('outbox');
  const chatsStore = readTx.objectStore('chats');
  const mediaStore = readTx.objectStore('media');
  const metaStore = readTx.objectStore('meta');

  const uniqueIds = [...new Set(normalized.map((record) => record.msgId))];
  const uniqueChatIds = [...new Set(normalized.map((record) => record.chatId).filter(Boolean))];
  const messageReads = new Map();
  const outboxReads = new Map();
  const mediaReads = new Map();
  const chatReads = new Map();
  for (const msgId of uniqueIds) {
    messageReads.set(msgId, reqPromise(messagesStore.get(msgId)));
    outboxReads.set(msgId, reqPromise(outboxStore.get(msgId)));
    mediaReads.set(msgId, reqPromise(mediaStore.get(msgId)));
  }
  for (const chatId of uniqueChatIds) chatReads.set(chatId, reqPromise(chatsStore.get(chatId)));
  const fingerprintRead = reqPromise(metaStore.get('localKeyFingerprint'));

  const messageState = new Map();
  for (const [msgId, request] of messageReads) {
    const raw = await request;
    messageState.set(msgId, raw ? await codec.openRecord(raw) : null);
  }
  const outboxState = new Map();
  for (const [msgId, request] of outboxReads) outboxState.set(msgId, await request);
  const mediaState = new Map();
  for (const [msgId, request] of mediaReads) mediaState.set(msgId, await request);
  const chatState = new Map();
  for (const [chatId, request] of chatReads) {
    const raw = await request;
    chatState.set(chatId, raw ? await codec.openChat(raw) : null);
  }
  const fingerprintRow = await fingerprintRead;
  if (fingerprintRow && fingerprintRow.value !== codec.fingerprint) {
    throw new Error('local-archive-key-mismatch');
  }
  const touchedChats = new Set();

  const messageOps = new Map();
  const outboxOps = new Map();
  let inserted = 0;
  let upgraded = 0;
  let updated = 0;
  let skipped = 0;

  const queueOutbox = (entry) => {
    outboxOps.set(entry.msgId, entry);
    outboxState.set(entry.msgId, entry);
  };

  const touchChat = (record) => {
    if (!record.chatId) return;
    const existingChat = chatState.get(record.chatId);
    const isGroup = record.isGroup === true || /@g\.us$/i.test(String(record.chatId));
    if (!existingChat) {
      chatState.set(record.chatId, {
        chatId: record.chatId,
        chatName: record.chatName || 'unknown',
        chatPhone: record.chatPhone || null,
        chatPushname: record.chatPushname || null,
        isGroup,
        isGroupKey: isGroup ? 1 : 0,
        firstSeen: now,
        lastSeen: now,
      });
    } else {
      const mergedGroup = isGroup || existingChat.isGroup === true;
      chatState.set(record.chatId, {
        ...existingChat,
        chatName: record.chatName || existingChat.chatName,
        chatPhone: record.chatPhone || existingChat.chatPhone || null,
        chatPushname: record.chatPushname || existingChat.chatPushname || null,
        isGroup: mergedGroup,
        isGroupKey: mergedGroup ? 1 : 0,
        lastSeen: now,
      });
    }
    touchedChats.add(record.chatId);
  };

  for (const record of normalized) {
    const existing = messageState.get(record.msgId);
    const storedMedia = mediaState.get(record.msgId);
    if (storedMedia) record.media = mergeMedia(record.media, mediaMeta(storedMedia));
    let effective = record;
    let stored = false;

    if (!existing) {
      messageState.set(record.msgId, record);
      messageOps.set(record.msgId, record);
      queueOutbox({ msgId: record.msgId, status: 'pending', attempts: 0, enqueuedAt: now });
      inserted++;
      stored = true;
    } else if (existing.payloadCleared) {
      if (existing.source === 'store' && record.source === 'dom') {
        skipped++;
        continue;
      }
      const isUpgrade = existing.source === 'dom' && record.source === 'store';
      const incomingHash = payloadHasher ? await payloadHasher(record) : null;
      if (!isUpgrade && incomingHash && existing.payloadHash && incomingHash === existing.payloadHash) {
        skipped++;
        continue;
      }
      const merged = normalize(mergeRecords(existing, record), now);
      if (!isUpgrade && !incomingHash && isBlank(record.text) && record.type !== 'revoked') {
        skipped++;
        continue;
      }
      merged.payloadCleared = false;
      delete merged.offloadedAt;
      delete merged.awaitingMedia;
      delete merged.remote;
      messageState.set(record.msgId, merged);
      messageOps.set(record.msgId, merged);
      effective = merged;
      if (isUpgrade) upgraded++;
      else updated++;
      stored = true;
      queueOutbox(
        pendingOutboxEntry(
          outboxState.get(record.msgId),
          record.msgId,
          isUpgrade ? 'upgrade' : 'post-offload-update',
          now
        )
      );
    } else {
      const merged = normalize(mergeRecords(existing, record), now);
      if (contentSignature(merged) === contentSignature(existing)) {
        skipped++;
        continue;
      }
      messageState.set(record.msgId, merged);
      messageOps.set(record.msgId, merged);
      effective = merged;
      const isUpgrade = existing.source === 'dom' && record.source === 'store';
      if (isUpgrade) upgraded++;
      else updated++;
      stored = true;
      const entry = outboxState.get(record.msgId);
      if (!entry) {
        queueOutbox({ msgId: record.msgId, status: 'pending', attempts: 0, enqueuedAt: now, reason: 'update' });
      } else if (entry.status === 'done' || entry.status === 'repair') {
        queueOutbox(pendingOutboxEntry(entry, record.msgId, isUpgrade ? 'upgrade' : 'update', now));
      }
    }

    if (stored) touchChat(effective);
  }

  const sealedMessages = [];
  for (const record of messageOps.values()) sealedMessages.push(await codec.sealRecord(record));
  const sealedChats = [];
  for (const chatId of touchedChats) {
    const chat = chatState.get(chatId);
    if (chat) sealedChats.push(await codec.sealChat(chat));
  }

  const tx = db.transaction(['messages', 'outbox', 'chats', 'meta'], 'readwrite');
  for (const record of sealedMessages) tx.objectStore('messages').put(record);
  for (const entry of outboxOps.values()) tx.objectStore('outbox').put(entry);
  for (const chat of sealedChats) tx.objectStore('chats').put(chat);
  tx.objectStore('meta').put({ key: 'schema', value: 2 });
  tx.objectStore('meta').put({ key: 'lastSync', value: now });
  if (!fingerprintRow) {
    tx.objectStore('meta').put({ key: 'localKeyFingerprint', value: codec.fingerprint });
  }
  await txDone(tx);
  return { inserted, upgraded, updated, skipped };
}

/**
 * Flip uploaded (done) or missing outbox entries back to pending so corrected
 * records get re-uploaded. Pending/inflight entries are left alone.
 */
export async function reenqueueForUpload(msgIds, reason = 'update') {
  if (!msgIds || !msgIds.length) return 0;
  const db = await getDb();
  const tx = db.transaction('outbox', 'readwrite');
  const outbox = tx.objectStore('outbox');
  let count = 0;
  for (const msgId of msgIds) {
    const entry = await reqPromise(outbox.get(msgId));
    if (!entry) {
      outbox.put({ msgId, status: 'pending', attempts: 0, enqueuedAt: Date.now(), reason });
      count++;
    } else if (entry.status === 'done' || entry.status === 'repair') {
      outbox.put(pendingOutboxEntry(entry, msgId, reason, Date.now()));
      count++;
    }
  }
  await txDone(tx);
  return count;
}

/**
 * Flip every uploaded (done) outbox entry back to pending. Used once when a new
 * storage backend is initialized (e.g. after switching from the old S3 mode),
 * so the existing local archive is re-uploaded in the new format.
 */
export async function reenqueueDoneForUpload(reason = 'update') {
  const db = await getDb();
  const tx = db.transaction(['outbox', 'messages'], 'readwrite');
  const store = tx.objectStore('outbox');
  const messages = tx.objectStore('messages');
  const entries = await reqPromise(store.getAll());
  let count = 0;
  for (const entry of entries) {
    if (entry.status !== 'done') continue;
    const record = await reqPromise(messages.get(entry.msgId));
    if (!record || !record.payloadCleared) {
      store.put(pendingOutboxEntry(entry, entry.msgId, reason, Date.now()));
      count++;
    }
  }
  await txDone(tx);
  return count;
}

/**
 * Repair pass: apply the live chat-name directory (from the store hook) to
 * records whose names are missing/unknown, and to the chats store.
 * Returns { chats, updated, reenqueued }.
 */
export async function applyChatDirectory(entries) {
  const codec = requireLocalCodec();
  const db = await getDb();
  let updated = 0;
  const changedIds = [];

  for (const entry of entries || []) {
    if (!entry || !entry.chatId) continue;
    const rawChat = await reqPromise(
      (() => {
        const tx = db.transaction('chats', 'readonly');
        return tx.objectStore('chats').get(entry.chatId);
      })()
    );
    if (rawChat) {
      const chat = await codec.openChat(rawChat);
      const patch = {
        chatName: !isBlank(entry.chatName) ? entry.chatName : chat.chatName,
      };
      if (entry.chatPhone) patch.chatPhone = entry.chatPhone;
      if (entry.chatPushname) patch.chatPushname = entry.chatPushname;
      await updateChat(entry.chatId, patch);
    }

    const readTx = db.transaction(['messages'], 'readonly');
    const index = readTx.objectStore('messages').index('by_chat');
    const rawMessages = await reqPromise(index.getAll(IDBKeyRange.only(entry.chatId)));
    const writes = [];
    for (const raw of rawMessages) {
      const record = await codec.openRecord(raw);
      const next = { ...record };
      let changed = false;
      if (isBlank(next.chatName) && !isBlank(entry.chatName)) {
        next.chatName = entry.chatName;
        changed = true;
      }
      if (!record.payloadCleared) {
        if (!next.chatPhone && entry.chatPhone) {
          next.chatPhone = entry.chatPhone;
          changed = true;
        }
        if (!next.chatPushname && entry.chatPushname) {
          next.chatPushname = entry.chatPushname;
          changed = true;
        }
      }
      if (changed) {
        writes.push(await codec.sealRecord(next));
        if (!record.payloadCleared) changedIds.push(record.msgId);
        updated++;
      }
    }
    if (writes.length) {
      const tx = db.transaction(['messages'], 'readwrite');
      for (const record of writes) tx.objectStore('messages').put(record);
      await txDone(tx);
    }
  }

  const reenqueued = await reenqueueForUpload(changedIds, 'repair');
  return { chats: (entries || []).length, updated, reenqueued };
}

export async function clearMessagePayloads(entries) {
  if (!entries || !entries.length) return { cleared: 0, bytes: 0 };
  const codec = requireLocalCodec();
  const db = await getDb();
  const readTx = db.transaction(['messages', 'outbox', 'media', 'meta'], 'readonly');
  const messages = readTx.objectStore('messages');
  const outbox = readTx.objectStore('outbox');
  const media = readTx.objectStore('media');
  const meta = readTx.objectStore('meta');

  const messageReads = entries.map((item) => reqPromise(messages.get(item.msgId)));
  const outboxReads = entries.map((item) => reqPromise(outbox.get(item.msgId)));
  const mediaReads = entries.map((item) => reqPromise(media.get(item.msgId)));
  const countRead = reqPromise(meta.get('offloadedCount'));
  const bytesRead = reqPromise(meta.get('offloadedBytes'));
  const [rawMessages, rawOutbox, rawMedia, countRow, bytesRow] = await Promise.all([
    Promise.all(messageReads),
    Promise.all(outboxReads),
    Promise.all(mediaReads),
    countRead,
    bytesRead,
  ]);

  let cleared = 0;
  let bytes = 0;
  const messageWrites = [];
  const outboxDeletes = [];
  const mediaWrites = [];
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    const raw = rawMessages[i];
    if (!raw || raw.payloadCleared) continue;
    const record = await codec.openRecord(raw);
    const outboxEntry = rawOutbox[i];
    if (!outboxEntry || (outboxEntry.status !== 'done' && outboxEntry.status !== 'repair')) continue;
    const storedMedia = rawMedia[i];
    const mediaStatus = storedMedia ? storedMedia.status : record.media && record.media.status;
    const awaitingMedia = mediaStatus === 'pending' || mediaStatus === 'not_downloaded';
    const next = {
      ...record,
      payloadCleared: true,
      offloadedAt: item.offloadedAt || Date.now(),
      awaitingMedia,
      remote: item.remote,
    };
    for (const field of CLEARED_FIELDS) delete next[field];
    if (item.payloadHash) next.payloadHash = item.payloadHash;
    messageWrites.push(await codec.sealRecord(next));
    if (outboxEntry.status === 'done') outboxDeletes.push(item.msgId);
    if (storedMedia && (storedMedia.bytes || storedMedia.bytesEnc) && mediaStatus === 'stored') {
      bytes += Number(storedMedia.byteLength) || 0;
      mediaWrites.push({ ...storedMedia, bytes: null, bytesEnc: null, bytesEncVersion: null });
    }
    cleared++;
  }

  const tx = db.transaction(['messages', 'outbox', 'media', 'meta'], 'readwrite');
  for (const record of messageWrites) tx.objectStore('messages').put(record);
  for (const msgId of outboxDeletes) tx.objectStore('outbox').delete(msgId);
  for (const entry of mediaWrites) tx.objectStore('media').put(entry);
  tx.objectStore('meta').put({ key: 'offloadedCount', value: (countRow ? countRow.value : 0) + cleared });
  tx.objectStore('meta').put({ key: 'offloadedBytes', value: (bytesRow ? bytesRow.value : 0) + bytes });
  await txDone(tx);
  return { cleared, bytes };
}

export async function putRestoredRecord(record) {
  if (!record || !record.msgId) return false;
  const codec = requireLocalCodec();
  const db = await getDb();
  const readTx = db.transaction(['messages', 'outbox'], 'readonly');
  const [existing, entry] = await Promise.all([
    reqPromise(readTx.objectStore('messages').get(record.msgId)),
    reqPromise(readTx.objectStore('outbox').get(record.msgId)),
  ]);
  if (!existing || !existing.payloadCleared) return false;
  const opened = await codec.openRecord(existing);
  const next = {
    ...opened,
    ...record,
    payloadCleared: false,
  };
  delete next.payloadEnc;
  delete next.payloadEncVersion;
  delete next.offloadedAt;
  delete next.awaitingMedia;
  delete next.remote;
  const sealed = await codec.sealRecord(next);
  const writeTx = db.transaction(['messages', 'outbox'], 'readwrite');
  writeTx.objectStore('messages').put(sealed);
  writeTx.objectStore('outbox').put(pendingOutboxEntry(entry, record.msgId, 'media-repair', Date.now()));
  await txDone(writeTx);
  return true;
}

export async function countMessages() {
  const db = await getDb();
  const tx = db.transaction('messages', 'readonly');
  return reqPromise(tx.objectStore('messages').count());
}

export async function getAllMessages() {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('messages', 'readonly');
  const rows = await reqPromise(tx.objectStore('messages').getAll());
  const out = [];
  for (const row of rows) out.push(await codec.openRecord(row));
  return out;
}

export async function getMessagesByIds(msgIds) {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('messages', 'readonly');
  const store = tx.objectStore('messages');
  const rows = await Promise.all((msgIds || []).map((id) => reqPromise(store.get(id))));
  const out = [];
  for (const row of rows) if (row) out.push(await codec.openRecord(row));
  return out;
}

export async function getMessage(msgId) {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('messages', 'readonly');
  const row = await reqPromise(tx.objectStore('messages').get(msgId));
  return row ? codec.openRecord(row) : null;
}

export async function getOutboxEntry(msgId) {
  const db = await getDb();
  const tx = db.transaction('outbox', 'readonly');
  return (await reqPromise(tx.objectStore('outbox').get(msgId))) || null;
}

export async function getChat(chatId) {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('chats', 'readonly');
  const row = await reqPromise(tx.objectStore('chats').get(chatId));
  return row ? codec.openChat(row) : null;
}

export async function getMessagesForExport() {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('messages', 'readonly');
  const rows = [];
  await new Promise((resolve, reject) => {
    const request = tx.objectStore('messages').openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const record = cursor.value;
      if (!record.payloadCleared) rows.push(record);
      cursor.continue();
    };
  });
  const out = [];
  for (const row of rows) out.push(await codec.openRecord(row));
  return out;
}

export async function hasClearedPayloads(options = {}) {
  const accountAlias = options.accountAlias || null;
  const archiveMode = options.archiveMode || null;
  const db = await getDb();
  const tx = db.transaction('messages', 'readonly');
  let found = false;
  await new Promise((resolve, reject) => {
    const request = tx.objectStore('messages').openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const record = cursor.value;
      const remote = record.remote || {};
      const aliasMatches = !accountAlias || !remote.accountAlias || remote.accountAlias === accountAlias;
      const modeMatches = !archiveMode || !remote.archiveMode || remote.archiveMode === archiveMode;
      if (record.payloadCleared && aliasMatches && modeMatches) {
        found = true;
        resolve();
        return;
      }
      cursor.continue();
    };
  });
  return found;
}

export async function getRecentMessages(limit = 20) {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('messages', 'readonly');
  const index = tx.objectStore('messages').index('by_sortTs');
  const rows = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) {
        resolve();
        return;
      }
      rows.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const out = [];
  for (const row of rows) out.push(await codec.openRecord(row));
  return out;
}

export async function getPendingCount() {
  const db = await getDb();
  const tx = db.transaction('outbox', 'readonly');
  const index = tx.objectStore('outbox').index('by_status');
  const [pending, inflight] = await Promise.all([
    reqPromise(index.count('pending')),
    reqPromise(index.count('inflight')),
  ]);
  return pending + inflight;
}

export async function listPendingOutbox(limit = 200) {
  const db = await getDb();
  const tx = db.transaction('outbox', 'readonly');
  const index = tx.objectStore('outbox').index('by_status');
  const out = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only('pending'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) {
        resolve();
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return out;
}

export async function listDoneOutbox(limit = 1000) {
  const db = await getDb();
  const tx = db.transaction('outbox', 'readonly');
  const index = tx.objectStore('outbox').index('by_status');
  const out = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only('done'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) {
        resolve();
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return out;
}

export async function listRepairs(limit = 200) {
  const db = await getDb();
  const tx = db.transaction('outbox', 'readonly');
  const index = tx.objectStore('outbox').index('by_status');
  const out = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only('repair'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) {
        resolve();
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return out;
}

export async function getRepairCount() {
  const db = await getDb();
  const tx = db.transaction('outbox', 'readonly');
  return reqPromise(tx.objectStore('outbox').index('by_status').count('repair'));
}

export async function enqueueMediaRepair(msgId) {
  if (!msgId) return false;
  const db = await getDb();
  const tx = db.transaction('outbox', 'readwrite');
  const outbox = tx.objectStore('outbox');
  const entry = await reqPromise(outbox.get(msgId));
  if (entry && (entry.status === 'pending' || entry.status === 'inflight')) {
    await txDone(tx);
    return false;
  }
  outbox.put({
    ...(entry || {}),
    msgId,
    status: 'repair',
    repair: 'media',
    attempts: 0,
    enqueuedAt: Date.now(),
    nextAttemptAt: 0,
    lastError: null,
  });
  await txDone(tx);
  return true;
}

export async function setOutboxStatus(msgIds, status, patch = {}) {
  const db = await getDb();
  const tx = db.transaction('outbox', 'readwrite');
  const outbox = tx.objectStore('outbox');
  for (const id of msgIds || []) {
    const entry = await reqPromise(outbox.get(id));
    if (entry) {
      const next = { ...entry, ...patch, status };
      if (status === 'pending') {
        for (const field of VERIFICATION_FIELDS) delete next[field];
      }
      outbox.put(next);
    }
  }
  await txDone(tx);
}

export async function deleteOutboxEntry(msgId) {
  const db = await getDb();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').delete(msgId);
  await txDone(tx);
}

export async function markOutboxDone(entries, common = {}) {
  if (!entries || !entries.length) return 0;
  const db = await getDb();
  const tx = db.transaction('outbox', 'readwrite');
  const outbox = tx.objectStore('outbox');
  let count = 0;
  for (const item of entries) {
    const entry = await reqPromise(outbox.get(item.msgId));
    if (!entry) continue;
    outbox.put({
      ...entry,
      ...common,
      repair: null,
      status: 'done',
      payloadHash: item.payloadHash || null,
      uploadedAt: common.uploadedAt || Date.now(),
    });
    count++;
  }
  await txDone(tx);
  return count;
}

export async function getChats() {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('chats', 'readonly');
  const rows = await reqPromise(tx.objectStore('chats').getAll());
  const chats = [];
  for (const row of rows) chats.push(await codec.openChat(row));
  return chats;
}

export async function updateChat(chatId, patch) {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('chats', 'readonly');
  const store = tx.objectStore('chats');
  const raw = await reqPromise(store.get(chatId));
  if (!raw) return;
  const next = await codec.sealChat({ ...(await codec.openChat(raw)), ...patch });
  const writeTx = db.transaction('chats', 'readwrite');
  writeTx.objectStore('chats').put(next);
  await txDone(writeTx);
}

export async function putMedia(entry) {
  if (!entry || !entry.msgId) return null;
  const codec = requireLocalCodec();
  const db = await getDb();
  const readTx = db.transaction('media', 'readonly');
  const existing = await reqPromise(readTx.objectStore('media').get(entry.msgId));
  const existingRank = MEDIA_RANK[existing && existing.status] || 0;
  const incomingRank = MEDIA_RANK[entry.status] || 0;
  const downgrade = incomingRank < existingRank;
  const next = {
    ...(existing || {}),
    ...entry,
    ...(downgrade
      ? {
          status: existing.status,
          byteLength: existing.byteLength,
          path: existing.path,
          sha256: existing.sha256,
          uploadedAt: existing.uploadedAt,
        }
      : {}),
    capturedAt: (existing && existing.capturedAt) || entry.capturedAt || Date.now(),
  };
  const hasNewBytes = entry.bytes != null;
  if (!hasNewBytes && existing) {
    next.bytes = existing.bytes;
    next.bytesEnc = existing.bytesEnc;
    next.bytesEncVersion = existing.bytesEncVersion;
  }
  if (!hasNewBytes && existing && contentSignature(next) === contentSignature(existing)) {
    return existing;
  }
  const sealed = await codec.sealMedia(next);
  const writeTx = db.transaction('media', 'readwrite');
  writeTx.objectStore('media').put(sealed);
  await txDone(writeTx);
  await attachMediaToMessage(entry.msgId);
  return next;
}

export async function getMedia(msgId) {
  const codec = requireLocalCodec();
  const db = await getDb();
  const tx = db.transaction('media', 'readonly');
  const row = await reqPromise(tx.objectStore('media').get(msgId));
  return row ? codec.openMedia(row) : null;
}

export async function getMediaMeta(msgId) {
  const db = await getDb();
  const tx = db.transaction('media', 'readonly');
  return (await reqPromise(tx.objectStore('media').get(msgId))) || null;
}

export async function listPendingMediaMeta(limit = 25) {
  const db = await getDb();
  const tx = db.transaction('media', 'readonly');
  const index = tx.objectStore('media').index('by_status');
  const rows = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only('pending'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) {
        resolve();
        return;
      }
      rows.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return rows;
}

export async function listPendingMedia(limit = 25) {
  const codec = requireLocalCodec();
  const rows = await listPendingMediaMeta(limit);
  const out = [];
  for (const row of rows) out.push(await codec.openMedia(row));
  return out;
}

export async function setMediaStatus(msgId, status, patch = {}) {
  const db = await getDb();
  const tx = db.transaction('media', 'readwrite');
  const store = tx.objectStore('media');
  const existing = await reqPromise(store.get(msgId));
  if (!existing) {
    await txDone(tx);
    return null;
  }
  const forced = status === 'blocked';
  if (!forced && (MEDIA_RANK[status] || 0) < (MEDIA_RANK[existing.status] || 0)) {
    await txDone(tx);
    return existing;
  }
  const next = { ...existing, ...patch, status };
  if (Object.prototype.hasOwnProperty.call(patch, 'bytes') && patch.bytes === null) {
    next.bytes = null;
    delete next.bytesEnc;
    delete next.bytesEncVersion;
  }
  store.put(next);
  await txDone(tx);
  await attachMediaToMessage(msgId);
  return next;
}

export async function deleteMediaBytes(msgId) {
  const db = await getDb();
  const tx = db.transaction('media', 'readwrite');
  const store = tx.objectStore('media');
  const existing = await reqPromise(store.get(msgId));
  if (existing) store.put({ ...existing, bytes: null, bytesEnc: null, bytesEncVersion: null });
  await txDone(tx);
}

export async function attachMediaToMessage(msgId) {
  const db = await getDb();
  const readTx = db.transaction('media', 'readonly');
  const stored = await reqPromise(readTx.objectStore('media').get(msgId));
  if (!stored) return false;
  const meta = mediaMeta(stored);
  const tx = db.transaction(['messages', 'outbox'], 'readwrite');
  const messages = tx.objectStore('messages');
  const outbox = tx.objectStore('outbox');
  const record = await reqPromise(messages.get(msgId));
  if (!record) {
    await txDone(tx);
    return false;
  }
  const merged = mergeMedia(record.media, meta);
  if (record.payloadCleared) {
    const awaitingMedia = meta.status === 'pending' || meta.status === 'not_downloaded';
    const next = { ...record, media: merged, awaitingMedia };
    if (contentSignature(next) === contentSignature(record)) {
      await txDone(tx);
      return false;
    }
    messages.put(next);
    if (meta.status === 'stored') {
      const entry = await reqPromise(outbox.get(msgId));
      if (!entry || (entry.status !== 'pending' && entry.status !== 'inflight')) {
        outbox.put({
          ...(entry || {}),
          msgId,
          status: 'repair',
          repair: 'media',
          attempts: 0,
          enqueuedAt: Date.now(),
          nextAttemptAt: 0,
          lastError: null,
        });
      }
    }
    await txDone(tx);
    return true;
  }
  if (contentSignature(merged) === contentSignature(record.media || null)) {
    await txDone(tx);
    return false;
  }
  messages.put({ ...record, media: merged });
  const entry = await reqPromise(outbox.get(msgId));
  if (!entry) outbox.put({ msgId, status: 'pending', attempts: 0, enqueuedAt: Date.now(), reason: 'media' });
  else if (entry.status === 'done' || entry.status === 'repair') {
    outbox.put(pendingOutboxEntry(entry, msgId, 'media', Date.now()));
  }
  await txDone(tx);
  return true;
}

export async function countMedia() {
  const db = await getDb();
  const tx = db.transaction('media', 'readonly');
  return reqPromise(tx.objectStore('media').count());
}

export async function countMediaByStatus(status) {
  const db = await getDb();
  const tx = db.transaction('media', 'readonly');
  return reqPromise(tx.objectStore('media').index('by_status').count(status));
}

export async function countMediaBytes() {
  const db = await getDb();
  const tx = db.transaction('media', 'readonly');
  let total = 0;
  await new Promise((resolve, reject) => {
    const request = tx.objectStore('media').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const row = cursor.value;
      if (row.bytesEnc && typeof row.bytesEnc.byteLength === 'number') total += row.bytesEnc.byteLength;
      else if (row.bytes && typeof row.bytes.byteLength === 'number') total += row.bytes.byteLength;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return total;
}

export async function getMeta(key) {
  const db = await getDb();
  const tx = db.transaction('meta', 'readonly');
  const row = await reqPromise(tx.objectStore('meta').get(key));
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}

export async function clearAll() {
  const db = await getDb();
  const tx = db.transaction(['messages', 'outbox', 'chats', 'meta', 'media'], 'readwrite');
  tx.objectStore('messages').clear();
  tx.objectStore('outbox').clear();
  tx.objectStore('chats').clear();
  tx.objectStore('meta').clear();
  tx.objectStore('media').clear();
  await txDone(tx);
}

export async function blockPreInstallOutbox(installedAt, reason = 'pre-install-history') {
  if (typeof installedAt !== 'number') return 0;
  const db = await getDb();
  const outboxEntries = await reqPromise(
    db.transaction('outbox', 'readonly').objectStore('outbox').getAll()
  );
  const candidates = outboxEntries.filter(
    (entry) => entry && entry.status !== 'done' && entry.status !== 'blocked'
  );
  if (!candidates.length) return 0;

  const messagesStore = db.transaction('messages', 'readonly').objectStore('messages');
  const messageReads = new Map(
    candidates.map((entry) => [entry.msgId, reqPromise(messagesStore.get(entry.msgId))])
  );
  const blocked = [];
  for (const entry of candidates) {
    const message = await messageReads.get(entry.msgId);
    if (isPreInstallMessage(message, installedAt)) {
      blocked.push({ ...entry, status: 'blocked', blockedFromStatus: entry.status, reason, lastError: null });
    }
  }
  if (!blocked.length) return 0;
  const tx = db.transaction('outbox', 'readwrite');
  const store = tx.objectStore('outbox');
  for (const entry of blocked) store.put(entry);
  await txDone(tx);
  return blocked.length;
}

export async function requeueBlockedOutbox(reason = null) {
  const db = await getDb();
  const readTx = db.transaction('outbox', 'readonly');
  const entries = await reqPromise(readTx.objectStore('outbox').getAll());
  const pending = entries
    .filter((entry) => entry && entry.status === 'blocked' && (!reason || entry.reason === reason))
    .map((entry) => ({
      ...entry,
      status: entry.blockedFromStatus === 'repair' ? 'repair' : 'pending',
      blockedFromStatus: null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      reason: 'feature-unlocked',
    }));
  if (!pending.length) return 0;
  const tx = db.transaction('outbox', 'readwrite');
  const store = tx.objectStore('outbox');
  for (const entry of pending) store.put(entry);
  await txDone(tx);
  return pending.length;
}

export async function countBlockedOutbox(reason = null) {
  const db = await getDb();
  const entries = await reqPromise(
    db.transaction('outbox', 'readonly').objectStore('outbox').getAll()
  );
  return entries.filter((entry) => entry && entry.status === 'blocked' && (!reason || entry.reason === reason))
    .length;
}

export async function requeueBlockedMedia() {
  const db = await getDb();
  const readTx = db.transaction('media', 'readonly');
  const entries = await reqPromise(readTx.objectStore('media').getAll());
  const pending = entries
    .filter((entry) => entry && entry.status === 'blocked')
    .map((entry) => ({
      ...entry,
      status:
        (entry.bytes && entry.bytes.byteLength) || (entry.bytesEnc && entry.bytesEnc.byteLength)
          ? 'pending'
          : 'not_downloaded',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    }));
  if (!pending.length) return 0;
  const tx = db.transaction('media', 'readwrite');
  const store = tx.objectStore('media');
  for (const entry of pending) store.put(entry);
  await txDone(tx);
  return pending.length;
}
