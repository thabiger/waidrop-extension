/**
 * WAiDrop - persisted activity log
 *
 * A small rolling log shared by the service worker and the popup. Entries are
 * broadcast immediately for live views and appended to chrome.storage.local so
 * they survive the service worker going idle and the popup being closed.
 */
const STORAGE_KEY = 'activityLog';
const CLEARED_KEY = 'activityLogClearedAt';
const MAX_ENTRIES = 200;
const MAX_MESSAGE_LENGTH = 2000;

let writeQueue = Promise.resolve();

function storageArea() {
  try {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : null;
  } catch (e) {
    return null;
  }
}

function broadcast(entry) {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
      return;
    }
    const sent = chrome.runtime.sendMessage({ type: 'ACTIVITY_LOG', entry });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (e) {
    /* popup closed or messaging unavailable */
  }
}

async function readLog() {
  const storage = storageArea();
  if (!storage || typeof storage.get !== 'function') return [];
  try {
    const result = await storage.get([STORAGE_KEY]);
    return Array.isArray(result && result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  } catch (e) {
    return [];
  }
}

/**
 * Make a message/chat identifier safe for the persisted activity log.
 * WhatsApp ids embed phone numbers and jids in plaintext; digit runs are
 * masked so the log can still be correlated without carrying PII at rest.
 */
export function redactIdentifier(value) {
  const text = String(value == null ? '' : value);
  if (!text) return 'unknown';
  const masked = text.replace(/\d{3,}/g, (digits) => `#${digits.length}`);
  return masked.length > 64 ? `${masked.slice(0, 64)}…` : masked;
}

export function logActivity(level, message) {
  const entry = {
    at: Date.now(),
    level: level === 'success' || level === 'warn' || level === 'error' ? level : 'info',
    message: String(message == null ? '' : message).slice(0, MAX_MESSAGE_LENGTH),
  };
  broadcast(entry);
  writeQueue = writeQueue
    .then(async () => {
      const storage = storageArea();
      if (!storage || typeof storage.set !== 'function') return;
      const log = await readLog();
      log.push(entry);
      await storage.set({ [STORAGE_KEY]: log.slice(-MAX_ENTRIES) });
    })
    .catch(() => {});
  return entry;
}

export async function getActivityLog() {
  const log = await readLog();
  return log.slice(-MAX_ENTRIES);
}

export async function getActivityLogClearedAt() {
  const storage = storageArea();
  if (!storage || typeof storage.get !== 'function') return 0;
  try {
    const result = await storage.get([CLEARED_KEY]);
    return Number(result && result[CLEARED_KEY]) || 0;
  } catch (e) {
    return 0;
  }
}

export async function clearActivityLog() {
  writeQueue = writeQueue
    .then(async () => {
      const storage = storageArea();
      if (!storage) return;
      if (typeof storage.remove === 'function') {
        await storage.remove([STORAGE_KEY]);
      } else if (typeof storage.set === 'function') {
        await storage.set({ [STORAGE_KEY]: [] });
      }
      if (typeof storage.set === 'function') {
        await storage.set({ [CLEARED_KEY]: Date.now() });
      }
    })
    .catch(() => {});
  await writeQueue;
}
