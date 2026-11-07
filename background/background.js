/**
 * WAiDrop - Background Service Worker (v4)
 *
 * Receives MESSAGE_BATCH from the content script and persists records into
 * the IndexedDB archive (background/idb.js), deduping by WhatsApp message id
 * and upgrading DOM records to richer store-hook records. The outbox it
 * maintains is the input queue for the encrypted Dropbox uploader.
 *
 * Also performs a one-time migration of records captured by the pre-M2
 * version from chrome.storage.local into IndexedDB.
 */
import {
  putRecords,
  putMedia,
  setMediaStatus,
  getMeta,
  setMeta,
  applyChatDirectory,
  blockPreInstallOutbox,
  requeueBlockedOutbox,
  setLocalCodec,
} from './idb.js';
import { runUpload, probeConnection, getSettings } from './uploader.js';
import { connect as connectDropbox } from './dropbox.js';
import { logActivity } from './activityLog.js';
import { deriveKeys, generateMasterKey, isValidMasterKey } from './crypto.js';
import { createLocalCodec } from './localCrypto.js';
import { createPayloadHasher } from './payloadHash.js';
import { ensureInstalledAt, getInstalledAt } from './installInfo.js';
import { PRE_INSTALL_REASON } from './archivePolicy.js';
import { runOffloadSweep } from './offload.js';
import { runMediaRepair } from './mediaRepair.js';
import { sanitizeRecord, sanitizeChatEntry, sanitizeMediaMeta } from './recordSanity.js';
// The MAIN-world store hook. No longer a manifest content script: it is
// injected per page load by the BRIDGE_INIT handler below, which passes a
// fresh per-session bridge key as a chrome.scripting argument. That argument
// is serialized browser-side, so the key never appears in the DOM,
// window.postMessage or any resource a page script can observe.
import { hookMain } from './inject-main.js';

const DEBUG = false;
const UPLOAD_ALARM = 'waidrop-upload';

const OFFLOAD_ALARM = 'waidrop-offload';
const REPAIR_ALARM = 'waidrop-repair';
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
// A hostile page could spray MEDIA_BEGIN without ever ending a session;
// cap the number of live sessions so the map cannot grow without bound.
const MEDIA_MAX_SESSIONS = 64;
const DIMENSION_MAX_BYTES = 20 * 1024 * 1024;

// Writes and uploads are independent: a slow Dropbox upload must never delay
// persisting newly captured messages. Both chains still wait for `ready`.
let writeQueue = Promise.resolve();
let uploadQueue = Promise.resolve();
let maintenanceQueue = Promise.resolve();
const mediaSessions = new Map();
let payloadHasherCache = null;

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

async function ensureMasterKey() {
  try {
    const settings = await getSettings();
    if (settings.encryptionKey) return settings.encryptionKey;
    const fingerprint = await getMeta('localKeyFingerprint');
    if (fingerprint) return null;
    const stored = await chrome.storage.local.get(['settings']);
    const next = {
      ...(stored.settings || {}),
      archiveMode: 'encrypted',
      encryptionKey: generateMasterKey(),
      encryptionKeyAcknowledged: false,
    };
    await chrome.storage.local.set({ settings: next });
    return next.encryptionKey;
  } catch (e) {
    console.warn('[WAiDrop] encryption key setup failed:', errorMessage(e));
    return null;
  }
}

async function refreshLocalCodec() {
  try {
    const settings = await getSettings();
    if (!isValidMasterKey(settings.encryptionKey)) {
      setLocalCodec(null);
      return null;
    }
    const codec = await createLocalCodec(settings.encryptionKey);
    const fingerprint = await getMeta('localKeyFingerprint');
    if (fingerprint && fingerprint !== codec.fingerprint) {
      setLocalCodec(null);
      return null;
    }
    setLocalCodec(codec);
    return codec;
  } catch (e) {
    setLocalCodec(null);
    console.warn('[WAiDrop] local encryption setup failed:', errorMessage(e));
    return null;
  }
}

async function reconcilePreInstall(settings) {
  const currentSettings = settings || (await getSettings());
  if (currentSettings.syncPreInstallMessages === true) {
    await requeueBlockedOutbox(PRE_INSTALL_REASON);
  } else {
    await blockPreInstallOutbox(await getInstalledAt(), PRE_INSTALL_REASON);
  }
}

