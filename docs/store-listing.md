# Chrome Web Store Listing Notes

## Short description

Archive WhatsApp Web chats locally and encrypted to Dropbox for free, including
1:1 chats, full-history sync, offline catch-up and full-resolution media.

## Detailed description

WAiDrop builds a searchable local archive of WhatsApp Web chats and can back it
up to your own Dropbox app folder.

Features:
- group and 1:1 chats
- text, metadata and full-resolution media
- encrypted local archive and encrypted Dropbox backup
- unlimited encrypted Dropbox sync
- offline catch-up of messages received while the WhatsApp Web tab was closed
- optional full-history sync for messages dated before installation
- multiple WhatsApp accounts in one Dropbox app folder, one alias per account
  (use a separate browser profile or device per account)
- Off / Passive / Active media capture
- local offload and media repair

Multiple accounts require separate browser profiles or devices; switching
WhatsApp accounts inside the same profile is not supported.

Encryption is mandatory. The key is never sent to Dropbox and must be saved by
the user; losing it makes the archive unreadable.

WAiDrop is free and open source under the MIT License. The popup contains an
optional Buy Me a Coffee donation link; donations do not unlock features.

WAiDrop is a local, read-only archiver, not an automation bot or unofficial API.
It does not send messages, drive the WhatsApp UI, create accounts, hook WebSocket
traffic, or route your session through a server. It archives content already
delivered to your own WhatsApp Web session. Off and Passive media modes make no
WhatsApp media requests. View-once ("disappearing") media is never captured in
the published build; such messages are skipped and only their metadata is
archived. The developer does not receive your archive, Dropbox token or
encryption key.

WAiDrop is not affiliated with, endorsed by or authorized by WhatsApp or Meta.
Despite the read-only design, interpretation of WhatsApp's Terms belongs to
WhatsApp/Meta; capture may stop working and accounts may be restricted. Use at
your own risk.

Seller: **PYXIS Tomasz Habiger**, Poland. The Chrome Web Store listing should
identify the seller and link the Privacy Policy and Terms.

## Permissions justification

- `storage`, `unlimitedStorage`: store the archive and settings locally.
- `alarms`: periodic upload and cleanup.
- `identity`: Dropbox OAuth.
- Host access to `web.whatsapp.com`: read messages and metadata from the WhatsApp
  Web page.
- Host access to Dropbox API domains: upload and verify archive objects.

No remote code is loaded. Dropbox is used only when the user connects it. The
extension contains no payment provider; the optional Buy Me a Coffee link opens
an external page.

## Data disclosures

- Personal communications: WhatsApp message content, captions, media and
  metadata. View-once ("disappearing") messages are not captured; only their
  metadata is archived. Message text, sender/chat names and phones, and media
  bytes are encrypted at rest locally; routing metadata stays plaintext.
- Authentication information: Dropbox refresh token.
- Financial/payment information: not handled by the extension.
- Encryption is mandatory. Disclose that the user must save the key and that
  lost keys cannot be recovered.
- Messages dated before installation stay local until the user enables
  full-history sync. Disclose this in the listing and terms.
- Data is not sold or used for advertising.

## Support

Use **waidrop@tnkrd.com** for the Chrome Web Store support field, the privacy
policy contact, the terms contact, and refund/support requests.

## Assets

- Icons: `icons/icon16.png`, `icon48.png`, `icon128.png`.
- Screenshots: capture the support/donation card, the storage settings and the
  activity/upload view.
- Promotional image: 440x280.
- Privacy policy and terms URLs must be hosted publicly before submission.
  Suggested paths:
  - `https://tnkrd.com/waidrop/privacy`
  - `https://tnkrd.com/waidrop/terms`
- Link those URLs from the Chrome Web Store listing and the popup footer.
