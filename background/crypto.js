/**
 * WAiDrop - client-side archive crypto (Dropbox mode)
 *
 * Contract (must match the Python implementation in waidrop-cli):
 *   K            = 32-byte master key (base64 in settings)
 *   hashKey      = HKDF-SHA256(ikm=K, salt="waidrop-v1", info="chat-hash", 32)
 *   encKey       = HKDF-SHA256(ikm=K, salt="waidrop-v1", info="object-encryption", 32)
 *   mediaKey     = HKDF-SHA256(ikm=K, salt="waidrop-v1", info="media-encryption", 32)
 *   chat folder  = lowerhex(HMAC-SHA256(hashKey, utf8(chatId)))[:16]
 *   media object = "WAMR" | 0x01 | nonce(12) | AES-256-GCM ciphertext+tag
 *                  (AAD = "WAMR" | 0x01 | utf8(relativePath))
 *   object bytes = "WAAR" | 0x01 | nonce(12) | AES-256-GCM ciphertext+tag
 *                  (AAD = "WAAR" | 0x01)
 *
 * No plaintext message content ever leaves the browser.
 */

const MAGIC = new Uint8Array([0x57, 0x41, 0x41, 0x52]); // "WAAR"
const VERSION = 1;
const AAD = new Uint8Array([...MAGIC, VERSION]);
const MEDIA_MAGIC = new Uint8Array([0x57, 0x41, 0x4d, 0x52]); // "WAMR"
const MEDIA_VERSION = 1;
const MEDIA_AAD_PREFIX = new Uint8Array([...MEDIA_MAGIC, MEDIA_VERSION]);
const SALT = new TextEncoder().encode('waidrop-v1');

export const ENVELOPE = { magic: 'WAAR', version: VERSION, nonceBytes: 12 };
export const MEDIA_ENVELOPE = { magic: 'WAMR', version: MEDIA_VERSION, nonceBytes: 12 };

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(String(text || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function generateMasterKey() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export function isValidMasterKey(keyBase64) {
  try {
    return base64ToBytes(keyBase64).length === 32;
  } catch (e) {
    return false;
  }
}

async function deriveBits(masterKeyB64, info) {
  const raw = base64ToBytes(masterKeyB64);
  if (raw.length !== 32) throw new Error('encryption key must be 32 bytes (base64)');
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(info) },
      ikm,
      256
    )
  );
}

export async function deriveKeyBits(masterKeyB64, info) {
  return deriveBits(masterKeyB64, info);
}