function enqueueWrite(task) {
  const result = writeQueue.then(() => ready).then(task);
  writeQueue = result.catch((e) => {
    console.warn('[WAiDrop] write failed:', errorMessage(e));
  });
  return result;
}

function enqueueUpload(options = {}) {
  const result = uploadQueue
    .then(() => ready)
    .then(() => runUpload({ log: logActivity, manual: options.manual === true }))
    .then((stats) => {
      if (stats && stats.mediaUploaded) scheduleRepair();
      if (stats && stats.uploaded) scheduleOffload();
      return stats;
    });
  uploadQueue = result.catch((e) => {
    const message = errorMessage(e);
    console.warn('[WAiDrop] upload failed:', message);
    logActivity('error', `Upload failed — ${message}`);
  });
  return result;
}

function enqueueMaintenance(task) {
  const result = maintenanceQueue
    .then(() => ready)
    .then(task);
  maintenanceQueue = result.catch((e) => {
    const message = errorMessage(e);
    console.warn('[WAiDrop] maintenance failed:', message);
    logActivity('error', `Maintenance failed — ${message}`);
  });
  return result;
}

async function getPayloadHasher() {
  try {
    const settings = await getSettings();
    if (!settings.encryptionKey) return null;
    if (payloadHasherCache && payloadHasherCache.key === settings.encryptionKey) {
      return payloadHasherCache.hasher;
    }
    const keys = await deriveKeys(settings.encryptionKey);
    const hasher = createPayloadHasher(keys, 'encrypted');
    payloadHasherCache = { key: settings.encryptionKey, hasher };
    return hasher;
  } catch (e) {
    return null;
  }
}

