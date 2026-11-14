# WAiDrop

WAiDrop is a Chrome extension that archives WhatsApp Web chats into an
encrypted local IndexedDB store and can back up an encrypted archive to
Dropbox. It is free and open source under the Apache License, Version 2.0,
and includes all chats, full-history sync, offline catch-up, multiple WhatsApp accounts and
full-resolution images, stickers and GIFs.

## How WAiDrop works with WhatsApp

WAiDrop starts with chat data that WhatsApp Web has already delivered to your
own logged-in browser tab. It does not use a WhatsApp network API, a proxy, a
backend, or automated messaging. It does not send messages, mark chats read,
change presence, drive the WhatsApp UI, hook WebSocket traffic, or modify
WhatsApp's code. It observes the page's already-loaded data and archives only
your own session content.

In the store build, media capture is Off or Passive only and makes no WhatsApp
media requests. The archive stays in your browser's IndexedDB; if you connect
Dropbox, encrypted objects go directly to your own Dropbox app folder. The
developer never receives your archive, Dropbox token, or encryption key. Local
payloads and Dropbox objects are encrypted before storage.

WAiDrop is not affiliated with, endorsed by, or authorized by WhatsApp or Meta.
These design choices do not guarantee compliance with
[WhatsApp's Terms](https://www.whatsapp.com/legal/terms-of-service);
WhatsApp/Meta determines how those terms are interpreted and enforced. Capture
may stop working, and accounts may be restricted. Use at your own risk and
comply with applicable terms and laws.

See [docs/capture-model.md](docs/capture-model.md) for the technical capture
model.

## Features

- First-run disclosure and affirmative consent before capture starts.
- Archive group chats and 1:1 chats.
- Encrypted local IndexedDB archive and encrypted Dropbox backup.
- Offline catch-up after reopening WhatsApp Web.
- Optional full-history sync for messages dated before installation.
- One archive alias per WhatsApp account.
- Full-resolution image, sticker and GIF capture in Off, Passive and Active modes.
- Unlimited Dropbox sync.
- Local offload and media repair.

All archives are encrypted. Message text, sender/chat names, phone numbers and
media bytes are encrypted at rest in IndexedDB; routing metadata such as ids,
timestamps and queue status remains plaintext for indexing. Dropbox stores only
ciphertext objects.

The encryption key is required before uploads are enabled. Back it up in a
password manager; losing it makes the local and Dropbox archives unreadable.
The key is locked once local data exists; changing it requires clearing the
archive.

WAiDrop is free. The popup links to an optional Buy Me a Coffee page for
readers who want to support development; donations do not unlock features.

## Installation

1. Clone this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable "Developer mode".
4. Click "Load unpacked" and select this directory.
5. Open the extension popup, read the first-run disclosure and accept it before
   capture starts.

## What it captures

- Text messages, captions and metadata from the WhatsApp Web store plus a DOM
  fallback for chats the store hook cannot reach.
- A bounded startup scan reads messages WhatsApp already loaded into memory
  (offline flush or startup hydration), so messages received while the tab was
  closed are archived when WhatsApp Web is reopened. The scan never requests
  history from WhatsApp; messages WhatsApp has not loaded remain uncaptured
  until their chat is opened.
- Group and 1:1 chats.
- Full-resolution images, stickers and GIFs. Media modes are Off, Passive and
  Active. Passive uses media WhatsApp has already downloaded or the user has
  opened. Active automatically downloads missing media and makes WhatsApp media
  requests. View-once media is skipped unless explicitly enabled.
- Video, audio and documents are stored as metadata/placeholders only.
- Media repair restores late-arriving media from the encrypted archive.

## Media capture modes

| Mode | Behavior | WhatsApp requests |
|---|---|---|
| Off | No full-resolution media capture. | None |
| Passive | Read media WhatsApp already downloaded or the user opened. | None |
| Active | Automatically download media WhatsApp has not cached. | Yes, may be recognized as automation |

Passive is the default. Active is opt-in, applies only to new media and does not
backfill history. The public store build ships without Active mode and therefore
never makes WhatsApp media requests.

The archive format and encryption contract are documented in
[`docs/archive-format.md`](docs/archive-format.md). Reading and media export are
implemented by the companion [`waidrop-cli`](https://github.com/thabiger/waidrop-cli).

## Dropbox backup

WAiDrop backs up to a Dropbox app folder. Every archive is encrypted with
AES-256-GCM using HKDF-derived keys; Dropbox stores ciphertext and keyed object
paths. Uploads are disabled until a valid key is saved. There is no daily upload
limit.

### Pre-install history

Messages dated before installation are captured locally and encrypted, but are
not synced by default. Enable **Sync messages dated before installation** in
Storage settings to include them. Turning it off blocks future pre-install sync;
already uploaded history remains in Dropbox.

Full-history sync uploads history the extension has captured; it does not
request older history from WhatsApp. Messages enter the archive from the
already-loaded store or from chats you open, and the startup scan is capped at
5,000 records per page load.

### Multiple WhatsApp accounts

WAiDrop can keep several WhatsApp accounts in one Dropbox app folder by
assigning a different account alias to each. Each alias has its own
`_format.json`, `_chats/index`, chat maps and message parts under
`/account=<alias>/`; the CLI selects one with `WAIDROP_ACCOUNT=<alias>`
(default `primary`).

Use a separate Chrome profile or device for each WhatsApp account. The local
IndexedDB archive belongs to one browser profile, so each profile can use its
own alias while pointing at the same Dropbox app folder.

The extension does not detect the active WhatsApp account, and the local archive
is not partitioned by account. Switching WhatsApp accounts inside the same
browser profile is not supported: changing the alias re-targets and re-enqueues
the local archive, which would mix accounts. Use separate profiles or devices
instead.

## Local offload

After a message part is uploaded and verified, the extension can replace the
local message payload with a lightweight stub.

- Uploads must be enabled and the encryption key acknowledged before offload.
- Offload keeps message ids, chat metadata, timestamps, media metadata and the
  remote part pointer, and removes text, sender names/phones and previews. Any
  remaining sensitive fields in the stub are re-encrypted.
- Media that is still pending or not downloaded does not block text offload.
  Media repair can restore late-arriving media by fetching the archived part
  from Dropbox.
- Changing the key, alias or Dropbox account pauses offload and repair until the
  old archive is restored.

Local stubs keep ids and timestamps plaintext for indexing; offload is not full
local metadata encryption.

## Activity log

The popup includes a collapsible activity log with live connection and upload
progress. Recent entries persist in `chrome.storage.local` after the popup is
closed.

## Donations

WAiDrop is free and open source under the
[Apache License, Version 2.0](LICENSE). There is no paid tier, checkout or license-key check. The popup includes an optional
**Buy me a coffee** button that opens <https://buymeacoffee.com/tomaszhabiq> in a
new tab. Donations are voluntary and do not affect features.

See [`docs/support.md`](docs/support.md).

## Support

Support: **https://waidrop.tnkrd.com/support**

Email: **waidrop@tnkrd.com**

Privacy: **https://waidrop.tnkrd.com/privacy**

Terms: **https://waidrop.tnkrd.com/terms**

## Development

```sh
npm install
npm test
npm run build            # dist/waidrop-<version>.zip (personal)
npm run verify:package   # check the ZIP contains only runtime files
npm run release:check    # test + build + verify (personal)

# Store submission (view-once capture and active media downloads removed):
npm run build:public          # dist/waidrop-<version>-public.zip
npm run verify:package:public # verify view-once capture and active downloads are absent
npm run release:check:public  # test + public build + verify
```

Tests use `jsdom` and `fake-indexeddb`; no WhatsApp or Dropbox account is needed.

The personal build keeps view-once media capture and active media downloads
enabled (private use, at your own risk). The public build disables them via
`utils/buildFlags.js`, which the build replaces with
`tools/release/buildFlags.public.js`, and strips the matching popup controls.
`verify:package:public` fails if view-once UI or the active media option leaks
into the store package.

### File structure

```
background/background.js    service worker, capture routing, key lifecycle
background/idb.js           IndexedDB archive/outbox/media stores
background/crypto.js        encrypted envelope primitives
background/localCrypto.js   local record/chat/media encryption codec
background/archiveCodec.js  encrypted archive encoding
background/archivePolicy.js install-date / pre-install policy
background/installInfo.js   installation timestamp and fallback
background/uploader.js      Dropbox uploader (history policy, media, chat index)
background/dropbox.js       Dropbox OAuth/API
background/config.js        Dropbox app and account defaults
content/content.js          DOM fallback, directory enrichment, media relay
background/inject-main.js   MAIN-world store hook + media capture
popup/                      settings and recent-message UI
utils/messageParser.js      DOM message parser
utils/mediaSettings.js      media mode migration/resolution
utils/buildFlags.js         build-variant feature flags (view-once capture)
docs/                       archive, capture model, legal, listing and support docs
scripts/build.mjs           Chrome Web Store package builder
scripts/runtime-files.mjs   runtime package allowlist
scripts/verify-package.mjs  package content and secret checks
```

## Privacy

- Local message text, sender/chat names and phone numbers, and media bytes are
  encrypted at rest in IndexedDB. Routing metadata such as ids, timestamps and
  queue status remains plaintext for indexing.
- Dropbox backups encrypt message content, chat names, phone numbers, message
  ids and full-resolution media before upload. The master key is never sent to
  Dropbox; losing it makes the local and Dropbox archives unreadable. Dropbox
  object names are not encrypted and reveal the account alias plus calendar
  dates/message timestamps, not message content.
- The key is stored in `chrome.storage.local`, so this protects IndexedDB at
  rest but not a fully compromised browser profile.
- Messages dated before installation stay local until full-history sync is
  enabled.
- Local stubs keep chat identifiers and timestamps plaintext after offload.
- The extension itself sends no payment or donation data. Clicking the Buy Me a
  Coffee button opens an external page governed by Buy Me a Coffee's policies.

See [`PRIVACY.md`](PRIVACY.md), [`TERMS.md`](TERMS.md) and
[`docs/capture-model.md`](docs/capture-model.md).

## Software license

Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Contributions intentionally submitted for inclusion in this project are licensed
under Apache-2.0, unless explicitly agreed otherwise. Third-party components
retain their own licenses.
