# WhatsApp Archive — Storage Contract v4

The extension writes an archive into a Dropbox **App folder**. The companion
`waidrop` CLI reads it directly through the Dropbox API.

Format v4 has a single mode: **encrypted**. Objects use AES-256-GCM envelopes.

Archives may contain group chats and 1:1 chats, plus full-resolution media when
capture is enabled. Messages dated before installation stay local until
full-history sync is enabled.

The account layout is shared by every archive. `_format.json` is authoritative
for the format and content encoding.

## 1. Layout

All paths are relative to the app-folder root:

```
/account=<alias>/_format.json
/account=<alias>/_chats/index.<ext>
/account=<alias>/_chats/<chatHash>.<ext>
/account=<alias>/chat=<chatHash>/dt=<YYYY-MM-DD>/part-<firstTs>-<lastTs>-<seq>.<partExt>
```

- `<alias>` is the account alias (default `primary`). Use one alias per
  WhatsApp account. Multiple aliases can coexist under one app folder, and each
  is an independent archive.
- `<ext>` is `.enc`.
- `<partExt>` is `.enc`.
- Media objects are `media-<hash>.enc`.
- `<chatHash>` is a keyed HMAC. Readers must resolve hashes from `_chats/index`
  or the record rather than hard-coding an algorithm.
- `dt=` is the **capturing browser's local date** (not UTC). Readers pad the
  listed date range by ±1 day and filter exactly by each record's `ts`.
- `part-<firstTs>-<lastTs>-<seq>`: `firstTs`/`lastTs` are the `sortTs` of the
  first/last record in the part (epoch ms). Parts for one chat+day sort by
  `firstTs`, then `seq`. Names derive from content, so retries overwrite the same
  object.
- Parts hold at most 200 records. One NDJSON object per line before encryption.
- `_format.json` is always plaintext.

The alias is an archive destination, not an account identifier carried inside
records. Use one alias per WhatsApp account and a separate browser profile or
device per account. Switching WhatsApp accounts inside the same browser profile
is not supported: the local archive is not partitioned by account, and changing
the alias re-targets and re-enqueues existing local records.

### Format marker

Encrypted mode:

```json
{
  "format": 4,
  "layout": "waidrop",
  "mode": "encrypted",
  "encryption": "aes-256-gcm",
  "keyDerivation": "hkdf-sha256",
  "chatHash": "hmac-sha256-16",
  "media": {
    "layout": "waidrop-media-v1",
    "encryption": "aes-256-gcm",
    "keyDerivation": "hkdf-sha256",
    "hash": "hmac-sha256-32"
  }
}
```

## 2. Encryption contract (encrypted mode)

Master key `K` = 32 random bytes, displayed as base64, generated in the extension
and copied to the CLI (`WAIDROP_KEY`). Losing it makes the archive unreadable.

```
hashKey  = HKDF-SHA256(ikm=K, salt=utf8("waidrop-v1"), info=utf8("chat-hash"),         L=32)
encKey   = HKDF-SHA256(ikm=K, salt=utf8("waidrop-v1"), info=utf8("object-encryption"), L=32)
mediaKey = HKDF-SHA256(ikm=K, salt=utf8("waidrop-v1"), info=utf8("media-encryption"),  L=32)

chatHash  = lowerhex(HMAC-SHA256(hashKey, utf8(chatId)))[0:16]
mediaHash = lowerhex(HMAC-SHA256(hashKey, utf8("media:" + msgId)))[0:32]
```

Message parts and chat/index objects:

```
"WAAR" | 0x01 | nonce(12 random bytes) | AES-256-GCM ciphertext+tag
```

with `AAD = "WAAR" | 0x01`. The encrypted plaintext is UTF-8 (NDJSON or JSON).

Media objects:

```
"WAMR" | 0x01 | nonce(12 random bytes) | AES-256-GCM ciphertext+tag
```

with `AAD = "WAMR" | 0x01 | utf8(relativeMediaPath)`.

A known-answer fixture shared by the JS and Python test suites:

```
key      = AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=
nonce    = 00 01 02 03 04 05 06 07 08 09 0a 0b
plaintext= "hello archive"
ciphertext (hex) =
  5741415201000102030405060708090a0b2109e73aa5a338c3a33a3b2e2f3ec1b69f67ed340a8f63ae39807c464f
chatHash("49171234567@c.us") = 8e59af6366e6c4aa

media path = chat=8e59af6366e6c4aa/dt=2026-10-17/media-00112233445566778899aabbccddeeff.enc
plaintext  = "hello media"
ciphertext (hex) =
  57414d5201000102030405060708090a0b6b80213e9b6eb042879d701327849c3fb0940883987c5986dfa8a5
mediaHash("ACE81BE4695181CE094591658F7D7844") = b9b8b4fb8d6daf44d4cd9d39853e9ade
```

## 3. Encrypted payloads

### 3.1 Message record