function notifyArchiveUpdated(stats) {
  try {
    const sent = chrome.runtime.sendMessage({ type: 'ARCHIVE_UPDATED', stats });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (e) {
    /* popup closed or messaging unavailable */
  }
}

function hasChanges(stats) {
  return !!stats && (stats.inserted > 0 || stats.upgraded > 0 || stats.updated > 0);
}

function decodeBase64(data) {
  const binary = atob(String(data || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function imageDimensions(bytes, mime) {
  const empty = { width: null, height: null };
  if (!mime || !/^image\//i.test(mime)) return empty;
  if (bytes.byteLength > DIMENSION_MAX_BYTES) return empty;
  if (typeof createImageBitmap !== 'function' || typeof Blob !== 'function') return empty;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const width = bitmap.width || null;
    const height = bitmap.height || null;
    if (typeof bitmap.close === 'function') bitmap.close();
    return { width, height };
  } catch (e) {
    return empty;
  }
}

async function completeMedia(session) {
  const chunks = session.chunks;
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (!bytes.length || bytes.length > MEDIA_MAX_BYTES) throw new Error('media size out of range');
  if (session.size && bytes.length !== session.size) throw new Error('media size mismatch');
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (session.sha256 && digest !== session.sha256) throw new Error('media hash mismatch');
  let width = session.width || null;
  let height = session.height || null;
  if (!width || !height) {
    const dimensions = await imageDimensions(bytes, session.mime);
    width = width || dimensions.width;
    height = height || dimensions.height;
  }
  await putMedia({
    msgId: session.msgId,
    chatId: session.chatId || null,
    isGroup: session.isGroup === true,
    fetchMode: session.fetchMode || 'passive',
    kind: session.kind || null,
    mime: session.mime || null,
    ts: session.ts || null,
    bytes: bytes.buffer,
    byteLength: bytes.length,
    sha256: session.sha256 || digest,
    width,
    height,
    status: 'pending',
    attempts: 0,
    capturedAt: Date.now(),
  });
}

if (chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'waidrop-media') return;
    port.onMessage.addListener((message) => {
      if (!message || !message.id) return;
      const id = message.id;
      try {
        if (message.type === 'MEDIA_BEGIN') {
          if (mediaSessions.size >= MEDIA_MAX_SESSIONS) {
            throw new Error('too many concurrent media sessions');
          }
          // Whitelist the metadata before any session state is created.
          const meta = sanitizeMediaMeta(message, MEDIA_MAX_BYTES);
          if (!meta) throw new Error('invalid media metadata');
          mediaSessions.set(meta.id, {
            ...meta,
            chunks: [],
            received: 0,
            port,
          });
          return;
        }
        if (message.type === 'MEDIA_CHUNK') {
          const session = mediaSessions.get(id);
          if (!session) throw new Error('unknown media session');
          const chunk = decodeBase64(message.data);
          session.chunks.push(chunk);
          session.received += chunk.length;
          if (session.received > MEDIA_MAX_BYTES) {
            mediaSessions.delete(id);
            throw new Error('media exceeds limit');
          }
          return;
        }
        if (message.type === 'MEDIA_END') {
          const session = mediaSessions.get(id);
          if (!session) throw new Error('unknown media session');
          mediaSessions.delete(id);
          enqueueWrite(() => completeMedia(session))
            .then(() => {
              scheduleUpload();
              try {
                port.postMessage({ type: 'MEDIA_ACK', id, ok: true });
              } catch (e) {
                /* port closed */
              }
            })
            .catch((e) => {
              try {
                port.postMessage({ type: 'MEDIA_ACK', id, ok: false, error: errorMessage(e) });
              } catch (err) {
                /* port closed */
              }
            });
          return;
        }
      } catch (e) {
        mediaSessions.delete(id);
        try {
          port.postMessage({ type: 'MEDIA_ACK', id, ok: false, error: e && e.message ? e.message : String(e) });
        } catch (err) {
          /* port closed */
        }
      }
    });
    port.onDisconnect.addListener(() => {
      for (const [id, session] of mediaSessions) {
        if (session.port === port) mediaSessions.delete(id);
      }
    });
  });
}

function ensureAlarm(name, periodInMinutes) {
  try {
    chrome.alarms.get(name, (alarm) => {
      if (!alarm) chrome.alarms.create(name, { periodInMinutes });
    });
  } catch (e) {
    /* alarms unavailable (tests) */
  }
}

function ensureUploadAlarm() {
  ensureAlarm(UPLOAD_ALARM, 1);
  ensureAlarm(OFFLOAD_ALARM, 15);
  ensureAlarm(REPAIR_ALARM, 15);
}

ensureUploadAlarm();

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    ensureUploadAlarm();
    (async () => {
      if (details && details.reason === 'install') await ensureInstalledAt(Date.now());
      await ensureMasterKey();
      await refreshLocalCodec();
    })().catch(() => {});
  });
}

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const before = changes.settings.oldValue || {};
    const after = changes.settings.newValue || {};
    if (before.encryptionKey !== after.encryptionKey) {
      refreshLocalCodec()
        .then(() => enqueueWrite(() => reconcilePreInstall()))
        .then(() => scheduleUpload())
        .catch(() => {});
    } else if (before.syncPreInstallMessages !== after.syncPreInstallMessages) {
      enqueueWrite(() => reconcilePreInstall())
        .then(() => scheduleUpload())
        .catch(() => {});
    }
  });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPLOAD_ALARM) {
      enqueueUpload();
      return;
    }
    if (alarm.name === OFFLOAD_ALARM) {
      enqueueMaintenance(() => runOffloadSweep({ log: logActivity }));
      return;
    }
    if (alarm.name === REPAIR_ALARM) {
      enqueueMaintenance(() => runMediaRepair({ log: logActivity })).then((stats) => {
        if (stats && stats.repaired) scheduleUpload();
      });
    }
  });
}

let uploadTimer = null;
function scheduleUpload() {
  if (uploadTimer) return;
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    enqueueUpload();
  }, 5000);
}

let repairTimer = null;
function scheduleRepair() {
  if (repairTimer) return;
  repairTimer = setTimeout(() => {
    repairTimer = null;
    enqueueMaintenance(() => runMediaRepair({ log: logActivity })).then((stats) => {
      if (stats && stats.repaired) scheduleUpload();
    });
  }, 1000);
}

let offloadTimer = null;
function scheduleOffload() {
  if (offloadTimer) return;
  offloadTimer = setTimeout(() => {
    offloadTimer = null;
    enqueueMaintenance(() => runOffloadSweep({ log: logActivity }));
  }, 1000);
}

