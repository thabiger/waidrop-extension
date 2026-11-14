# Chrome Web Store Listing Notes

## Short description

Free encrypted WhatsApp Web archive in Dropbox with CLI query, full-history sync
and downloaded full-resolution images/stickers.

## Detailed description

WAiDrop builds an encrypted local archive of WhatsApp Web chats and can back it
up to your own Dropbox app folder. On first run it shows a plain-language
disclosure and asks for consent before it starts archiving. Query the archive
by chat, phone number or date, and export media, with the companion
open-source waidrop-cli.

AI access through MCP is provided by the separate open-source WAiDrop CLI/MCP
server, installed separately. AI provider compatibility varies; provider names
are examples, not endorsements.

Features:
- group and 1:1 chats
- text, metadata, and full-resolution images, stickers and GIFs that WhatsApp
  Web has already downloaded or that you have opened (individual captures are
  capped at 20 MiB)
- video, audio and documents archived as metadata/placeholders only
- encrypted local archive and encrypted Dropbox backup
- unlimited encrypted Dropbox sync
- offline catch-up of messages received while the WhatsApp Web tab was closed
- optional full-history sync for messages dated before installation that WAiDrop
  has already captured; it does not request older history from WhatsApp
- multiple WhatsApp accounts in one Dropbox app folder, one alias per account
  (use a separate browser profile or device per account)
- Off / Passive media capture (Passive is the default)
- local offload and media repair

Multiple accounts require separate browser profiles or devices; switching
WhatsApp accounts inside the same profile is not supported.

Encryption is mandatory. The key is never sent to Dropbox and must be saved by
the user; losing it makes the archive unreadable.

WAiDrop is free and open source under the Apache License, Version 2.0.
The popup contains an optional Buy Me a Coffee donation link; donations do not unlock features.

WAiDrop is a local, read-only archiver, not an automation bot or unofficial API.
It does not send messages, drive the WhatsApp UI, create accounts, hook WebSocket
traffic, or route your session through a server. It uses only chat data that
WhatsApp Web has already delivered to your open browser tab. It does not use the
WhatsApp API, a proxy, a backend, or automated messaging. The extension never
requests media from WhatsApp; it captures only media WhatsApp has already
downloaded or that you have opened. View-once ("disappearing") media is never captured in the
published build; such messages are skipped and only their metadata is
archived. The developer does not receive your archive, Dropbox token or
encryption key.

WAiDrop is not affiliated with, endorsed by or authorized by WhatsApp or Meta.
Despite the read-only design, interpretation of WhatsApp's Terms belongs to
WhatsApp/Meta; capture may stop working and accounts may be restricted. Use at
your own risk.

Privacy: https://waidrop.tnkrd.com/privacy
Terms: https://waidrop.tnkrd.com/terms
Support: https://waidrop.tnkrd.com/support

## Single purpose

Archive WhatsApp Web chats locally in an encrypted archive and optionally back
up that archive to the user's own Dropbox account.

## Permissions justification

- `storage`, `unlimitedStorage`: store the archive and settings locally.
- `alarms`: periodic upload and cleanup.
- `identity`: Dropbox OAuth.
- `scripting`: inject the read-only page hook into the already-open
  `web.whatsapp.com` tab; no other sites are scripted.
- Host access to `web.whatsapp.com`: read messages and metadata from the WhatsApp
  Web page.
- Host access to Dropbox API domains: upload and verify archive objects.

No remote code is loaded. Dropbox is used only when the user connects it. The
extension contains no payment provider; the optional Buy Me a Coffee link opens
an external page.

## Data disclosures

- Personally identifiable information: chat names, sender names and phone
  numbers contained in the archived messages.
- Personal communications: WhatsApp message content, captions, media and
  metadata. View-once ("disappearing") messages are not captured; only their
  metadata is archived. Message text, sender/chat names and phones, and media
  bytes are encrypted at rest locally; routing metadata stays plaintext.
  Dropbox object names are not encrypted and include the account alias plus
  calendar dates/message timestamps; message content, names, phones and media
  remain encrypted.
- Authentication information: Dropbox refresh token.
- Website content: the WhatsApp Web page content the user has open is read to
  build the archive.
- Financial/payment information: not handled by the extension.
- Encryption is mandatory. Disclose that the user must save the key and that
  lost keys cannot be recovered.
- Messages dated before installation stay local until the user enables
  full-history sync. Disclose this in the listing and terms.
- Data is not sold or used for advertising.

## Support

Use **https://waidrop.tnkrd.com/support** for the Chrome Web Store support URL
and **waidrop@tnkrd.com** for the privacy policy contact, the terms contact, and
refund/support requests.

## Reviewer test instructions

- The popup, privacy/terms/support links, and first-run consent screen can be
  reviewed without logging in to WhatsApp.
- To exercise capture, open `https://web.whatsapp.com/`, log in with a WhatsApp
  account, open a chat and send/receive a few messages from another device.
  Open the popup and accept the first-run disclosure.
- Dropbox is optional. It is only needed to test backup and media repair.
- The store build has no Active media mode and makes no WhatsApp media requests.
  View-once ("disappearing") media is not captured.
- The extension does not use the WhatsApp API, a proxy, a backend, or automated
  messaging. It reads only data already delivered to the open WhatsApp Web tab.
- No automation: the extension never sends messages, marks chats read, changes
  presence or drives the WhatsApp UI.

## Assets

Ready-to-upload files are in `store-assets/`:

- `store-assets/screenshots/01-your-whatsapp-archive.png` through
  `store-assets/screenshots/05-manage-local-storage.png` — five 1280x800
  screenshots. Upload in filename order.
- `store-assets/store-icon-128x128.png` — 128x128 store icon (96x96 artwork,
  16px transparent padding). The same icon is installed at `icons/icon128.png`.
- `store-assets/small-promo-440x280.png` — recommended small promo tile.
- `store-assets/marquee-1400x560.png` — optional marquee.
- `store-assets/store-listing-description.txt` — ready-to-paste detailed
  description, including the separate CLI/MCP disclosure.
- `store-assets/UPLOAD-GUIDE.txt` — upload order and asset notes.

Do not upload the media ZIP as the extension package. Use
`dist/waidrop-<version>-public.zip` for the extension upload.

Privacy policy, terms and support URLs:

- `https://waidrop.tnkrd.com/privacy`
- `https://waidrop.tnkrd.com/terms`
- `https://waidrop.tnkrd.com/support`

Link those URLs from the Chrome Web Store listing and the popup footer.
