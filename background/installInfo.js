/**
 * Installation date used by the pre-install history policy.
 *
 * New installs record the timestamp in chrome.storage.local. Upgrades from
 * builds without this field fall back to the earliest chat capture time so the
 * existing local archive keeps syncing.
 */
import { getDb } from './idb.js';

const STORAGE_KEY = 'installedAt';

function storageArea() {
  try {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : null;
  } catch (e) {
    return null;
  }
}

async function earliestArchiveTimestamp() {
  try {
    const db = await getDb();
    const readTx = db.transaction(['chats', 'messages'], 'readonly');
    const chatRequest = readTx.objectStore('chats').getAll();
    const messageRequest = readTx.objectStore('messages').getAll();
    const [chats, messages] = await Promise.all([
      new Promise((resolve, reject) => {
        chatRequest.onsuccess = () => resolve(chatRequest.result);
        chatRequest.onerror = () => reject(chatRequest.error);
      }),
      new Promise((resolve, reject) => {
        messageRequest.onsuccess = () => resolve(messageRequest.result);
        messageRequest.onerror = () => reject(messageRequest.error);
      }),
    ]);
    let earliest = Infinity;
    for (const chat of chats) {
      if (chat && typeof chat.firstSeen === 'number' && chat.firstSeen < earliest) earliest = chat.firstSeen;
    }
    for (const message of messages) {
      if (!message) continue;
      if (typeof message.capturedAt === 'number' && message.capturedAt < earliest) {
        earliest = message.capturedAt;
      }
      if (typeof message.ts === 'number' && message.ts < earliest) {
        earliest = message.ts;
      }
    }
    return Number.isFinite(earliest) ? earliest : null;
  } catch (e) {
    return null;
  }
}

export async function setInstalledAt(timestamp) {
  const storage = storageArea();
  if (!storage) return timestamp;
  await storage.set({ [STORAGE_KEY]: timestamp });
  return timestamp;
}

export async function getInstalledAt() {
  const storage = storageArea();
  if (storage) {
    try {
      const result = await storage.get([STORAGE_KEY]);
      const stored = result && result[STORAGE_KEY];
      if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
    } catch (e) {
      /* fall through */
    }
  }
  const fallback = await earliestArchiveTimestamp();
  if (fallback == null) return Date.now();
  await setInstalledAt(fallback);
  return fallback;
}

export async function ensureInstalledAt(timestamp) {
  const storage = storageArea();
  if (storage) {
    try {
      const result = await storage.get([STORAGE_KEY]);
      const value = result[STORAGE_KEY];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch (e) {
      /* fall through */
    }
  }
  return setInstalledAt(typeof timestamp === 'number' ? timestamp : Date.now());
}
