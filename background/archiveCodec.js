/**
 * Mode-aware archive codec.
 *
 * Two archive modes share the same account layout:
 *   plaintext - objects are UTF-8 JSON/NDJSON or raw media bytes
 *   encrypted - the existing WAAR/WAMR AES-256-GCM envelopes
 *
 * Chat/media path hashes are keyed HMACs in encrypted mode and plain SHA-256
 * truncations in plaintext mode. `_format.json` is authoritative for the mode.
 */
import {
  chatHash,
  mediaHash,
  encryptObject,
  decryptObject,
  encryptMedia,
  decryptMedia,
  sha256Hex,
} from './crypto.js';

export const ARCHIVE_MODES = ['plaintext', 'encrypted'];

export function normalizeArchiveMode(value) {
  return value === 'encrypted' ? 'encrypted' : 'plaintext';
}

export function isEncryptedMode(value) {
  return normalizeArchiveMode(value) === 'encrypted';
}

export function objectExtension(mode) {
  return isEncryptedMode(mode) ? '.enc' : '.ndjson';
}

export function chatObjectExtension(mode) {
  return isEncryptedMode(mode) ? '.enc' : '.json';
}

export function mediaObjectExtension(mode) {
  return isEncryptedMode(mode) ? '.enc' : '.bin';
}

export async function chatHashForMode(mode, keys, chatId) {
  if (isEncryptedMode(mode)) return chatHash(keys, chatId);
  return (await sha256Hex(new TextEncoder().encode(String(chatId)))).slice(0, 16);
}

export async function mediaHashForMode(mode, keys, msgId) {
  if (isEncryptedMode(mode)) return mediaHash(keys, msgId);
  return (await sha256Hex(new TextEncoder().encode(`media:${String(msgId)}`))).slice(0, 32);
}

export async function encodeObject(mode, keys, plaintext) {
  if (isEncryptedMode(mode)) return encryptObject(keys, plaintext);
  const text = typeof plaintext === 'string' ? plaintext : new TextDecoder().decode(plaintext);
  return new TextEncoder().encode(text);
}

export async function decodeObject(mode, keys, bytes) {
  if (isEncryptedMode(mode)) return decryptObject(keys, bytes);
  return new TextDecoder().decode(bytes);
}

export async function encodeMedia(mode, keys, relativePath, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isEncryptedMode(mode)) return encryptMedia(keys, relativePath, data);
  return data;
}

export async function decodeMedia(mode, keys, relativePath, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isEncryptedMode(mode)) return decryptMedia(keys, relativePath, data);
  return data;
}