const ready = (async () => {
  await ensureMasterKey();
  await refreshLocalCodec();
  try {
    const migratedFlag = await getMeta('migratedFromStorageLocal');
    if (!migratedFlag) {
      const result = await chrome.storage.local.get(['messages', 'lastSync']);
      const legacy = Array.isArray(result.messages) ? result.messages : [];
      const valid = legacy.filter((r) => r && r.msgId);
      const stats = await putRecords(valid);
      await setMeta('migratedFromStorageLocal', { at: Date.now(), count: valid.length });
      if (result.messages !== undefined || result.lastSync !== undefined) {
        await chrome.storage.local.remove(['messages', 'lastSync']);
      }
      console.log(
        '[WAiDrop] migrated',
        valid.length,
        'record(s) from chrome.storage.local to IndexedDB',
        JSON.stringify(stats)
      );
    }
  } catch (e) {
    console.warn('[WAiDrop] migration failed:', e && e.message);
  }
  await ensureInstalledAt();
})();

ready
  .then(() => {
    enqueueWrite(() => reconcilePreInstall()).catch(() => {});
    setTimeout(() => {
      enqueueMaintenance(() => runOffloadSweep({ log: logActivity }));
      enqueueMaintenance(() => runMediaRepair({ log: logActivity }));
    }, 3000);
  })
  .catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ status: 'unknown' });
    return false;
  }

  switch (message.type) {
    case 'CONTENT_SCRIPT_READY':
      sendResponse({ status: 'ready' });
      return false;

    case 'BRIDGE_INIT': {
      const tabId = sender && sender.tab && sender.tab.id;
      if (!chrome.scripting || !chrome.scripting.executeScript || !tabId) {
        sendResponse({ status: 'unavailable' });
        return false;
      }
      try {
        const bridgeKey = generateBridgeKey();
        chrome.scripting.executeScript(
          {
            target: { tabId },
            world: 'MAIN',
            injectImmediately: true,
            func: hookMain,
            args: [bridgeKey],
          },
          () => {
            if (chrome.runtime.lastError) {
              sendResponse({
                status: 'error',
                error: chrome.runtime.lastError.message || 'MAIN-world injection failed',
              });
              return;
            }
            // Same key on both ends of the bridge; it is never written to
            // storage and never crosses the page.
            sendResponse({ status: 'ok', bridgeKey });
          }
        );
        return true;
      } catch (e) {
        sendResponse({ status: 'error', error: errorMessage(e) });
        return false;
      }
    }

    case 'MESSAGE_BATCH': {
      const incoming = Array.isArray(message.records) ? message.records : [];
      // Whitelist/normalize every record before it reaches IndexedDB; junk
      // is dropped and counted instead of poisoning the archive.
      const sanitized = [];
      let rejected = 0;
      for (const record of incoming) {
        const clean = sanitizeRecord(record);
        if (clean) sanitized.push(clean);
        else rejected++;
      }
      // Respond only after IndexedDB has committed the batch. Keeping the
      // message channel open also keeps the service worker alive until then,
      // so a live batch cannot be lost while the worker goes idle.
      enqueueWrite(() => handleBatch(sanitized, { rejected }))
        .then((stats) => {
          if (hasChanges(stats)) {
            console.log('[WAiDrop] stored batch:', JSON.stringify(stats));
            notifyArchiveUpdated(stats);
            scheduleUpload();
          }
          sendResponse({ status: 'stored', stats });
        })
        .catch((e) => sendResponse({ status: 'error', error: errorMessage(e) }));
      return true;
    }

    case 'NAME_DIRECTORY': {
      const incoming = Array.isArray(message.chats) ? message.chats : [];
      const sanitizedChats = [];
      let rejectedChats = 0;
      for (const chat of incoming) {
        const clean = sanitizeChatEntry(chat);
        if (clean) sanitizedChats.push(clean);
        else rejectedChats++;
      }
      enqueueWrite(() => applyChatDirectory(sanitizedChats))
        .then((stats) => {
          if (stats.updated) {
            console.log('[WAiDrop] name repair:', JSON.stringify(stats));
            notifyArchiveUpdated(stats);
            scheduleUpload();
          }
        })
        .catch((e) => console.warn('[WAiDrop] name repair failed:', errorMessage(e)));
      sendResponse({ status: 'accepted', count: sanitizedChats.length, rejected: rejectedChats });
      return false;
    }

    case 'MEDIA_STATUS': {
      const msgId = typeof message.msgId === 'string' && message.msgId.length <= 256 ? message.msgId : null;
      if (!msgId) {
        sendResponse({ status: 'ignored' });
        return false;
      }
      enqueueWrite(async () => {
        const status = typeof message.status === 'string' && message.status.length <= 32 ? message.status : 'failed';
        const lastError = typeof message.error === 'string' ? message.error.slice(0, 256) : null;
        const updated = await setMediaStatus(msgId, status, {
          lastError,
        });
        if (!updated) {
          await putMedia({
            msgId,
            chatId: message.chatId || null,
            status,
            byteLength: 0,
            lastError,
            capturedAt: Date.now(),
          });
        }
      })
        .then(() => scheduleUpload())
        .catch((e) => console.warn('[WAiDrop] media status failed:', errorMessage(e)));
      sendResponse({ status: 'accepted' });
      return false;
    }

    case 'TRIGGER_UPLOAD': {
      enqueueUpload({ manual: true })
        .then((stats) => sendResponse({ status: 'ok', stats }))
        .catch((e) => sendResponse({ status: 'error', error: errorMessage(e) }));
      return true;
    }

    case 'RUN_OFFLOAD': {
      enqueueMaintenance(() => runOffloadSweep({ manual: true, log: logActivity }))
        .then((stats) => {
          notifyArchiveUpdated(stats);
          sendResponse({ status: 'ok', stats });
        })
        .catch((e) => sendResponse({ status: 'error', error: errorMessage(e) }));
      return true;
    }

    case 'REPAIR_MEDIA': {
      enqueueMaintenance(() => runMediaRepair({ manual: true, log: logActivity }))
        .then((stats) => {
          if (stats && stats.repaired) scheduleUpload();
          notifyArchiveUpdated(stats);
          sendResponse({ status: 'ok', stats });
        })
        .catch((e) => sendResponse({ status: 'error', error: errorMessage(e) }));
      return true;
    }

    case 'TEST_CONNECTION': {
      logActivity('info', 'Testing Dropbox connection...');
      probeConnection()
        .then((result) => {
          if (result && result.ok) {
            const who = result.accountName || result.email || 'Dropbox account';
            logActivity('success', `Dropbox connection OK — ${who}.`);
          } else {
            logActivity('error', `Dropbox connection failed — ${(result && result.error) || 'unknown error'}`);
          }
          sendResponse(result);
        })
        .catch((e) => {
          const message = e && e.message ? e.message : String(e);
          logActivity('error', `Dropbox connection failed — ${message}`);
          sendResponse({ ok: false, error: message });
        });
      return true;
    }

    case 'DROPBOX_CONNECT': {
      logActivity('info', 'Connecting Dropbox...');
      (async () => {
        const settings = await getSettings();
        const auth = await connectDropbox(settings.dropboxAppKey);
        const who = auth.accountName || auth.email || auth.accountId || 'account';
        console.log('[WAiDrop] Dropbox connected:', who);
        logActivity('success', `Dropbox connected as ${who}.`);
        sendResponse({ ok: true, accountName: auth.accountName || null, email: auth.email || null });
      })().catch((e) => {
        const message = e && e.message ? e.message : String(e);
        console.warn('[WAiDrop] Dropbox connect failed:', message);
        logActivity('error', `Dropbox connect failed — ${message}`);
        sendResponse({ ok: false, error: message });
      });
      return true;
    }

    case 'ACTIVITY_LOG':
      return false;

    default:
      sendResponse({ status: 'unknown' });
      return false;
  }
});

// Per-session bridge key: 32 random bytes, hex. Minted once per BRIDGE_INIT
// (one per page load per tab), handed to the MAIN-world hook via
// chrome.scripting args and to the isolated content script via the private
// chrome.runtime response channel.
function generateBridgeKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

async function handleBatch(records, options = {}) {
  const candidates = new Map();
  for (const record of records) {
    if (!record || !record.msgId) continue;
    const existing = candidates.get(record.msgId);
    if (!existing || (existing.source === 'dom' && record.source === 'store')) {
      candidates.set(record.msgId, record);
    }
  }
  if (!candidates.size) {
    return {
      inserted: 0,
      upgraded: 0,
      updated: 0,
      skipped: 0,
      rejected: options.rejected || 0,
    };
  }

  const payloadHasher = await getPayloadHasher();
  const stats = await putRecords([...candidates.values()], { payloadHasher });
  if (options.rejected) stats.rejected = (stats.rejected || 0) + options.rejected;
  if (DEBUG) {
    console.log('[WAiDrop] idb put:', JSON.stringify(stats));
  }
  return stats;
}
