import { payloadHashHex } from './crypto.js';
import { normalizeArchiveMode } from './archiveCodec.js';

export function payloadProjection(record) {
  return {
    text: typeof record.text === 'string' ? record.text : '',
    type: record.type || null,
    ts: typeof record.ts === 'number' ? record.ts : null,
    source: record.source || null,
  };
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function createPayloadHasher(keys, mode = 'encrypted') {
  // Fail closed: the unkeyed plaintext-mode hash no longer exists.
  normalizeArchiveMode(mode);
  return async (record) => payloadHashHex(keys, stableStringify(payloadProjection(record)));
}
