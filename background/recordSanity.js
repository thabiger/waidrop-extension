/**
 * Sanitizers for everything that crosses the content-script bridge.
 *
 * Threat model: the MAIN-world store hook and the DOM parser run inside the
 * page, so a hostile page script can inject traffic into every channel the
 * background accepts (runtime messages and the media port). The bridge
 * handshake raises the bar, but the persistence layer still treats all
 * inbound data as untrusted: these pure sanitizers enforce a field
 * whitelist derived from the two producers (utils/messageParser.js DOM
 * records and serializeStoreMessage() store records), with type checks and
 * size caps, before anything reaches IndexedDB or the uploader queue.
 */

const MAX_MSG_ID = 256;
const MAX_NAME = 512;
const MAX_PHONE = 32;
const MAX_TEXT = 100000;
const MAX_TYPE = 64;
const MAX_MIME = 128;
const MAX_MEDIA_ID = 512;
const DIRECTIONS = new Set(['in', 'out']);
const SOURCES = new Set(['dom', 'store']);

function optString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function optNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize one message record. Returns null when the record is unusable
 * (missing/oversized msgId, absurd text length); otherwise returns a copy
 * containing only whitelisted, well-typed fields.
 */
export function sanitizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const msgId = optString(input.msgId, MAX_MSG_ID);
  if (!msgId) return null;

  const out = { v: 1, msgId };
  const msgKey = optString(input.msgKey, MAX_MSG_ID);
  if (msgKey) out.msgKey = msgKey;
  const chatId = optString(input.chatId, MAX_MSG_ID);
  if (chatId) out.chatId = chatId;
  const chatName = optString(input.chatName, MAX_NAME);
  if (chatName) out.chatName = chatName;
  const chatPhone = optString(input.chatPhone, MAX_PHONE);
  if (chatPhone) out.chatPhone = chatPhone;
  const chatPushname = optString(input.chatPushname, MAX_NAME);
  if (chatPushname) out.chatPushname = chatPushname;
  out.isGroup = input.isGroup === true;
  if (DIRECTIONS.has(input.direction)) out.direction = input.direction;
  const senderId = optString(input.senderId, MAX_MSG_ID);
  if (senderId) out.senderId = senderId;
  const senderName = optString(input.senderName, MAX_NAME);
  if (senderName) out.senderName = senderName;
  const senderPushname = optString(input.senderPushname, MAX_NAME);
  if (senderPushname) out.senderPushname = senderPushname;
  const senderPhone = optString(input.senderPhone, MAX_PHONE);
  if (senderPhone) out.senderPhone = senderPhone;
  if (typeof input.text === 'string') {
    // No legitimate WhatsApp body comes close to this cap; anything past it
    // is an attempt to bloat the archive.
    if (input.text.length > MAX_TEXT) return null;
    out.text = input.text;
  }
  const ts = optNumber(input.ts);
  if (ts !== null) out.ts = ts;
  const tsRaw = optString(input.tsRaw, MAX_NAME);
  if (tsRaw) out.tsRaw = tsRaw;
  const type = optString(input.type, MAX_TYPE);
  if (type) out.type = type;
  const capturedAt = optNumber(input.capturedAt);
  out.capturedAt = capturedAt === null ? Date.now() : capturedAt;
  if (SOURCES.has(input.source)) out.source = input.source;
  return out;
}

/**
 * Normalize one chat-directory entry. Returns null without a usable chatId.
 */
export function sanitizeChatEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const chatId = optString(input.chatId, MAX_MSG_ID);
  if (!chatId) return null;
  const out = { chatId, isGroup: input.isGroup === true };
  const chatName = optString(input.chatName, MAX_NAME);
  if (chatName) out.chatName = chatName;
  const chatPhone = optString(input.chatPhone, MAX_PHONE);
  if (chatPhone) out.chatPhone = chatPhone;
  const chatPushname = optString(input.chatPushname, MAX_NAME);
  if (chatPushname) out.chatPushname = chatPushname;
  return out;
}

/**
 * Normalize MEDIA_BEGIN metadata. Returns null when the session is unusable
 * (missing id/msgId, absurd declared size); totalChars defaults to 0 when
 * absent, matching the previous coercion in the port handler. The received
 * byte count is still enforced per chunk there.
 */
export function sanitizeMediaMeta(input, maxBytes) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = optString(input.id, MAX_MEDIA_ID);
  const msgId = optString(input.msgId, MAX_MSG_ID);
  if (!id || !msgId) return null;

  const out = { id, msgId };
  const chatId = optString(input.chatId, MAX_MSG_ID);
  if (chatId) out.chatId = chatId;
  out.isGroup = input.isGroup === true;
  const fetchMode = optString(input.fetchMode, MAX_TYPE);
  if (fetchMode) out.fetchMode = fetchMode;
  const kind = optString(input.kind, MAX_TYPE);
  if (kind) out.kind = kind;
  const mime = optString(input.mime, MAX_MIME);
  if (mime) out.mime = mime;
  const ts = optNumber(input.ts);
  out.ts = ts === null ? null : ts;
  const size = optNumber(input.size);
  out.size = size !== null && size >= 0 ? size : null;
  const width = optNumber(input.width);
  out.width = width === null ? null : width;
  const height = optNumber(input.height);
  out.height = height === null ? null : height;
  const sha256 = optString(input.sha256, MAX_MSG_ID);
  if (sha256) out.sha256 = sha256;
  const totalChars = optNumber(input.totalChars);
  if (totalChars === null || totalChars < 0) {
    out.totalChars = 0;
  } else {
    const bound = Math.ceil(((maxBytes || 0) * 4) / 3) + 1024;
    if (totalChars > bound) return null;
    out.totalChars = totalChars;
  }
  return out;
}