| Field | Type | Notes |
|---|---|---|
| `v` | int | schema version, `1` |
| `msgId` | string | WhatsApp message id (dedupe key) |
| `msgKey` | string\|null | full serialized key |
| `chatId` | string\|null | jid (`…@c.us`, `…@g.us`, `…@lid`); `null` for DOM-only |
| `chatName` | string | display name at capture time |
| `chatPhone` | string\|null | digits only, when known |
| `chatPushname` | string\|null | WhatsApp profile name |
| `isGroup` | bool | |
| `direction` | `in`\|`out`\|`unknown` | |
| `senderId` | string\|null | group participant / DM peer |
| `senderName` | string\|null | `"You"` for outgoing |
| `senderPushname` | string\|null | |
| `senderPhone` | string\|null | digits only |
| `text` | string | body/caption; for media it may also contain a small preview |
| `ts` | number\|null | server timestamp, epoch ms |
| `tsRaw` | string\|null | raw DOM pre-plain text |
| `type` | string | `chat`, `image`, `video`, `audio`, `ptt`, `document`, `sticker`, `gif`, `vcard`, `location`, `revoked`, … |
| `media` | object\|absent | full-resolution media metadata |
| `capturedAt` | number | epoch ms of first capture |
| `source` | `store`\|`dom` | capture layer |
| `sortTs` | number | ordering key (`ts` else `capturedAt`) |

Full-resolution media metadata:

```json
"media": {
  "status": "stored",
  "kind": "image",
  "mime": "image/jpeg",
  "size": 2456789,
  "width": 1600,
  "height": 1200,
  "sha256": "<64 lowercase hex>",
  "path": "chat=<hash>/dt=<date>/media-<hash>.enc",
  "capturedAt": 1792736631000
}
```

`status = "stored"` means the object has been uploaded. `pending` means it is
still local. `not_downloaded` means only the preview is available. `blocked`
may appear in archives written by older versions; such entries are requeued on
upgrade. `unavailable`, `view_once`, `too_large` and `failed` are terminal for
that capture attempt.

Media messages without captured bytes appear as text/metadata.

### 3.2 `_chats/<hash>.<ext>`

```json
{ "chatId": "49171234567@c.us", "chatName": "Anna Schmidt",
  "chatPhone": "49171234567", "chatPushname": "Anna",
  "isGroup": false, "firstSeen": 1792224000000, "lastSeen": 1792310400000 }
```

### 3.3 `_chats/index.<ext>`

```json
{ "generatedAt": "2026-10-17T12:00:00.000Z", "mode": "encrypted",
  "chats": [ { "hash": "8e59af6366e6c4aa", "chatId": "49171234567@c.us",
               "chatName": "Anna Schmidt", "chatPhone": "49171234567",
               "chatPushname": "Anna", "isGroup": false,
               "firstSeen": 1792224000000, "lastSeen": 1792310400000 } ] }
```

The index is authoritative for name/number → chat hash resolution. It carries
`firstSeen`/`lastSeen`, which readers can use to skip chats that cannot contain
messages in a requested window.

## 4. Deduplication

The same `msgId` can appear in more than one part (corrected/repaired records).
Readers must dedupe by `msgId`, preferring:

1. `source == "store"` over `"dom"`,
2. then the higher `capturedAt`,
3. then any.

Media metadata follows the same record: prefer `stored` over `pending`, then the
newer `media.capturedAt`. A media object is written once per message and
overwritten on retry; re-uploading the same path is safe.

Sort output by (`ts` or `sortTs`, `msgId`).

## 5. Reading with the CLI

```
waidrop auth                          # one-time OAuth PKCE connect
waidrop chats
waidrop query --name "Anna*" --from 2026-10-01 --to 2026-10-17
waidrop query --last 1h
waidrop query --last 1h --media-out ./waidrop-media
waidrop context --last 6h --context-before 30m --format text
```

The CLI uses the same Dropbox app key as the extension (shared App Folder) and
authenticates via OAuth 2.0 PKCE with a locally stored refresh token. Run
`waidrop auth` once; access tokens are auto-refreshed thereafter.

The CLI must read `_format.json` first. Format 4 archives are always encrypted
and require `WAIDROP_KEY`.

Configuration:
- Dropbox: `waidrop auth` (credentials file) or `WAIDROP_DROPBOX_TOKEN` /
  `WAIDROP_DROPBOX_REFRESH_TOKEN` + `WAIDROP_DROPBOX_APP_KEY` for testing.
- Encrypted: `WAIDROP_KEY`.
- Optional: `WAIDROP_ACCOUNT` (default `primary`), `WAIDROP_FOLDER`.

## 6. Archive changes

The extension writes encrypted archives only. Use one alias per WhatsApp
account.

Messages dated on/after installation are synced by default. Messages before that
date stay local until full-history sync is enabled.

For destination changes, the extension re-uploads records that were not
offloaded. Offload is blocked when the key, alias or Dropbox account changes
until the old archive is restored.

## 7. Privacy properties and caveats

- Encrypted archives: Dropbox sees ciphertext for message content, chat names,
  phone numbers, message ids and full-resolution media. It sees object counts,
  sizes, date partitions and keyed chat hashes.
- Local archives: message text, sender/chat names and phone numbers, and media
  bytes are encrypted at rest in IndexedDB. Ids, timestamps and queue status
  remain plaintext for indexing.
- A leaked Dropbox token can read/overwrite/delete the app folder. It cannot
  decrypt without the master key.
- Deleting the local IndexedDB archive does not delete Dropbox objects.
- Full-resolution media increases Dropbox storage and bandwidth use. Individual
  captures are capped (default 20 MiB) and local media bytes are deleted after a
  successful upload.
- Key rotation is not implemented in v4; a future envelope version can add key
  ids.
