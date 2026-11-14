# Read-only capture model

This document describes what the extension does on `web.whatsapp.com`, what the
page can observe, and the invariants that keep capture read-only and low-impact.

## What WhatsApp Web can observe

WhatsApp Web is a normal page. It can observe:

- the DOM
- its own JavaScript objects and module registry
- window events, including `window.postMessage` and `MessagePort` transfers
- main-thread timing and jank

It cannot enumerate installed extensions, read isolated-world JavaScript,
extension storage/IndexedDB or other origins without a browser vulnerability.

The extension does not try to defeat a provider that actively instruments its
own page. It minimizes the page-visible surface and fails closed when it cannot.

## What is intentionally not done

- no DOM writes, injected UI or hidden elements
- no WebSocket hook or network interception
- no monkeypatching of WhatsApp prototypes or `window.require`
- no send/read/ack/seen/presence calls
- no synthetic clicks or key events (`isTrusted` remains true for user actions)
- no WhatsApp media requests in Off or Passive media mode

## Authenticated store bridge

- A `MessageChannel` handshake at `document_start`. The only page-visible event
  is one empty `postMessage` carrying the transferred port.
- A nonce + shared-key challenge authenticates the isolated content script.
- After connection, records, media, directory data, health and config use the
  port only.
- Every post-handshake frame is MAC'd with the per-session key and carries a
  monotonically increasing sequence number, in both directions. A script that
  shares the transferred port can read its own page data but cannot forge
  records, media or config, and replays are rejected.
- Page-forged `waidrop-config` and `waidrop-main` messages, and page-triggered
  legacy bridge announcements, are ignored: the legacy plain-`postMessage`
  transport has been removed.
- The MAIN-world test API is enabled only through the `hookMain()` injection
  argument, which page scripts cannot set.

## Read-only store hook

- Resolves collections through `WAWebCollections`, then the separate
  `WAWebMsgCollection` / `WAWebChatCollection` / `WAWebContactCollection`
  modules, then a bounded shape scan over `__debug.modulesMap`.
- Waits for `Debug.VERSION` or the app shell before requiring modules, and
  retries with backoff instead of hammering an unknown name.
- Read-only: one `Msg.on('add')` listener plus media-stage change listeners.
  No WhatsApp objects are mutated.
- Startup catch-up: when the content-script config enables it, two one-shot
  idle scans (~5 s and ~30 s after init) read `getModelsArray()` from the
  already-materialized global `Msg` and per-chat `chat.msgs` collections. No
  loader or history APIs are called; records are capped at 5,000 and drained in
  idle chunks; catch-up media is cached-only (`allowDownload: false`) even when
  Active mode is enabled.
- Every callback is wrapped; a failure never surfaces inside WhatsApp's
  emitters.

Residual: a determined build could inspect `Msg._events` or instrument the
module loader. There is no public evidence WhatsApp does this.

## Media invariants

- Media starts disabled until the isolated script sends the stored mode. A
  missing bridge or config means no media reads.
- Off mode never captures or uploads media: no media blob reads, no
  `downloadMedia`, no media objects in the archive.
- `activeFetch` is re-checked immediately before `downloadMedia` and again after
  waits; an active-to-passive switch cancels queued and in-flight downloads.
  Turning media Off updates the media config to `enabled: false` and clears the
  queue.
- `LruMediaStore.get` is called only for completed stages (`RESOLVED`, `READY`,
  `DOWNLOADED`), never during `FETCHING`, `REUPLOADING` or `ERROR`.
- Direct cache reads are deduplicated; passive captures are spaced by at least
  150 ms and drains use idle time when available.
- SHA-256 and image dimensions are computed in the extension service worker,
  not on the page's main thread.
- View-once media is skipped unless explicitly enabled. Active mode is opt-in
  and disabled in the public store build.

## DOM fallback

- Observes `#main` for message additions; `#app` is used only as a shell
  lifecycle observer.
- Parses newly added cells directly, with a 5 s full sweep as a safety net and
  a 250 ms minimum sweep interval.
- `seen` / `storeSeen` are capped at 5,000 entries.
- Verbose logs are behind `DEBUG`; only critical failures warn.
- Direction detection prefers tail/meta signals; computed style and layout are
  last-resort fallbacks.

## Residual risk

- One startup port handshake is page-visible.
- The store hook's listeners, module requires and collection enumeration are
  theoretically observable.
- Active mode makes server-visible media requests. Keep it off unless needed.
- WhatsApp module churn can break the store hook; the DOM fallback remains.
- The static bridge key is a capability against page scripts, not a secret from
  the extension author or the provider.
- Base64 conversion of captured media still runs in the isolated content
  script.

## Verification

- `npm test` includes the authenticated bridge, passive media and capture-model
  invariant suites.
- `tools/recon/store-resolver-probe.js` diagnoses collection module changes.
- `tools/recon/media-probe.js` checks LRU/media-stage behavior.
- Manual check: after reload, a `window` `message` listener should see only the
  empty bridge handshake, never `waidrop-*` payloads.
