<!-- Canonical public URL: https://waidrop.tnkrd.com/privacy -->

# WAiDrop Privacy Policy

Effective date: 2026-10-29  
Last updated: 2026-11-13

## 1. Scope and controller

WAiDrop is developed and controlled by **Tomasz Habiger**. Contact:
**waidrop@tnkrd.com**.

We are the controller of the support data described below. We are **not** the
controller of the archive content you create: that content stays on your device
and, if you enable it, in your own Dropbox account. We do not receive it unless
you choose to send us a screenshot, log or other copy in a support message.

This policy applies to the extension and our support handling. It does not apply
to WhatsApp, Dropbox, Buy Me a Coffee, Google/Chrome Web Store or other
third-party services, which have their own privacy policies.

## 2. Short version

- The extension archives WhatsApp Web chats on your device.
- If you enable Dropbox backup, the archive is uploaded to **your own Dropbox
  account**, not to us.
- We do not receive or have access to your archived messages, Dropbox token or
  encryption key.
- Local archive payloads and media, and all Dropbox backups, are encrypted. The
  key stays on your device and must be saved by you; lost keys cannot be
  recovered. Dropbox object names are not encrypted: they include your account
  alias and calendar dates/message timestamps, which reveal when a chat was
  active, but not message content, names, phone numbers or media.
- Messages dated before installation stay local until you enable full-history
  sync. Full-history sync uploads only messages WAiDrop has already captured; it
  does not request older history from WhatsApp.
- View-once ("disappearing") media is **never captured** in the published
  extension; such messages are skipped and only their metadata is archived.
- WAiDrop is free. The popup contains an optional Buy Me a Coffee link; no
  payment data is collected by the extension.
- We do not sell personal data, use it for advertising, or operate an analytics
  backend in the extension.

## 3. Data we handle

| Data | Where it comes from | Purpose | Where it is stored |
|---|---|---|---|
| WhatsApp messages, captions, chat names, phone numbers, sender names, timestamps, message ids and media | WhatsApp Web, through the extension | Build your archive | Your device; your Dropbox app folder if you enable backup |
| Archive settings and the encryption key | You, through the extension | Configure and decrypt the archive | Your device |
| Dropbox authorization token | Dropbox, when you connect it | Upload and verify backup objects | Your device; sent only to Dropbox |
| Support correspondence | You, when you email us | Respond to your request | Our support email account |

The extension does not send your archived messages, Dropbox token or encryption
key to us. We cannot read them. If you send us a support message with a
screenshot, log or file, we will receive what you choose to send.

We do not use automated decision-making or profiling in the extension.

## 4. What we do not collect

- We do not receive WhatsApp message content, media or your Dropbox token
  through the extension. If you send us a support message, we receive what you
  choose to send.
- View-once ("disappearing") messages are not captured by the published
  extension; they are skipped and only their metadata is archived.
- No encryption keys.
- No card, bank or donation details. The extension does not process payments or
  donations; clicking the Buy Me a Coffee link opens an external page.
- No advertising identifiers, behavioural profiles or analytics from the
  extension.
- No precise location data.

## 5. Legal bases (EEA)

Where the GDPR applies, we rely on:

- **Legitimate interests**: to respond to support requests, secure the product,
  prevent fraud and establish or defend legal claims.
- **Consent**: only where we specifically ask for it.

## 6. Who we share data with

- **Dropbox** — only if you connect it; the archive is stored in your own
  Dropbox account. See <https://www.dropbox.com/privacy>.
- **Buy Me a Coffee** — only if you click the donation link. The extension does
  not send any data to Buy Me a Coffee. See the privacy policy linked on the
  Buy Me a Coffee page.
- **Google/Chrome Web Store** — extension distribution and updates. See
  <https://policies.google.com/privacy>.
- **Our email provider** — to receive and answer support messages.
- **Authorities or courts** — where required by law, or to establish or defend
  legal claims.
- **A successor business** — if the business is transferred, support data may
  transfer as part of it. Archive content is not held by us and would not
  transfer.

We do not sell personal data or share it for advertising.

## 7. International transfers

Dropbox, Buy Me a Coffee and Google may process data outside the EEA. See their
privacy policies for the safeguards they use for international transfers.

## 8. Retention

- **Local archive and Dropbox data**: controlled by you. We do not set a
  retention period because we do not hold it.
- **Support emails**: kept for up to 12 months from the last contact, unless we
  need them longer to resolve a dispute or comply with law.
- **Donation records**: not held by us. Buy Me a Coffee retains them according to
  its own policies.

## 9. Security

We use HTTPS for network connections. Message payloads, chat identity fields and
media bytes are encrypted locally before they reach IndexedDB, and Dropbox
archives are encrypted in your browser with AES-256-GCM before upload. The
encryption key is stored in `chrome.storage.local` and is never sent to Dropbox
or to us. Archive object paths are outside the encrypted payload: they contain
the account alias and dates/message timestamps (visible to Dropbox and anyone
who can list the app folder), while chat hashes are keyed and do not reveal
phone numbers. Local encryption protects IndexedDB at rest, not a fully
compromised browser profile. No method of storage or transmission is completely
secure.
Protect your device, your Dropbox account and your encryption key. If you lose
the key, the local and Dropbox archives cannot be recovered.

If a data breach affects your personal data, we will notify you and the
competent authorities where required by law.

## 10. Your rights

If you are in the EEA, or the UK, you may have the right to:

- access your personal data;
- correct inaccurate data;
- delete data;
- restrict or object to processing;
- receive your data in a portable format;
- withdraw consent where processing is based on consent;
- complain to a supervisory authority.

To exercise these rights, email **waidrop@tnkrd.com**. We may need to verify
your identity. We aim to respond within one month; where the law allows, we may
extend this period and will tell you if we do. Because we do not hold your
archive, you can access, export or delete it directly through the extension and
your Dropbox account.

If you are a California resident, we do not sell or share personal information
as those terms are defined by the CCPA/CPRA. You may contact us to exercise your
rights. If you are in the UK, you may also have rights under the UK GDPR; contact
us and we will handle your request.

## 11. Children

WAiDrop is not directed at children. You must meet WhatsApp's minimum age
requirement in your country and be at least 13 years old. If you are below the
age of digital consent in your country, do not use the extension.

## 12. Changes

We may update this policy. We will change the date above and, for material
changes, provide a notice in the extension or by email where we have your
address.

## 13. Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the Chrome Web
Store User Data Policy, including the Limited Use requirements.

We use data only to provide the archiving, backup and export features described
in this policy. We do not:

- sell or transfer user data to third parties for advertising or unrelated
  purposes;
- use user data to determine creditworthiness or for lending;
- allow humans to read your archive unless you explicitly send it to support or
  we are required by law.

## 14. Contact

**waidrop@tnkrd.com**
