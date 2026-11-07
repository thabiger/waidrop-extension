# M0 Recon — WhatsApp Web DOM & Store probe

Purpose: capture the *current* WhatsApp Web DOM structure and Store reachability so every
later milestone builds against reality instead of assumptions. The first v1 run (2026-10-17)
already proved the need: current builds (**2.3000.1050712378**) no longer render
`div.message-in` / `div.message-out` or `[data-testid="msg-text"]`, and the old webpack
chunk-push trick to reach the Store is dead in this build. Probe v2 handles both.

Everything here is **read-only**. The probe is pasted into DevTools on a logged-in
`https://web.whatsapp.com` tab.

## Steps

### 1. Reproduce the broken state (optional, can be done any time)

1. `chrome://extensions` → Developer mode → **Load unpacked** → select this repo root.
2. Open https://web.whatsapp.com and open a chat.
3. DevTools console should show `[WAiDrop] Content script loaded`, then a
   `Could not serialize message` error when message nodes arrive — confirming that nothing
   reaches the background worker today.
4. The popup stays at "Total Messages: 0" forever — expected until M1.

### 2. Run probe v2 — IMPORTANT: a chat must be open

1. Open **a DM** with both an incoming and an outgoing message visible.
2. Open DevTools → Console, paste all of `whatsapp-dom-probe.js`, press Enter.
3. Save the clipboard JSON to `tools/recon/out/dom-probe.json`.
4. Now open **a group chat** (messages visible), run the probe again, save to
   `tools/recon/out/dom-probe-group.json`.

The probe now samples the newest message rows from `#main [role="row"]`, guesses message
direction from geometry (`directionGuess`) and reports the WhatsApp `data-id` prefix
(`true_...` / `false_...`) for each row. If `samples.rowSource` or `samples.rows` is
missing, the chat was not open — rerun.

### 3. Turn probe output into test fixtures

From the `samples.rows` entries, pick:

- the row with `dataIdPrefix: "false"` (incoming) → `tests/fixtures/message-in.html`
- the row with `dataIdPrefix: "true"` (outgoing) → `tests/fixtures/message-out.html`

Wrap each `sanitizedHTML` in a skeleton document:

```html
<!DOCTYPE html>
<html><body><div id="main"><div role="application">…paste row here…</div></div></body></html>
```

Never paste real message text, names, or phone numbers into the repo — the probe output is
already sanitized (`«t:N»` placeholders, masked digits/titles), keep it that way.

## What we are looking for in the report

| Field | Why it matters |
|---|---|
| `selectorReport` | Which anchors survive: `[role="row"]`, `msg-container`, `data-pre-plain-text`, header testids. Drives the M1 parser. |
| `samples.rows[]` | Exact row structure, `data-id` prefix (direction), `data-pre-plain-text`, child testids, geometry. |
| `samples.rows[].directionGuess` | Geometry-based incoming/outgoing check — cross-validate against `dataIdPrefix`. |
| `panel` | Whether the message list is virtualized (scrollHeight vs clientHeight). |
| `header` | Chat identification anchors (`conversation-info-header-chat-title`, `chat-subtitle`). |
| `store.mR` / `store.mRModules` | Whether `window.mR` exists and resolves `WAWebCollections` etc. — the M4 read-only store hook depends on this. |
| `store.chunk.requireCaptured` | Whether the legacy chunk-push capture works (expected `false` on current builds). |

## Definition of done for M0

- [x] Legacy interception failure confirmed by code review (serialization bug M1 fixes).
- [x] `tools/recon/out/dom-probe.json` (DM) + `dom-probe-group.json` (group) saved from probe v2.
- [x] Fixture HTML files generated from the sanitized rows (`npm run fixtures`).


## Full-resolution media probe

After a build update, open a chat containing a recent image and paste
`media-probe.js` into the DevTools console. It is read-only: it inspects the
in-memory media cache and reports module names, media stage, size, MIME,
SHA-256 and blob type. It never calls `downloadMedia()`. No image bytes or
message text are logged. Use it to confirm which media WhatsApp has already
downloaded before relying on passive full-resolution capture.

The report also includes `cache.lruGetSource` and `cache.lruSuspiciousCalls`.
If `LruMediaStore.get` references fetch/XHR/download helpers, treat it as a
network path and remove it from passive capture. The extension currently reads
the LRU store only when WhatsApp reports a completed download stage
(`RESOLVED`, `READY` or `DOWNLOADED`).

## Store resolver probe

If the extension logs `Requiring unknown module "WAWebCollections"` or the store
hook does not initialize after a WhatsApp Web update, paste
`store-resolver-probe.js` into the DevTools console. It reports the loader type,
whether `__debug.modulesMap` is exposed, which collection module names exist,
and which exports look like Msg/Chat/Contact collections. The probe is read-only
and never sends messages or changes WhatsApp state.
