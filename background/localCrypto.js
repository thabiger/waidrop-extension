/**
 * Local archive encryption.
 *
 * Message payloads, chat identity fields and media bytes are sealed before
 * they reach IndexedDB. Routing metadata (ids, timestamps, direction, type and
 * queue status) stays plaintext so indexes and maintenance jobs keep working.
 */
import {
  base64ToBytes,
  bytesToBase64,
  deriveKeyBits,
  isValidMasterKey,
  keyFingerprint,
} from './crypto.js';

const VERSION = 1;
const RECORD_MAGIC = new Uint8Array([0x57, 0x41, 0x4c, 0x52]); // WALR
const CHAT_MAGIC = new Uint8Array([0x57, 0x41, 0x4c, 0x43]); // WALC
const MEDIA_MAGIC = new Uint8Array([0x57, 0x41, 0x4c, 0x4d]); // WALM

const RECORD_SECRET_FIELDS = [
  'text',
  'tsRaw',
  'msgKey',
  'senderId',
  'senderName',
  'senderPushname',
  'senderPhone',
  'chatName',
  'chatPhone',
  'chatPushname',
  'error',
];

const CHAT_SECRET_FIELDS = [
  'chatName',
  'chatPhone',
  'chatPushname',
  'mapUploadedName',
  'mapUploadedPhone',
  'mapUploadedPushname',
];

function hasField(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function hasSecrets(value, fields) {
  return !!value && fields.some((field) => hasField(value, field));
}

function aad(magic, kind, id) {
  const prefix = new Uint8Array([...magic, VERSION]);
  const suffix = new TextEncoder().encode(`${kind}:${String(id || '')}`);
  const out = new Uint8Array(prefix.length + suffix.length);
  out.set(prefix, 0);
  out.set(suffix, prefix.length);
  return out;
}

function envelope(magic, nonce, ciphertext) {
  const out = new Uint8Array(magic.length + 1 + nonce.length + ciphertext.length);
  out.set(magic, 0);
  out[magic.length] = VERSION;
  out.set(nonce, magic.length + 1);
  out.set(ciphertext, magic.length + 1 + nonce.length);
  return out;
}

function parseEnvelope(magic, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const header = magic.length + 1;
  if (data.length <= header + 12 + 16) throw new Error('local envelope too short');
  for (let i = 0; i < magic.length; i++) {
    if (data[i] !== magic[i]) throw new Error('bad local envelope magic');
  }
  if (data[magic.length] !== VERSION) throw new Error('unsupported local envelope version');
  return {
    nonce: data.slice(header, header + 12),
    ciphertext: data.slice(header + 12),
  };
}

async function sealText(key, magic, kind, id, value) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(magic, kind, id) },
      key,
      new TextEncoder().encode(JSON.stringify(value))
    )
  );
  return bytesToBase64(envelope(magic, nonce, ciphertext));
}

async function openText(key, magic, kind, id, encrypted) {
  const parts = parseEnvelope(magic, base64ToBytes(encrypted));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: parts.nonce, additionalData: aad(magic, kind, id) },
    key,
    parts.ciphertext
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function extract(value, fields) {
  const secret = {};
  for (const field of fields) {
    if (hasField(value, field)) secret[field] = value[field];
  }
  return secret;
}

function strip(value, fields) {
  const next = { ...value };
  for (const field of fields) delete next[field];
  return next;
}

function keyError(error) {
  const wrapped = new Error('local-archive-key-mismatch');
  wrapped.cause = error;
  return wrapped;
}

