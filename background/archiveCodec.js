/**
 * Mode-aware archive codec.
 *
 * The shipped extension always writes encrypted archives. The retired
 * plaintext mode is still parseable so a pre-existing Dropbox archive can be
 * recognized and refused; no write path accepts it.
 *
 *   encrypted - WAAR/WAMR AES-256-GCM envelopes with keyed HMAC paths
 *   plaintext - legacy UTF-8 JSON/NDJSON or raw media bytes (read-only)
 *
 * `_format.json` is authoritative for the mode of an existing remote archive.
 */
import {
  chatHash,
  mediaHash,
  encryptObject,
  decryptObject,
  encryptMedia,
  decryptMedia,
} from './crypto.js';

export const ARCHIVE_MODES = ['encrypted', 'plaintext'];
export const READ_ONLY_ARCHIVE_MODES = ['plaintext'];

/** Parse a remote format marker. Returns null for unknown values. */
export function parseArchiveMode(value) {
  return value === 'encrypted' || value === 'plaintext' ? value : null;
}

/**
 * Normalize a mode for a write path. The retired plaintext mode (and any
 * unknown value) fails closed: archives are always encrypted.
 */
export function normalizeArchiveMode(value) {
  if (value !== 'encrypted') {
    throw new Error(`unsupported archive write mode: ${String(value)} (archives are always encrypted)`);
  }
  return 'encrypted';
}

export function isEncryptedMode(value) {
  return normalizeArchiveMode(value) === 'encrypted';
}

export function objectExtension(mode) {
  normalizeArchiveMode(mode);
  return '.enc';
}

export function chatObjectExtension(mode) {
  normalizeArchiveMode(mode);
  return '.enc';
}

export function mediaObjectExtension(mode) {
  normalizeArchiveMode(mode);
  return '.enc';
}

export async function chatHashForMode(mode, keys, chatId) {
  normalizeArchiveMode(mode);
  return chatHash(keys, chatId);
}

export async function mediaHashForMode(mode, keys, msgId) {
  normalizeArchiveMode(mode);
  return mediaHash(keys, msgId);
}

export async function encodeObject(mode, keys, plaintext) {
  normalizeArchiveMode(mode);
  return encryptObject(keys, plaintext);
}

export async function decodeObject(mode, keys, bytes) {
  if (parseArchiveMode(mode) !== 'plaintext') return decryptObject(keys, bytes);
  return new TextDecoder().decode(bytes);
}

export async function encodeMedia(mode, keys, relativePath, bytes) {
  normalizeArchiveMode(mode);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return encryptMedia(keys, relativePath, data);
}

export async function decodeMedia(mode, keys, relativePath, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (parseArchiveMode(mode) !== 'plaintext') return decryptMedia(keys, relativePath, data);
  return data;
}