export async function deriveKeys(masterKeyB64) {
  const hashBits = await deriveBits(masterKeyB64, 'chat-hash');
  const encBits = await deriveBits(masterKeyB64, 'object-encryption');
  const mediaBits = await deriveBits(masterKeyB64, 'media-encryption');
  const payloadBits = await deriveBits(masterKeyB64, 'payload-hash');
  const hashKey = await crypto.subtle.importKey('raw', hashBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const encKey = await crypto.subtle.importKey('raw', encBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const mediaKey = await crypto.subtle.importKey('raw', mediaBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const payloadKey = await crypto.subtle.importKey('raw', payloadBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { hashKey, encKey, mediaKey, payloadKey };
}

function toUint8(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export function bytesToHex(bytes) {
  return Array.from(toUint8(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Bytes(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toUint8(bytes)));
}

export async function sha256Hex(bytes) {
  return bytesToHex(await sha256Bytes(bytes));
}

export async function keyFingerprint(masterKeyB64) {
  return (await sha256Hex(base64ToBytes(masterKeyB64))).slice(0, 16);
}

export async function dropboxContentHash(bytes) {
  const data = toUint8(bytes);
  const blockSize = 4 * 1024 * 1024;
  const blockHashes = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    blockHashes.push(await sha256Bytes(data.subarray(offset, Math.min(offset + blockSize, data.length))));
  }
  const combined = new Uint8Array(blockHashes.length * 32);
  for (let i = 0; i < blockHashes.length; i++) combined.set(blockHashes[i], i * 32);
  return bytesToHex(await sha256Bytes(combined));
}

async function hmacHexWithKey(key, text) {
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return bytesToHex(signature);
}

async function hmacHex(keys, text) {
  return hmacHexWithKey(keys.hashKey, text);
}

export async function payloadHashHex(keys, text) {
  return hmacHexWithKey(keys.payloadKey, text);
}

/** Deterministic, keyed chat folder hash: not derivable from a phone number. */
export async function chatHash(keys, chatId) {
  return (await hmacHex(keys, String(chatId))).slice(0, 16);
}

/** Deterministic, keyed media object hash: hides the message id from Dropbox paths. */
export async function mediaHash(keys, msgId) {
  return (await hmacHex(keys, `media:${String(msgId)}`)).slice(0, 32);
}

function mediaAad(relativePath) {
  const path = new TextEncoder().encode(String(relativePath || ''));
  const aad = new Uint8Array(MEDIA_AAD_PREFIX.length + path.length);
  aad.set(MEDIA_AAD_PREFIX, 0);
  aad.set(path, MEDIA_AAD_PREFIX.length);
  return aad;
}

/** Encrypt full-resolution media bytes with the media key and its archive path as AAD. */
export async function encryptMedia(keys, relativePath, bytes, options = {}) {
  if (!keys || !keys.mediaKey) throw new Error('media key unavailable');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const nonce = options.nonce ? Uint8Array.from(options.nonce) : crypto.getRandomValues(new Uint8Array(12));
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes');
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: mediaAad(relativePath) },
      keys.mediaKey,
      data
    )
  );
  const envelope = new Uint8Array(MEDIA_MAGIC.length + 1 + nonce.length + ciphertext.length);
  envelope.set(MEDIA_MAGIC, 0);
  envelope[MEDIA_MAGIC.length] = MEDIA_VERSION;
  envelope.set(nonce, MEDIA_MAGIC.length + 1);
  envelope.set(ciphertext, MEDIA_MAGIC.length + 1 + nonce.length);
  return envelope;
}

/** Decrypt a media envelope (tests / backup tooling). */
export async function decryptMedia(keys, relativePath, envelopeBytes) {
  if (!keys || !keys.mediaKey) throw new Error('media key unavailable');
  const bytes = envelopeBytes instanceof Uint8Array ? envelopeBytes : new Uint8Array(envelopeBytes);
  const headerLength = MEDIA_MAGIC.length + 1;
  if (bytes.length <= headerLength + 12 + 16) throw new Error('media envelope too short');
  for (let i = 0; i < MEDIA_MAGIC.length; i++) {
    if (bytes[i] !== MEDIA_MAGIC[i]) throw new Error('bad media envelope magic');
  }
  if (bytes[MEDIA_MAGIC.length] !== MEDIA_VERSION) throw new Error('unsupported media envelope version');
  const nonce = bytes.slice(headerLength, headerLength + 12);
  const ciphertext = bytes.slice(headerLength + 12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: mediaAad(relativePath) },
    keys.mediaKey,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

/**
 * Encrypt a UTF-8 string (or bytes) into the archive envelope.
 * `options.nonce` exists for known-answer tests only.
 */
export async function encryptObject(keys, plaintext, options = {}) {
  const data = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const nonce = options.nonce ? Uint8Array.from(options.nonce) : crypto.getRandomValues(new Uint8Array(12));
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes');
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, keys.encKey, data)
  );
  const envelope = new Uint8Array(MAGIC.length + 1 + nonce.length + ciphertext.length);
  envelope.set(MAGIC, 0);
  envelope[MAGIC.length] = VERSION;
  envelope.set(nonce, MAGIC.length + 1);
  envelope.set(ciphertext, MAGIC.length + 1 + nonce.length);
  return envelope;
}

/** Decrypt an archive envelope back to a UTF-8 string (used by tests / backup tools). */
export async function decryptObject(keys, envelopeBytes) {
  const bytes = envelopeBytes instanceof Uint8Array ? envelopeBytes : new Uint8Array(envelopeBytes);
  const headerLength = MAGIC.length + 1;
  if (bytes.length <= headerLength + 12 + 16) throw new Error('envelope too short');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('bad envelope magic');
  }
  if (bytes[MAGIC.length] !== VERSION) throw new Error('unsupported envelope version');
  const nonce = bytes.slice(headerLength, headerLength + 12);
  const ciphertext = bytes.slice(headerLength + 12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: AAD },
    keys.encKey,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}