export async function createLocalCodec(masterKeyB64) {
  if (!isValidMasterKey(masterKeyB64)) throw new Error('encryption key must be 32 bytes (base64)');
  const [recordBits, chatBits, mediaBits] = await Promise.all([
    deriveKeyBits(masterKeyB64, 'local-record-encryption'),
    deriveKeyBits(masterKeyB64, 'local-chat-encryption'),
    deriveKeyBits(masterKeyB64, 'local-media-encryption'),
  ]);
  const recordKey = await crypto.subtle.importKey('raw', recordBits, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const chatKey = await crypto.subtle.importKey('raw', chatBits, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const mediaKey = await crypto.subtle.importKey('raw', mediaBits, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const fingerprint = await keyFingerprint(masterKeyB64);

  async function sealRecord(record) {
    if (!record) return record;
    const secret = extract(record, RECORD_SECRET_FIELDS);
    if (!Object.keys(secret).length) return record;
    const next = strip(record, RECORD_SECRET_FIELDS);
    next.payloadEnc = await sealText(recordKey, RECORD_MAGIC, 'record', record.msgId, secret);
    next.payloadEncVersion = VERSION;
    return next;
  }

  async function openRecord(record) {
    if (!record) return null;
    if (record.payloadEnc) {
      let secret;
      try {
        secret = await openText(recordKey, RECORD_MAGIC, 'record', record.msgId, record.payloadEnc);
      } catch (error) {
        throw keyError(error);
      }
      const next = { ...record, ...secret };
      delete next.payloadEnc;
      delete next.payloadEncVersion;
      return next;
    }
    if (hasSecrets(record, RECORD_SECRET_FIELDS)) throw new Error('legacy-plaintext-local-archive');
    return record;
  }

  async function sealChat(chat) {
    if (!chat) return chat;
    const secret = extract(chat, CHAT_SECRET_FIELDS);
    if (!Object.keys(secret).length) return chat;
    const next = strip(chat, CHAT_SECRET_FIELDS);
    next.chatEnc = await sealText(chatKey, CHAT_MAGIC, 'chat', chat.chatId, secret);
    next.chatEncVersion = VERSION;
    return next;
  }

  async function openChat(chat) {
    if (!chat) return null;
    if (chat.chatEnc) {
      let secret;
      try {
        secret = await openText(chatKey, CHAT_MAGIC, 'chat', chat.chatId, chat.chatEnc);
      } catch (error) {
        throw keyError(error);
      }
      const next = { ...chat, ...secret };
      delete next.chatEnc;
      delete next.chatEncVersion;
      return next;
    }
    if (hasSecrets(chat, CHAT_SECRET_FIELDS)) throw new Error('legacy-plaintext-local-archive');
    return chat;
  }

  async function sealMedia(media) {
    if (!media || media.bytes == null) return media;
    const bytes = media.bytes instanceof Uint8Array ? media.bytes : new Uint8Array(media.bytes);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad(MEDIA_MAGIC, 'media', media.msgId) },
        mediaKey,
        bytes
      )
    );
    const next = { ...media };
    next.bytesEnc = envelope(MEDIA_MAGIC, nonce, ciphertext);
    next.bytesEncVersion = VERSION;
    next.byteLength = bytes.byteLength;
    delete next.bytes;
    return next;
  }

  async function openMedia(media) {
    if (!media) return null;
    if (media.bytesEnc) {
      let plaintext;
      try {
        const parts = parseEnvelope(MEDIA_MAGIC, media.bytesEnc);
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: parts.nonce, additionalData: aad(MEDIA_MAGIC, 'media', media.msgId) },
            mediaKey,
            parts.ciphertext
          )
        );
      } catch (error) {
        throw keyError(error);
      }
      const next = { ...media, bytes: plaintext };
      delete next.bytesEnc;
      delete next.bytesEncVersion;
      return next;
    }
    if (media.bytes != null) throw new Error('legacy-plaintext-local-archive');
    return { ...media, bytes: null };
  }

  return {
    fingerprint,
    sealRecord,
    openRecord,
    sealChat,
    openChat,
    sealMedia,
    openMedia,
    isSealedRecord: (record) => !!record && typeof record.payloadEnc === 'string',
    isSealedChat: (chat) => !!chat && typeof chat.chatEnc === 'string',
  };
}
